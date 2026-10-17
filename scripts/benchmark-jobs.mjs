/** Isolated real-PG task benchmark. No application settings or external model imports. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { migrateJobs } from '../server/jobs/schema.js';
import { JobRepository } from '../server/jobs/repository.js';
import { JobWorker, pause } from '../server/jobs/runtime.js';

function number(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const config = {
  jobs: number('BENCH_JOBS', 100, 1, 100000),
  concurrency: number('BENCH_CONCURRENCY', 4, 1, 128),
  mailboxes: number('BENCH_MAILBOXES', 16, 1, 100000),
  stubMs: number('BENCH_STUB_MS', 20, 0, 60000),
  failEvery: number('BENCH_FAIL_EVERY', 0, 0, 100000),
  timeoutMs: number('BENCH_TIMEOUT_MS', 120000, 1000, 3600000),
};
if (!process.env.JOBS_TEST_DATABASE_URL) throw new Error('Set JOBS_TEST_DATABASE_URL to a dedicated test PostgreSQL instance');
const runId = `jobs_bench_${randomUUID().replaceAll('-', '')}`;
const output = resolve(process.env.BENCH_OUTPUT_DIR || `work/${runId}`);
await mkdir(output, { recursive: true });
let commit = 'unknown';
let dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
} catch { /* A source archive has no git metadata. */ }
const connectionString = process.env.JOBS_TEST_DATABASE_URL;
const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000, query_timeout: 10000 });
const pool = new pg.Pool({ connectionString, max: config.concurrency + 2,
  options: `-c search_path=${runId} -c statement_timeout=8000 -c lock_timeout=5000`,
  connectionTimeoutMillis: 3000, query_timeout: 10000 });
const repository = new JobRepository(pool, { leaseMs: 120000 });
const rows = [];
const samples = [];
const submitted = new Map();
const scope = { tenantId: runId, ownerId: runId };
let created = false;
let sampler;
let failure = null;
let started;
let cpu;
let databaseVersion = null;
const percentile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
};
try {
  await admin.query(`CREATE SCHEMA ${runId}`);
  created = true;
  await migrateJobs(pool);
  databaseVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
  started = performance.now();
  cpu = process.cpuUsage();
  const sample = () => samples.push({ type: 'resource', elapsedMs: performance.now() - started,
    rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage(cpu) });
  sample();
  sampler = setInterval(sample, 100);
  // A bounded burst: enqueue sequentially, then drain concurrently; admission is included in latency.
  for (let index = 0; index < config.jobs; index++) {
    const at = performance.now();
    const { job } = await repository.enqueue({ ...scope, mailboxId: `mailbox-${index % config.mailboxes}`,
      kind: 'benchmark.stub', idempotencyKey: String(index), payload: { index }, maxAttempts: 1 });
    submitted.set(job.id, { index, at, enqueueMs: performance.now() - at });
  }
  const deadline = started + config.timeoutMs;
  const workers = await Promise.allSettled(Array.from({ length: config.concurrency }, async (_, index) => {
    const worker = new JobWorker(repository, { 'benchmark.stub': async (job, context) => {
      await pause(config.stubMs, context.signal);
      context.signal.throwIfAborted();
      if (config.failEvery && (job.payload.index + 1) % config.failEvery === 0) {
        throw Object.assign(new Error('Injected stub failure'), { code: 'BENCH_INJECTED', retryable: false });
      }
      await context.checkpoint('stub.persist', { synthetic: true });
      return { synthetic: true };
    } }, { timeoutMs: Math.max(1000, config.stubMs + 10000) });
    while (performance.now() < deadline) {
      const job = await repository.claim({ workerId: `bench-${index}` });
      if (!job) {
        if (rows.length === config.jobs) return;
        await pause(5);
        continue;
      }
      const claimedAt = performance.now();
      await worker.execute(job);
      const final = await repository.getOwned({ ...scope, id: job.id });
      const input = submitted.get(job.id);
      rows.push({ type: 'job', id: job.id, index: input.index, status: final.status,
        errorCode: final.error?.code ?? null, attempts: final.attempts, enqueueMs: input.enqueueMs,
        queueMs: claimedAt - input.at, serviceMs: performance.now() - claimedAt,
        endToEndMs: performance.now() - input.at, censored: false });
    }
  }));
  const rejected = workers.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  sample();
} catch (error) {
  // Avoid logging connection strings, server exception details or credentials.
  failure = { code: error.code || error.name || 'BENCH_FAILED' };
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  const observedAt = performance.now();
  const completed = new Set(rows.map(row => row.id));
  for (const [id, input] of submitted) {
    if (!completed.has(id)) rows.push({ type: 'job', id, index: input.index, status: 'unobserved',
      endToEndMs: observedAt - input.at, censored: true });
  }
  const elapsedMs = started === undefined ? null : observedAt - started;
  const terminal = rows.filter(row => ['succeeded', 'failed', 'cancelled'].includes(row.status));
  const success = rows.filter(row => row.status === 'succeeded');
  const latency = data => ({ n: data.length, p50Ms: percentile(data.map(r => r.endToEndMs), .5),
    p95Ms: percentile(data.map(r => r.endToEndMs), .95) });
  const summary = {
    runId, at: new Date().toISOString(), commit, dirty, mode: 'real-pg-synthetic-handler-no-model', config,
    environment: { node: process.version, platform: platform(), arch: arch(), cpuCount: cpus().length, databaseVersion },
    failure, requested: config.jobs, admitted: submitted.size, observed: rows.length,
    succeeded: success.length, failed: terminal.filter(r => r.status === 'failed').length,
    censored: rows.filter(r => r.censored).length,
    nonSuccessRate: (config.jobs - success.length) / config.jobs,
    latencyTerminalIncludingFailures: latency(terminal), latencySuccessOnly: latency(success),
    elapsedMs, terminalPerSecond: elapsedMs ? terminal.length * 1000 / elapsedMs : null,
    cpuMicroseconds: cpu ? process.cpuUsage(cpu) : null,
    maxSampledRssBytes: samples.length ? Math.max(...samples.map(s => s.rssBytes)) : null,
    costs: { modelCalls: 0, modelCost: 'unknown/not-applicable', infrastructureCost: 'unknown', totalCost: 'unknown' },
    limitations: ['Burst admission then drain', 'One Node process', 'No MQ transport or HTTP',
      'No model, IMAP or SMTP', 'CPU/RSS exclude PostgreSQL', 'Censored jobs excluded from terminal percentiles; count and lower-bound latency retained'],
  };
  if (summary.censored || submitted.size !== config.jobs) process.exitCode = 1;
  try {
    await writeFile(resolve(output, 'raw.jsonl'), [...rows, ...samples].map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ output, ...summary }, null, 2));
  } finally {
    await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${runId} CASCADE`); }
    finally { await admin.end(); }
  }
}
