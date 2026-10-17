import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-storage-'));
process.env.DAYLIGHT_DATA_DIR = directory;
process.env.DAYLIGHT_RUNTIME = 'production';
const { readStore, saveStore, readSettings, saveSettings, readCalendarSync, saveCalendarSync, hydrateStoreFromPostgres } = await import('./store.js');
const { withStorageSnapshot, withStorageCommit, commitStorage, discardStorage, readSnapshotDocument, stageSnapshotDocument, settingsKey, STORAGE_SCHEMA } = await import('./storage/index.js');
const { mutateScenarioData, readScenarioData } = await import('./scenarios/repository.js');
const { runWithRequestContext } = await import('./request-context.js');
const { readTraces, saveTraces } = await import('./traces.js');
const url = process.env.DAYLIGHT_STORAGE_TEST_URL;
const integration = url ? test : test.skip;
let admin, pool;
const schema = `storage_test_${randomUUID().replaceAll('-', '')}`;
const settings = () => ({ mailboxes: [{ id: 'a', ownerUserId: 'alice', email: 'alice@example.invalid' }, { id: 'b', ownerUserId: 'bob' }], userPrefs: { alice: { activeMailboxId: 'a' } } });
const options = () => ({ pool, userId: 'alice' });
async function document(table, id) {
  const column = table === 'app_settings' ? 'id' : 'mailbox_id';
  return (await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [id])).rows[0];
}
async function reset() {
  await pool.query('TRUNCATE app_settings, mailbox_calendars');
  await pool.query('INSERT INTO app_settings (id,payload,updated_at) VALUES ($1,$2,now())', ['default', settings()]);
}
before(async () => {
  if (!url) return;
  admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE app_settings (id text primary key,payload jsonb not null,updated_at timestamptz not null,
    CHECK (NOT (payload ? 'rejectCommit')));
    CREATE TABLE mailbox_calendars (mailbox_id text primary key,payload jsonb not null,updated_at timestamptz not null);`);
  await pool.query(STORAGE_SCHEMA);
  await pool.query(STORAGE_SCHEMA);
});
after(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('production never reads, imports or saves files without a snapshot', async () => {
  fs.writeFileSync(path.join(directory, 'settings.json'), '{broken local cache');
  assert.throws(readSettings, { code: 'STORAGE_SNAPSHOT_REQUIRED' });
  assert.throws(() => saveStore({}, 'a'), { code: 'STORAGE_SNAPSHOT_REQUIRED' });
  assert.equal((await hydrateStoreFromPostgres()).reason, 'explicit-migration-required');
});

integration('real PG: stage scenario and calendar, commit atomically, release connections before application work', async () => {
  await reset();
  await withStorageSnapshot(options(), async () => {
    assert.equal(pool.idleCount, pool.totalCount);
    assert.equal(readSettings().activeMailboxId, 'a');
    assert.deepEqual(readSettings().mailboxes.map(box => box.id), ['a']);
    assert.equal(readStore().events.length, 0); // missing calendar is empty, never demo/file imported
    const copy = readStore(); copy.events.push({ id: 'not-saved' });
    assert.equal(readStore().events.length, 0);
    await mutateScenarioData(data => {
      const calendar = readStore(); calendar.events.push({ id: 'event' }); saveStore(calendar);
      data.executions.push({ eventId: 'event' });
    });
    assert.equal(await document('mailbox_calendars', 'a'), undefined);
    assert.equal(await document('app_settings', 'scenarios:alice'), undefined);
    assert.equal((await readScenarioData()).executions.length, 1);
    assert.deepEqual(await commitStorage(), { committed: 2 });
    assert.deepEqual(await commitStorage(), { committed: 0 });
    const calendar = readStore(); calendar.tasks.push({ id: 'task' }); saveStore(calendar);
    await commitStorage();
  });
  assert.equal((await document('mailbox_calendars', 'a')).version, '2');
  assert.equal((await document('app_settings', 'scenarios:alice')).payload.executions[0].eventId, 'event');
});

integration('real PG: two concurrent first writers cannot overwrite each other; loser is 409', async () => {
  await reset();
  let ready = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = id => withStorageCommit(options(), async () => {
    const calendar = readStore(); calendar.events.push({ id }); saveStore(calendar);
    if (++ready === 2) release();
    await gate;
  });
  const results = await Promise.allSettled([write('first'), write('second')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const error = results.find(row => row.status === 'rejected').reason;
  assert.equal(error.status, 409);
  assert.equal(error.code, 'STORAGE_VERSION_CONFLICT');
  assert.equal((await document('mailbox_calendars', 'a')).payload.events.length, 1);
});

integration('real PG: existing-row CAS and scenario conflict roll back a prior calendar update', async () => {
  await reset();
  await withStorageCommit(options(), async () => { saveStore(readStore()); await mutateScenarioData(() => {}); });
  await assert.rejects(withStorageCommit(options(), async () => {
    await mutateScenarioData(data => {
      const calendar = readStore(); calendar.events.push({ id: 'rolled-back' }); saveStore(calendar);
      data.history.push({ id: 'loser' });
    });
    await withOtherSnapshot();
  }), { status: 409 });
  async function withOtherSnapshot() {
    // Simulate another process committing after this snapshot was loaded.
    await pool.query("UPDATE app_settings SET version=version+1 WHERE id='scenarios:alice'");
  }
  assert.equal((await document('mailbox_calendars', 'a')).payload.events.length, 0);
});

integration('real PG: SQL failure rolls back all documents and fencing/checkpoint SQL', async () => {
  await reset();
  await assert.rejects(withStorageCommit({ ...options(), beforeCommit: client => client.query("INSERT INTO app_settings VALUES ('checkpoint', '{}', now(), 1)") }, async () => {
    await mutateScenarioData(data => { data.rejectCommit = true; saveStore({ events: [{ id: 'bad' }] }); });
  }), { code: '23514' });
  assert.equal(await document('mailbox_calendars', 'a'), undefined);
  assert.equal(await document('app_settings', 'checkpoint'), undefined);
});

integration('real PG: callback exception restores staged calendars; async continuations cannot leak writes', async () => {
  await reset();
  await withStorageCommit(options(), async () => {
    await assert.rejects(mutateScenarioData(() => { saveStore({ events: [{ id: 'bad' }] }); throw new Error('stop'); }), /stop/);
    assert.equal(readStore().events.length, 0);
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    let continuation;
    await assert.rejects(mutateScenarioData(() => {
      continuation = (async () => { await gate; saveStore({ events: [{ id: 'late' }] }); })();
      return continuation;
    }), { code: 'STORAGE_ASYNC_MUTATOR' });
    resume();
    await assert.rejects(continuation, { code: 'STORAGE_SNAPSHOT_REQUIRED' });
    assert.equal(readStore().events.length, 0);
  });
  assert.equal(await document('mailbox_calendars', 'a'), undefined);
});

integration('real PG: uncommitted work, wrong mailbox, identity changes and missing settings fail closed', async () => {
  await reset();
  await assert.rejects(withStorageSnapshot(options(), async () => { saveStore(readStore()); }), { code: 'STORAGE_UNCOMMITTED' });
  assert.equal(await document('mailbox_calendars', 'a'), undefined);
  await assert.rejects(withStorageSnapshot({ ...options(), mailboxIds: ['b'] }, () => {}), { status: 403 });
  await withStorageSnapshot(options(), () => {
    assert.throws(() => readStore('b'), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
    runWithRequestContext({ userId: 'bob' }, () => assert.throws(readSettings, { status: 403 }));
    assert.throws(() => saveSettings({ ...readSettings(), mailboxes: [{ id: 'b' }] }), { status: 403 });
  });
  await pool.query('TRUNCATE app_settings');
  await assert.rejects(withStorageSnapshot(options(), () => {}), { code: 'STORAGE_SETTINGS_MISSING' });
});

integration('real PG: settings and calendarSync stage together; stale ownership/config blocks calendar commit', async () => {
  await reset();
  await withStorageCommit(options(), () => {
    saveSettings({ ...readSettings(), model: 'new-model' });
    saveCalendarSync({ connections: [{ id: 'connection' }] });
    assert.equal(readCalendarSync().connections[0].id, 'connection');
  });
  assert.equal((await document('app_settings', 'default')).payload.userPrefs.alice.model, 'new-model');
  assert.equal((await document('app_settings', 'default')).payload.mailboxes.length, 2);
  await assert.rejects(withStorageCommit(options(), async () => {
    saveStore(readStore());
    await pool.query("UPDATE app_settings SET version=version+1 WHERE id='default'");
  }), { status: 409 });
  assert.equal(await document('mailbox_calendars', 'a'), undefined);
});

integration('real PG: generic documents, discard and final lease check roll back correctly', async () => {
  await reset();
  const generic = { ...options(), documents: [{ id: 'custom-prompts', initial: { text: 'initial' } }] };
  await withStorageSnapshot(generic, () => {
    assert.equal(readSnapshotDocument(settingsKey('custom-prompts')).text, 'initial');
    stageSnapshotDocument(settingsKey('prompts'), { text: 'discarded' });
    discardStorage();
    assert.throws(readSettings, { code: 'STORAGE_SNAPSHOT_REQUIRED' });
  });
  assert.equal(await document('app_settings', 'prompts'), undefined);
  await assert.rejects(withStorageCommit({ ...generic, afterWrite: async client => {
    assert.equal((await client.query("SELECT payload FROM app_settings WHERE id='prompts'")).rows[0].payload.text, 'written');
    throw Object.assign(new Error('lease expired'), { code: 'LEASE_EXPIRED' });
  } }, () => stageSnapshotDocument(settingsKey('prompts'), { text: 'written' })), { code: 'LEASE_EXPIRED' });
  assert.equal(await document('app_settings', 'prompts'), undefined);
});

integration('real PG: unchanged source calendars and scenarios are validated, including absent inputs', async () => {
  await reset();
  await withStorageCommit(options(), () => saveStore(readStore()));
  for (const source of ['calendar', 'scenario']) {
    await assert.rejects(withStorageCommit({ ...options(), documents: ['prompts'] }, async () => {
      readStore(); await readScenarioData();
      stageSnapshotDocument(settingsKey('prompts'), { source });
      if (source === 'calendar') await pool.query("UPDATE mailbox_calendars SET version=version+1 WHERE mailbox_id='a'");
      else await pool.query("INSERT INTO app_settings VALUES ('scenarios:alice','{}',now(),1)");
    }), { status: 409 });
    assert.equal(await document('app_settings', 'prompts'), undefined);
  }
});

integration('real PG: cross-mailbox write skew conflicts without lock upgrades or deadlock', async () => {
  await reset();
  await pool.query("UPDATE app_settings SET payload=jsonb_set(payload,'{mailboxes}', $1::jsonb)", [JSON.stringify([{ id: 'a', ownerUserId: 'alice' }, { id: 'c', ownerUserId: 'alice' }])]);
  await withStorageCommit(options(), () => { saveStore(readStore('a'), 'a'); saveStore(readStore('c'), 'c'); });
  let ready = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = id => withStorageCommit(options(), async () => {
    assert.equal(readStore(id === 'a' ? 'c' : 'a').events.length, 0);
    saveStore({ events: [{ id }] }, id);
    if (++ready === 2) release();
    await gate;
  });
  const results = await Promise.allSettled([write('a'), write('c')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
});

integration('real PG: mail adapter stages auxiliary metadata and joins checkpoint rollback without transaction ownership', async () => {
  await reset();
  const { createMailJobStorage } = await import('./storage/mail-job.js');
  const adapter = createMailJobStorage({ pool });
  const job = { owner_id: 'alice', mailbox_id: 'a', tenant_id: 'tenant' };
  const snapshot = await adapter.load({ job });
  await adapter.runSnapshot(snapshot, () => {
    assert.equal(readSettings().activeMailboxId, 'a');
    assert.deepEqual(readSnapshotDocument(settingsKey('traces:a')), []);
    stageSnapshotDocument(settingsKey('recruitment:a'), { candidates: [{ id: 'candidate' }] });
    snapshot.store.events.push({ id: 'mail-event' });
  });
  assert.equal(await document('mailbox_calendars', 'a'), undefined);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const statements = [];
    const borrowed = { query(sql, values) { statements.push(sql); return client.query(sql, values); }, release() { assert.fail('must not release checkpoint client'); } };
    await adapter.commit({ client: borrowed, job, snapshot, expectedVersion: snapshot.version });
    assert.equal(statements.some(sql => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)), false);
    assert.equal((await client.query("SELECT payload FROM mailbox_calendars WHERE mailbox_id='a'")).rows[0].payload.events[0].id, 'mail-event');
    await client.query('ROLLBACK');
    assert.equal(await document('mailbox_calendars', 'a'), undefined);
    assert.equal(await document('app_settings', 'recruitment:a'), undefined);
    await assert.rejects(adapter.runSnapshot(snapshot, () => {}), { code: 'STORAGE_SNAPSHOT_REQUIRED' });
  } finally { client.release(); }
  const fresh = await adapter.load({ job });
  await adapter.runSnapshot(fresh, () => fresh.store.events.push({ id: 'retry' }));
  await pool.query("UPDATE app_settings SET version=version+1 WHERE id='default'");
  const conflictClient = await pool.connect();
  try {
    await conflictClient.query('BEGIN');
    await assert.rejects(adapter.commit({ client: conflictClient, job, snapshot: fresh, expectedVersion: fresh.version }), { code: 'MAIL_SNAPSHOT_CONFLICT', status: 409 });
    await conflictClient.query('ROLLBACK');
  } finally { conflictClient.release(); }
});

integration('real PG: worker explicit mailbox overrides preference and rejects another owner', async () => {
  await reset();
  await pool.query("UPDATE app_settings SET payload=jsonb_set(payload,'{mailboxes}', $1::jsonb)", [JSON.stringify([{ id: 'a', ownerUserId: 'alice' }, { id: 'c', ownerUserId: 'alice' }, { id: 'b', ownerUserId: 'bob' }])]);
  await withStorageSnapshot({ ...options(), context: { mailboxId: 'c' } }, () => {
    assert.equal(readSettings().activeMailboxId, 'c');
    assert.deepEqual(readSnapshotDocument(settingsKey('traces:c')), []);
  });
  await assert.rejects(withStorageSnapshot({ ...options(), mailboxId: 'b' }, () => {}), { status: 403 });
});

integration('real PG: implicit trace storage uses the owner mailbox and persists independently across snapshots', async () => {
  await reset();
  await withStorageCommit(options(), () => {
    assert.deepEqual(readTraces(), []);
    saveTraces([{ trace_id: 'owner-trace' }]);
  });
  assert.deepEqual((await document('app_settings', 'traces:a')).payload, [{ trace_id: 'owner-trace' }]);
  assert.equal(await document('app_settings', 'traces:undefined'), undefined);
  await withStorageSnapshot(options(), () => {
    assert.deepEqual(readTraces(), [{ trace_id: 'owner-trace' }]);
  });
  await withStorageSnapshot({ pool, userId: 'bob' }, () => {
    assert.deepEqual(readTraces(), []);
    assert.throws(() => readTraces('a'), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
  });
});

integration('real PG: development standalone scenarios preserve PG authority across process restart and commit calendar atomically', async () => {
  await reset();
  await pool.query("INSERT INTO app_settings VALUES ('scenarios:alice', $1, now(), 1)", [{ history: [{ id: 'legacy-pg' }] }]);
  const { createHash } = await import('node:crypto');
  const scenarioDir = path.join(directory, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioDir, `${createHash('sha256').update('alice').digest('hex')}.json`), '{broken stale cache');
  const connection = new URL(url);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: true, connectionString: connection.toString() } }));
  const script = `
    import assert from 'node:assert/strict';
    import { initPostgres, closePostgres, getPostgresPool } from './server/infra/postgres.js';
    import { runWithRequestContext } from './server/request-context.js';
    import { readScenarioData, mutateScenarioData } from './server/scenarios/repository.js';
    import { readStore, saveStore } from './server/store.js';
    const result = await initPostgres(); assert.equal(result.mode, 'postgres', JSON.stringify(result));
    try { await runWithRequestContext({userId:'alice'}, async () => {
      assert.equal((await readScenarioData()).history[0].id, 'legacy-pg');
      if (process.env.STORAGE_RESTART_READ_ONLY) {
        assert.equal((await readScenarioData()).history[1].id, 'persisted');
        return;
      }
      await mutateScenarioData(data => {
        const db = getPostgresPool(); assert.equal(db.idleCount, db.totalCount);
        const calendar = readStore(); calendar.events.push({id:'development'}); saveStore(calendar);
        data.history.push({id:'persisted'});
      });
      await assert.rejects(mutateScenarioData(data => {
        saveStore({events:[{id:'rollback'}]}); data.rejectCommit=true;
      }), {code:'23514'});
      await assert.rejects(mutateScenarioData(async () => {}), {code:'STORAGE_ASYNC_MUTATOR'});
    }); } finally { await closePostgres(); }
  `;
  const execute = promisify(execFile);
  const env = { ...process.env, DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: directory };
  await execute(process.execPath, ['--input-type=module', '-e', script], { env });
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, STORAGE_RESTART_READ_ONLY: '1' } });
  assert.equal((await document('mailbox_calendars', 'a')).payload.events[0].id, 'development');
  assert.equal((await document('app_settings', 'scenarios:alice')).payload.history[1].id, 'persisted');
  fs.rmSync(scenarioDir, { recursive: true });
});

test('local mode preserves synchronous JSON read/save and scenario persistence', async () => {
  process.env.DAYLIGHT_RUNTIME = 'local';
  try {
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings()));
    await runWithRequestContext({ userId: 'alice' }, async () => {
      saveStore({ events: [{ id: 'local' }], emails: [], tasks: [] });
      assert.equal(readStore().events[0].id, 'local');
      await mutateScenarioData(data => { data.history.push({ id: 'local-history' }); });
      assert.equal((await readScenarioData()).history[0].id, 'local-history');
    });
  } finally { process.env.DAYLIGHT_RUNTIME = 'production'; }
});
