import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// The pool and its rows are simulated. All files use an isolated work directory; no external calls occur.
fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/assistant-meetings-store-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
const { initPostgres } = await import('./infra/postgres.js');
const { saveInfraConfig } = await import('./infra/config.js');
const { readAssistantMeetingOperations, withAssistantMeetingMailboxLock } = await import('./assistant-meetings-store.js');
let sequence = 0;

function mailbox() {
  const id = `synthetic-store-${++sequence}`;
  const folder = path.join(directory, 'mailboxes', id);
  fs.mkdirSync(folder, { recursive: true });
  return { id, folder, cache: path.join(folder, 'assistant-meetings.json'),
    marker: path.join(folder, 'assistant-meetings.json.postgres') };
}

async function postgres(t) {
  const rows = new Map();
  const calendarRows = new Map();
  const statements = [];
  let releaseCount = 0;
  class FakePool {
    constructor(options) { this.options = options; }
    on() {}
    async query(sql, params = []) {
      statements.push(sql);
      if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] };
      if (sql.startsWith('update app_settings')) { rows.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (sql === 'select 1' || sql.startsWith('\nCREATE TABLE')) return { rows: [] };
      if (sql.startsWith('select count')) return { rows: [{ count: 1 }] };
      if (sql.startsWith('select pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.startsWith('select pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.startsWith('select payload from app_settings')) return { rows: rows.has(params[0]) ? [{ payload: structuredClone(rows.get(params[0])) }] : [] };
      if (sql.startsWith('insert into app_settings')) { rows.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (sql.startsWith('select payload from mailbox_calendars')) return { rows: calendarRows.has(params[0]) ? [{ payload: structuredClone(calendarRows.get(params[0])) }] : [] };
      if (sql.startsWith('insert into mailbox_calendars')) { calendarRows.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      throw new Error(`Unexpected fake PostgreSQL statement: ${sql}`);
    }
    async connect() { return { query: (...args) => this.query(...args), release() { releaseCount++; } }; }
    async end() {}
  }
  t.mock.method(pg, 'Pool', function Pool(options) { return new FakePool(options); });
  saveInfraConfig({ postgres: { enabled: true } });
  const initialized = await initPostgres();
  assert.equal(initialized.mode, 'postgres', JSON.stringify(initialized));
  t.after(async () => { saveInfraConfig({ postgres: { enabled: false } }); await initPostgres(); });
  return { rows, calendarRows, statements, released: () => releaseCount };
}

test('PostgreSQL 已有权威记录时不解析损坏缓存，读写后持久保存权威标记和正常缓存', async (t) => {
  const db = await postgres(t);
  const box = mailbox();
  fs.writeFileSync(box.cache, '{');
  db.rows.set(`assistant-meetings:${box.id}`, { schemaVersion: 1, operations: [{ operationKey: 'fixture', status: 'completed' }] });
  const result = await withAssistantMeetingMailboxLock(box.id, async (repository) => {
    const data = await repository.read();
    assert.equal(data.operations[0].status, 'completed');
    data.operations[0].status = 'needs_attention';
    await repository.save(data);
    return data;
  });
  assert.equal(result.operations[0].status, 'needs_attention');
  assert.equal(fs.existsSync(box.marker), true);
  assert.equal(JSON.parse(fs.readFileSync(box.cache, 'utf8')).operations[0].status, 'needs_attention');
  assert.equal(db.rows.get(`assistant-meetings:${box.id}`).operations[0].status, 'needs_attention');
  assert.ok(db.released() >= 4, '每个检查点使用独立短事务');
  assert.equal(db.statements.some((statement) => statement.startsWith('select pg_try_advisory_lock')), false);
});

test('PG保存preparing后即使JSON缓存写失败，关闭PG仍阻止旧缓存恢复及重复建会', async (t) => {
  const db = await postgres(t);
  const box = mailbox();
  fs.writeFileSync(box.cache, JSON.stringify({ operations: [] }));
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === box.cache) throw Object.assign(new Error('Synthetic cache failure'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  await withAssistantMeetingMailboxLock(box.id, async (repository) => {
    await repository.read();
    await repository.save({ operations: [{ operationKey: 'known-external-attempt', status: 'preparing' }] });
  });
  assert.ok(db.rows.get(`assistant-meetings:${box.id}`));
  assert.equal(JSON.parse(fs.readFileSync(box.cache, 'utf8')).operations.length, 0, '保留模拟的陈旧缓存');
  assert.equal(fs.existsSync(box.marker), true);
  saveInfraConfig({ postgres: { enabled: false } });
  let callbackCalls = 0;
  await assert.rejects(withAssistantMeetingMailboxLock(box.id, async () => { callbackCalls++; }),
    (failure) => failure.code === 'MEETING_STORAGE_AUTHORITY_REQUIRED' && /迁移/.test(failure.message));
  await assert.rejects(readAssistantMeetingOperations(box.id), (failure) => failure.code === 'MEETING_STORAGE_AUTHORITY_REQUIRED');
  assert.equal(callbackCalls, 0);
});

test('已标记PG权威后数据库行丢失，查询与建会读取均失败，不回退旧JSON', async (t) => {
  const db = await postgres(t);
  const box = mailbox();
  fs.writeFileSync(box.cache, JSON.stringify({ operations: [] }));
  db.rows.set(`assistant-meetings:${box.id}`, { operations: [{ operationKey: 'already-reserved', status: 'preparing' }] });
  assert.equal((await readAssistantMeetingOperations(box.id)).operations.length, 1);
  db.rows.delete(`assistant-meetings:${box.id}`);
  await assert.rejects(readAssistantMeetingOperations(box.id), (failure) => failure.code === 'MEETING_STORAGE_AUTHORITY_MISSING');
  let externalCalls = 0;
  await assert.rejects(withAssistantMeetingMailboxLock(box.id, async (repository) => { await repository.read(); externalCalls++; }),
    (failure) => failure.code === 'MEETING_STORAGE_AUTHORITY_MISSING');
  assert.equal(externalCalls, 0);
  assert.equal(db.rows.has(`assistant-meetings:${box.id}`), false);
});

test('权威标记写入失败会阻止保存后的外部副作用，不把未标记的PG结果当作安全检查点', async (t) => {
  const db = await postgres(t);
  const box = mailbox();
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === box.marker) throw Object.assign(new Error('Synthetic authority barrier failure'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  let externalCalls = 0;
  await assert.rejects(withAssistantMeetingMailboxLock(box.id, async (repository) => {
    await repository.read();
    await repository.save({ operations: [{ operationKey: 'never-called-externally', status: 'preparing' }] });
    externalCalls++;
  }), /authority barrier failure/);
  assert.equal(externalCalls, 0);
  assert.ok(db.rows.get(`assistant-meetings:${box.id}`));
});

test('首次迁移没有PG标记的正常JSON记录，保存到PG后继续保持幂等检查点', async (t) => {
  const db = await postgres(t);
  const box = mailbox();
  fs.writeFileSync(box.cache, JSON.stringify({ operations: [{ operationKey: 'from-file', status: 'needs_attention' }] }));
  await withAssistantMeetingMailboxLock(box.id, async (repository) => {
    const data = await repository.read();
    assert.equal(data.operations[0].operationKey, 'from-file');
    await repository.save(data);
  });
  assert.equal(db.rows.get(`assistant-meetings:${box.id}`).operations[0].status, 'needs_attention');
  assert.equal(fs.existsSync(box.marker), true);
});
