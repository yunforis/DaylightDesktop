/**
 * Metrics instrumentation must be cheap, non-blocking and private.
 * These tests pin the contract: bounded buffering, sanitised labels, raw latency samples,
 * a rolling summary, and a sink that can fail without ever breaking the caller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-metrics-'));
process.env.DAYLIGHT_METRICS = '1';
process.env.DAYLIGHT_METRICS_DIR = dir;
process.env.DAYLIGHT_METRICS_BUFFER = '6';
process.env.DAYLIGHT_METRICS_FLUSH_MS = '30';
process.env.DAYLIGHT_METRICS_SUMMARY_MS = '50';
process.env.DAYLIGHT_METRICS_RESERVOIR = '200';
process.env.DAYLIGHT_RUN_ID = 'metrics-test-run';
process.env.DAYLIGHT_GIT_SHA = 'testsha';
// A deployment artifact is often not a git checkout, so provenance is injected explicitly.
process.env.DAYLIGHT_GIT_DIRTY = '1';

const metrics = await import('./metrics.js');
const { startMetrics, stopMetrics, flushMetrics, counter, counterAdd, gauge, observe,
  timer, timed, timedSync, metricsSummary, metricsStatus, metricsEnabled, writeMetricsSummary,
  sinkFileName, hostTag } = metrics;

const sinkFor = pid => path.join(dir, sinkFileName(pid));
const readSamples = () => {
  const file = sinkFor(process.pid);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const flushed = async () => { flushMetrics(); await settle(); };

test('recording starts with the switch; the sink is created by the service entry point', () => {
  assert.equal(metricsEnabled(), true);
  assert.equal(metricsStatus().buffered, 0);
  const started = startMetrics({ role: 'test' });
  assert.equal(started.enabled, true);
  assert.equal(started.runId, 'metrics-test-run');
  assert.equal(started.sink, sinkFor(process.pid));
  assert.equal(path.dirname(started.summary), dir);
  assert.ok(fs.existsSync(dir));
  // Recording works as soon as the switch is on, before and after startMetrics.
  assert.equal(counter('after.start'), true);
});

test('each sample carries the required fields and Beijing timestamps', async () => {
  gauge('probe.value', 42, 'bytes', { stage: 'unit' });
  await flushed();
  const sample = readSamples().find(item => item.metric === 'probe.value');
  assert.ok(sample, 'sample was written');
  assert.equal(sample.value, 42);
  assert.equal(sample.unit, 'bytes');
  assert.equal(sample.labels.stage, 'unit');
  assert.equal(sample.runId, 'metrics-test-run');
  assert.equal(sample.gitSha, 'testsha');
  assert.equal(sample.pid, process.pid);
  assert.match(sample.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
  assert.equal(typeof sample.dirty, 'boolean');
  assert.equal(sample.dirty, true, 'the injected dirty flag is reported verbatim');
});

test('labels are sanitised so private and unbounded values never leave the process', async () => {
  gauge('privacy.probe', 1, 'count', {
    mailbox_id: 'mb-1234',
    email: 'someone@example.com',
    body: 'confidential text',
    apiKey: 'sk-live-abcdefghijklmnop',
    endpoint: 'https://api.example.com/v1/chat?token=abc123',
    note: 'x'.repeat(120),
    'weird key!': 'kept-value',
    kind: 7,
  });
  await flushed();
  const sample = readSamples().find(item => item.metric === 'privacy.probe');
  assert.equal(sample.labels.mailbox_id, 'mb-1234');
  assert.equal(sample.labels.kind, 7);
  assert.equal(sample.labels.email, undefined, 'address-like values are dropped');
  assert.equal(sample.labels.body, undefined, 'forbidden key dropped entirely');
  assert.equal(sample.labels.apikey, undefined, 'credential-like key dropped entirely');
  assert.equal(sample.labels.endpoint, 'https://api.example.com/v1/chat', 'query string removed');
  assert.equal(sample.labels.note.length, 40, 'long values truncated');
  const keys = Object.keys(sample.labels);
  assert.ok(keys.length <= 12);
  assert.ok(keys.every(key => /^[a-z][a-z0-9_]{0,31}$/.test(key)), `clean keys: ${keys}`);
});

test('an overflowing buffer drops samples and reports the loss instead of blocking', async () => {
  const status = metricsStatus();
  for (let index = 0; index < 200; index += 1) counter('flood.counter', { index: index % 3 });
  assert.equal(status.buffered <= 6 || metricsStatus().buffered <= 6, true, 'buffer stays bounded');
  await flushed();
  const drops = readSamples().filter(sample => sample.metric === 'metrics_dropped_total');
  assert.ok(drops.length > 0, 'drop total was surfaced as data');
  assert.ok(drops.at(-1).value > 0);
  assert.equal(metricsSummary().dropped > 0, true);
});

test('latency metrics keep every raw sample so percentiles can be recomputed', async () => {
  const values = [12.5, 3.25, 41, 8.75];
  for (const value of values) observe('probe.latency.ms', value, 'ms');
  await flushed();
  const samples = readSamples().filter(sample => sample.metric === 'probe.latency.ms' && sample.value < 100);
  assert.deepEqual(samples.map(sample => sample.value).sort((a, b) => a - b), [...values].sort((a, b) => a - b));
});

test('timers record a duration in milliseconds and always release', async () => {
  const stop = timer('probe.timer.ms', { phase: 'a' });
  stop({ phase: 'b' });
  await timed('probe.timed.ms', { kind: 'async' }, async () => { await new Promise(r => setTimeout(r, 5)); });
  timedSync('probe.timedsync.ms', {}, () => { let total = 0; for (let i = 0; i < 1000; i += 1) total += i; return total; });
  await assert.rejects(timed('probe.timed.ms', { kind: 'reject' }, async () => { throw new Error('boom'); }), /boom/);
  await flushed();
  const samples = readSamples();
  const stopSample = samples.find(sample => sample.metric === 'probe.timer.ms');
  assert.equal(stopSample.unit, 'ms');
  assert.equal(stopSample.labels.phase, 'b', 'stop labels override start labels');
  for (const metric of ['probe.timed.ms', 'probe.timedsync.ms']) {
    assert.ok(samples.some(sample => sample.metric === metric), `${metric} recorded`);
  }
  assert.equal(samples.filter(sample => sample.metric === 'probe.timed.ms').length, 2, 'rejecting call is still timed');
});

test('the rolling summary carries count, sum, min, max and percentiles', async () => {
  await flushed();
  const summary = metricsSummary();
  assert.equal(summary.runId, 'metrics-test-run');
  const entry = summary.metrics['probe.latency.ms'];
  assert.ok(entry);
  assert.ok(entry.count >= 4);
  assert.ok(entry.min <= entry.p50 && entry.p50 <= entry.p99 && entry.p99 <= entry.max);
  assert.equal(Number.isFinite(entry.mean), true);
  assert.equal(entry.unit, 'ms');
  assert.ok(summary.written > 0);
  const persisted = await writeMetricsSummary();
  assert.equal(persisted.runId, 'metrics-test-run');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'metrics-summary.json'), 'utf8'));
  assert.equal(onDisk.runId, 'metrics-test-run');
  assert.equal(onDisk.metrics['probe.latency.ms'].unit, 'ms');
});

test('a failing sink never throws into the caller and is reported as status', async () => {
  await flushed();
  const before = metricsStatus().written;
  fs.rmSync(dir, { recursive: true, force: true });
  for (let index = 0; index < 20; index += 1) counter('sink.failure', { index });
  flushMetrics();
  await settle();
  const status = metricsStatus();
  assert.equal(typeof status.sinkError, 'string');
  assert.ok(status.sinkError.length > 0, 'sink failure recorded');
  assert.ok(status.written >= before || status.dropped > 0);
  stopMetrics();
});

test('metrics stay completely off when the environment switch is absent', () => {
  const script = `
    process.env.DAYLIGHT_METRICS = '0';
    const metrics = await import(${JSON.stringify(path.join(here, 'metrics.js'))});
    metrics.startMetrics({ role: 'off' });
    const result = metrics.counter('never.recorded');
    if (result !== false) throw new Error('counter reported a write while disabled');
    if (metrics.metricsEnabled()) throw new Error('metricsEnabled stayed true');
    if (metrics.metricsStatus().sink !== null) throw new Error('disabled metrics exposed a sink');
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' });
});

test('provenance reports unknown rather than a false clean tree when git is unavailable', () => {
  const script = `
    process.env.DAYLIGHT_METRICS = '0';
    delete process.env.DAYLIGHT_METRICS_DIR;
    delete process.env.DAYLIGHT_GIT_SHA;
    delete process.env.DAYLIGHT_GIT_DIRTY;
    const metrics = await import(${JSON.stringify(path.join(here, 'metrics.js'))});
    const provenance = metrics.metricsProvenance();
    if (provenance.sha !== 'unknown') throw new Error('expected an unknown sha, got ' + provenance.sha);
    if (provenance.dirty !== null) throw new Error('expected dirty to stay null when no tree is reachable, got ' + provenance.dirty);
  `;
  // A deployment artifact is often a plain directory, so no repository is reachable.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-nogit-'));
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe', cwd });
});

test('sink names differ for the same PID under different container host tags', () => {
  // PID 1 exists in every container: without the host tag the sinks would overwrite each other.
  const script = `
    process.env.DAYLIGHT_METRICS = '0';
    const metrics = await import(${JSON.stringify(path.join(here, 'metrics.js'))});
    process.stdout.write(metrics.sinkFileName(1));
  `;
  const nameFor = host => execFileSync(process.execPath, ['--input-type=module', '--eval', script],
    { stdio: 'pipe', env: { ...process.env, HOSTNAME: host } }).toString().trim();
  const api = nameFor('daylight-api');
  const worker = nameFor('daylight-worker');
  assert.equal(api, 'metrics-daylight-api-1.jsonl');
  assert.equal(worker, 'metrics-daylight-worker-1.jsonl');
  assert.notEqual(api, worker, 'the same PID in two containers must not share a file name');
});

test('an unusable metrics directory degrades to sinkError instead of crashing the service', () => {
  // The sink points *inside a regular file*, so mkdir fails with ENOTDIR for any uid —
  // including root, which can otherwise create a missing directory anywhere.
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-metrics-blocked-'));
  const blocker = path.join(blockedRoot, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const script = `
    process.env.DAYLIGHT_METRICS = '1';
    process.env.DAYLIGHT_METRICS_DIR = ${JSON.stringify(path.join(blocker, 'metrics'))};
    const metrics = await import(${JSON.stringify(path.join(here, 'metrics.js'))});
    let started;
    try { started = metrics.startMetrics({ role: 'readonly' }); }
    catch (error) { throw new Error('startMetrics threw on an unwritable sink: ' + (error.code || error.name)); }
    if (!started.enabled) throw new Error('metrics should stay enabled with a broken sink');
    metrics.counter('still.recorded');
    metrics.flushMetrics();
    await new Promise(resolve => setTimeout(resolve, 60));
    const status = metrics.metricsStatus();
    if (typeof status.sinkError !== 'string' || status.sinkError.length === 0) {
      throw new Error('expected sinkError to be reported, got ' + JSON.stringify(status.sinkError));
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' });
});
