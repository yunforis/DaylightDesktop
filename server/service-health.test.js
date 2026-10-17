import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { serviceHealth, installShutdown } from './service-health.js';

test('dependency outage and draining reject readiness without killing liveness', async () => {
  let connected = true;
  const health = serviceHealth({ checkReady: async () => { if (!connected) throw new Error('secret connection details'); return true; } });
  const request = async (url) => {
    const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await health.respond({ url }, res);
    return res;
  };
  assert.equal((await request('/health/startup')).statusCode, 503);
  health.started();
  assert.equal((await request('/health/ready')).statusCode, 200);
  connected = false;
  const unavailable = await request('/health/ready');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(JSON.stringify(unavailable.body).includes('secret'), false);
  assert.equal((await request('/health/live')).statusCode, 200);
  connected = true;
  health.drain();
  assert.equal((await request('/health/ready')).statusCode, 503);
  assert.equal((await request('/health/live')).statusCode, 200);
});

test('hung readiness times out, aborts its check and still serves liveness', async () => {
  let signal;
  const health = serviceHealth({ readinessTimeoutMs: 20, checkReady: options => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  health.started();
  const response = { setHeader() {}, end() {} };
  await health.respond({ url: '/health/ready' }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(signal.aborted, true);
  await health.respond({ url: '/health/live' }, response);
  assert.equal(response.statusCode, 200);
});

test('draining during an in-flight readiness check cannot return ready', async () => {
  let complete;
  const health = serviceHealth({ checkReady: () => new Promise(resolve => { complete = resolve; }) });
  health.started();
  const response = { setHeader() {}, end() {} };
  const pending = health.respond({ url: '/health/ready' }, response);
  await Promise.resolve();
  health.drain();
  complete(true);
  await pending;
  assert.equal(response.statusCode, 503);
});

test('shutdown closes idle connections and forces active ones before cleaning resources', async () => {
  const calls = [];
  let finish;
  const previous = process.exitCode;
  const shutdown = installShutdown({
    health: { drain() { calls.push('drain'); } }, timeoutMs: 50,
    server: {
      close(callback) { finish = callback; calls.push('close'); },
      closeIdleConnections() { calls.push('idle'); },
      closeAllConnections() { calls.push('force'); finish(); },
    },
    stop: async () => { calls.push('stop'); },
    close: async () => { calls.push('resources'); },
  });
  try {
    const pending = shutdown();
    assert.equal(shutdown(), pending);
    await pending;
    assert.deepEqual(calls, ['drain', 'close', 'idle', 'stop', 'resources', 'force']);
    assert.equal(process.exitCode, 0);
  } finally {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    process.exitCode = previous;
  }
});

test('failed resource cleanup keeps the hard deadline instead of leaving a live process', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { installShutdown } from './server/service-health.js';
    setInterval(() => {}, 1000);
    const shutdown = installShutdown({
      health: { drain() {} },
      server: { close(done) { done(); }, closeIdleConnections() {}, closeAllConnections() {} },
      close: async () => { throw new Error('cleanup failed'); }, timeoutMs: 50,
    });
    await shutdown();
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve([code, signal]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, 1, stderr);
  } finally { clearTimeout(watchdog); }
});
