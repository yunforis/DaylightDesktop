import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectStorageBackup, applyStorageBackup } from '../scripts/import-storage.js';

async function backup(t, settings = { mailboxes: [{ id: 'a', ownerUserId: 'alice' }] }) {
  await fs.mkdir('work', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('work/storage-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  return directory;
}
test('dry-run validates scope without a database and does not disclose backup content', async t => {
  const directory = await backup(t);
  await fs.mkdir(path.join(directory, 'mailboxes/a'), { recursive: true });
  await fs.writeFile(path.join(directory, 'mailboxes/a/calendar.json'), '{"events":[{"body":"private-body"}]}');
  const ownerHash = createHash('sha256').update('alice').digest('hex');
  await fs.mkdir(path.join(directory, 'scenarios'));
  await fs.writeFile(path.join(directory, `scenarios/${ownerHash}.json`), '{}');
  const { documents, summary } = await collectStorageBackup(directory);
  assert.equal(documents.length, 3);
  assert.match(summary.scope, /users and auxiliary modules require separate migration/);
  const before = await fs.readFile(path.join(directory, 'settings.json'));
  const result = spawnSync(process.execPath, ['scripts/import-storage.js', `--source=${directory}`], { encoding: 'utf8', env: { ...process.env, DAYLIGHT_DATABASE_URL: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
  assert.doesNotMatch(result.stdout + result.stderr, /alice|private-body|ownerUserId/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'settings.json')), before);
});
test('invalid, duplicate and ambiguous mailbox ownership is refused', async t => {
  for (const mailboxes of [
    [{ id: '../outside', ownerUserId: 'alice' }],
    [{ id: 'a', ownerUserId: 'alice' }, { id: 'a', ownerUserId: 'alice' }],
    [{ id: 'a' }], [{ id: 'a', ownerUserId: {} }],
    [{ id: 'a', ownerUserId: 'alice', userId: 'bob' }],
  ]) {
    const directory = await backup(t, { mailboxes });
    await assert.rejects(collectStorageBackup(directory), /refused/);
  }
});
test('file and directory symlinks cannot escape the backup root', async t => {
  const external = await backup(t);
  for (const directoryLink of [false, true]) {
    const directory = await backup(t);
    await fs.mkdir(path.join(directory, 'mailboxes'));
    if (directoryLink) await fs.symlink(external, path.join(directory, 'mailboxes/a'));
    else {
      await fs.mkdir(path.join(directory, 'mailboxes/a'));
      await fs.symlink(path.join(external, 'settings.json'), path.join(directory, 'mailboxes/a/calendar.json'));
    }
    await assert.rejects(collectStorageBackup(directory), /refused/);
  }
});
test('invalid JSON refusal never logs source snippets or private paths', async t => {
  const directory = await backup(t);
  await fs.writeFile(path.join(directory, 'settings.json'), '{"secret":"private-key" BROKEN');
  const result = spawnSync(process.execPath, ['scripts/import-storage.js', `--source=${directory}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /private-key|BROKEN|storage-import-/);
});
test('import is content-idempotent and conflicting authority rolls back the whole batch', async t => {
  const directory = await backup(t);
  const { documents } = await collectStorageBackup(directory);
  let rows = new Map(), staged, inserts = 0, releases = 0;
  const pool = { async connect() { return { release() { releases++; }, async query(sql, args) {
    if (sql === 'BEGIN') staged = structuredClone(rows);
    if (sql.startsWith('SELECT payload')) return { rows: staged.has(args[0]) ? [{ payload: staged.get(args[0]) }] : [] };
    if (sql.startsWith('INSERT')) { staged.set(args[0], JSON.parse(args[1])); inserts++; }
    if (sql === 'COMMIT') rows = staged;
    if (sql === 'ROLLBACK') staged = undefined;
    return { rows: [] };
  } }; } };
  await applyStorageBackup(pool, documents);
  await applyStorageBackup(pool, documents);
  assert.equal(inserts, 1);
  const conflict = [{ table: 'app_settings', id: 'new', payload: {} }, { ...documents[0], payload: { changed: true } }];
  await assert.rejects(applyStorageBackup(pool, conflict), /refused/);
  assert.equal(rows.has('new'), false);
  assert.deepEqual(rows.get('default'), documents[0].payload);
  assert.equal(releases, 3);
});
