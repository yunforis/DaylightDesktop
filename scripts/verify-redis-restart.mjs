/** Isolated real Redis restart proof. Run with Node >=22; no existing Redis is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node >=22 required');

async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error(`Timed out: ${label}`);
}

if (process.argv[2] === '--client') {
  const redis = await import('../server/infra/redis.js');
  const { closeInfra } = await import('../server/infra/index.js');
  const send = (stage, details = {}) => process.send({ stage, ...details });
  const command = expected => new Promise(resolve => {
    const listener = message => {
      if (message === expected) { process.off('message', listener); resolve(); }
    };
    process.on('message', listener);
  });
  const close = async () => {
    const start = performance.now();
    let rejected = false;
    try { await closeInfra({ timeoutMs: 500 }); } catch { rejected = true; }
    const elapsedMs = Math.round(performance.now() - start);
    assert.ok(elapsedMs < 1500, `closeInfra took ${elapsedMs}ms`);
    assert.equal(redis.redisMode(), 'unavailable');
    await assert.rejects(redis.redisSet('closed', 'must-not-write'), /unavailable in production/);
    return { elapsedMs, rejected };
  };
  try {
    assert.equal((await redis.initRedis()).mode, 'redis');
    assert.equal(await redis.redisSet('probe', 'before-restart'), 'OK');
    send('initialized');
    await command('killed');
    await until(async () => !(await redis.redisStatus()).ok, 'outage detected');
    assert.equal(redis.redisMode(), 'redis');
    await assert.rejects(redis.redisGet('probe'));
    await assert.rejects(redis.redisSet('outage', 'must-not-write'));
    send('outage-rejected', { mode: redis.redisMode(), fallback: false });
    await command('restarted');
    const start = performance.now();
    // Do not call initRedis again: the original client must reconnect itself.
    await until(async () => (await redis.redisStatus()).ok, 'original client PING recovery');
    assert.equal(redis.redisMode(), 'redis');
    assert.equal(await redis.redisGet('outage'), null);
    assert.equal(await redis.redisSet('probe', 'after-restart'), 'OK');
    assert.equal(await redis.redisGet('probe'), 'after-restart');
    send('recovered', { elapsedMs: Math.round(performance.now() - start) });
    send('closed-connected', await close());
    // Also prove shutdown while the real server is unavailable, with reconnect pending.
    await redis.initRedis();
    send('initialized-again');
    await command('killed-again');
    await until(async () => !(await redis.redisStatus()).ok, 'second outage detected');
    send('closed-disconnected', await close());
    process.disconnect(); // Natural exit proves no reconnect timer/socket is keeping Node alive.
  } catch (error) {
    console.error(error);
    await closeInfra({ timeoutMs: 500 }).catch(() => {});
    process.exitCode = 1;
    process.disconnect();
  }
} else {
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const dir = fs.mkdtempSync(path.join(work, 'redis-restart-'));
  const evidence = path.join(dir, 'evidence.jsonl');
  const report = (stage, details = {}) => {
    const event = { at: new Date().toISOString(), stage, ...details };
    fs.appendFileSync(evidence, `${JSON.stringify(event)}\n`);
    console.log(JSON.stringify(event));
  };
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = path.join(dir, 'redis.conf');
  fs.writeFileSync(config, [
    'bind 127.0.0.1', `port ${port}`, 'protected-mode yes', 'daemonize no',
    'save ""', 'appendonly no', `dir "${dir}"`, 'loglevel notice',
  ].join('\n') + '\n');
  let server;
  let client;
  const children = new Set();
  const startServer = async () => {
    server = spawn(process.env.REDIS_SERVER_BIN || 'redis-server', [config], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(server);
    const current = server;
    let spawnError;
    let ready = false;
    current.on('error', error => { spawnError = error; });
    current.once('exit', () => children.delete(current));
    for (const stream of [current.stdout, current.stderr]) stream.on('data', chunk => {
      fs.appendFileSync(path.join(dir, 'redis.log'), chunk);
      if (chunk.toString().includes('Ready to accept connections')) ready = true;
    });
    await until(async () => {
      if (spawnError) throw spawnError;
      if (current.exitCode !== null) throw new Error(`Own Redis exited: ${current.exitCode}`);
      if (!ready) return false;
      return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.on('error', () => resolve(false));
        socket.on('connect', () => { socket.destroy(); resolve(true); });
      });
    }, 'own Redis startup');
    report('redis-started', { pid: current.pid, port });
  };
  const killServer = async () => {
    const current = server;
    const exited = once(current, 'exit');
    assert.equal(current.kill('SIGKILL'), true);
    await exited;
    report('own-redis-killed', { pid: current.pid });
  };
  const watchdog = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 25000);
  try {
    report('environment', { node: process.version, platform: process.platform, directory: dir });
    await startServer();
    client = spawn(process.execPath, [script, '--client'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, DAYLIGHT_RUNTIME: 'production', DAYLIGHT_DATA_DIR: path.join(dir, 'data'),
        DAYLIGHT_REDIS_URL: `redis://127.0.0.1:${port}`,
        DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/unused',
        DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
        DAYLIGHT_JWT_SECRET: 'synthetic-isolated-redis-proof-at-least-32-characters',
        DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic-unused',
        DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
        DAYLIGHT_REQUIRE_AUTH: '1', DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN: '0' },
    });
    children.add(client);
    const exited = once(client, 'exit');
    const stages = [];
    let handling = Promise.resolve();
    let failure;
    let closedAt;
    for (const stream of [client.stdout, client.stderr]) stream.on('data', chunk => fs.appendFileSync(path.join(dir, 'client.log'), chunk));
    client.on('message', message => {
      handling = handling.then(async () => {
        stages.push(message.stage);
        report(message.stage, message);
        if (message.stage === 'closed-disconnected') closedAt = performance.now();
        if (message.stage === 'initialized') { await killServer(); client.send('killed'); }
        if (message.stage === 'outage-rejected') { await startServer(); client.send('restarted'); }
        if (message.stage === 'initialized-again') { await killServer(); client.send('killed-again'); }
      }).catch(error => { failure = error; client.kill('SIGKILL'); });
    });
    const [code, signal] = await exited;
    children.delete(client);
    await handling;
    if (failure) throw failure;
    assert.equal(signal, null, 'Client must exit naturally, without watchdog kill');
    assert.equal(code, 0, `Client failed; see ${path.join(dir, 'client.log')}`);
    assert.deepEqual(stages, ['initialized', 'outage-rejected', 'recovered', 'closed-connected', 'initialized-again', 'closed-disconnected']);
    const exitAfterCloseMs = Math.round(performance.now() - closedAt);
    assert.ok(exitAfterCloseMs < 5000, `Natural exit took ${exitAfterCloseMs}ms after close`);
    report('PASS', { naturalClientExit: true, exitAfterCloseMs, port, evidence });
  } catch (error) {
    report('FAIL', { message: error.message });
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    // Only child PIDs created by this invocation are ever signalled.
    for (const child of children) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited.catch(() => {});
    }
  }
}
