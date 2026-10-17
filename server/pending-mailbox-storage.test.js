import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { pendingMailboxId } from './mailbox-identity.js';
import { readSettings, readStore, saveSettings, saveStore } from './store.js';
import { readRecruitment } from './recruitment-store.js';
import { withStorageCommit, withStorageSnapshot, readSnapshotDocument, settingsKey, STORAGE_SCHEMA } from './storage/index.js';
import { productionStorageMiddleware } from './production-api.js';

process.env.DAYLIGHT_RUNTIME = 'production';
const url = process.env.DAYLIGHT_STORAGE_TEST_URL;
const integration = url ? test : test.skip;
const owner = '12345678-90ab-cdef-1234-567890abcdef';
const user = { id: owner, email: 'new-account@example.invalid' };
const pending = pendingMailboxId(owner);
const historical = 'mb-1234567890';
const schema = `pending_mailbox_${randomUUID().replaceAll('-', '')}`;
const empty = () => ({ events: [], emails: [], tasks: [], lastSync: null });
const settings = () => ({ activeMailboxId: 'default', model: 'fixture-model', mailboxes: [
  { id: 'default', email: 'legacy@example.invalid' },
  { id: 'unassigned', email: 'unassigned@example.invalid' },
  { id: 'b', ownerUserId: 'bob', email: 'bob@example.invalid' },
] });
let admin, pool;
const options = () => ({ pool, userId: owner, user });
const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE ${table === 'app_settings' ? 'id' : 'mailbox_id'}=$1`, [id])).rows[0];
async function reset() {
  await pool.query('TRUNCATE app_settings, mailbox_calendars, rag_chunks');
  await pool.query('INSERT INTO app_settings (id,payload,updated_at) VALUES ($1,$2,now())', ['default', settings()]);
  await pool.query('INSERT INTO mailbox_calendars (mailbox_id,payload,updated_at) VALUES ($1,$2,now()), ($3,$4,now())',
    [historical, { events: [{ id: 'orphan-private' }] }, 'b', { events: [{ id: 'bob-private' }] }]);
}
before(async () => {
  if (!url) return;
  admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE app_settings (id text primary key,payload jsonb not null,updated_at timestamptz not null);
    CREATE TABLE mailbox_calendars (mailbox_id text primary key,payload jsonb not null,updated_at timestamptz not null);
    CREATE TABLE rag_chunks (mailbox_id text not null);`);
  await pool.query(STORAGE_SCHEMA);
});
after(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test('pending profile IDs include the whole owner identity rather than a short shared prefix', () => {
  assert.notEqual(pending, historical);
  assert.notEqual(pending, pendingMailboxId('12345678-90ab-cdef-1234-567890abcdef-other'));
});

integration('real PG: account without a saved mailbox opens empty state without reading or adopting orphan and other-owner data', async () => {
  await reset();
  await withStorageCommit(options(), () => {
    assert.equal(readSettings().activeMailboxId, pending);
    assert.deepEqual(readSettings().mailboxes.map(box => [box.id, box.pendingSetup]), [[pending, true]]);
    assert.deepEqual(readStore(), empty());
    assert.deepEqual(readRecruitment(pending).attachments, []);
    assert.deepEqual(readSnapshotDocument(settingsKey(`traces:${pending}`)), []);
    for (const id of [historical, 'default', 'unassigned', 'b']) {
      assert.throws(() => readStore(id), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
    }
    assert.throws(() => saveStore({ events: [{ id: 'not-registered' }] }), { code: 'MAILBOX_SETUP_REQUIRED', status: 400 });
  });
  assert.equal(await row('mailbox_calendars', pending), undefined);
  assert.deepEqual((await row('app_settings', 'default')).payload, settings());
  assert.equal((await row('mailbox_calendars', historical)).payload.events[0].id, 'orphan-private');
  for (const id of [historical, 'default', 'unassigned', 'b']) {
    await assert.rejects(withStorageSnapshot({ ...options(), mailboxId: id }, () => {}), { status: 403 });
  }
});

integration('real PG HTTP: initial state and explicit mailbox save succeed, then new calendar data persists across snapshots', async t => {
  await reset();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(productionStorageMiddleware({ pool }));
  app.get('/state', (req, res) => res.json({ settings: readSettings(), calendar: readStore() }));
  app.put('/settings', (req, res) => {
    const current = readSettings();
    saveSettings({ ...current, mailboxes: current.mailboxes.map(box => ({ ...box, email: req.body.email })) },
      { registerMailboxIds: [current.activeMailboxId] });
    saveStore({ ...readStore(), tasks: [{ id: 'first-task' }] });
    res.json({ settings: readSettings(), calendar: readStore() });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${address}/state`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).calendar, empty());
  response = await fetch(`${address}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.mailboxes[0].pendingSetup, undefined);
  response = await fetch(`${address}/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).calendar.tasks[0].id, 'first-task');
  const saved = (await row('app_settings', 'default')).payload;
  assert.equal(saved.mailboxes.find(box => box.id === pending).ownerUserId, owner);
  assert.equal(saved.mailboxes.filter(box => !box.ownerUserId).length, 2);
  assert.equal(saved.mailboxes.some(box => box.id === historical), false);
  assert.equal((await row('mailbox_calendars', historical)).payload.events[0].id, 'orphan-private');
});

integration('real PG: model preferences do not silently register a pending profile', async () => {
  await reset();
  await withStorageCommit(options(), () => saveSettings({ ...readSettings(), model: 'personal-model' }));
  const saved = (await row('app_settings', 'default')).payload;
  assert.equal(saved.userPrefs[owner].model, 'personal-model');
  assert.equal(saved.mailboxes.some(box => box.ownerUserId === owner), false);
  assert.equal(await row('mailbox_calendars', pending), undefined);
});

integration('real PG: existing empty calendars and private auxiliary namespaces conflict instead of being claimed', async () => {
  const localIdentity = createHash('sha256').update(`local\0${pending}`).digest('hex');
  for (const collision of [
    ['mailbox_calendars', pending, empty()],
    ['app_settings', `traces:${pending}`, [{ id: 'private-trace' }]],
    ['app_settings', `assistant-meetings:${pending}`, { operations: [{ id: 'private-meeting' }] }],
    ['app_settings', `assistant:requests:${localIdentity}`, { items: [{ id: 'private-request' }] }],
  ]) {
    await reset();
    const [table, id, payload] = collision;
    await pool.query(`INSERT INTO ${table} (${table === 'app_settings' ? 'id' : 'mailbox_id'},payload,updated_at) VALUES ($1,$2,now())`, [id, JSON.stringify(payload)]);
    // Even an exact pending-ID collision cannot make a read-only page fail or expose data.
    await withStorageCommit(options(), () => assert.deepEqual(readStore(), empty()));
    await assert.rejects(withStorageCommit(options(), () => {
      const current = readSettings();
      saveSettings(current, { registerMailboxIds: [current.activeMailboxId] });
    }), { code: 'STORAGE_VERSION_CONFLICT', status: 409 });
    assert.deepEqual((await row(table, id)).payload, payload);
    assert.deepEqual((await row('app_settings', 'default')).payload, settings());
  }
});

integration('real PG: guessed unassigned IDs and orphan calendar IDs never gain current-user ownership', async () => {
  await reset();
  for (const id of ['default', 'unassigned', 'b']) {
    await assert.rejects(withStorageCommit(options(), () => {
      saveSettings({ ...readSettings(), mailboxes: [{ id, email: user.email }] });
    }), { status: 403 });
  }
  await assert.rejects(withStorageCommit(options(), () => {
    saveSettings({ ...readSettings(), activeMailboxId: historical, mailboxes: [{ id: historical, email: user.email }] });
  }), { code: 'STORAGE_VERSION_CONFLICT', status: 409 });
  assert.deepEqual((await row('app_settings', 'default')).payload, settings());
  assert.equal((await row('mailbox_calendars', historical)).payload.events[0].id, 'orphan-private');
});

integration('real PG: two concurrent first mailbox registrations have one winner and one atomic conflict', async () => {
  await reset();
  let ready = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const register = label => withStorageCommit(options(), async () => {
    const current = readSettings();
    saveSettings({ ...current, mailboxes: current.mailboxes.map(box => ({ ...box, email: `${label}@example.invalid` })) },
      { registerMailboxIds: [current.activeMailboxId] });
    if (++ready === 2) release();
    await gate;
  });
  const results = await Promise.allSettled([register('one'), register('two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const saved = (await row('app_settings', 'default')).payload;
  assert.equal(saved.mailboxes.filter(box => box.ownerUserId === owner).length, 1);
  assert.deepEqual((await row('mailbox_calendars', pending)).payload, empty());
});

integration('real PG: a concurrent RAG writer blocks registration and its existing chunks remain unclaimed', async () => {
  await reset();
  const client = await pool.connect();
  let entered;
  const entering = new Promise(resolve => { entered = resolve; });
  let registering;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`daylight:mailbox-registration:${pending}`]);
    registering = withStorageCommit({ ...options(), beforeCommit: () => entered() }, () => {
      const current = readSettings();
      saveSettings(current, { registerMailboxIds: [current.activeMailboxId] });
    });
    // Attach the rejection observer before releasing the competing transaction.
    const rejected = assert.rejects(registering, { status: 409 });
    await entering;
    await client.query('INSERT INTO rag_chunks (mailbox_id) VALUES ($1)', [pending]);
    await client.query('COMMIT');
    await rejected;
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  assert.deepEqual((await row('app_settings', 'default')).payload, settings());
  assert.equal((await pool.query('SELECT count(*) FROM rag_chunks WHERE mailbox_id=$1', [pending])).rows[0].count, '1');
});

integration('real PG: an existing owner can configure an additional mailbox and use its empty documents immediately', async () => {
  await reset();
  const newId = randomUUID();
  await withStorageCommit({ pool, userId: 'bob' }, () => {
    const current = readSettings();
    saveSettings({ ...current, activeMailboxId: newId, mailboxes: [...current.mailboxes, { id: newId, email: 'second@example.invalid' }] });
    assert.deepEqual(readStore(), empty());
    assert.deepEqual(readRecruitment(newId).attachments, []);
    saveStore({ ...readStore(), tasks: [{ id: 'second-box-task' }] });
  });
  assert.equal((await row('mailbox_calendars', newId)).payload.tasks[0].id, 'second-box-task');
  assert.equal((await row('app_settings', 'default')).payload.mailboxes.find(box => box.id === newId).ownerUserId, 'bob');
});

integration('real PG: first setup with a different email registers only the selected profile', async () => {
  await reset();
  const newId = randomUUID();
  await withStorageCommit(options(), () => {
    const current = readSettings();
    saveSettings({ ...current, activeMailboxId: newId,
      mailboxes: [...current.mailboxes, { id: newId, email: 'different-address@example.invalid' }] },
    { registerMailboxIds: [newId] });
    assert.equal(readSettings().activeMailboxId, newId);
    assert.deepEqual(readSettings().mailboxes.map(box => box.id), [newId]);
    assert.deepEqual(readStore(), empty());
  });
  const saved = (await row('app_settings', 'default')).payload;
  assert.equal(saved.mailboxes.filter(box => box.ownerUserId === owner).length, 1);
  assert.equal(await row('mailbox_calendars', pending), undefined);
});
