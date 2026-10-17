import test from 'node:test';
import assert from 'node:assert/strict';
import { runMailJob } from './mail-job.js';
import { mailboxMessageIdentity, processEmails, readMailboxEmails } from './agent.js';

const job = { id: 'job', tenant_id: 'tenant', owner_id: 'owner', mailbox_id: 'box', lease_token: 'lease', payload: {} };
const settings = { activeMailboxId: 'box', email: 'synthetic@example.invalid', mailFilters: [] };
const mail = (id, day = 1) => ({ id, subject: 'Synthetic', body: 'No action', receivedAt: `2026-10-0${day}T00:00:00Z` });
const extraction = { summary: 'No action', events: [], tasks: [] };

function fixture(emails = [mail('a')]) {
  const state = { store: { emails: [], events: [], tasks: [] }, version: 0, commits: 0, calls: 0, steps: new Map(), active: true };
  const storage = {
    load: async () => ({ version: state.version, store: structuredClone(state.store) }),
    runSnapshot: async (_snapshot, fn) => fn(),
    commit: async ({ client, snapshot, expectedVersion }) => {
      assert.equal(client.transaction, true);
      if (expectedVersion !== state.version) throw Object.assign(new Error('conflict'), { code: 'MAIL_SNAPSHOT_CONFLICT' });
      client.next = snapshot.store;
    },
  };
  const repository = { checkpoint: async (_id, token, name, value, write) => {
    assert.equal(token, 'lease');
    if (!state.active) throw Object.assign(new Error('lease lost'), { code: 'JOB_LEASE_LOST' });
    if (state.steps.has(name)) return state.steps.get(name);
    const client = { transaction: true };
    await write(client, job);
    if (!state.active) throw Object.assign(new Error('lease lost'), { code: 'JOB_LEASE_LOST' });
    state.store = structuredClone(client.next);
    state.version++;
    state.commits++;
    state.steps.set(name, value);
    return value;
  } };
  const args = { job, settings, storage, repository, readEmails: async () => emails,
    handleSpecialEmail: async () => null,
    extractor: async () => { state.calls++; return extraction; } };
  return { state, args };
}

test('chronological processing and replay preserve one atomic effect/checkpoint per mail', async () => {
  const { state, args } = fixture([mail('b', 2), mail('a')]);
  const order = [];
  args.extractor = async email => { order.push(email.id); return extraction; };
  await runMailJob(args);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(state.commits, 2);
  assert.equal(state.steps.size, 2);
  const replay = await runMailJob(args);
  assert.equal(replay.duplicate, 2);
  assert.equal(state.commits, 2);
  assert.equal(order.length, 2);
});

test('a shuffled batch reaching the job loop is applied earliest-first, never in arrival order', async () => {
  // IMAP returns newest-first; a reschedule notice must not be applied before the
  // original invitation, so both the batch layer and the job layer re-sort by receivedAt.
  const base = [mail('e1', 1), mail('e2', 2), mail('e3', 3), mail('e4', 4), mail('e5', 5)];
  const { state, args } = fixture([...base].reverse());
  const order = [];
  args.extractor = async email => { order.push(email.id); return extraction; };
  const result = await runMailJob(args);
  assert.deepEqual(order, ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(result.total, 5);
  assert.equal(state.commits, 5);
});

test('the batch layer orders by received time, not by the order the reader produced', async () => {
  const times = ['2026-10-03T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z',
    '2026-10-02T00:00:00Z', '2026-10-04T00:00:00Z'];
  const emails = times.map((receivedAt, index) => ({ id: `qq:order:${index}`, subject: 'Synthetic', body: 'No action', receivedAt }));
  const order = [];
  const store = { emails: [], events: [], tasks: [] };
  const result = await processEmails(store, [...emails].reverse(),
    async mail => { order.push(mail.receivedAt); return []; }, 'qq',
    { mailFilters: [], enrichAttachments: false });
  assert.deepEqual(order, [...times].sort());
  assert.equal(result.skipped, emails.length);
});

test('CAS conflict replans against manual changes outside the commit transaction', async () => {
  const { state, args } = fixture();
  args.extractor = async (_mail, _settings, events) => {
    state.calls++;
    if (state.calls === 1) {
      state.store.events.push({ id: 'manual', title: 'Manual', source: 'manual', start: '2026-10-01T01:00:00+08:00', end: '2026-10-01T02:00:00+08:00' });
      state.version++;
    } else assert.equal(events[0].id, 'manual');
    return extraction;
  };
  await runMailJob(args);
  assert.equal(state.calls, 2);
  assert.equal(state.commits, 1);
  assert.equal(state.store.events[0].id, 'manual');
});

test('another writer processing the same mail during planning does not write again', async () => {
  const { state, args } = fixture();
  args.extractor = async () => {
    state.store.emails.push(mail('a'));
    state.version++;
    return extraction;
  };
  assert.equal((await runMailJob(args)).duplicate, 1);
  assert.equal(state.commits, 0);
});

test('model failure remains retryable while earlier successful mail stays committed', async () => {
  const { state, args } = fixture([mail('a'), mail('b', 2)]);
  args.extractor = async email => { if (email.id === 'b') throw new Error('synthetic model failure'); return extraction; };
  const failure = await runMailJob(args).then(() => null, error => error);
  assert.equal(failure.code, 'MAIL_PROCESSING_FAILED');
  assert.equal(failure.retryable, true);
  // The operator needs the redacted cause, not only the code: a bare MAIL_PROCESSING_FAILED
  // cannot distinguish a rejected API key from one unparseable message.
  assert.deepEqual(failure.result.errors, [{ emailId: 'b', code: 'MAIL_PROCESSING_FAILED', reason: 'synthetic model failure' }]);
  assert.match(failure.message, /synthetic model failure/);
  assert.equal(state.commits, 1);
  assert.equal(state.steps.size, 1);
  args.extractor = async () => extraction;
  assert.equal((await runMailJob(args)).duplicate, 1);
  assert.equal(state.commits, 2);
});

test('partial recruitment and staged side effects are discarded for retry', async () => {
  const { state, args } = fixture();
  args.handleSpecialEmail = async email => ({ ...email, recruitmentStatus: 'partial' });
  await assert.rejects(runMailJob(args), { code: 'MAIL_PROCESSING_FAILED' });
  assert.equal(state.commits, 0);
  assert.equal(state.store.emails.length, 0);
  args.handleSpecialEmail = async email => ({ ...email, recruitmentStatus: 'success' });
  await runMailJob(args);
  assert.equal(state.commits, 1);
});

test('已提交的邮件写入邮箱知识库一次，重放不再重复写入', async () => {
  const { state, args } = fixture([mail('b', 2), mail('a')]);
  const indexed = [];
  args.indexEmail = async (record, context) => {
    indexed.push({ id: record.id, mailboxId: context.mailboxId });
    assert.equal(context.settings, args.settings, '索引器必须拿到本次任务的设置');
    return { chunkCount: 2, skipped: false };
  };
  const first = await runMailJob(args);
  // 只索引真正提交成功的邮件，顺序与提交顺序一致
  assert.deepEqual(indexed, [{ id: 'a', mailboxId: 'box' }, { id: 'b', mailboxId: 'box' }]);
  assert.equal(first.knowledgeChunks, 4);
  assert.equal(state.commits, 2);
  const replay = await runMailJob(args);
  assert.equal(replay.duplicate, 2);
  assert.equal(replay.knowledgeChunks, 0);
  assert.equal(indexed.length, 2, '重复邮件不能再次写入知识库');
});

test('知识库写入失败不影响邮件处理结果，并留下脱敏告警', async () => {
  const { state, args } = fixture([mail('a')]);
  args.indexEmail = async () => { throw new Error('embedding endpoint rejected key sk-invented0123456789 for ops@example.invalid'); };
  const original = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  try {
    const result = await runMailJob(args);
    assert.equal(result.errors.length, 0);
    assert.equal(result.knowledgeChunks, 0);
    assert.equal(state.commits, 1, '检索是旁路能力，不能连带回滚邮件提交');
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  const logged = JSON.parse(warnings[0]);
  assert.equal(logged.event, 'knowledge_index_failed');
  assert.equal(logged.emailId, 'a');
  assert.equal(logged.mailboxId, 'box');
  assert.ok(logged.error, '必须留下可排查原因');
  assert.ok(!logged.error.includes('sk-invented0123456789'), '密钥不能写进日志');
  assert.ok(!logged.error.includes('ops@example.invalid'), '地址不能写进日志');
});

test('lease revocation and abort after a model response prevent late writes', async () => {
  for (const abort of [false, true]) {
    const { state, args } = fixture();
    const controller = new AbortController();
    args.signal = controller.signal;
    args.extractor = async () => {
      if (abort) controller.abort(new Error('stopped')); else state.active = false;
      return extraction;
    };
    await assert.rejects(runMailJob(args), abort ? /stopped/ : { code: 'JOB_LEASE_LOST' });
    assert.equal(state.commits, 0);
    assert.equal(state.steps.size, 0);
  }
});

test('bounded CAS retries fail without checkpointing stale results', async () => {
  const { state, args } = fixture();
  args.extractor = async () => { state.calls++; state.version++; return extraction; };
  await assert.rejects(runMailJob(args), { code: 'MAIL_SNAPSHOT_CONFLICT' });
  assert.equal(state.calls, 3);
  assert.equal(state.commits, 0);
});

test('lease lost after staged business write rolls back both data and checkpoint', async () => {
  const { state, args } = fixture();
  const commit = args.storage.commit;
  args.storage.commit = async input => { await commit(input); state.active = false; };
  await assert.rejects(runMailJob(args), { code: 'JOB_LEASE_LOST' });
  assert.equal(state.store.emails.length, 0);
  assert.equal(state.steps.size, 0);
  assert.equal(state.commits, 0);
});

test('scope mismatch fails before fetching mail', async () => {
  const { args } = fixture();
  args.settings = { ...settings, activeMailboxId: 'someone-else' };
  args.readEmails = () => assert.fail('must not fetch');
  await assert.rejects(runMailJob(args), /scope/);
});

test('scoped IMAP identities preserve legacy IDs and distinguish UIDVALIDITY and owners', () => {
  const config = { ...settings, id: 'default' };
  const options = { uidValidity: 123n, uid: 7, scope: 'tenant/owner/box' };
  const legacy = 'qq:synthetic@example.invalid:123:7';
  assert.equal(mailboxMessageIdentity(config, { ...options, scope: undefined }), legacy);
  assert.equal(mailboxMessageIdentity(config, { ...options, processedIds: new Set([legacy]) }), legacy);
  const scoped = mailboxMessageIdentity(config, options);
  assert.notEqual(scoped, legacy);
  assert.notEqual(mailboxMessageIdentity(config, { ...options, uidValidity: 124n, processedIds: new Set([legacy]) }), legacy);
  assert.notEqual(mailboxMessageIdentity(config, { ...options, scope: 'other-owner' }), scoped);
  assert.equal(mailboxMessageIdentity({ ...config, id: 'migrated' }, { ...options, processedIds: new Set([legacy]) }), legacy);
});

test('IMAP migration skips legacy source downloads using synthetic metadata only', async () => {
  const legacy = 'qq:synthetic@example.invalid:123:7';
  const client = { mailbox: { exists: 1, uidValidity: 123n }, connect: async () => {},
    getMailboxLock: async () => ({ release() {} }), logout: async () => {}, close() {},
    async *fetch(_range, query) {
      assert.equal(query.source, undefined);
      yield { uid: 7, internalDate: new Date('2026-10-01T00:00:00Z') };
    } };
  const result = await readMailboxEmails({ ...settings, id: 'default' }, {
    identityScope: 'tenant/owner/box', processedIds: new Set([legacy]), clientFactory: () => client,
  });
  assert.equal(result[0].id, legacy);
  assert.equal(result[0].body, undefined);
});
