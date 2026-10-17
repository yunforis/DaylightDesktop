/** Local real PG/Redis/RabbitMQ + synthetic S3/calendar HTTP. No cloud or mail/model calls.
 * Run with Node >=22: node scripts/verify-production.mjs
 * Optional PRODUCTION_TEST_DATABASE_URL / PRODUCTION_TEST_AMQP_URL: loopback only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import amqp from 'amqplib';
import { verifyCalendar } from './fixtures/production-calendar-checks.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
function localUrl(value) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Dependencies must use loopback');
  return url;
}

export async function verifyProduction() {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'work/production-verify-'));
  const schema = `prod_verify_${randomUUID().replaceAll('-', '')}`;
  const database = localUrl(process.env.PRODUCTION_TEST_DATABASE_URL || 'postgresql://127.0.0.1/postgres');
  const broker = localUrl(process.env.PRODUCTION_TEST_AMQP_URL || 'amqp://daylight:daylight@127.0.0.1:5672');
  const admin = new pg.Pool({ connectionString: database.href, connectionTimeoutMillis: 3000 });
  const children = new Set(); const logs = []; const checks = [];
  let pool, redis, s3, api, worker, schemaCreated = false;
  function launch(name, args, env) {
    const log = fs.openSync(path.join(dir, `${name}.log`), 'a'); logs.push(log);
    const child = spawn(args[0], args.slice(1), { cwd: root, env, stdio: ['ignore', log, log] });
    children.add(child); child.once('exit', () => children.delete(child)); return child;
  }
  async function stop(child, signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await once(child, 'exit'); } finally { clearTimeout(deadline); }
  }
  async function check(name, fn) {
    try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { checks.push({ name, passed: false, error: error.stack }); throw error; }
  }
  console.log(`Evidence directory: ${dir}`);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    database.searchParams.set('options', `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: database.href, max: 8 });
    const redisPort = await port(), apiPort = await port();
    const redisProcess = launch('redis', ['redis-server', '--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', dir], process.env);
    redis = new Redis({ host: '127.0.0.1', port: redisPort, lazyConnect: true, retryStrategy: () => null });
    redis.on('error', () => {});
    await until(async () => {
      try { if (redis.status === 'end' || redis.status === 'wait') await redis.connect(); return await redis.ping() === 'PONG'; } catch { return false; }
    }, 'isolated Redis startup');
    const objects = new Map(); const requests = [];
    s3 = http.createServer(async (req, res) => {
      requests.push({ method: req.method, path: req.url });
      const key = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      if (req.method === 'PUT') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        objects.set(key, Buffer.concat(chunks)); res.setHeader('ETag', '"synthetic"'); return res.end();
      }
      if (req.method === 'GET' && objects.has(key)) return res.end(objects.get(key));
      if (req.method === 'DELETE') { objects.delete(key); return res.end(); }
      res.writeHead(404); res.end();
    });
    s3.listen(0, '127.0.0.1'); await once(s3, 'listening');
    const env = { ...process.env, DAYLIGHT_RUNTIME: 'production', DAYLIGHT_DATA_DIR: path.join(dir, 'data'),
      DAYLIGHT_DATABASE_URL: database.href, DAYLIGHT_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      DAYLIGHT_AMQP_URL: broker.href, DAYLIGHT_JWT_SECRET: `synthetic-${randomUUID()}`,
      DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: schema, DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
      DAYLIGHT_OSS_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, DAYLIGHT_OSS_FORCE_PATH_STYLE: '1',
      DAYLIGHT_REQUIRE_AUTH: '1', DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN: '0', PRODUCTION_VERIFY_QUEUE: schema,
      PORT: String(apiPort), HOST: '127.0.0.1', HEALTH_PORT: '0',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*',
    };
    const preload = path.join(root, 'scripts/fixtures/production-preload.mjs');
    const migration = launch('migration', [process.execPath, 'scripts/migrate.js'], env);
    assert.equal((await once(migration, 'exit'))[0], 0, `Migration failed; see ${dir}/migration.log`);
    const users = ['alice', 'bob']; const tokens = [];
    for (const user of users) {
      await pool.query(`INSERT INTO users(id,email,username,password_hash,created_at,updated_at) VALUES($1,$2,$1,'synthetic',now(),now())`, [user, `${user}@example.invalid`]);
      const jti = randomUUID();
      await redis.set(`session:${user}:${jti}`, JSON.stringify({ jti, userId: user, sessionVersion: 0 }), 'EX', 600);
      tokens.push(jwt.sign({ sub: user, jti, sv: 0 }, env.DAYLIGHT_JWT_SECRET, { expiresIn: '10m' }));
    }
    await pool.query(`UPDATE app_settings SET payload=$1::jsonb WHERE id='default'`, [JSON.stringify({
      email: '', apiKey: '', baseUrl: `http://127.0.0.1:${s3.address().port}/unused-model`,
      mailboxes: users.map(user => ({ id: `mail-${user}`, ownerUserId: user, email: `${user}@example.invalid`, host: '127.0.0.1', autoSync: false })),
      userPrefs: Object.fromEntries(users.map(user => [user, { activeMailboxId: `mail-${user}` }])),
    })]);
    const startApi = () => launch('api', [process.execPath, '--import', preload, 'server/index.js'], env);
    const call = async (route, user = 0, method = 'GET', body, key) => {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api${route}`, {
        method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json',
          ...(user === null ? {} : { Authorization: `Bearer ${tokens[user]}` }), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    async function ready() {
      await until(async () => { try { return (await call('/scenarios')).status === 200; } catch { return false; } }, 'production HTTP startup');
    }
    const expect = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result)); return result.data; };
    api = startApi(); await ready();
    let workbench, item, job;
    await check('production API auth and owned scenario setup', async () => {
      expect(await call('/scenarios', null), 401);
      workbench = expect(await call('/scenarios/workbenches', 0, 'POST', { templateId: 'graduate-admission', mailboxIds: ['mail-alice'], name: '合成隔离验证' }));
      item = expect(await call(`/scenarios/workbenches/${workbench.id}/items`, 0, 'POST', { title: '合成申请', fields: { institution: '合成大学' } }));
      expect(await call(`/scenarios/workbenches/${workbench.id}/items/${item.id}/external-sources`, 0, 'POST', { channel: workbench.template.externalSources[0], note: '请明天下午18点前确认参营并提交成绩单。' }));
    });
    const planPath = `/scenarios/workbenches/${workbench.id}/items/${item.id}/plan`;
    await check('HTTP enqueue is idempotent; queued cancellation and manual retry', async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => call(planPath, 0, 'POST', { useModel: false }, 'same-request')));
      job = expect(results[0], 202).job;
      assert.ok(results.every(result => result.status === 202 && result.data.job.id === job.id));
      assert.equal(expect(await call(`/jobs/${job.id}`)).job.status, 'queued');
      expect(await call(`/jobs/${job.id}/cancel`, 0, 'POST', {}));
      assert.equal(expect(await call(`/jobs/${job.id}`)).job.status, 'cancelled');
      expect(await call(`/jobs/${job.id}/retry`, 0, 'POST', {}));
    });
    await check('second user cannot read/retry/cancel jobs or plan/confirm another owner', async () => {
      for (const suffix of ['', '/retry', '/cancel']) expect(await call(`/jobs/${job.id}${suffix}`, 1, suffix ? 'POST' : 'GET', suffix ? {} : undefined), 404);
      expect(await call(planPath, 1, 'POST', { useModel: false }), 404);
      expect(await call('/jobs?mailbox=mail-alice', 1), 404);
    });
    const marker = path.join(dir, 'checkpoint.marker');
    worker = launch('worker-crash', [process.execPath, '--import', preload, 'server/worker.js'], { ...env, PRODUCTION_VERIFY_CRASH_MARKER: marker });
    await check('independent real worker commits business result and plan.persist checkpoint', async () => {
      await until(() => fs.existsSync(marker), 'checkpoint before worker completion');
      assert.equal(fs.readFileSync(marker, 'utf8'), job.id);
      const steps = await pool.query('SELECT * FROM daylight_job_steps WHERE job_id=$1', [job.id]);
      assert.deepEqual(steps.rows.map(row => row.name), ['plan.persist']);
      const data = expect(await call('/scenarios'));
      assert.ok(data.actions.some(action => action.itemId === item.id));
      assert.equal((await pool.query('SELECT status FROM daylight_jobs WHERE id=$1', [job.id])).rows[0].status, 'running');
    });
    await stop(worker, 'SIGKILL'); await stop(api);
    await pool.query("UPDATE daylight_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    const before = (await pool.query("SELECT payload FROM app_settings WHERE id='scenarios:alice'")).rows[0].payload;
    api = startApi(); await ready();
    worker = launch('worker-restart', [process.execPath, '--import', preload, 'server/worker.js'], env);
    await check('API and worker restart recover committed checkpoint without duplicated business actions', async () => {
      await until(async () => expect(await call(`/jobs/${job.id}`)).job.status === 'succeeded', 'lease recovery and completion');
      const after = (await pool.query("SELECT payload FROM app_settings WHERE id='scenarios:alice'")).rows[0].payload;
      assert.deepEqual(after, before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM daylight_job_steps WHERE job_id=$1', [job.id])).rows[0].n, 1);
      assert.ok(expect(await call(`/jobs/${job.id}`)).job.generation >= 2);
    });
    let action;
    await check('calendar confirmation transaction failure rolls back scenario and calendar together', async () => {
      const proposal = expect(await call(`/scenarios/workbenches/${workbench.id}/items/${item.id}/schedule`, 0, 'POST', {
        title: '合成面试', localStart: '2027-01-12T10:00', localEnd: '2027-01-12T11:00', timeZone: 'Asia/Shanghai',
      })); action = proposal.action;
      expect(await call(`/scenarios/workbenches/${workbench.id}/actions/${action.id}/schedule`, 1, 'POST', {}), 404);
      const original = expect(await call('/scenarios'));
      const calendar = expect(await call('/state'));
      await pool.query(`CREATE FUNCTION reject_calendar() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$;
        CREATE TRIGGER reject_calendar BEFORE INSERT OR UPDATE ON mailbox_calendars FOR EACH ROW EXECUTE FUNCTION reject_calendar()`);
      try { expect(await call(`/scenarios/workbenches/${workbench.id}/actions/${action.id}/schedule`, 0, 'POST', {}), 503); }
      finally { await pool.query('DROP TRIGGER reject_calendar ON mailbox_calendars'); }
      assert.deepEqual(expect(await call('/scenarios')), original);
      assert.deepEqual(expect(await call('/state')).events, calendar.events);
    });
    await check('concurrent calendar confirmations produce exactly one event and execution', async () => {
      const route = `/scenarios/workbenches/${workbench.id}/actions/${action.id}/schedule`;
      const results = await Promise.all(Array.from({ length: 8 }, () => call(route, 0, 'POST', {})));
      assert.ok(results.every(result => [200, 409].includes(result.status)), JSON.stringify(results));
      expect(await call(route, 0, 'POST', {}));
      assert.equal(expect(await call('/state')).events.filter(event => event.scenarioActionId === action.id).length, 1);
      assert.equal(expect(await call('/scenarios')).executions.filter(execution => execution.actionId === action.id).length, 1);
    });
    await check('production OSS adapter PUT/GET uses local S3 mock; no local authoritative JSON created', async () => {
      const probe = launch('oss-probe', [process.execPath, '--import', preload, 'scripts/fixtures/production-oss-probe.mjs'], env);
      assert.equal((await once(probe, 'exit'))[0], 0, `OSS probe failed; see ${dir}/oss-probe.log`);
      assert.ok(requests.some(request => request.method === 'HEAD'));
      assert.ok(requests.some(request => request.method === 'PUT'));
      assert.ok(requests.some(request => request.method === 'GET'));
      for (const filename of ['settings.json', 'calendar.json', 'users.json']) assert.equal(fs.existsSync(path.join(env.DAYLIGHT_DATA_DIR, filename)), false);
    });
    await stop(worker);
    await verifyCalendar({ pool, env, preload, dir, launch, stop, call, expect, until, check });
    await stop(api); await stop(redisProcess);
    console.log('Local production dependency verification passed. S3 and Google calendar use local HTTP mocks; no cloud/model/IMAP/SMTP verification.');
  } catch (error) {
    console.error(`FAIL ${error.stack}\nLogs: ${dir}`); throw error;
  } finally {
    await Promise.all([...children].map(child => stop(child)));
    redis?.disconnect();
    if (s3) { s3.closeAllConnections(); await new Promise(resolve => s3.close(resolve)); }
    try {
      const connection = await amqp.connect(broker.href, { timeout: 3000 });
      try { const channel = await connection.createChannel(); await channel.deleteQueue(schema); } finally { await connection.close(); }
    } catch (error) { console.error(`Queue cleanup: ${error.code || error.message}`); }
    await pool?.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ checks, scope: 'real local PostgreSQL/Redis/RabbitMQ; local S3 and Google calendar HTTP mocks; synthetic rule plan, no external mail/model' }, null, 2));
    for (const log of logs) fs.closeSync(log);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyProduction();
