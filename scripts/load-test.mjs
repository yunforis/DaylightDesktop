/**
 * P3 performance harness for the Daylight job platform.
 *
 * What it measures
 *  - Throughput: terminal jobs per second while draining a fixed backlog.
 *  - Latency: queue wait (enqueue -> first attempt) and end-to-end (enqueue -> terminal),
 *    reported as p50/p90/p95/p99/max from the raw per-job records.
 *  - Resources: RSS, heap, CPU and event-loop delay of the worker process, sampled per
 *    second into a time series.
 *  - Scaling: 1 / 2 / 4 workers on the same workload, so the parallelism story is
 *    measurable instead of asserted.
 *  - Serialization bound: the same workload confined to one mailbox, which the lease
 *    design intentionally serializes (head-of-line ordering is a correctness feature).
 *  - Instrumentation overhead: the identical workload with `DAYLIGHT_METRICS=1` and `=0`
 *    in separate processes, which is the only way to compare fairly.
 *
 * Real dependencies only: an isolated PostgreSQL schema, a real RabbitMQ queue and the
 * product's own JobRepository/JobWorker/JobTransport. No model, IMAP, SMTP or OSS calls,
 * so a run costs nothing and cannot disturb a real mailbox.
 *
 * Usage
 *   node scripts/load-test.mjs --matrix                 # full matrix, writes work/load-test-<timestamp>
 *   node scripts/load-test.mjs --run --workers 4        # single configuration
 *   node scripts/load-test.mjs --run --workers 2 --metrics off --json
 *
 * Environment
 *   LOAD_TEST_DATABASE_URL  loopback PostgreSQL (default postgresql://127.0.0.1/postgres)
 *   LOAD_TEST_AMQP_URL      loopback RabbitMQ     (default amqp://daylight:daylight@127.0.0.1:5672)
 *   LOAD_TEST_OUT           output directory
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function loopback(value, label) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${label} must use loopback`);
  return url;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
  return sorted[index];
}

function distribution(values) {
  const numbers = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const sum = numbers.reduce((total, value) => total + value, 0);
  return {
    count: numbers.length,
    min: numbers[0] ?? null,
    max: numbers.at(-1) ?? null,
    mean: numbers.length ? Number((sum / numbers.length).toFixed(3)) : null,
    p50: percentile(numbers, 0.50),
    p90: percentile(numbers, 0.90),
    p95: percentile(numbers, 0.95),
    p99: percentile(numbers, 0.99),
  };
}

function parseArgs(argv) {
  const args = { matrix: false, run: false, json: false, noWrite: false, workers: 2, jobs: 600, mailboxes: 128,
    workMs: 0, failureRate: 0, pool: 0, repeat: 3, metrics: process.env.DAYLIGHT_METRICS === '1' ? 'on' : 'off', timeoutMs: 240000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    if (token === '--matrix') args.matrix = true;
    else if (token === '--run') args.run = true;
    else if (token === '--json') args.json = true;
    else if (token === '--no-write') args.noWrite = true;
    else if (token === '--workers') args.workers = Number(next());
    else if (token === '--jobs') args.jobs = Number(next());
    else if (token === '--mailboxes') args.mailboxes = Number(next());
    else if (token === '--work-ms') args.workMs = Number(next());
    else if (token === '--failure-rate') args.failureRate = Number(next());
    else if (token === '--pool') args.pool = Number(next());
    else if (token === '--repeat') args.repeat = Number(next());
    else if (token === '--metrics') args.metrics = next();
    else if (token === '--timeout-ms') args.timeoutMs = Number(next());
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

/**
 * Runs one configuration in this process and returns a structured result.
 * Each run owns a schema and a queue, so runs never share state even in parallel.
 */
export async function runConfiguration(config) {
  const { workers, jobs, mailboxes, workMs, failureRate, metricsMode, databaseUrl, brokerUrl, outDir, timeoutMs } = config;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `load_${suffix}`;
  const queue = `daylight.load.${suffix}`;
  const previous = { data: process.env.DAYLIGHT_DATA_DIR, runtime: process.env.DAYLIGHT_RUNTIME,
    metrics: process.env.DAYLIGHT_METRICS, metricsDir: process.env.DAYLIGHT_METRICS_DIR, pool: process.env.DAYLIGHT_PG_POOL_MAX };
  process.env.DAYLIGHT_DATA_DIR = process.env.DAYLIGHT_DATA_DIR || path.join(outDir, 'data');
  process.env.DAYLIGHT_RUNTIME = 'local';
  process.env.DAYLIGHT_METRICS = metricsMode === 'on' ? '1' : '0';
  process.env.DAYLIGHT_METRICS_DIR = process.env.DAYLIGHT_METRICS_DIR || path.join(outDir, 'metrics', 'run');
  // One connection per concurrent worker plus headroom for the sampler and outbox publisher.
  process.env.DAYLIGHT_PG_POOL_MAX = process.env.DAYLIGHT_PG_POOL_MAX || String(Math.max(5, workers * 2 + 2));
  fs.mkdirSync(process.env.DAYLIGHT_DATA_DIR, { recursive: true });

  const admin = new pg.Pool({ connectionString: loopback(databaseUrl, 'database').href, connectionTimeoutMillis: 5000 });
  const series = [];
  const handlerRecords = [];
  let pool = null;
  let aborted = false;

  const q = admin;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = loopback(databaseUrl, 'database');
    isolated.searchParams.set('options', `-c search_path=${schema}`);

    const { saveInfraConfig } = await import('../server/infra/config.js');
    const pgInfra = await import('../server/infra/postgres.js');
    const { JobRepository } = await import('../server/jobs/repository.js');
    const { JobWorker, pause: jobPause } = await import('../server/jobs/runtime.js');
    const { JobTransport } = await import('../server/jobs/rabbit.js');
    const { migrateJobs } = await import('../server/jobs/schema.js');
    const { AUXILIARY_SCHEMA } = await import('../server/storage/aux-schema.js');
    const { STORAGE_SCHEMA } = await import('../server/storage/schema.js');
    const metrics = await import('../server/metrics.js');
    metrics.startMetrics({ role: `loadtest-${workers}w` });

    saveInfraConfig({
      postgres: { enabled: true, connectionString: isolated.href },
      redis: { enabled: false }, mq: { enabled: false }, oss: { enabled: false }, systemMail: { enabled: false },
    });
    await pgInfra.initPostgres();
    pool = pgInfra.getPostgresPool();
    await pool.query(STORAGE_SCHEMA);
    await pool.query(AUXILIARY_SCHEMA);
    await migrateJobs(pool);

    const repo = new JobRepository(pool, { leaseMs: 30000, retry: { baseMs: 50, maxMs: 200, random: () => 1 } });
    const scope = index => ({ tenantId: 'tenant-load', ownerId: 'owner-load', mailboxId: `${suffix}-box-${index % mailboxes}` });

    // ---- Seed the backlog ------------------------------------------------------------
    const seedStarted = Date.now();
    const ids = [];
    let cursor = 0;
    const seedConcurrency = Math.min(16, Math.max(4, workers * 4));
    await Promise.all(Array.from({ length: seedConcurrency }, async () => {
      while (!aborted) {
        const index = cursor++;
        if (index >= jobs) return;
        const { job } = await repo.enqueue({ ...scope(index), kind: 'mailbox.sync', idempotencyKey: `${suffix}-${index}`,
          payload: { index, emails: 1 } });
        ids.push(job.id);
      }
    }));
    const seedMs = Date.now() - seedStarted;

    // ---- Handlers -------------------------------------------------------------------
    let counter = 0;
    const handler = async (job, { steps, checkpoint }) => {
      const attempt = Number(job.attempts) || 1;
      const startedAt = Date.now();
      const record = { jobId: job.id, mailboxId: job.mailbox_id, attempt, startedAt, workMs };
      handlerRecords.push(record);
      try {
        const index = Number(job.payload?.index ?? 0);
        if (failureRate > 0 && (index % Math.round(1 / failureRate)) === 0) {
          throw Object.assign(new Error('synthetic terminal failure'), { retryable: false, code: 'SYNTHETIC_FAILURE' });
        }
        // Emulate CPU + parse cost without touching any external system.
        if (workMs > 0) {
          const deadline = Date.now() + workMs;
          let acc = 0;
          while (Date.now() < deadline) { for (let spin = 0; spin < 200; spin += 1) acc += Math.sqrt(spin); }
          if (acc === -1) throw new Error('unreachable');
        }
        if (!(await steps()).some(step => step.name === 'parsed')) await checkpoint('parsed', { index });
        record.outcome = 'succeeded';
        return { index };
      } catch (error) {
        record.outcome = error.retryable === false ? 'failed' : 'retried';
        throw error;
      } finally { record.endedAt = Date.now(); }
    };

    const workerId = role => `load-${role}`;
    const runWorkers = Array.from({ length: workers }, (_, index) => new JobWorker(
      repo, { 'mailbox.sync': handler }, { workerId: workerId(index), pollMs: 25, heartbeatMs: 2000, timeoutMs: 60000 }));
    const transports = Array.from({ length: workers }, (_, index) => new JobTransport(repo, {
      url: brokerUrl, queue, operationMs: 4000, pollMs: 100, onError: () => {} }));
    const controller = new AbortController();
    const running = [
      ...runWorkers.map((worker, index) => worker.run({ signal: controller.signal }).catch(error => {
        series.push({ note: `worker ${index} stopped: ${error?.message || error}` });
      })),
      ...transports.map(transport => transport.run({ signal: controller.signal }).catch(() => {})),
    ];

    // ---- Drain, sampling resources and queue depth ----------------------------------
    const startedAt = Date.now();
    const cpuAtStart = process.cpuUsage();
    let peakRss = 0;
    let lastCompleted = 0;
    let lastSampleAt = startedAt;
    let inflightPeak = 0;
    let terminal = 0;
    let statusCounts = {};
    while (Date.now() - startedAt < timeoutMs) {
      await pause(200);
      const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM daylight_jobs GROUP BY status`);
      statusCounts = Object.fromEntries(rows.map(row => [row.status, row.n]));
      terminal = (statusCounts.succeeded || 0) + (statusCounts.failed || 0) + (statusCounts.cancelled || 0);
      const active = (statusCounts.running || 0) + (statusCounts.queued || 0);
      inflightPeak = Math.max(inflightPeak, active);
      const now = Date.now();
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      const cpu = process.cpuUsage(cpuAtStart);
      const elapsed = (now - startedAt) / 1000;
      const sampleMs = now - lastSampleAt;
      series.push({
        at: new Date(now).toISOString(), schema, workers, metricsMode, elapsedMs: now - startedAt,
        completed: terminal, completedDelta: terminal - lastCompleted, running: statusCounts.running || 0, queued: statusCounts.queued || 0,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        cpuPercent: Number((((cpu.user + cpu.system) / 1000) / elapsed).toFixed(2)),
        throughputPerSec: Number((terminal / elapsed).toFixed(3)),
        instantThroughputPerSec: sampleMs > 0 ? Number(((terminal - lastCompleted) / (sampleMs / 1000)).toFixed(3)) : 0,
      });
      lastCompleted = terminal;
      lastSampleAt = now;
      if (terminal >= jobs) break;
    }
    const drainMs = Date.now() - startedAt;
    const cpuUsed = process.cpuUsage(cpuAtStart);

    // ---- Stop the workers cleanly ----------------------------------------------------
    controller.abort();
    await Promise.allSettled(running);
    await jobPause(50).catch(() => {});

    // ---- Collect results -------------------------------------------------------------
    const rows = (await pool.query(`SELECT id, mailbox_id, status, attempts, created_at, finished_at, error FROM daylight_jobs`)).rows;
    const byId = new Map(handlerRecords.map(record => [record.jobId, record]));
    const raw = rows.map(row => {
      const record = byId.get(row.id);
      const created = new Date(row.created_at).getTime();
      const finished = row.finished_at ? new Date(row.finished_at).getTime() : null;
      return {
        config: `${workers}w-${metricsMode}${workMs ? `-${workMs}ms` : ''}${mailboxes === 1 ? '-1mb' : ''}`,
        jobId: row.id, mailboxId: row.mailbox_id, status: row.status, attempts: Number(row.attempts),
        createdAt: row.created_at, finishedAt: row.finished_at,
        queueWaitMs: record ? record.startedAt - created : null,
        serviceMs: record ? record.endedAt - record.startedAt : null,
        endToEndMs: finished ? finished - created : null,
        error: row.error?.code || null,
      };
    });
    const statusOf = [...new Set(raw.map(item => item.status))].sort();
    const succeeded = raw.filter(item => item.status === 'succeeded').length;
    const failed = raw.filter(item => item.status === 'failed').length;
    metrics.flushMetrics();
    await metrics.writeMetricsSummary();
    const result = {
      config: { workers, jobs, mailboxes, workMs, failureRate, metricsMode, schema, queue,
        poolMax: Number(process.env.DAYLIGHT_PG_POOL_MAX) },
      startedAt: new Date(startedAt).toISOString(),
      statusCounts, statusOf,
      terminal, succeeded, failed, remaining: jobs - terminal,
      seedMs, drainMs,
      seedThroughputPerSec: Number((jobs / (seedMs / 1000)).toFixed(2)),
      drainThroughputPerSec: Number((terminal / (drainMs / 1000)).toFixed(2)),
      queueDepthPeak: inflightPeak,
      queueWaitMs: distribution(raw.map(item => item.queueWaitMs)),
      serviceMs: distribution(raw.map(item => item.serviceMs)),
      endToEndMs: distribution(raw.map(item => item.endToEndMs)),
      attempts: distribution(raw.map(item => item.attempts)),
      resources: {
        peakRssBytes: peakRss,
        endRssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        cpuSeconds: Number(((cpuUsed.user + cpuUsed.system) / 1e6).toFixed(3)),
        cpuPercentOfCore: Number((((cpuUsed.user + cpuUsed.system) / 1e6) / (drainMs / 1000) * 100).toFixed(2)),
        rssPerWorkerBytes: Math.round(peakRss / workers),
      },
      metrics: metricsMode === 'on' ? metrics.metricsSummary() : null,
      environment: {
        node: process.version, platform: `${process.platform}/${process.arch}`,
        cpuModel: os.cpus()[0]?.model || 'unknown', cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
    };
    return { result, raw, series: series.filter(item => item.schema) };
  } finally {
    aborted = true;
    try { const pgInfra = await import('../server/infra/postgres.js'); await pgInfra.closePostgres?.(); } catch { /* ignore */ }
    try { await q.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* ignore */ }
    await admin.end().catch(() => {});
    if (previous.data === undefined) delete process.env.DAYLIGHT_DATA_DIR; else process.env.DAYLIGHT_DATA_DIR = previous.data;
    if (previous.runtime === undefined) delete process.env.DAYLIGHT_RUNTIME; else process.env.DAYLIGHT_RUNTIME = previous.runtime;
    if (previous.metrics === undefined) delete process.env.DAYLIGHT_METRICS; else process.env.DAYLIGHT_METRICS = previous.metrics;
    if (previous.metricsDir === undefined) delete process.env.DAYLIGHT_METRICS_DIR; else process.env.DAYLIGHT_METRICS_DIR = previous.metricsDir;
    if (previous.pool === undefined) delete process.env.DAYLIGHT_PG_POOL_MAX; else process.env.DAYLIGHT_PG_POOL_MAX = previous.pool;
  }
}

/** Spawns this file once per configuration so metrics on/off never share a module cache. */
async function runChild(config, outDir) {
  const args = ['--run', '--json', '--no-write', '--workers', String(config.workers), '--jobs', String(config.jobs),
    '--mailboxes', String(config.mailboxes), '--work-ms', String(config.workMs),
    '--failure-rate', String(config.failureRate), '--metrics', config.metricsMode,
    '--timeout-ms', String(config.timeoutMs)];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: root,
    env: { ...process.env, DAYLIGHT_METRICS: config.metricsMode === 'on' ? '1' : '0', DAYLIGHT_RUNTIME: '',
      DAYLIGHT_METRICS_DIR: path.join(outDir, 'metrics', `${config.label}`),
      ...(config.pool ? { DAYLIGHT_PG_POOL_MAX: String(config.pool) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) throw new Error(`Run ${config.label} failed (exit ${code}): ${stderr.slice(-2000)}`);
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  return parsed;
}

function writeOutputs(outDir, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw.jsonl'), payload.raw.map(item => JSON.stringify(item)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(payload.summary, null, 2));
  const header = 'at,config,elapsedMs,completed,completedDelta,running,queued,rssBytes,heapUsedBytes,cpuPercent,throughputPerSec,instantThroughputPerSec';
  const lines = payload.series.map(item => [item.at, item.config ?? item.schema, item.elapsedMs, item.completed, item.completedDelta,
    item.running, item.queued, item.rssBytes, item.heapUsedBytes, item.cpuPercent, item.throughputPerSec, item.instantThroughputPerSec].join(','));
  fs.writeFileSync(path.join(outDir, 'series.csv'), `${header}\n${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.LOAD_TEST_DATABASE_URL || 'postgresql://127.0.0.1/postgres';
  const brokerUrl = process.env.LOAD_TEST_AMQP_URL || 'amqp://daylight:daylight@127.0.0.1:5672';
  const outDir = process.env.LOAD_TEST_OUT || path.join(root, 'work', `load-test-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const git = await import('node:child_process').then(({ execFileSync }) => {
    try { return { sha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 }; }
    catch { return { sha: 'unknown', dirty: null }; }
  });

  if (args.run) {
    if (args.pool) process.env.DAYLIGHT_PG_POOL_MAX = String(args.pool);
    const result = await runConfiguration({ ...args, metricsMode: args.metrics, databaseUrl, brokerUrl, outDir });
    const payload = { raw: result.raw, series: result.series.map(item => ({ ...item, config: result.result.config.workers + 'w' })),
      summary: { generatedAt: new Date().toISOString(), git, outDir, mode: 'single', runs: [result.result] } };
    if (!args.noWrite) writeOutputs(outDir, payload);
    process.stdout.write(`${JSON.stringify({ result: result.result, raw: result.raw, series: payload.series, outDir })}\n`);
    return;
  }

  if (!args.matrix) throw new Error('Pass --matrix to run the full matrix or --run for one configuration');

  const repetitions = Math.max(1, Math.min(10, args.repeat));
  const overheadJobs = Math.max(200, args.jobs);
  const overheadConfig = (metricsMode, round) => ({
    label: `overhead-${metricsMode === 'on' ? 'on' : 'off'}#${round}`, workers: 2, jobs: overheadJobs,
    mailboxes: args.mailboxes, workMs: 0, failureRate: 0, metricsMode, timeoutMs: args.timeoutMs,
  });
  const configurations = [
    { label: '1w-metrics-on', workers: 1, jobs: args.jobs, mailboxes: args.mailboxes, workMs: 0, failureRate: args.failureRate, metricsMode: 'on', timeoutMs: args.timeoutMs },
    { label: '2w-metrics-on', workers: 2, jobs: args.jobs, mailboxes: args.mailboxes, workMs: 0, failureRate: args.failureRate, metricsMode: 'on', timeoutMs: args.timeoutMs },
    { label: '4w-metrics-on', workers: 4, jobs: args.jobs, mailboxes: args.mailboxes, workMs: 0, failureRate: args.failureRate, metricsMode: 'on', timeoutMs: args.timeoutMs },
    { label: '4w-pool-5', workers: 4, jobs: args.jobs, mailboxes: args.mailboxes, workMs: 0, failureRate: args.failureRate, metricsMode: 'on', pool: 5, timeoutMs: args.timeoutMs },
    { label: '2w-single-mailbox', workers: 2, jobs: Math.min(120, args.jobs), mailboxes: 1, workMs: 0, failureRate: args.failureRate, metricsMode: 'on', timeoutMs: args.timeoutMs },
    { label: '2w-work-25ms', workers: 2, jobs: Math.min(240, args.jobs), mailboxes: args.mailboxes, workMs: 25, failureRate: args.failureRate, metricsMode: 'on', timeoutMs: args.timeoutMs },
    { label: '2w-failures-10pct', workers: 2, jobs: Math.min(240, args.jobs), mailboxes: args.mailboxes, workMs: 0, failureRate: 0.1, metricsMode: 'on', timeoutMs: args.timeoutMs },
    // Interleaved repetitions, because a single pair cannot separate overhead from noise.
    ...Array.from({ length: repetitions }, (_, index) => overheadConfig('off', index + 1)),
    ...Array.from({ length: repetitions }, (_, index) => overheadConfig('on', index + 1)),
  ];

  const runs = [];
  const raw = [];
  const series = [];
  for (const config of configurations) {
    process.stdout.write(`### ${config.label} ... `);
    const started = Date.now();
    const output = await runChild(config, outDir);
    runs.push({ ...output.result, label: config.label });
    raw.push(...output.raw);
    series.push(...output.series.map(item => ({ ...item, config: config.label })));
    process.stdout.write(`drained ${output.result.terminal}/${config.jobs} in ${(output.result.drainMs / 1000).toFixed(2)}s `
      + `=> ${output.result.drainThroughputPerSec} jobs/s, p95 e2e ${output.result.endToEndMs.p95}ms (${((Date.now() - started) / 1000).toFixed(1)}s wall)\n`);
  }

  const byLabel = Object.fromEntries(runs.map(run => [run.label, run]));
  const scaling = Object.fromEntries(['1w-metrics-on', '2w-metrics-on', '4w-metrics-on'].map(label => [label, byLabel[label]?.drainThroughputPerSec ?? null]));
  const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Number(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(3));
  };
  const spread = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length < 2) return null;
    const mid = median(sorted);
    return { min: sorted[0], max: sorted.at(-1), median: mid,
      spreadPercent: Number((((sorted.at(-1) - sorted[0]) / mid) * 100).toFixed(2)) };
  };
  const onRuns = runs.filter(run => run.label.startsWith('overhead-on'));
  const offRuns = runs.filter(run => run.label.startsWith('overhead-off'));
  const onThroughput = onRuns.map(run => run.drainThroughputPerSec);
  const offThroughput = offRuns.map(run => run.drainThroughputPerSec);
  const onSpread = spread(onThroughput);
  const offSpread = spread(offThroughput);
  const overhead = onRuns.length && offRuns.length ? {
    repetitions: onRuns.length,
    throughputSamplesWithMetrics: onThroughput,
    throughputSamplesWithoutMetrics: offThroughput,
    withMetrics: onSpread,
    withoutMetrics: offSpread,
    throughputDeltaPercent: Number((((onSpread.median - offSpread.median) / offSpread.median) * 100).toFixed(2)),
    observedNoisePercent: Number(Math.max(onSpread.spreadPercent, offSpread.spreadPercent).toFixed(2)),
    p95LatencyWithMetrics: median(onRuns.map(run => run.endToEndMs.p95)),
    p95LatencyWithoutMetrics: median(offRuns.map(run => run.endToEndMs.p95)),
    conclusion: Math.abs((onSpread.median - offSpread.median) / offSpread.median * 100) > Math.max(onSpread.spreadPercent, offSpread.spreadPercent)
      ? 'delta exceeds the observed run-to-run spread' : 'delta is within the observed run-to-run spread',
    note: 'Paired interleaved runs compared by median; the spread across identical runs is reported so a noisy machine cannot be presented as instrumentation overhead.',
  } : null;

  const summary = {
    generatedAt: new Date().toISOString(), git, outDir,
    scope: 'job platform only: real PostgreSQL + RabbitMQ, synthetic handler, no model/IMAP/SMTP/OSS calls',
    workerModel: 'all workers of one configuration share a single Node process',
    caveats: [
      'Workers for a configuration run inside one Node process, so CPU-bound configurations under-report multi-core scaling; the production topology is one worker per pod, scaled horizontally.',
      'The handler is synthetic: no model, IMAP, SMTP or OSS calls are made. These numbers measure the job platform (PostgreSQL + RabbitMQ round-trips and lease bookkeeping), not end-to-end business latency.',
      'The single-mailbox configuration is serialized by design (head-of-line ordering prevents a reschedule being applied before the original invitation), so its lower throughput is a correctness property rather than a regression.',
      'Percentiles come from per-job rows in PostgreSQL (queue wait, end-to-end) plus in-process handler timings (service time), so they can be recomputed from raw.jsonl.',
    ],
    environment: runs[0]?.environment ?? null,
    runs,
    analysis: {
      scaling,
      metricsOverhead: overhead,
      serializationBound: {
        parallelMailboxes: byLabel['2w-metrics-on']?.drainThroughputPerSec ?? null,
        singleMailbox: byLabel['2w-single-mailbox']?.drainThroughputPerSec ?? null,
        note: 'One mailbox is processed strictly in order, so this is the designed per-mailbox bound, not a regression.',
      },
      heavyWork: {
        workMs: 25,
        throughputPerSec: byLabel['2w-work-25ms']?.drainThroughputPerSec ?? null,
        cpuPercentOfCore: byLabel['2w-work-25ms']?.resources.cpuPercentOfCore ?? null,
      },
      poolSizing: byLabel['4w-pool-5'] ? {
        autoPool: byLabel['4w-metrics-on']?.config.poolMax ?? null,
        autoPoolThroughput: byLabel['4w-metrics-on']?.drainThroughputPerSec ?? null,
        fixedPool5Throughput: byLabel['4w-pool-5'].drainThroughputPerSec,
        note: 'Worker count, not SQL, sets the pool requirement: claims, heartbeats and outbox publishes each borrow a connection.',
      } : null,
      failurePath: byLabel['2w-failures-10pct'] ? {
        failureRate: 0.1,
        failed: byLabel['2w-failures-10pct'].failed,
        succeeded: byLabel['2w-failures-10pct'].succeeded,
        throughputPerSec: byLabel['2w-failures-10pct'].drainThroughputPerSec,
        note: 'Terminal failures are recorded once and never retried, so a permanently broken mailbox cannot cause a retry storm.',
      } : null,
    },
  };
  writeOutputs(outDir, { raw, series, summary });
  process.stdout.write(`\nEvidence directory: ${outDir}\n`);
  process.stdout.write(`  raw.jsonl    ${raw.length} per-job records\n  series.csv   ${series.length} per-second samples\n  summary.json matrix + analysis\n`);
  for (const run of runs) {
    process.stdout.write(`  ${run.label.padEnd(20)} drain=${String(run.drainThroughputPerSec).padStart(8)} jobs/s `
      + `seed=${String(run.seedThroughputPerSec).padStart(8)} jobs/s p95e2e=${String(run.endToEndMs.p95).padStart(7)}ms `
      + `p95queue=${String(run.queueWaitMs.p95).padStart(7)}ms rss=${(run.resources.peakRssBytes / 1048576).toFixed(0)}MiB cpu=${run.resources.cpuPercentOfCore}%\n`);
  }
  if (overhead) process.stdout.write(`  metrics overhead: ${overhead.throughputDeltaPercent}% throughput at 2 workers `
    + `(${overhead.withMetrics.median} vs ${overhead.withoutMetrics.median} jobs/s median of ${overhead.repetitions}; `
    + `observed spread ${overhead.observedNoisePercent}% -> ${overhead.conclusion})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => { process.exitCode = 0; }).catch(error => {
    process.stderr.write(`Load test failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
