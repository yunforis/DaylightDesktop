import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, beforeEach, after } from 'node:test';
import pg from 'pg';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/infra-local-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
delete process.env.DAYLIGHT_RUNTIME;
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  activeMailboxId: 'default', mailboxes: [{ id: 'default', email: 'fixture@example.invalid' }],
}));
const config = await import('./infra/config.js');
const postgres = await import('./infra/postgres.js');
const { runAssistantRequest } = await import('./assistant-requests.js');

beforeEach(async () => {
  await postgres.closePostgres();
  fs.rmSync(path.join(directory, 'infra.json'), { force: true });
  fs.writeFileSync(path.join(directory, 'assistant-requests.json'), JSON.stringify({ items: [] }));
});
after(async () => { await postgres.closePostgres(); });

test('显式启用但连接失败时健康状态不可用，小 D 在执行前拒绝，停用后可重试同一请求', async (t) => {
  let ended = 0;
  t.mock.method(pg, 'Pool', function Pool() {
    this.on = () => {};
    this.connect = async () => { throw new Error('合成连接不能借用'); };
    this.query = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); };
    this.end = async () => { ended++; };
  });
  config.saveInfraConfig({ postgres: { enabled: true } });
  assert.equal((await postgres.initPostgres()).ok, false);
  assert.equal(ended, 1);
  assert.equal(postgres.getPostgresPool(), null);
  assert.deepEqual(await postgres.postgresStatus(), {
    ok: false, mode: 'unavailable', error: 'connect ECONNREFUSED 127.0.0.1:5432',
  });
  const input = { requestId: 'local-failed-pg-request', messages: [{ role: 'user', content: '合成请求' }] };
  await assert.rejects(runAssistantRequest(input, () => assert.fail('存储失败时不能执行模型或工具')), { status: 503 });
  const file = path.join(directory, 'assistant-requests.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.some(item => item.id === input.requestId), false);

  config.saveInfraConfig({ postgres: { enabled: false } });
  await postgres.initPostgres();
  const result = { reply: '显式切换后恢复', toolTrace: [] };
  assert.deepEqual(await runAssistantRequest(input, async () => result), result);
  assert.equal((await postgres.postgresStatus()).mode, 'file');
  assert.equal((await postgres.postgresStatus()).ok, true);
});

test('数据库已配置但尚未初始化时也不能报告健康', async () => {
  config.saveInfraConfig({ postgres: { enabled: true } });
  const status = await postgres.postgresStatus();
  assert.equal(status.ok, false);
  assert.equal(status.mode, 'unavailable');
});

test('显式停用数据库仍拒绝恢复带 PostgreSQL 权威标记的旧请求', async () => {
  config.saveInfraConfig({ postgres: { enabled: false } });
  const marker = path.join(directory, 'assistant-requests.json.postgres');
  fs.writeFileSync(marker, JSON.stringify({ authoritative: 'postgres' }));
  try {
    await assert.rejects(runAssistantRequest({ requestId: 'postgres-authority-request', messages: [{ role: 'user', content: '不能重放旧请求' }] },
      () => assert.fail('不能绕过数据库权威保护')), /已由 PostgreSQL 管理/);
  } finally { fs.unlinkSync(marker); }
});
