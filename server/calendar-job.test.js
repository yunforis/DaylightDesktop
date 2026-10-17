import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorageSnapshot, withStorageCommit, readSnapshotDocument, stageSnapshotDocument, settingsKey, createMailJobStorage } from './storage/index.js';
import { readStore, saveStore, saveCalendarSync, readCalendarSync } from './store.js';
import { externalSyncKey, queueExternalSync, pushExternalCalendarTarget, confirmPendingExternalSync, saveCalendarWithExternalSync, verifyExternalCalendarIdentity } from './external-calendar.js';
import { createCalendarHandler, scheduleExternalCalendars, reconcileUnknownCalendarResult } from './calendar-job.js';
import { mutateScenarioData, readScenarioData } from './scenarios/repository.js';

const event = () => ({ id: 'event', title: 'Synthetic', start: '2026-10-20T10:00:00+08:00', end: '2026-10-20T11:00:00+08:00' });
function fixture() {
  let rows = new Map([
    ['app_settings:default', { payload: { mailboxes: [{ id: 'box', ownerUserId: 'owner' }],
      calendarSync: { connections: [{ id: 'remote', provider: 'google', accessToken: 'synthetic', expiresAt: Date.now() + 3600000 }] } }, version: 1 }],
  ]);
  let transactions = 0;
  const pool = { async connect() {
    let backup;
    return { async query(sql, values) {
      if (sql.startsWith('BEGIN')) { backup = structuredClone(rows); transactions++; }
      if (sql === 'COMMIT') { transactions--; backup = undefined; }
      if (sql === 'ROLLBACK') { rows = backup; transactions--; backup = undefined; }
      const table = sql.match(/(?:FROM|INTO|UPDATE)\s+(app_settings|mailbox_calendars)\b/i)?.[1];
      const key = `${table}:${values?.[0]}`;
      const row = rows.get(key);
      if (/SELECT (?:payload, )?version FROM/i.test(sql)) return { rows: row ? [structuredClone(row)] : [] };
      if (/^INSERT INTO (app_settings|mailbox_calendars)/i.test(sql)) {
        if (row) return { rows: [] };
        rows.set(key, { payload: JSON.parse(values[1]), version: 1 });
        return { rows: [{ version: 1 }] };
      }
      if (/^UPDATE (app_settings|mailbox_calendars)/i.test(sql)) {
        if (!row || String(row.version) !== String(values[2])) return { rows: [] };
        rows.set(key, { payload: JSON.parse(values[1]), version: row.version + 1 });
        return { rows: [{ version: row.version + 1 }] };
      }
      return { rows: [] };
    }, release() {} };
  } };
  const options = { pool, userId: 'owner', mailboxId: 'box' };
  const document = () => rows.get('app_settings:external-sync:box')?.payload;
  const snapshot = (opts, fn) => withStorageSnapshot({ ...opts, pool }, fn);
  const jobs = { async lockLease() { return { tenant_id: 'owner', owner_id: 'owner', mailbox_id: 'box' }; } };
  const job = id => ({ id: 'job', lease_token: 'lease', tenant_id: 'owner', owner_id: 'owner', mailbox_id: 'box', payload: { intentId: id } });
  const handler = push => createCalendarHandler(jobs, { snapshot, findUser: async () => ({ id: 'owner' }), push });
  const context = { signal: new AbortController().signal };
  const stage = async (action = 'create', body = event()) => {
    await withStorageCommit(options, () => {
      const store = readStore();
      if (!store.events.some(item => item.id === body.id)) store.events.push(body);
      saveStore(store);
      queueExternalSync(store, body, action);
    });
    return document().intents.at(-1).id;
  };
  return { pool, options, document, job, handler, context, stage, jobs, transactions: () => transactions };
}

test('snapshot queues intent with business state and never invokes detached network/save; exception discards both', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  await assert.rejects(withStorageCommit(f.options, () => {
    const store = readStore(); store.events.push(event()); saveStore(store);
    queueExternalSync(store, event(), 'create', { save: () => { throw new Error('Detached save forbidden'); } });
    assert.equal(readSnapshotDocument(externalSyncKey('box')).intents.length, 1);
    throw new Error('Business rejected');
  }), /Business rejected/);
  assert.equal(f.document(), undefined);
  await f.stage();
  assert.equal(f.document().intents[0].status, 'pending');
  assert.deepEqual(f.document().intents[0].connectionIds, ['remote']);
  await new Promise(resolve => setImmediate(resolve));
});

test('create checkpoints outside I/O, persists remote identity, replay skips, update/delete reuse identity after local deletion', async () => {
  const f = fixture();
  const calls = [];
  const run = f.handler(async (connection, payload, action) => {
    assert.equal(f.transactions(), 0);
    assert.equal(f.document().intents.at(-1).receipts.remote.status, 'sending');
    calls.push({ payload, action });
    return action === 'delete' ? null : 'remote-id';
  });
  let id = await f.stage();
  await run(f.job(id), f.context);
  await run(f.job(id), f.context);
  assert.equal(calls.length, 1);
  id = await f.stage('update', { ...event(), title: 'Changed' });
  await run(f.job(id), f.context);
  assert.equal(calls[1].payload.externalIds.remote, 'remote-id');
  id = await f.stage('delete');
  await withStorageCommit(f.options, () => { const store = readStore(); store.events = []; saveStore(store); });
  await run(f.job(id), f.context);
  assert.equal(calls[2].payload.externalIds.remote, 'remote-id');
  assert.equal(f.document().intents.at(-1).status, 'succeeded');
});

test('unknown create blocks automatic/manual replay and later intents without a second remote call', async () => {
  const f = fixture();
  let calls = 0;
  const run = f.handler(async () => { calls++; throw new Error('Socket closed after server accepted'); });
  const id = await f.stage();
  await assert.rejects(run(f.job(id), f.context), { code: 'CALENDAR_RESULT_UNKNOWN', retryable: false });
  assert.equal(f.document().intents[0].status, 'unknown');
  await assert.rejects(run(f.job(id), f.context), { code: 'CALENDAR_RESULT_UNKNOWN' });
  const later = await f.stage('update');
  await assert.rejects(run(f.job(later), f.context), { code: 'CALENDAR_RESULT_UNKNOWN' });
  assert.equal(calls, 1);
});

test('interrupted create retains sending and is treated as unknown on recovery', async () => {
  const f = fixture();
  const id = await f.stage();
  const controller = new AbortController();
  const run = f.handler(async () => { controller.abort(new Error('Worker lost')); return 'accepted-but-unrecorded'; });
  await assert.rejects(run(f.job(id), { signal: controller.signal }), /Worker lost/);
  assert.equal(f.document().intents[0].receipts.remote.status, 'sending');
  await assert.rejects(f.handler(async () => { throw new Error('Must not call remote'); })(f.job(id), f.context), { code: 'CALENDAR_RESULT_UNKNOWN' });
});

test('update failure retries the same identity', async () => {
  const f = fixture();
  const id = await f.stage('update', { ...event(), externalIds: { remote: 'existing' } });
  let calls = 0;
  const run = f.handler(async (_, body) => {
    assert.equal(body.externalIds.remote, 'existing');
    if (++calls === 1) throw new Error('Timeout');
    return 'existing';
  });
  await assert.rejects(run(f.job(id), f.context), { code: 'CALENDAR_REMOTE_FAILED', retryable: true });
  await run(f.job(id), f.context);
  assert.equal(calls, 2);
});

test('lost lease prevents preparation and all remote calls', async () => {
  const f = fixture();
  const id = await f.stage();
  f.jobs.lockLease = async () => { throw Object.assign(new Error('Lease lost'), { code: 'JOB_LEASE_LOST' }); };
  let calls = 0;
  await assert.rejects(f.handler(async () => { calls++; })(f.job(id), f.context), { code: 'JOB_LEASE_LOST' });
  assert.equal(calls, 0);
  assert.equal(f.document().intents[0].receipts, undefined);
});

test('lost lease after remote acceptance retains sending and prevents a second create', async () => {
  const f = fixture();
  const id = await f.stage();
  const lock = f.jobs.lockLease;
  await assert.rejects(f.handler(async () => {
    f.jobs.lockLease = async () => { throw Object.assign(new Error('Lease lost'), { code: 'JOB_LEASE_LOST' }); };
    return 'remote-accepted';
  })(f.job(id), f.context), { code: 'JOB_LEASE_LOST' });
  assert.equal(f.document().intents[0].receipts.remote.status, 'sending');
  f.jobs.lockLease = lock;
  await assert.rejects(f.handler(async () => { throw new Error('No second create'); })(f.job(id), f.context), { code: 'CALENDAR_RESULT_UNKNOWN' });
});

test('confirmation stages selected mailbox intents atomically with pending removal', async () => {
  const f = fixture();
  await withStorageCommit(f.options, () => {
    saveCalendarSync({ connections: [{ id: 'remote', provider: 'google' }], requireConfirm: true });
    queueExternalSync({ events: [event()] }, event(), 'create');
  });
  assert.equal(f.document(), undefined);
  await withStorageCommit(f.options, () => {
    assert.equal(confirmPendingExternalSync({ events: [event()] }, { all: true }).confirmed, 1);
    assert.equal(readSnapshotDocument(externalSyncKey('box')).intents.length, 1);
  });
  assert.equal(f.document().intents.length, 1);
});

test('provider updates/deletes use fixed identity, absent delete is success and CalDAV 412 is not a receipt', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response('', { status: init.method === 'DELETE' ? 404 : 412 });
  });
  const connection = { id: 'remote', provider: 'google', accessToken: 'synthetic', expiresAt: Date.now() + 3600000 };
  const body = { ...event(), externalIds: { remote: 'fixed' } };
  assert.equal(await pushExternalCalendarTarget(connection, body, 'delete'), null);
  assert.ok(calls[0].url.endsWith('/events/fixed'));
  await assert.rejects(pushExternalCalendarTarget({ ...connection, provider: 'caldav', caldavUrl: 'https://calendar.invalid', username: 'synthetic', password: 'synthetic' }, event(), 'create'), /412/);
});

test('scheduler creates jobs and notifications in the supplied intent transaction with stable dedup key', async () => {
  const queries = [];
  const row = { id: 'external-sync:box', payload: { intents: [{ id: 'intent', ownerId: 'owner', mailboxId: 'box', status: 'pending' }] } };
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT id,payload')) return { rows: [structuredClone(row)] };
    if (sql.includes('INSERT INTO daylight_jobs')) return { rows: [{ id: values[0], available_at: new Date() }] };
    return { rows: [] };
  } };
  let notified = 0;
  const count = await scheduleExternalCalendars({ transaction: fn => fn(client), notify: async passed => { assert.equal(passed, client); notified++; } });
  assert.equal(count, 1);
  assert.equal(notified, 1);
  const insertion = queries.find(item => item.sql.includes('INSERT INTO daylight_jobs'));
  assert.equal(insertion.values[3], 'calendar:intent');
  assert.equal(JSON.parse(queries.at(-1).values[1]).intents[0].status, 'scheduled');
});

test('business writer deduplicates unchanged events, preserves receipts, and stages reschedule deletion plus creation', async () => {
  const f = fixture();
  await withStorageCommit(f.options, () => {
    const store = readStore(); store.events.push({ ...event(), externalIds: { remote: 'fixed' } });
    saveCalendarWithExternalSync(store, 'box');
    saveCalendarWithExternalSync(store, 'box');
    const again = readStore();
    delete again.events[0].externalIds;
    again.events[0].workbenchId = 'metadata-only';
    saveCalendarWithExternalSync(again, 'box');
    assert.equal(readSnapshotDocument(externalSyncKey('box')).intents.length, 1);
    assert.equal(readStore().events[0].externalIds.remote, 'fixed');
    again.events[0].status = 'cancelled';
    again.events.push({ ...event(), id: 'replacement' });
    saveCalendarWithExternalSync(again, 'box');
    saveCalendarWithExternalSync(again, 'box');
  });
  assert.deepEqual(f.document().intents.map(item => item.action), ['create', 'delete', 'create']);
  assert.equal(f.document().intents[1].event.externalIds.remote, 'fixed');
});

test('scenario mutation and intent rollback together on callback and database failure', async () => {
  const f = fixture();
  await assert.rejects(withStorageCommit(f.options, () => mutateScenarioData(data => {
    data.history.push({ id: 'history' });
    const store = readStore(); store.events.push(event()); saveCalendarWithExternalSync(store, 'box');
    throw new Error('Scenario rejected');
  })), /Scenario rejected/);
  await withStorageCommit(f.options, async () => {
    assert.equal(readStore().events.length, 0);
    assert.equal((await readScenarioData()).history.length, 0);
    assert.equal(readSnapshotDocument(externalSyncKey('box')).intents.length, 0);
  });
  await assert.rejects(withStorageCommit({ ...f.options, afterWrite() { throw new Error('Commit rejected'); } },
    () => mutateScenarioData(data => {
      data.history.push({ id: 'history' });
      const store = readStore(); store.events.push(event()); saveCalendarWithExternalSync(store, 'box');
    })), /Commit rejected/);
  assert.equal(f.document(), undefined);
  await withStorageCommit(f.options, async () => {
    assert.equal(readStore().events.length, 0);
    assert.equal((await readScenarioData()).history.length, 0);
  });
});

test('mail storage checkpoints calendar and intent on supplied client, rollback removes both and replay creates one intent', async () => {
  const f = fixture();
  const adapter = createMailJobStorage({ pool: f.pool });
  const job = f.job('unused');
  const prepare = async () => {
    const snapshot = await adapter.load({ job });
    await adapter.runSnapshot(snapshot, () => { snapshot.store.events.push(event()); snapshot.store.emails.push({ id: 'mail' }); });
    return snapshot;
  };
  let snapshot = await prepare();
  const client = await f.pool.connect();
  await client.query('BEGIN');
  await adapter.commit({ client, job, snapshot, expectedVersion: snapshot.version });
  assert.equal(f.document().intents.length, 1);
  await client.query('ROLLBACK');
  assert.equal(f.document(), undefined);
  snapshot = await prepare();
  await client.query('BEGIN');
  await adapter.commit({ client, job, snapshot, expectedVersion: snapshot.version });
  await client.query('COMMIT');
  snapshot = await adapter.load({ job });
  await adapter.runSnapshot(snapshot, () => {});
  await client.query('BEGIN');
  await adapter.commit({ client, job, snapshot, expectedVersion: snapshot.version });
  await client.query('COMMIT');
  assert.equal(f.document().intents.length, 1);
});

test('non-active owned mailbox is staged correctly, disabled connections and confirmation settings are respected', async () => {
  const f = fixture();
  await withStorageCommit(f.options, () => {
    const settings = readSnapshotDocument(settingsKey('default'));
    settings.mailboxes.push({ id: 'other', ownerUserId: 'owner' });
    stageSnapshotDocument(settingsKey('default'), settings);
  });
  await withStorageCommit(f.options, () => {
    saveCalendarSync({ connections: [{ id: 'remote', provider: 'google' }], requireConfirm: true });
    const store = readStore('other'); store.events.push(event());
    saveCalendarWithExternalSync(store, 'other'); saveCalendarWithExternalSync(store, 'other');
    const sync = readCalendarSync();
    assert.equal(sync.pendingExternalSync.length, 1);
    assert.equal(sync.pendingExternalSync[0].mailboxId, 'other');
    assert.equal(readSnapshotDocument(externalSyncKey('other')).intents.length, 0);
    saveCalendarSync({ connections: [{ id: 'remote', enabled: false }] });
    store.events[0].title = 'Changed'; saveCalendarWithExternalSync(store, 'other');
    assert.equal(readSnapshotDocument(externalSyncKey('other')).intents.length, 0);
  });
});

test('manual unknown recovery requires confirmation, verifies identity, rolls back atomically and never pushes on replay', async () => {
  const f = fixture();
  const id = await f.stage();
  await assert.rejects(f.handler(async () => { throw new Error('Ambiguous'); })(f.job(id), f.context));
  const input = { confirmed: true, outcome: 'found', remoteId: 'verified-id', connectionId: 'remote', note: 'Checked event in remote calendar' };
  let verified = 0;
  const verify = async (_, remoteId) => { verified++; assert.equal(f.transactions(), 0); return remoteId; };
  await assert.rejects(withStorageCommit(f.options, () => reconcileUnknownCalendarResult('box', id, { ...input, confirmed: false }, { verify })), { code: 'CALENDAR_CONFIRMATION_REQUIRED' });
  assert.equal(verified, 0);
  await assert.rejects(withStorageCommit({ ...f.options, afterWrite() { throw new Error('Reject receipt'); } },
    () => reconcileUnknownCalendarResult('box', id, input, { verify })), /Reject receipt/);
  assert.equal(f.document().intents[0].receipts.remote.status, 'unknown');
  await withStorageCommit(f.options, () => reconcileUnknownCalendarResult('box', id, input, { verify }));
  await f.handler(async () => { throw new Error('Must not push'); })(f.job(id), f.context);
  assert.equal(f.document().targets['["event","remote"]'].remoteId, 'verified-id');
  await withStorageCommit(f.options, () => assert.equal(readStore().events[0].externalIds.remote, 'verified-id'));
});

test('manual absent recovery closes attempt without sending; remote verification rejects missing identity and foreign CalDAV URLs', async t => {
  const f = fixture();
  const id = await f.stage();
  await assert.rejects(f.handler(async () => { throw new Error('Ambiguous'); })(f.job(id), f.context));
  await withStorageCommit(f.options, () => reconcileUnknownCalendarResult('box', id,
    { confirmed: true, outcome: 'absent', connectionId: 'remote', note: 'Manually checked collection: no event' },
    { verify() { throw new Error('No network for manual absence'); } }));
  await f.handler(async () => { throw new Error('No automatic resend'); })(f.job(id), f.context);
  const later = await f.stage('update');
  await assert.rejects(f.handler(async () => { throw new Error('No automatic create after manual absence'); })(f.job(later), f.context), { code: 'CALENDAR_RESULT_UNKNOWN' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, init) => { calls++; assert.equal(init.method, 'GET'); return new Response(JSON.stringify({ id: 'different' })); });
  const connection = { id: 'remote', provider: 'google', accessToken: 'synthetic', expiresAt: Date.now() + 3600000 };
  await assert.rejects(verifyExternalCalendarIdentity(connection, ''), { code: 'CALENDAR_REMOTE_ID_INVALID' });
  await assert.rejects(verifyExternalCalendarIdentity({ provider: 'caldav', caldavUrl: 'https://calendar.invalid/owned' }, 'https://foreign.invalid/event.ics'), { code: 'CALENDAR_REMOTE_ID_INVALID' });
  assert.equal(calls, 0);
  await assert.rejects(verifyExternalCalendarIdentity(connection, 'expected'), { code: 'CALENDAR_VERIFICATION_FAILED' });
});
