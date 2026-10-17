import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/trace-storage-'));
process.env.DAYLIGHT_DATA_DIR = directory;
process.env.DAYLIGHT_RUNTIME = 'local';
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const { readTraces, saveTraces } = await import('./traces.js');
const { withStorageSnapshot, commitStorage } = await import('./storage/index.js');
const { runWithRequestContext } = await import('./request-context.js');

const settings = () => ({
  activeMailboxId: 'b',
  mailboxes: [
    { id: 'a', ownerUserId: 'alice' },
    { id: 'c', ownerUserId: 'alice' },
    { id: 'b', ownerUserId: 'bob' },
  ],
  userPrefs: { alice: { activeMailboxId: 'a' }, bob: { activeMailboxId: 'b' } },
});
const traces = id => [{ trace_id: `trace-${id}`, mode: 'qq', status: 'imported' }];

function fixturePool() {
  const documents = new Map([
    ['default', { payload: settings(), version: 1 }],
    ...['a', 'b', 'c'].map(id => [`traces:${id}`, { payload: traces(id), version: 1 }]),
  ]);
  const loaded = [];
  return { documents, loaded, async connect() {
    return { release() {}, async query(sql, args = []) {
      const row = sql.includes('app_settings') ? documents.get(args[0]) : undefined;
      if (sql.startsWith('SELECT payload')) {
        loaded.push(args[0]);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      if (sql.startsWith('SELECT version')) return { rows: row ? [{ version: row.version }] : [] };
      if (sql.startsWith('INSERT INTO app_settings') || sql.startsWith('UPDATE app_settings')) {
        const version = (row?.version || 0) + 1;
        documents.set(args[0], { payload: JSON.parse(args[1]), version });
        return { rows: [{ version }] };
      }
      return { rows: [] };
    } };
  } };
}

test('shared trace reads and writes default to the current owner preference without local file fallback', async () => {
  const pool = fixturePool();
  fs.writeFileSync(path.join(directory, 'settings.json'), '{invalid local settings');
  await withStorageSnapshot({ pool, userId: 'alice' }, async () => {
    assert.deepEqual(readTraces(), traces('a'));
    saveTraces(traces('updated-a'));
    assert.deepEqual(readTraces(), traces('updated-a'));
    assert.deepEqual(readTraces('c'), traces('c'));
    await commitStorage();
  });
  assert.deepEqual(pool.documents.get('traces:a').payload, traces('updated-a'));
  assert.deepEqual(pool.documents.get('traces:b').payload, traces('b'));
  assert.deepEqual(pool.documents.get('traces:c').payload, traces('c'));
  assert.ok(!pool.loaded.includes('traces:b'));
  assert.ok(!pool.documents.has('traces:undefined'));
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), '{invalid local settings');
});

test('request mailbox overrides saved preference for implicit trace reads and writes; foreign owner remains inaccessible', async () => {
  const pool = fixturePool();
  await withStorageSnapshot({ pool, userId: 'alice', mailboxId: 'c' }, async () => {
    assert.deepEqual(readTraces(), traces('c'));
    saveTraces(traces('updated-c'));
    saveTraces(traces('explicit-a'), 'a');
    assert.deepEqual(readTraces('a'), traces('explicit-a'));
    assert.throws(() => readTraces('b'), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
    assert.throws(() => saveTraces([], 'b'), { code: 'STORAGE_DOCUMENT_NOT_LOADED' });
    await commitStorage();
  });
  assert.deepEqual(pool.documents.get('traces:c').payload, traces('updated-c'));
  assert.deepEqual(pool.documents.get('traces:a').payload, traces('explicit-a'));
  assert.deepEqual(pool.documents.get('traces:b').payload, traces('b'));
  await withStorageSnapshot({ pool, userId: 'bob' }, () => {
    assert.deepEqual(readTraces(), traces('b'));
  });
});

test('an account without a saved mailbox can load empty traces but cannot write before setup', async () => {
  const pool = fixturePool();
  await withStorageSnapshot({ pool, userId: 'new-owner' }, () => {
    assert.deepEqual(readTraces(), []);
    assert.throws(() => saveTraces([]), { code: 'MAILBOX_SETUP_REQUIRED', status: 400 });
  });
  assert.ok(!pool.documents.has('traces:undefined'));
});

test('local trace files retain default, explicit and request-selected mailbox behavior', async () => {
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings()));
  await runWithRequestContext({ userId: 'alice' }, async () => {
    assert.deepEqual(readTraces(), []);
    saveTraces(traces('local-a'));
    saveTraces(traces('local-c'), 'c');
    assert.deepEqual(readTraces(), traces('local-a'));
    assert.deepEqual(readTraces('c'), traces('local-c'));
    await runWithRequestContext({ userId: 'alice', mailboxId: 'c' }, () => {
      assert.deepEqual(readTraces(), traces('local-c'));
      saveTraces(traces('local-updated-c'));
    });
    assert.deepEqual(readTraces(), traces('local-a'));
    assert.deepEqual(readTraces('c'), traces('local-updated-c'));
  });
});
