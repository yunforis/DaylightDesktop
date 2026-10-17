/**
 * Low-overhead metric instrumentation.
 *
 * Design constraints (production):
 *  - Recording never blocks business code: samples go to a bounded in-memory buffer and a
 *    background task appends them in batches. A full buffer drops the sample and only
 *    increments `metrics_dropped_total`.
 *  - A failing sink never propagates: write errors only add to the dropped counter.
 *  - Latency metrics keep every raw sample in the JSONL sink so any percentile can be
 *    recomputed; the rolling summary carries count/sum/min/max plus a bounded reservoir.
 *  - No email bodies, subjects, addresses, URLs with query strings, tokens, keys or full
 *    connection strings may enter a sample. Sanitisation happens here, at the boundary.
 *
 * Sinks:
 *   <dir>/metrics-<host>-<pid>.jsonl  one JSON sample per line (raw)
 *   <dir>/metrics-summary.json        rolling aggregate, rewritten periodically
 * The file name carries the container/host tag because PID namespaces repeat: several
 * containers sharing one sink volume would otherwise all write `metrics-1.jsonl`.
 *
 * Environment:
 *   DAYLIGHT_METRICS=1            enable (anything else disables; zero overhead when off)
 *   DAYLIGHT_METRICS_SAMPLE=0..1  sampling ratio for observe/timer samples (default 1)
 *   DAYLIGHT_METRICS_DIR=<dir>    sink directory (default <dataDir>/metrics)
 *   DAYLIGHT_METRICS_BUFFER=<n>   buffer capacity (default 10000)
 *   DAYLIGHT_RUN_ID=<id>          correlates a run; generated when absent
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.DAYLIGHT_METRICS === '1';
const sampleRate = (() => {
  const raw = Number(process.env.DAYLIGHT_METRICS_SAMPLE ?? '1');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
})();
const directory = process.env.DAYLIGHT_METRICS_DIR
  || path.join(process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data'), 'metrics');
const capacity = Math.max(100, Number(process.env.DAYLIGHT_METRICS_BUFFER) || 10000);
const flushMs = Math.max(50, Number(process.env.DAYLIGHT_METRICS_FLUSH_MS) || 1000);
const summaryMs = Math.max(1000, Number(process.env.DAYLIGHT_METRICS_SUMMARY_MS) || 15000);
const reservoirLimit = Math.max(200, Number(process.env.DAYLIGHT_METRICS_RESERVOIR) || 4000);

export const runId = process.env.DAYLIGHT_RUN_ID || randomUUID();
const pid = process.pid;

const buffer = [];
const summary = new Map();
const inFlightQueued = [];
/** Container/host tag. PID alone is not unique once containers share a sink volume. */
export function hostTag() {
  const raw = String(process.env.HOSTNAME || os.hostname() || 'local');
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48) || 'local';
}
export function sinkFileName(pidValue = pid) { return `metrics-${hostTag()}-${pidValue}.jsonl`; }

let sinkFile = path.join(directory, sinkFileName());
let summaryFile = path.join(directory, 'metrics-summary.json');
let inFlight = false;
let dropped = 0;
let droppedTotal = 0;
let written = 0;
let sinkError = '';
let closed = false;
let flushTimer = null;
let summaryTimer = null;
let samplersStarted = false;
let gitInfo = null;

/** Labels that would leak private or unbounded values regardless of content. */
const FORBIDDEN_LABEL = /^(body|subject|sender|senderaddress|recipient|to|cc|bcc|from|email|mail|authorization|cookie|token|apikey|api_key|secret|password|pass|key|url|uri|querystring|attachment|filename|content|prompt|message)$/i;
const LABEL_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SECRETISH = /(sk-|bearer\s|postgres(ql)?:\/\/|rediss?:\/\/|amqps?:\/\/|https?:\/\/[^\s]*[:@][^\s]*@|-----BEGIN)/i;
const EMAILISH = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function git() {
  if (gitInfo) return gitInfo;
  const injected = String(process.env.DAYLIGHT_GIT_SHA || '').trim();
  const injectedDirty = String(process.env.DAYLIGHT_GIT_DIRTY ?? '').trim().toLowerCase();
  // `dirty` is a provenance fact, not a guess: an injected value wins, a missing working
  // tree leaves it null ("unknown") rather than claiming the tree was clean.
  const declaredDirty = injectedDirty === '' ? null : ['1', 'true', 'yes'].includes(injectedDirty) ? true
    : ['0', 'false', 'no'].includes(injectedDirty) ? false : null;
  gitInfo = { sha: injected || 'unknown', dirty: declaredDirty };
  if (declaredDirty !== null) return gitInfo;
  try {
    if (!injected) gitInfo.sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || gitInfo.sha;
    gitInfo.dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { /* git is optional: metrics must never depend on a working tree */ }
  return gitInfo;
}

function beijingIso(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  return `${shifted.toISOString().slice(0, 23)}+08:00`;
}

function sanitizeValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value ?? '');
  if (!text) return '';
  if (SECRETISH.test(text) || EMAILISH.test(text)) return '[redacted]';
  return text.split('?')[0].slice(0, 40);
}

function sanitizeLabels(labels) {
  if (!labels || typeof labels !== 'object') return {};
  const out = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(labels)) {
    if (count >= 12) break;
    const key = String(rawKey).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!LABEL_KEY.test(key) || FORBIDDEN_LABEL.test(key)) continue;
    out[key] = sanitizeValue(rawValue);
    count += 1;
  }
  return out;
}

function shouldSample() {
  return sampleRate >= 1 || Math.random() < sampleRate;
}

function aggregate(sample) {
  let entry = summary.get(sample.metric);
  if (!entry) {
    entry = { count: 0, sum: 0, min: null, max: null, unit: sample.unit, last: null, reservoir: [], dropped: 0 };
    summary.set(sample.metric, entry);
  }
  entry.count += 1;
  entry.unit = sample.unit;
  entry.last = sample.value;
  if (typeof sample.value === 'number' && Number.isFinite(sample.value)) {
    entry.sum += sample.value;
    entry.min = entry.min === null ? sample.value : Math.min(entry.min, sample.value);
    entry.max = entry.max === null ? sample.value : Math.max(entry.max, sample.value);
    if (entry.reservoir.length < reservoirLimit) entry.reservoir.push(sample.value);
    else {
      // Deterministic thinning keeps the reservoir representative without growing memory.
      const index = entry.count % reservoirLimit;
      entry.reservoir[index] = sample.value;
    }
  }
}

function emit(metric, value, unit, labels, { sampled = false } = {}) {
  if (!enabled || closed) return false;
  if (sampled && !shouldSample()) return true;
  if (buffer.length >= capacity) { dropped += 1; droppedTotal += 1; return false; }
  const g = git();
  const sample = { ts: beijingIso(), metric, value, unit, labels: sanitizeLabels(labels), runId, gitSha: g.sha, dirty: g.dirty, pid };
  buffer.push(sample);
  aggregate(sample);
  return true;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
  return sorted[index];
}

function writeChunk(text) {
  if (inFlight) { inFlightQueued.push(text); return; }
  inFlight = true;
  fs.appendFile(sinkFile, text, (error) => {
    inFlight = false;
    if (error) {
      sinkError = error.code || error.name;
      dropped += text.split('\n').length - 1;
      droppedTotal += text.split('\n').length - 1;
    } else {
      written += text.split('\n').length - 1;
    }
    const queued = inFlightQueued.splice(0).join('');
    if (queued) writeChunk(queued);
  });
}

export function flushMetrics() {
  if (!enabled || closed) return;
  if (buffer.length) {
    const chunk = `${buffer.splice(0).map(sample => JSON.stringify(sample)).join('\n')}\n`;
    writeChunk(chunk);
  }
  if (dropped) {
    // Surface drops as data, not just as an internal counter.
    const sample = { ts: beijingIso(), metric: 'metrics_dropped_total', value: droppedTotal, unit: 'count',
      labels: {}, runId, gitSha: git().sha, dirty: git().dirty, pid };
    dropped = 0;
    writeChunk(`${JSON.stringify(sample)}\n`);
  }
}

function percentileBlock(entry) {
  const sorted = [...entry.reservoir].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99),
    samples: sorted.length,
  };
}

export function metricsSummary() {
  const metrics = {};
  for (const [name, entry] of summary) {
    metrics[name] = {
      unit: entry.unit, count: entry.count, sum: entry.sum,
      min: entry.min, max: entry.max, last: entry.last,
      mean: entry.count ? entry.sum / entry.count : null,
      ...percentileBlock(entry),
    };
  }
  return { runId, pid, gitSha: git().sha, dirty: git().dirty, generatedAt: beijingIso(),
    sampling: sampleRate, buffered: buffer.length, written, dropped: droppedTotal,
    sinkError: sinkError || null, metrics };
}

/** Persists the rolling aggregate. Safe to call at any time; failures only set sinkError. */
export async function writeMetricsSummary() {
  if (!enabled) return null;
  const snapshot = metricsSummary();
  try { await fs.promises.writeFile(summaryFile, JSON.stringify(snapshot, null, 2)); }
  catch (error) { sinkError = error.code || error.name; }
  return snapshot;
}

/* ── public recording API ───────────────────────────────────────────────── */

export function metricsEnabled() { return enabled; }

/** Provenance recorded on every sample and in the summary: { sha, dirty }. */
export function metricsProvenance() { return git(); }

export function counter(name, labels) { return emit(name, 1, 'count', labels); }
export function counterAdd(name, delta, labels) { return emit(name, delta, 'count', labels, { sampled: false }); }
export function gauge(name, value, unit, labels) { return emit(name, value, unit, labels); }
export function observe(name, value, unit, labels) { return emit(name, value, unit, labels, { sampled: true }); }

/** Returns a stop() function; the duration is sampled per DAYLIGHT_METRICS_SAMPLE. */
export function timer(name, labels) {
  if (!enabled) return () => {};
  const start = process.hrtime.bigint();
  return (extraLabels) => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    emit(name, Number(ms.toFixed(3)), 'ms', { ...labels, ...extraLabels }, { sampled: true });
  };
}

/** Records the duration of fn in all cases, then rethrows. */
export async function timed(name, labels, fn) {
  const stop = timer(name, labels);
  try { return await fn(); }
  finally { stop(); }
}

export function timedSync(name, labels, fn) {
  const stop = timer(name, labels);
  try { return fn(); }
  finally { stop(); }
}

/* ── process + dependency samplers ──────────────────────────────────────── */

let loopHistogram = null;
let lastCpu = null;
let observers = [];

export function startProcessSamplers({ intervalMs = 5000 } = {}) {
  if (!enabled || samplersStarted) return;
  samplersStarted = true;
  try {
    loopHistogram = monitorEventLoopDelay({ resolution: 10 });
    loopHistogram.enable();
  } catch { loopHistogram = null; }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 0) observe('gc.pause.ms', Number(entry.duration.toFixed(3)), 'ms', { kind: entry.detail?.kind ?? 'unknown' });
      }
    });
    observer.observe({ entryTypes: ['gc'] });
    observers.push(observer);
  } catch { /* gc observation is optional */ }
  lastCpu = process.cpuUsage();
  const tick = setInterval(() => {
    const memory = process.memoryUsage();
    gauge('process.rss.bytes', memory.rss, 'bytes');
    gauge('process.heap_used.bytes', memory.heapUsed, 'bytes');
    gauge('process.external.bytes', memory.external, 'bytes');
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const totalUs = cpu.user + cpu.system;
    gauge('process.cpu.percent', Number(((totalUs / 1e6) / (intervalMs / 1000) * 100).toFixed(2)), 'percent');
    if (loopHistogram) {
      gauge('eventloop.delay.ms', Number((loopHistogram.mean / 1e6).toFixed(3)), 'ms', { stat: 'mean' });
      gauge('eventloop.delay.ms', Number((loopHistogram.max / 1e6).toFixed(3)), 'ms', { stat: 'max' });
      loopHistogram.reset();
    }
    try { gauge('process.handles', process._getActiveHandles().length, 'count'); } catch { /* private API */ }
    gauge('process.uptime.seconds', Number(process.uptime().toFixed(3)), 'seconds');
  }, intervalMs);
  tick.unref?.();
  flushTimer = setInterval(flushMetrics, flushMs);
  flushTimer.unref?.();
  summaryTimer = setInterval(() => { writeMetricsSummary(); }, summaryMs);
  summaryTimer.unref?.();
}

export function stopMetrics() {
  if (!enabled) return;
  flushMetrics();
  closed = true;
  if (flushTimer) clearInterval(flushTimer);
  if (summaryTimer) clearInterval(summaryTimer);
  for (const observer of observers) { try { observer.disconnect(); } catch { /* ignore */ } }
  observers = [];
  try { loopHistogram?.disable(); } catch { /* ignore */ }
  // Shutdown is not latency critical: persist the aggregate synchronously so the
  // evidence files are complete even if the process exits immediately afterwards.
  try { fs.writeFileSync(summaryFile, JSON.stringify(metricsSummary(), null, 2)); }
  catch (error) { sinkError = error.code || error.name; }
}

/** Called once by a service entry point; safe to call when metrics are disabled. */
export function startMetrics({ sinkDir, role = 'app' } = {}) {
  if (!enabled) return { enabled: false };
  if (sinkDir) {
    // A missing or read-only sink directory must degrade to sinkError, never crash a
    // production service: observability is not allowed to take the app down.
    try {
      fs.mkdirSync(sinkDir, { recursive: true });
      sinkFile = path.join(sinkDir, sinkFileName());
      summaryFile = path.join(sinkDir, 'metrics-summary.json');
    } catch (error) { sinkError = error.code || error.name; }
  } else {
    try { fs.mkdirSync(directory, { recursive: true }); }
    catch (error) { sinkError = error.code || error.name; }
  }
  startProcessSamplers();
  counter('process.start_total', { role });
  return { enabled: true, runId, pid, sink: sinkFile, summary: summaryFile };
}

export function metricsStatus() {
  return { enabled, runId, pid, buffered: buffer.length, written, dropped, sinkError: sinkError || null, sink: enabled ? sinkFile : null };
}
