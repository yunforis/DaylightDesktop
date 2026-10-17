import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';

const work = path.resolve('work');
fs.mkdirSync(work, { recursive: true });
const dir = fs.mkdtempSync(path.join(work, 'infra-production-'));
process.env.DAYLIGHT_DATA_DIR = dir;
process.env.DAYLIGHT_RUNTIME = 'production';
Object.assign(process.env, {
  DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/daylight',
  DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
  DAYLIGHT_JWT_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic',
  DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
});
delete process.env.DAYLIGHT_REQUIRE_AUTH;
delete process.env.DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN;
const config = await import('./infra/config.js');
const pg = await import('./infra/postgres.js');
const redis = await import('./infra/redis.js');
const oss = await import('./infra/oss.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('production ignores local configuration and rejects local persistence and auth bypass', () => {
  fs.writeFileSync(path.join(dir, 'infra.json'), 'not JSON');
  assert.equal(config.readInfraConfig().auth.requireAuth, true);
  assert.equal(config.readInfraConfig().auth.allowLocalDemoLogin, false);
  assert.equal(config.readInfraConfig().managedBy, 'environment');
  assert.throws(() => config.saveInfraConfig({}), /managed by environment/);
  process.env.DAYLIGHT_REQUIRE_AUTH = '0';
  assert.throws(() => config.readInfraConfig(), /requires authentication/);
  delete process.env.DAYLIGHT_REQUIRE_AUTH;
  const url = process.env.DAYLIGHT_REDIS_URL;
  delete process.env.DAYLIGHT_REDIS_URL;
  assert.throws(() => config.readInfraConfig(), /DAYLIGHT_REDIS_URL/);
  process.env.DAYLIGHT_REDIS_URL = url;
  fs.unlinkSync(path.join(dir, 'infra.json'));
});

test('production cannot use uninitialized file, memory, or attachment fallbacks', async () => {
  await assert.rejects(pg.findUserById('synthetic'), /unavailable in production/);
  for (const action of [() => redis.redisGet('x'), () => redis.redisSet('x', 'y'), () => redis.redisDel('x'), () => redis.redisKeys('x')]) {
    await assert.rejects(action(), /unavailable in production/);
  }
  await assert.rejects(oss.putAttachment({ filename: 'x', buffer: Buffer.from('x') }), /unavailable in production/);
  assert.equal(oss.resolveLocalAttachment('users/test/file'), null);
  assert.equal((await pg.postgresStatus()).ok, false);
  assert.equal((await redis.redisStatus()).ok, false);
  assert.equal((await oss.ossStatus()).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('PG production checks schema without DDL or import and closes failed pools', async (t) => {
  const driver = (await import('pg')).default;
  let ended = 0;
  let fail = true;
  const queries = [];
  t.mock.method(driver.Pool.prototype, 'query', async (sql) => {
    queries.push(sql);
    if (fail) throw new Error('synthetic failure');
    return { rows: [] };
  });
  t.mock.method(driver.Pool.prototype, 'end', async () => { ended++; });
  await assert.rejects(pg.initPostgres(), /synthetic failure/);
  assert.equal(ended, 1);
  assert.equal(pg.getPostgresPool(), null);
  fail = false;
  assert.equal((await pg.initPostgres()).mode, 'postgres');
  assert.ok(queries.every((sql) => /^select /i.test(sql)));
  assert.ok(queries.some((sql) => sql.includes('app_settings')));
  assert.match(pg.SCHEMA, /CREATE TABLE IF NOT EXISTS users/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fail = true;
  await assert.rejects(pg.initPostgres(), /synthetic failure/);
  assert.equal(ended, 3);
});

test('Redis failure disconnects client and never switches to memory in production', async (t) => {
  const Redis = (await import('ioredis')).default;
  let disconnected = 0;
  t.mock.method(Redis.prototype, 'connect', async () => { throw new Error('synthetic redis unavailable'); });
  t.mock.method(Redis.prototype, 'disconnect', () => { disconnected++; });
  await assert.rejects(redis.initRedis(), /synthetic redis unavailable/);
  assert.equal(disconnected, 1);
  assert.equal(redis.redisMode(), 'unavailable');
  await assert.rejects(redis.redisSet('x', 'y'), /unavailable in production/);
});

test('OSS init and health perform requests; failure rejects without creating local storage', async (t) => {
  const { S3Client } = await import('@aws-sdk/client-s3');
  let fail = true;
  let calls = 0;
  let destroyed = 0;
  t.mock.method(S3Client.prototype, 'send', async () => { calls++; if (fail) throw new Error('synthetic OSS unavailable'); return {}; });
  t.mock.method(S3Client.prototype, 'destroy', () => { destroyed++; });
  await assert.rejects(oss.initOss(), /synthetic OSS unavailable/);
  assert.equal(destroyed, 1);
  fail = false;
  assert.equal((await oss.initOss()).ok, true);
  assert.equal((await oss.ossStatus()).ok, true);
  fail = true;
  assert.equal((await oss.ossStatus()).ok, false);
  assert.equal(calls, 4);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('attachment keys reject traversal and local downloads reject symlink escapes', async () => {
  for (const key of ['../secret', '/secret', 'a/../../secret', 'a\\secret', 'a/%2e%2e/secret', 'a?x']) {
    await assert.rejects(oss.getAttachmentObject(key), /Invalid attachment key/);
  }
  process.env.DAYLIGHT_RUNTIME = 'local';
  config.saveInfraConfig({ postgres: { enabled: false }, oss: { enabled: false } });
  await oss.initOss();
  const stored = await oss.putAttachment({ filename: 'sample.txt', buffer: Buffer.from('synthetic') });
  assert.equal((await oss.getAttachmentObject(stored.key)).buffer.toString(), 'synthetic');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dir, 'attachments', 'escape'));
  assert.equal(oss.resolveLocalAttachment('escape'), null);
  process.env.DAYLIGHT_RUNTIME = 'production';
});

test('shared readiness rejects missing settings, schema errors, Redis and OSS outages', async (t) => {
  const infra = await import('./infra/index.js');
  const driver = (await import('pg')).default;
  const Redis = (await import('ioredis')).default;
  const { S3Client } = await import('@aws-sdk/client-s3');
  let failure = '';
  const queries = [];
  t.mock.method(driver.Pool.prototype, 'query', async sql => {
    queries.push(sql);
    if (failure === 'schema' && sql.includes('version')) throw new Error('missing version');
    return { rows: sql.includes("id = 'default'") && failure !== 'settings' ? [{ payload: { mailboxes: [] } }] : [] };
  });
  t.mock.method(driver.Pool.prototype, 'end', async () => {});
  t.mock.method(Redis.prototype, 'connect', async () => {});
  t.mock.method(Redis.prototype, 'ping', async () => { if (failure === 'redis') throw new Error('offline'); return 'PONG'; });
  t.mock.method(Redis.prototype, 'quit', async () => {});
  t.mock.method(Redis.prototype, 'disconnect', () => {});
  t.mock.method(S3Client.prototype, 'send', async () => { if (failure === 'oss') throw new Error('forbidden'); return {}; });
  t.mock.method(S3Client.prototype, 'destroy', () => {});
  await pg.initPostgres();
  await redis.initRedis();
  await oss.initOss();
  assert.equal(await infra.sharedRuntimeReady(), true);
  for (failure of ['schema', 'settings', 'redis', 'oss']) assert.equal(await infra.sharedRuntimeReady(), false, failure);
  failure = 'settings';
  assert.equal(await infra.sharedRuntimeReady({ requireSettings: false }), true);
  const originalQuery = driver.Pool.prototype.query;
  driver.Pool.prototype.query = () => new Promise(() => {});
  try { assert.equal(await infra.sharedRuntimeReady({ timeoutMs: 20 }), false); }
  finally { driver.Pool.prototype.query = originalQuery; }
  assert.ok(queries.every(sql => /^select /i.test(sql)));
  assert.equal((await infra.infraHealth()).status.mq.mode, 'unobserved');
  infra.setJobsTransportStatus(() => ({ ok: false, mode: 'disconnected' }));
  assert.deepEqual((await infra.infraHealth()).status.mq, {
    ok: false, mode: 'disconnected', required: false, fallback: 'database-polling',
  });
  await infra.closeInfra();
  infra.setJobsTransportStatus(null);
});

test('closeInfra bounds stuck Redis quit, disconnects and closes OSS and PG even on error', async (t) => {
  const infra = await import('./infra/index.js');
  const driver = (await import('pg')).default;
  const Redis = (await import('ioredis')).default;
  const { S3Client } = await import('@aws-sdk/client-s3');
  let disconnected = 0;
  let ended = 0;
  let destroyed = 0;
  t.mock.method(driver.Pool.prototype, 'query', async () => ({ rows: [] }));
  t.mock.method(driver.Pool.prototype, 'end', async () => { ended++; });
  t.mock.method(Redis.prototype, 'connect', async () => {});
  t.mock.method(Redis.prototype, 'ping', async () => 'PONG');
  t.mock.method(Redis.prototype, 'quit', () => new Promise(() => {}));
  t.mock.method(Redis.prototype, 'disconnect', () => { disconnected++; });
  t.mock.method(S3Client.prototype, 'send', async () => ({}));
  t.mock.method(S3Client.prototype, 'destroy', () => { destroyed++; });
  await pg.initPostgres();
  await redis.initRedis();
  await oss.initOss();
  const before = destroyed;
  await assert.rejects(infra.closeInfra({ timeoutMs: 20 }), /cleanup failed/);
  assert.equal(disconnected, 1);
  assert.equal(ended, 1);
  assert.equal(destroyed, before + 1);
  assert.equal(pg.getPostgresPool(), null);
  assert.equal(redis.redisMode(), 'unavailable');
  await assert.rejects(redis.redisGet('x'), /unavailable in production/);
  await infra.closeInfra();
});

test('production Redis keeps bounded reconnect delays and bounded commands after disconnect', async (t) => {
  const Redis = (await import('ioredis')).default;
  let instance;
  t.mock.method(Redis.prototype, 'connect', async function () { instance = this; });
  t.mock.method(Redis.prototype, 'ping', async () => 'PONG');
  t.mock.method(Redis.prototype, 'quit', async () => {});
  t.mock.method(Redis.prototype, 'disconnect', () => {});
  await redis.initRedis();
  assert.equal(instance.options.enableOfflineQueue, false);
  assert.equal(instance.options.maxRetriesPerRequest, 1);
  assert.ok(instance.options.commandTimeout <= 5000);
  for (const attempts of [1, 10, 1000]) {
    const delay = instance.options.retryStrategy(attempts);
    assert.ok(delay > 0 && delay <= 3000);
  }
  await redis.closeRedis();
});
