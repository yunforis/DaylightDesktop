import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from './jobs/repository.js';
import { JobWorker, bounded } from './jobs/runtime.js';
import { JobTransport } from './jobs/rabbit.js';
import { EventEmitter } from 'node:events';

test('retry jitter has a nonzero floor and capped exponential growth', () => {
  assert.equal(retryDelay(1, { random: () => 0 }), 500);
  assert.equal(retryDelay(2, { random: () => 1 }), 2000);
  assert.equal(retryDelay(100, { random: () => 1 }), 300000);
  assert.throws(() => retryDelay(1, { random: () => NaN }));
});

test('worker bounds execution and revokes late checkpoint access', async () => {
  let lateContext;
  let failed;
  let commits = 0;
  const repository = { leaseMs: 1000, heartbeat: async () => {},
    checkpoint: async () => { commits++; }, complete: async () => { commits++; },
    fail: async (...args) => { failed = args; } };
  const worker = new JobWorker(repository, { hang: async (_job, ctx) => {
    lateContext = ctx;
    await new Promise(() => {});
  } }, { timeoutMs: 30 });
  await worker.execute({ id: 'job', kind: 'hang', lease_token: 'token' });
  assert.equal(failed[2].code, 'JOB_TIMEOUT');
  assert.equal(lateContext.signal.aborted, true);
  assert.throws(() => lateContext.checkpoint('late', {}));
  assert.equal(commits, 0);
});

test('heartbeat loss aborts the handler without reporting success', async () => {
  let signal;
  let completed = false;
  const repository = { leaseMs: 100, heartbeat: async () => { throw new Error('database unavailable'); },
    complete: async () => { completed = true; }, fail: async () => {} };
  await new JobWorker(repository, { wait: async (_job, ctx) => {
    signal = ctx.signal;
    await new Promise(() => {});
  } }, { heartbeatMs: 10, timeoutMs: 500 }).execute({ id: 'id', kind: 'wait' });
  assert.equal(signal.aborted, true);
  assert.equal(completed, false);
});

test('bounded operations reject instead of hanging indefinitely', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 10), { code: 'JOB_TIMEOUT' });
});

test('unsupported kinds fail terminally and never enter a handler', async () => {
  let retryable;
  const repository = { leaseMs: 1000, fail: async (_id, _token, _error, options) => { retryable = options.retryable; } };
  await new JobWorker(repository, {}).execute({ id: 'unknown', kind: 'unknown' });
  assert.equal(retryable, false);
});

test('transport status tracks setup, broker loss, reconnect wait and graceful stop', async () => {
  const controller = new AbortController();
  let allowConnection, allowConsume, polled;
  const connectionReady = new Promise(resolve => { allowConnection = resolve; });
  const consumerReady = new Promise(resolve => { allowConsume = resolve; });
  const polling = new Promise(resolve => { polled = resolve; });
  const channel = Object.assign(new EventEmitter(), {
    assertQueue: async () => {}, prefetch: async () => {}, consume: () => consumerReady,
  });
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: async () => channel, close: async () => {},
  });
  const transport = new JobTransport({ claimOutbox: async () => { polled(); return []; } }, {
    url: 'amqp://synthetic.invalid', connect: () => connectionReady, pollMs: 1,
    onError: () => { assert.equal(transport.status().ok, false); controller.abort(); },
  });
  assert.equal(transport.status().state, 'stopped');
  const running = transport.run({ signal: controller.signal });
  assert.equal(transport.status().state, 'connecting');
  allowConnection(connection);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.status().ok, false);
  allowConsume({ consumerTag: 'synthetic' });
  await polling;
  assert.deepEqual(transport.status(), { ok: true, mode: 'rabbitmq', state: 'connected' });
  channel.emit('close');
  assert.deepEqual(transport.status(), { ok: false, mode: 'rabbitmq', state: 'reconnecting' });
  await running;
  assert.equal(transport.status().state, 'stopped');
});

test('transport failed connection and session cleanup never report connected', async () => {
  const transport = new JobTransport({}, { url: 'amqp://synthetic.invalid', connect: async () => { throw new Error('offline'); } });
  await assert.rejects(transport.session(), /offline/);
  assert.deepEqual(transport.status(), { ok: false, mode: 'rabbitmq', state: 'reconnecting' });
  const controller = new AbortController();
  controller.abort();
  await transport.run({ signal: controller.signal });
  assert.equal(transport.status().state, 'stopped');
});

test('session finally clears connected status even without a broker close event', async () => {
  const channel = Object.assign(new EventEmitter(), {
    assertQueue: async () => {}, prefetch: async () => {}, consume: async () => ({ consumerTag: 'synthetic' }),
  });
  let closing = false;
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: async () => channel,
    close: async () => {
      closing = true;
      assert.equal(transport.status().ok, false);
    },
  });
  const transport = new JobTransport({ claimOutbox: async () => {
    assert.equal(transport.status().state, 'connected');
    throw new Error('database unavailable');
  } }, { url: 'amqp://synthetic.invalid', connect: async () => connection });
  await assert.rejects(transport.session(), /database unavailable/);
  assert.equal(closing, true);
  assert.deepEqual(transport.status(), { ok: false, mode: 'rabbitmq', state: 'reconnecting' });
});
