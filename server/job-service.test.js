import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailHandler, createPlanHandler, scheduleMailboxes, queueCalendarExport } from './job-service.js';
import { withStorageSnapshot, commitStorage, readSnapshotDocument, stageSnapshotDocument, settingsKey } from './storage/index.js';
import { readSettings, readStore } from './store.js';
import { readTraces, saveTraces } from './traces.js';
import { externalSyncKey } from './external-calendar.js';

const job = () => ({ id: 'job-a', lease_token: 'lease-a', tenant_id: 'alice', owner_id: 'alice', mailbox_id: 'a',
  payload: { workbenchId: 'workbench', itemId: 'item', useModel: false } });
const context = () => ({ signal: new AbortController().signal, steps: async () => [] });
const configured = () => ({ mailboxes: [
  { id: 'a', ownerUserId: 'alice', email: 'alice@example.invalid', authorizationCode: 'synthetic-code', imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid' },
  { id: 'b', ownerUserId: 'alice', email: 'other@example.invalid' },
  { id: 'c', ownerUserId: 'bob', email: 'bob@example.invalid' },
], userPrefs: { alice: { activeMailboxId: 'b', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic', apiKey: 'synthetic-key' } } });

// Transactional SQL fixture: exercise the actual snapshot/CAS commit, including rollback.
// No database, model, IMAP, or user data is accessed by this suite.
function fixture(settings = configured()) {
  let rows = new Map();
  const rowKey = (table, id) => `${table}:${id}`;
  const put = (table, id, payload) => rows.set(rowKey(table, id), { payload: structuredClone(payload), version: '1' });
  if (settings) put('app_settings', 'default', settings);
  put('app_settings', 'scenarios:alice', { workbenches: [{ id: 'workbench', mailboxIds: ['a'] }], items: [{ id: 'item', workbenchId: 'workbench' }] });
  let staged, checkpoint, savedCheckpoint;
  const log = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      if (sql.startsWith('BEGIN')) { staged = structuredClone(rows); savedCheckpoint = checkpoint; return { rows: [] }; }
      if (sql === 'COMMIT') { log.push('commit'); staged = null; return { rows: [] }; }
      if (sql === 'ROLLBACK') { log.push('rollback'); rows = staged; checkpoint = savedCheckpoint; staged = null; return { rows: [] }; }
      if (sql.includes('pg_advisory')) return { rows: [] };
      if (sql.startsWith('INSERT INTO daylight_job_steps')) { log.push('checkpoint'); checkpoint = JSON.parse(params[2]); return { rows: [] }; }
      const table = sql.match(/(?:FROM|UPDATE|INTO) (app_settings|mailbox_calendars)/)?.[1];
      if (!table) throw new Error(`Unexpected SQL: ${sql}`);
      const key = rowKey(table, params[0]);
      if (sql.startsWith('SELECT')) return { rows: rows.has(key) ? [structuredClone(rows.get(key))] : [] };
      log.push('business-write');
      const previous = rows.get(key);
      if ((sql.startsWith('INSERT') && previous) || (sql.startsWith('UPDATE') && previous?.version !== params[2])) return { rows: [] };
      const version = String(Number(previous?.version || 0) + 1);
      rows.set(key, { payload: JSON.parse(params[1]), version });
      return { rows: [{ version }] };
    },
  };
  const pool = { connect: async () => client, query: (...args) => client.query(...args) };
  const snapshot = (options, fn) => withStorageSnapshot({ ...options, pool }, fn);
  return { pool, snapshot, log, get checkpoint() { return checkpoint; },
    data: () => rows.get(rowKey('app_settings', 'scenarios:alice')).payload };
}

function planHarness(f = fixture(), { loseAfterWrite = false, changedScope = false } = {}) {
  let fences = 0;
  let proposals = 0;
  const jobs = { async lockLease(client, id, token) {
    assert.equal(id, 'job-a'); assert.equal(token, 'lease-a');
    f.log.push('fence'); fences++;
    if (loseAfterWrite && fences === 2) throw Object.assign(new Error('Lease lost'), { code: 'JOB_LEASE_LOST' });
    return { ...job(), generation: 2, ...(changedScope ? { owner_id: 'bob' } : {}) };
  } };
  const handler = createPlanHandler(jobs, { findUser: async id => ({ id }), snapshot: f.snapshot,
    propose: async () => {
      proposals++;
      assert.equal(readSettings().activeMailboxId, 'a');
      assert.deepEqual(readSettings().mailboxes.map(box => box.id), ['a', 'b']);
      const key = settingsKey('scenarios:alice');
      stageSnapshotDocument(key, { ...readSnapshotDocument(key), planned: true });
    },
  });
  return { handler, f, get proposals() { return proposals; } };
}

test('plan binds owner/job mailbox and commits business state with a checkpoint between lease fences', async () => {
  const h = planHarness();
  const result = await h.handler(job(), context());
  assert.equal(result.completed, true);
  assert.equal(h.f.data().planned, true);
  assert.deepEqual(h.f.checkpoint, result);
  const start = h.f.log.indexOf('fence');
  assert.deepEqual(h.f.log.slice(start), ['fence', 'checkpoint', 'business-write', 'fence', 'commit']);
});

test('lease loss after writes rolls back both scenario state and checkpoint', async () => {
  const h = planHarness(fixture(), { loseAfterWrite: true });
  await assert.rejects(h.handler(job(), context()), { code: 'JOB_LEASE_LOST' });
  assert.equal(h.f.data().planned, undefined);
  assert.equal(h.f.checkpoint, undefined);
  assert.equal(h.f.log.at(-1), 'rollback');
});

test('changed lease identity rejects before business persistence and rolls back', async () => {
  const h = planHarness(fixture(), { changedScope: true });
  await assert.rejects(h.handler(job(), context()), /lease scope changed/);
  assert.equal(h.f.log.includes('business-write'), false);
  assert.equal(h.f.checkpoint, undefined);
});

test('persisted plan checkpoint replays without another proposal or write', async () => {
  const h = planHarness();
  const saved = { workbenchId: 'workbench', itemId: 'item', completed: true };
  assert.deepEqual(await h.handler(job(), { ...context(), steps: async () => [{ name: 'plan.persist', result: saved }] }), saved);
  assert.equal(h.proposals, 0);
  assert.equal(h.f.log.includes('business-write'), false);
});

test('abort before persistence cannot create a plan checkpoint', async () => {
  const h = planHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.handler(job(), { ...context(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.proposals, 0);
  assert.equal(h.f.checkpoint, undefined);
});

test('invalid or missing task scope/input never reaches user lookup, proposal or commit', async () => {
  let lookedUp = false;
  for (const factory of [createPlanHandler, createMailHandler]) {
    const handler = factory({}, { findUser: async () => { lookedUp = true; } });
    for (const value of [null, {}, { ...job(), tenant_id: 'bob' }, { ...job(), mailbox_id: '' }]) {
      await assert.rejects(handler(value, context()), /Invalid task scope/);
    }
  }
  assert.equal(lookedUp, false);
  const h = planHarness();
  await assert.rejects(h.handler({ ...job(), payload: {} }, context()), /Invalid plan task input/);
  await assert.rejects(h.handler({ ...job(), payload: { ...job().payload, itemId: 'missing' } }, context()), /item unavailable/);
  assert.equal(h.proposals, 0);
  assert.equal(h.f.checkpoint, undefined);
});

test('deleted owners and non-owned job mailboxes cannot execute', async () => {
  for (const factory of [createPlanHandler, createMailHandler]) {
    await assert.rejects(factory({}, { findUser: async () => null })(job(), context()), /owner unavailable/);
    const f = fixture();
    const handler = factory({}, { findUser: async id => ({ id }), snapshot: f.snapshot });
    await assert.rejects(handler({ ...job(), mailbox_id: 'c' }, context()), { code: 'STORAGE_MAILBOX_FORBIDDEN' });
    assert.equal(f.checkpoint, undefined);
  }
});

test('missing shared settings never reports plan or mail success', async () => {
  for (const factory of [createPlanHandler, createMailHandler]) {
    const f = fixture(null);
    const handler = factory({}, { findUser: async id => ({ id }), snapshot: f.snapshot });
    await assert.rejects(handler(job(), context()), { code: 'STORAGE_SETTINGS_MISSING' });
    assert.equal(f.checkpoint, undefined);
  }
});

test('model plan and mail reject unconfigured settings before side effects', async () => {
  const settings = configured();
  settings.userPrefs.alice.apiKey = '';
  const h = planHarness(fixture(settings));
  await assert.rejects(h.handler({ ...job(), payload: { ...job().payload, useModel: true } }, context()), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(h.proposals, 0);
  let ran = false;
  const mail = createMailHandler({}, { findUser: async id => ({ id }), snapshot: h.f.snapshot, run: async () => { ran = true; } });
  await assert.rejects(mail(job(), context()), { code: 'MAIL_NOT_CONFIGURED' });
  assert.equal(ran, false);
});

test('mail delegates to the shared core adapter with the explicit owner and mailbox', async () => {
  const f = fixture();
  const jobs = {};
  let adapter;
  const handler = createMailHandler(jobs, { findUser: async id => ({ id }), snapshot: f.snapshot,
    storageFactory(options) { assert.equal(options.userId, 'alice'); assert.equal(options.mailboxId, 'a'); return adapter = {}; },
    run: async input => {
      assert.equal(input.repository, jobs); assert.equal(input.storage, adapter);
      assert.equal(input.settings.activeMailboxId, 'a');
      return { total: 0 };
    },
  });
  assert.deepEqual(await handler(job(), context()), { total: 0 });
});

test('mail runs carry a trace recorder that persists the processing log and reply draft', async () => {
  const f = fixture();
  let recorder;
  const handler = createMailHandler({}, { findUser: async id => ({ id }), snapshot: f.snapshot,
    storageFactory: () => ({}),
    run: async input => {
      recorder = input.recorder;
      await f.snapshot({ userId: 'alice', mailboxId: 'a' }, async () => {
        const jobContext = recorder.beginEmail({ id: 'qq:a:1:1', subject: '合成面试通知' }, 'qq');
        const span = jobContext.startSpan('extract', '模型抽取', { llm_request: true });
        jobContext.finishSpan(span, { observation: '已解析' });
        jobContext.finish('imported', { decision: '已创建日程', draft_reply: '您好，已收到面试通知。\n' });
        await commitStorage({});
      });
      return { total: 1 };
    },
  });
  await handler(job(), context());
  assert.ok(recorder, 'a production mail run without a recorder stores no trace at all');
  const stored = await f.snapshot({ userId: 'alice', mailboxId: 'a' }, () => readSnapshotDocument(settingsKey('traces:a')));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'imported');
  assert.equal(stored[0].draft_reply, '您好，已收到面试通知。\n');
  assert.equal(stored[0].spans.length, 1);
  assert.equal(stored[0].spans[0].stage, 'extract');
});

test('trace reads and writes default to the active mailbox, never a traces:undefined document', async () => {
  const f = fixture();
  await f.snapshot({ userId: 'alice', mailboxId: 'b' }, async () => {
    assert.equal(readSettings().activeMailboxId, 'b');
    assert.deepEqual(readTraces(), []);
    saveTraces([{ trace_id: 'trace-b', draft_reply: '合成回复' }]);
    await commitStorage({});
  });
  const stored = await f.snapshot({ userId: 'alice', mailboxId: 'b' }, () => readSnapshotDocument(settingsKey('traces:b')));
  assert.deepEqual(stored.map((trace) => trace.trace_id), ['trace-b']);
  const untouched = await f.snapshot({ userId: 'alice', mailboxId: 'b' }, () => readSnapshotDocument(settingsKey('traces:a')));
  assert.deepEqual(untouched, [], 'an unaddressed trace write must not land in another mailbox');
  // The default used to address `traces:undefined`, which is never loaded: the processing log
  // answered 503 in production while the file store silently resolved a default directory.
  await assert.rejects(f.snapshot({ userId: 'alice', mailboxId: 'b' },
    () => readSnapshotDocument(settingsKey('traces:undefined'))), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
});

test('scheduler checks each mailbox rather than the active mailbox and uses minute-scoped keys', async () => {
  const f = fixture();
  const enqueued = [];
  const jobs = { enqueue: async input => enqueued.push(input), mailboxSyncOutcomes: async () => [],
    hasPendingSync: async () => false };
  const result = await scheduleMailboxes(jobs, new Date('2026-10-17T01:02:30Z'), { snapshot: f.snapshot });
  assert.deepEqual(result, { scheduled: 1, deferred: 0 });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].ownerId, 'alice');
  assert.equal(enqueued[0].mailboxId, 'a');
  assert.match(enqueued[0].idempotencyKey, /^scheduled:\d+$/);
});

test('a repeatedly failing mailbox is backed off instead of dialled every minute', async () => {
  const f = fixture();
  const enqueued = [];
  const now = new Date('2026-10-17T01:02:30Z');
  // Two consecutive terminal failures: the delay doubles to ten minutes.
  const history = [
    { status: 'failed', attempts: 1, error: { code: 'MAIL_NOT_CONFIGURED' }, finished_at: new Date(now.getTime() - 60000).toISOString() },
    { status: 'failed', attempts: 1, error: null, finished_at: new Date(now.getTime() - 120000).toISOString() },
  ];
  const jobs = { enqueue: async input => enqueued.push(input), mailboxSyncOutcomes: async () => history,
    hasPendingSync: async () => false };
  assert.deepEqual(await scheduleMailboxes(jobs, now, { snapshot: f.snapshot }), { scheduled: 0, deferred: 1 });
  assert.deepEqual(await scheduleMailboxes(jobs, new Date(now.getTime() + 4 * 60000), { snapshot: f.snapshot }), { scheduled: 0, deferred: 1 });
  assert.equal(enqueued.length, 0, 'the account is not dialled while the backoff window is open');
  assert.deepEqual(await scheduleMailboxes(jobs, new Date(now.getTime() + 10 * 60000 + 1000), { snapshot: f.snapshot }), { scheduled: 1, deferred: 0 });
  assert.equal(enqueued.length, 1, 'the scheduled sync resumes once the window closes');
});

test('one success clears the backoff, so a repaired mailbox syncs on the next minute', async () => {
  const f = fixture();
  const enqueued = [];
  const now = new Date('2026-10-17T01:02:30Z');
  const history = [
    { status: 'succeeded', attempts: 1, error: null, finished_at: new Date(now.getTime() - 30000).toISOString() },
    { status: 'failed', attempts: 2, error: { code: 'MAIL_NOT_CONFIGURED' }, finished_at: new Date(now.getTime() - 300000).toISOString() },
  ];
  const jobs = { enqueue: async input => enqueued.push(input), mailboxSyncOutcomes: async () => history,
    hasPendingSync: async () => false };
  assert.deepEqual(await scheduleMailboxes(jobs, now, { snapshot: f.snapshot }), { scheduled: 1, deferred: 0 });
  assert.equal(enqueued.length, 1);
});

test('a mailbox already syncing is deferred instead of queued again every minute', async () => {
  const f = fixture();
  const enqueued = [];
  const now = new Date('2026-10-17T01:02:30Z');
  // A sync that outlives the minute cadence used to add one job per minute without bound.
  const pending = { open: true };
  const checks = [];
  const jobs = { enqueue: async input => enqueued.push(input), mailboxSyncOutcomes: async () => [],
    hasPendingSync: async input => { checks.push({ ownerId: input.ownerId, mailboxId: input.mailboxId }); return pending.open; } };
  assert.deepEqual(await scheduleMailboxes(jobs, now, { snapshot: f.snapshot }), { scheduled: 0, deferred: 1 });
  assert.deepEqual(await scheduleMailboxes(jobs, new Date(now.getTime() + 60000), { snapshot: f.snapshot }), { scheduled: 0, deferred: 1 });
  assert.equal(enqueued.length, 0, 'no duplicate dial is queued while the mailbox sync is still in flight');
  assert.deepEqual(checks, [{ ownerId: 'alice', mailboxId: 'a' }, { ownerId: 'alice', mailboxId: 'a' }]);
  pending.open = false;
  const later = new Date(now.getTime() + 120000);
  assert.deepEqual(await scheduleMailboxes(jobs, later, { snapshot: f.snapshot }), { scheduled: 1, deferred: 0 });
  assert.equal(enqueued.length, 1, 'the next free minute schedules exactly one sync');
  assert.equal(enqueued[0].idempotencyKey, `scheduled:${Math.floor(later.getTime() / 60000)}`);
});

test('the backoff window is configurable and its delay grows exponentially to a cap', async () => {
  const { mailboxBackoffMs, failureStreak } = await import('./jobs/repository.js');
  assert.equal(mailboxBackoffMs(1), 300000);
  assert.equal(mailboxBackoffMs(2), 600000);
  assert.equal(mailboxBackoffMs(3), 1200000);
  assert.equal(mailboxBackoffMs(20), 3600000, 'capped at one hour');
  assert.equal(mailboxBackoffMs(4, { baseMs: 60000, maxMs: 300000 }), 300000);
  assert.throws(() => mailboxBackoffMs(1, { baseMs: 0 }), /baseMs/);
  assert.equal(failureStreak([{ status: 'failed' }, { status: 'failed' }, { status: 'succeeded' }]), 2);
  assert.equal(failureStreak([{ status: 'succeeded' }, { status: 'failed' }]), 0);
  assert.equal(failureStreak([]), 0);

  const f = fixture();
  const enqueued = [];
  const now = new Date('2026-10-17T01:02:30Z');
  const history = [{ status: 'failed', attempts: 1, error: null, finished_at: new Date(now.getTime() - 55000).toISOString() }];
  const jobs = { enqueue: async input => enqueued.push(input), mailboxSyncOutcomes: async () => history,
    hasPendingSync: async () => false };
  // A one-minute base keeps the first retry close to the scheduler cadence for a healthy mailbox.
  assert.deepEqual(await scheduleMailboxes(jobs, now, { snapshot: f.snapshot, baseBackoffMs: 60000 }), { scheduled: 0, deferred: 1 });
  assert.deepEqual(await scheduleMailboxes(jobs, new Date(now.getTime() + 4000), { snapshot: f.snapshot, baseBackoffMs: 60000 }), { scheduled: 0, deferred: 1 });
  assert.deepEqual(await scheduleMailboxes(jobs, new Date(now.getTime() + 6000), { snapshot: f.snapshot, baseBackoffMs: 60000 }), { scheduled: 1, deferred: 0 });
  assert.equal(enqueued.length, 1);
});

test('a job failure reason is bounded and redacts addresses and credentials', async () => {
  const { describeFailure } = await import('./jobs/runtime.js');
  assert.equal(describeFailure(new Error('Login is disabled for alice@example.invalid')),
    'Login is disabled for <address>');
  assert.equal(describeFailure(new Error('   spaced \n  out   ')), 'spaced out');
  assert.equal(describeFailure({ code: 'JOB_FAILED' }), 'JOB_FAILED');
  assert.equal(describeFailure(new Error('x'.repeat(500))).length, 300);
  assert.equal(describeFailure(new Error('x'.repeat(500))).endsWith('…'), true);
  // A failed model call must not persist its key, and a database error must not persist the password.
  assert.equal(describeFailure(new Error('401 from https://api.example.invalid/v1/chat?token=sk-live-abc123')),
    '401 from https://api.example.invalid/v1/chat?token=<redacted>');
  assert.equal(describeFailure(new Error('connect failed postgresql://daylight:hunter2@db:5432/daylight')),
    'connect failed <redacted>db:5432/daylight');
  assert.equal(describeFailure(new Error('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')),
    'Authorization: <redacted>');
});

test('bulk calendar export stages forced durable intents without claiming remote success, and rolls back on failure', async () => {
  const settings = configured();
  settings.calendarSync = { requireConfirm: true, connections: [{ id: 'remote', provider: 'google' }] };
  const f = fixture(settings);
  const events = [{ id: 'event', title: 'Synthetic', start: '2026-10-20T10:00:00+08:00', end: '2026-10-20T11:00:00+08:00' }];
  await f.snapshot({ userId: 'alice', mailboxId: 'a' }, async () => {
    const receipt = queueCalendarExport(readStore(), events, settings.calendarSync.connections);
    assert.equal(receipt.status, 'queued');
    assert.equal(receipt.durable, true);
    assert.equal(receipt.exported, undefined);
    assert.equal(receipt.queued, 1);
    const intent = readSnapshotDocument(externalSyncKey('a')).intents[0];
    assert.equal(intent.ownerId, 'alice');
    assert.equal(intent.mailboxId, 'a');
    assert.deepEqual(intent.connectionIds, ['remote']);
    assert.equal(intent.status, 'pending');
    const { commitStorage } = await import('./storage/index.js');
    await commitStorage();
  });
  await assert.rejects(f.snapshot({ userId: 'alice', mailboxId: 'a' }, () => {
    queueCalendarExport(readStore(), events, settings.calendarSync.connections);
    throw new Error('Business rejected');
  }), /Business rejected/);
  await f.snapshot({ userId: 'alice', mailboxId: 'a' }, () => {
    assert.equal(readSnapshotDocument(externalSyncKey('a')).intents.length, 1);
  });
});
