import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/pending-mailbox-access-'));
Object.assign(process.env, {
  DAYLIGHT_DATA_DIR: directory, DAYLIGHT_RUNTIME: 'production',
  DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/daylight',
  DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
  DAYLIGHT_JWT_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic',
  DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const { default: pg } = await import('pg');
const { initPostgres, closePostgres } = await import('./infra/postgres.js');
const { withStorageSnapshot, readSnapshotDocument, settingsKey } = await import('./storage/index.js');
const { readSettings, readStore } = await import('./store.js');
const { pendingMailboxId } = await import('./mailbox-identity.js');
const { readAssistantState, mutateAssistantState, assistantMailbox } = await import('./assistant-state.js');
const { listAssistantDrafts } = await import('./assistant-actions.js');
const { createAssistantMeeting } = await import('./assistant-meetings.js');
const { readAssistantMeetingOperations, withAssistantMeetingMailboxLock } = await import('./assistant-meetings-store.js');
const { runAssistantRequest } = await import('./assistant-requests.js');
const { listChunks, replaceChunks, deleteChunksByAttachment, reassignCandidate } = await import('./rag/store.js');

const owner = 'synthetic-owner';
const hash = value => createHash('sha256').update(value).digest('hex');
const pending = pendingMailboxId(owner);

async function database(t, settings) {
  const statements = [], documents = new Map([['default', settings]]), chunks = [];
  const query = async (sql, values = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    statements.push({ sql: normalized, values });
    if (normalized.startsWith('select payload')) return { rows: documents.has(values[0]) ? [{ payload: structuredClone(documents.get(values[0])), version: 1 }] : [] };
    if (normalized.startsWith('select version')) return { rows: documents.has(values[0]) ? [{ version: 1 }] : [] };
    if (normalized.startsWith('insert into app_settings')) documents.set(values[0], JSON.parse(values[1]));
    if (normalized.startsWith('update app_settings')) documents.set(values[0], JSON.parse(values[1]));
    if (normalized.startsWith('select * from rag_chunks')) return { rows: chunks.filter(chunk => chunk.mailbox_id === values[0]
      && (!normalized.includes('attachment_id = $2') || chunk.attachment_id === values[1])) };
    return { rows: [] };
  };
  t.mock.method(pg, 'Pool', function Pool() {
    this.query = query; this.on = () => {}; this.end = async () => {};
    this.connect = async () => ({ query, release() {} });
  });
  assert.equal((await initPostgres()).mode, 'postgres');
  t.after(closePostgres);
  return { statements, documents, chunks };
}

const scope = { userId: owner, user: { id: owner, email: 'synthetic@example.invalid' } };

test('pending mailbox assistant and RAG reads return empty without loading colliding orphan records', async t => {
  const state = await database(t, { mailboxes: [{ id: 'foreign', ownerUserId: 'other-owner' }] });
  const collidingIds = new Set([pending, `external-sync:${pending}`, `traces:${pending}`, `recruitment:${pending}`,
    `assistant-meetings:${pending}`]);
  state.documents.set(pending, { events: [{ id: 'orphan-private-event' }], emails: [], tasks: [], lastSync: null });
  state.documents.set(`external-sync:${pending}`, { intents: [{ id: 'orphan-private-intent' }], targets: {} });
  state.documents.set(`traces:${pending}`, [{ id: 'orphan-private-trace' }]);
  state.documents.set(`recruitment:${pending}`, { candidates: [{ id: 'orphan-private-candidate' }] });
  for (const namespace of ['drafts', 'requests', 'recruitment-effects']) {
    const id = `assistant:${namespace}:${hash(`${owner}\0${pending}`)}`;
    collidingIds.add(id);
    state.documents.set(id, { schemaVersion: 1, items: [{ id: 'orphan-private-record' }] });
  }
  state.documents.set(`assistant-meetings:${pending}`, { schemaVersion: 1, operations: [{ id: 'orphan-private-meeting' }] });
  state.chunks.push({ id: 'orphan-private-chunk', mailbox_id: pending, attachment_id: 'orphan-pdf', content: 'synthetic private source' });
  await withStorageSnapshot(scope, async () => {
    const settings = readSettings();
    assert.equal(settings.activeMailboxId, pending);
    assert.equal(settings.mailboxes.length, 1);
    assert.equal(settings.mailboxes[0].pendingSetup, true, 'snapshot synthesizes the unregistered profile');
    assert.ok(state.statements.every(statement => statement.values.every(value => !collidingIds.has(value))),
      'snapshot does not query any colliding pending calendar or auxiliary namespace');
    state.statements.length = 0;
    assert.deepEqual(readStore(pending), { events: [], emails: [], tasks: [], lastSync: null });
    assert.deepEqual(readSnapshotDocument(settingsKey(`external-sync:${pending}`)), { intents: [], targets: {} });
    assert.deepEqual(readSnapshotDocument(settingsKey(`traces:${pending}`)), []);
    assert.deepEqual(readSnapshotDocument(settingsKey(`recruitment:${pending}`)),
      { candidates: [], attachments: [], messages: [], interviews: [], traces: [] });
    for (const namespace of ['drafts', 'requests', 'recruitment-effects', 'meetings']) {
      assert.deepEqual(await readAssistantState(pending, namespace), { schemaVersion: 1, items: [] });
    }
    assert.deepEqual(await listAssistantDrafts(pending), { drafts: [] });
    assert.deepEqual((await readAssistantMeetingOperations(pending)).operations, []);
    assert.deepEqual(await listChunks(pending), []);
    assert.equal(state.statements.length, 0, 'pending access never queries archived operations or RAG');
  });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('pending mailbox mutations fail before PG, business callback, model or external meeting execution', async t => {
  const state = await database(t, { mailboxes: [{ id: 'foreign', ownerUserId: 'other-owner' }] });
  let executed = 0;
  const forbidden = () => { executed++; assert.fail('unregistered mailbox must not execute'); };
  await withStorageSnapshot({ ...scope, mailboxId: pending }, async () => {
    state.statements.length = 0;
    for (const namespace of ['drafts', 'requests', 'recruitment-effects', 'meetings']) {
      await assert.rejects(mutateAssistantState(pending, namespace, forbidden), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    }
    await assert.rejects(runAssistantRequest({ requestId: 'synthetic-pending-request', messages: [{ role: 'user', content: 'synthetic' }] }, forbidden),
      { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    await assert.rejects(createAssistantMeeting(pending, {}, readSettings(), { prepareMeeting: forbidden, withMailboxLock: forbidden }),
      { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    await assert.rejects(withAssistantMeetingMailboxLock(pending, forbidden), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    await assert.rejects(replaceChunks(pending, 'attachment', []), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    await assert.rejects(deleteChunksByAttachment(pending, 'attachment'), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    await assert.rejects(reassignCandidate(pending, 'attachment', 'candidate'), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
    assert.equal(executed, 0);
    assert.equal(state.statements.length, 0);
  });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('registered owner retains assistant/RAG access and RAG writers lock mailbox registration before attachment mutation', async t => {
  const mailbox = 'registered-mailbox';
  const state = await database(t, { mailboxes: [{ id: mailbox, ownerUserId: owner }, { id: 'foreign', ownerUserId: 'other-owner' }] });
  state.chunks.push({ id: 'owned-chunk', mailbox_id: mailbox, attachment_id: 'pdf', owner_user_id: owner,
    content: 'synthetic own content', page: 1, chunk_index: 0, embedding: null });
  await withStorageSnapshot(scope, async () => {
    await mutateAssistantState(mailbox, 'requests', data => data.items.push({ id: 'own-request' }));
    assert.equal((await readAssistantState(mailbox, 'requests')).items[0].id, 'own-request');
    assert.equal((await listChunks(mailbox))[0].id, 'owned-chunk');
    state.statements.length = 0;
    await replaceChunks(mailbox, 'pdf', []);
    const locks = state.statements.filter(statement => statement.sql.startsWith('select pg_advisory_xact_lock'));
    assert.equal(locks[0].values[0], `daylight:mailbox-registration:${mailbox}`);
    assert.ok(locks[0].sql.startsWith('select pg_advisory_xact_lock_shared'));
    assert.equal(locks[1].values[0], JSON.stringify(['rag', mailbox, 'pdf']));
    assert.ok(state.statements.findIndex(statement => statement.sql.startsWith('delete from rag_chunks'))
      > state.statements.findIndex(statement => statement === locks[1]));
    await assert.rejects(readAssistantState('foreign', 'requests'), { status: 404 });
    await assert.rejects(listChunks('foreign'), { status: 403, code: 'STORAGE_MAILBOX_FORBIDDEN' });
    assert.throws(() => assistantMailbox('foreign', { mailboxes: [{ id: 'foreign', ownerUserId: 'other-owner' }] }), { status: 404 });
    await assert.rejects(createAssistantMeeting('foreign', {}, { mailboxes: [{ id: 'foreign', ownerUserId: 'other-owner' }] }), { status: 404 });
  });
});
