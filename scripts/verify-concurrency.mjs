/**
 * P2 concurrency verification: 20 race conditions exercised against real PostgreSQL,
 * a private Redis instance and a real RabbitMQ broker.
 *
 * How isolation works
 * - PostgreSQL: a dedicated schema created for this run and addressed through
 *   `options=-c search_path=<schema>`; the shared `public` schema is never touched.
 * - Redis: a private `redis-server` child process on a free loopback port (or
 *   `CONCURRENCY_TEST_REDIS_URL` when the caller already has an isolated instance).
 * - RabbitMQ: a queue name unique to this run; the broker is shared but the queue is not.
 *
 * Why local runtime: these checks drive the product's own modules (JobRepository,
 * JobWorker, JobTransport, the storage snapshot/CAS layer and the auth service) with
 * infrastructure injected via `saveInfraConfig`. That exercises exactly the code paths
 * production uses while keeping the run free of OSS/JWT/model configuration. Production
 * runtime itself is covered by `scripts/verify-production.mjs`.
 *
 * Run standalone:
 *   node scripts/verify-concurrency.mjs
 * Or through the test runner:
 *   DAYLIGHT_VERIFY_CONCURRENCY=1 node --test server/concurrency-suite.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Concurrency is only meaningful point-to-point: refuse anything but loopback. */
function loopback(value, label) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${label} must use loopback`);
  return url;
}

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function verifyConcurrency({
  databaseUrl = process.env.CONCURRENCY_TEST_DATABASE_URL || 'postgresql://127.0.0.1/postgres',
  brokerUrl = process.env.CONCURRENCY_TEST_AMQP_URL || 'amqp://daylight:daylight@127.0.0.1:5672',
  redisUrl = process.env.CONCURRENCY_TEST_REDIS_URL || '',
  keepEvidence = false,
} = {}) {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'work/concurrency-verify-'));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `conc_${suffix}`;
  const queue = `daylight.concurrency.${suffix}`;
  const previousDataDir = process.env.DAYLIGHT_DATA_DIR;
  const previousRuntime = process.env.DAYLIGHT_RUNTIME;
  process.env.DAYLIGHT_DATA_DIR = path.join(dir, 'data');
  process.env.DAYLIGHT_RUNTIME = 'local';
  fs.mkdirSync(process.env.DAYLIGHT_DATA_DIR, { recursive: true });

  const admin = new pg.Pool({ connectionString: loopback(databaseUrl, 'database').href, connectionTimeoutMillis: 5000 });
  const children = [];
  const checks = [];
  const startedAt = Date.now();
  let redisProcess = null;
  let clientCount = 0;
  const configure = [];

  async function check(name, description, fn) {
    const began = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, description, status: 'pass', ms: Date.now() - began, detail });
    } catch (error) {
      checks.push({ name, description, status: 'fail', ms: Date.now() - began, error: error?.message || String(error) });
    }
  }

  /** Each check owns a mailbox so that ordering between checks can never interfere. */
  const scopeFor = (name, index = 0) => ({
    tenantId: 'tenant-conc',
    ownerId: 'owner-conc',
    mailboxId: `conc-${suffix}-${name}${index ? `-${index}` : ''}`,
  });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = loopback(databaseUrl, 'database');
    isolated.searchParams.set('options', `-c search_path=${schema}`);

    // ---- Redis isolation -------------------------------------------------------------
    let resolvedRedis = redisUrl;
    if (!resolvedRedis) {
      const port = await freePort();
      redisProcess = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port),
        '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      redisProcess.stderr.on('data', () => {});
      children.push(redisProcess);
      await once(redisProcess, 'spawn');
      await until(async () => {
        const socket = net.connect({ host: '127.0.0.1', port });
        try { await once(socket, 'connect'); return true; } catch { return false; } finally { socket.destroy(); }
      }, 'private redis to accept connections');
      const probe = new Redis({ host: '127.0.0.1', port, lazyConnect: true, retryStrategy: () => null });
      probe.on('error', () => { /* the probe is short lived; failures surface as a rejected connect */ });
      await probe.connect();
      const pong = await probe.ping();
      await probe.quit();
      assert.equal(pong, 'PONG', 'the private Redis answers PING');
      resolvedRedis = `redis://127.0.0.1:${port}`;
    }
    loopback(resolvedRedis, 'redis');

    // ---- Product modules (imported after the data directory is redirected) ----------
    const { saveInfraConfig, readInfraConfig } = await import('../server/infra/config.js');
    const pgInfra = await import('../server/infra/postgres.js');
    const redisInfra = await import('../server/infra/redis.js');
    const sessions = await import('../server/infra/sessions.js');
    const auth = await import('../server/auth.js');
    const { JobRepository, LeaseLostError } = await import('../server/jobs/repository.js');
    const { JobWorker } = await import('../server/jobs/runtime.js');
    const { JobTransport } = await import('../server/jobs/rabbit.js');
    const { migrateJobs } = await import('../server/jobs/schema.js');
    const { AUXILIARY_SCHEMA } = await import('../server/storage/aux-schema.js');
    const { STORAGE_SCHEMA } = await import('../server/storage/schema.js');
    const storage = await import('../server/storage/index.js');

    saveInfraConfig({
      postgres: { enabled: true, connectionString: isolated.href },
      redis: { enabled: true, url: resolvedRedis },
      mq: { enabled: false },
      oss: { enabled: false },
      systemMail: { enabled: false },
    });
    // Mirrors the resolution order inside server/auth.js so the suite signs the same tokens.
    const jwtSecret = readInfraConfig().auth.jwtSecret || process.env.DAYLIGHT_JWT_SECRET || 'daylight-dev-secret-change-me';
    assert.ok(jwtSecret.length >= 8, 'a jwt secret is available for session checks');

    await pgInfra.initPostgres();
    assert.equal(pgInfra.postgresMode(), 'postgres', 'isolated PostgreSQL must be reachable');
    const redisReady = await redisInfra.initRedis();
    assert.equal(redisReady.mode, 'redis', 'isolated Redis must be reachable');
    const pool = pgInfra.getPostgresPool();

    // Storage + jobs DDL. SCHEMA itself is applied by initPostgres above.
    await pool.query(STORAGE_SCHEMA);
    await pool.query(AUXILIARY_SCHEMA);
    await migrateJobs(pool);

    // ---- Fixtures -------------------------------------------------------------------
    const settingsPayload = {
      mailboxes: [
        { id: `conc-${suffix}-box`, ownerUserId: 'owner-conc', autoSync: false },
        { id: `conc-${suffix}-other`, ownerUserId: 'owner-conc', autoSync: false },
      ],
      activeMailboxId: `conc-${suffix}-box`,
    };
    await pool.query(`INSERT INTO app_settings (id, payload, updated_at, version) VALUES ('default',$1::jsonb,clock_timestamp(),1)`, [JSON.stringify(settingsPayload)]);
    await pool.query(`INSERT INTO mailbox_calendars (mailbox_id, payload, updated_at, version) VALUES ($1,$2::jsonb,clock_timestamp(),1)`,
      [`conc-${suffix}-box`, JSON.stringify({ events: [], processed: [], processedIds: [] })]);

    const repo = new JobRepository(pool, { leaseMs: 250, retry: { baseMs: 10, maxMs: 20, random: () => 1 } });

    /** Outbox rows are shared across checks: claim until the row for `jobId` surfaces. */
    const outboxRowFor = async (jobId, leaseMs = 5000) => {
      for (let round = 0; round < 40; round += 1) {
        const rows = await repo.claimOutbox({ limit: 10, leaseMs });
        if (!rows.length) return null;
        const mine = rows.find(row => row.job_id === jobId);
        for (const row of rows) if (row.id !== mine?.id) await repo.confirmOutbox(row.id, row.lease_token);
        if (mine) return mine;
      }
      return null;
    };

    // ================= Job queue: enqueue and claim ==================================
    // The queue table is shared by every check, so any assertion about what a global
    // `claim()` does is scoped to an explicit job id. Only `enqueue-idempotent-race`
    // inspects the table by mailbox.
    await check('enqueue-idempotent-race',
      '24 concurrent producers with one idempotency key create exactly one job',
      async () => {
        const scope = scopeFor('idem');
        const results = await Promise.all(Array.from({ length: 24 }, () => repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'shared' })));
        const created = results.filter(result => result.created);
        const ids = new Set(results.map(result => result.job.id));
        assert.equal(created.length, 1, `exactly one producer created the job, saw ${created.length}`);
        assert.equal(ids.size, 1, 'all producers observe the same job id');
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM daylight_jobs WHERE mailbox_id=$1', [scope.mailboxId]);
        assert.equal(rows[0].n, 1);
        return { created: created.length, rows: rows[0].n, jobId: [...ids][0] };
      });

    await check('mailbox-head-of-line',
      'jobs in one mailbox execute strictly in enqueue order',
      async () => {
        const scope = scopeFor('order');
        const ids = [];
        for (let index = 0; index < 5; index += 1) {
          const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: `k${index}`, payload: { index } });
          ids.push(job.id);
        }
        // Asking for a later job directly must fail while an earlier one is still queued.
        assert.equal(await repo.claim({ workerId: 'w-overtake', id: ids[2] }), null, 'a later job cannot overtake an earlier queued job');
        const first = await repo.claim({ workerId: 'w-order', id: ids[0] });
        assert.equal(first.id, ids[0], 'the earliest job is claimable');
        assert.equal(await repo.claim({ workerId: 'w-other', id: ids[1] }), null, 'a mailbox runs one job at a time');
        await repo.complete(first.id, first.lease_token);
        const next = await repo.claim({ workerId: 'w-order', id: ids[1] });
        assert.equal(next.id, ids[1], 'the next job follows in sequence');
        await repo.complete(next.id, next.lease_token);
        return { order: [0, 1] };
      });

    await check('parallel-mailboxes-claim-once',
      '24 concurrent claims across 12 mailboxes lease every job exactly once',
      async () => {
        const scopes = Array.from({ length: 12 }, (_, index) => scopeFor('fan', index + 1));
        const ids = [];
        for (const scope of scopes) ids.push((await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'one' })).job.id);
        // Interleave explicit ids so the concurrency is real but the target set is fixed.
        const targets = Array.from({ length: 24 }, (_, index) => ids[index % ids.length]);
        const claims = (await Promise.all(targets.map((id, index) => repo.claim({ workerId: `worker-${index}`, id })))).filter(Boolean);
        assert.equal(new Set(claims.map(job => job.id)).size, claims.length, 'no job was leased twice');
        assert.equal(new Set(claims.map(job => job.lease_token)).size, claims.length, 'every lease has a unique fencing token');
        assert.deepEqual([...new Set(claims.map(job => job.id))].sort(), [...ids].sort(), 'all twelve jobs were leased exactly once');
        return { leased: claims.length };
      });

    // ================= Job queue: lease fencing ======================================
    await check('stale-lease-writes-fenced',
      'a worker whose lease expired cannot checkpoint, complete or fail the job',
      async () => {
        const scope = scopeFor('fence');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'fence' });
        const first = await repo.claim({ workerId: 'w1', id: job.id });
        await pause(320); // outlive leaseMs=250
        const taken = (await repo.recoverExpired()).filter(item => item.id === job.id);
        assert.equal(taken.length, 1, 'the expired lease is recovered');
        await pause(40); // clear the retry backoff before the takeover
        const second = await repo.claim({ workerId: 'w2', id: job.id });
        assert.ok(second, 'a second worker takes over');
        assert.notEqual(second.lease_token, first.lease_token);
        await assert.rejects(repo.checkpoint(first.id, first.lease_token, 'stale', { ok: true }), error => error instanceof LeaseLostError);
        await assert.rejects(repo.complete(first.id, first.lease_token, { ok: true }), error => error instanceof LeaseLostError);
        await assert.rejects(repo.fail(first.id, first.lease_token, { code: 'STALE' }, { retryable: false }), error => error instanceof LeaseLostError);
        assert.equal((await repo.steps(second.id, second.lease_token)).length, 0, 'the fenced worker wrote no checkpoint row');
        assert.equal((await repo.getOwned({ ...scope, id: job.id })).status, 'running', 'the job still belongs to the live worker');
        await repo.complete(second.id, second.lease_token);
        return { fenced: 3 };
      });

    await check('crash-after-checkpoint-exactly-once',
      'a crash after checkpointing re-runs without repeating the checkpointed effect',
      async () => {
        const scope = scopeFor('once');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'once' });
        let effects = 0;
        const handler = async (jobInfo, { steps, checkpoint }) => {
          if ((await steps()).some(step => step.name === 'effect')) return { skipped: true };
          effects += 1;
          await checkpoint('effect', { applied: true });
          throw Object.assign(new Error('simulated crash after the effect was checkpointed'), { code: 'SIMULATED_CRASH' });
        };
        const worker = new JobWorker(repo, { probe: handler }, { workerId: 'w-crash', pollMs: 20, heartbeatMs: 60, timeoutMs: 2000 });
        const signal = new AbortController().signal;
        const claimed = await repo.claim({ workerId: 'w-crash', id: job.id });
        await worker.execute(claimed, signal);
        assert.equal(effects, 1, 'the effect ran once');
        assert.equal((await repo.getOwned({ ...scope, id: job.id })).status, 'queued', 'a retryable crash is requeued');
        await pause(60); // clear the retry backoff
        const retry = await repo.claim({ workerId: 'w-crash', id: job.id });
        assert.ok(retry, 'the retry is claimable');
        await worker.execute(retry, signal);
        assert.equal(effects, 1, 'the checkpointed effect is not repeated');
        assert.equal((await repo.getOwned({ ...scope, id: job.id })).status, 'succeeded');
        return { effects };
      });

    await check('recover-expired-single',
      'concurrent lease recovery requeues a job once and never duplicates attempts',
      async () => {
        const scope = scopeFor('recover');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'recover', maxAttempts: 10 });
        const claimed = await repo.claim({ workerId: 'w-exp', id: job.id });
        await pause(320);
        const rounds = await Promise.all(Array.from({ length: 8 }, () => repo.recoverExpired()));
        const recovered = rounds.flat().filter(item => item.id === job.id);
        assert.equal(recovered.length, 1, `exactly one caller recovered the job, saw ${recovered.length}`);
        const after = await repo.getOwned({ ...scope, id: job.id });
        assert.equal(after.status, 'queued');
        assert.equal(after.attempts, 1, 'recovery did not consume an extra attempt');
        return { recovered: recovered.length, attempts: after.attempts };
      });

    await check('heartbeat-fends-off-recovery',
      'a live heartbeat keeps the lease so no other worker can take the job',
      async () => {
        const scope = scopeFor('beat');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'beat' });
        const claimed = await repo.claim({ workerId: 'w-live', id: job.id });
        for (let index = 0; index < 4; index += 1) { await pause(120); await repo.heartbeat(claimed.id, claimed.lease_token); }
        const stolen = (await repo.recoverExpired()).filter(item => item.id === job.id);
        assert.equal(stolen.length, 0, 'an extended lease is not treated as expired');
        assert.equal(await repo.claim({ workerId: 'w-thief', id: job.id }), null, 'nobody else can claim a running job');
        assert.equal((await repo.getOwned({ ...scope, id: job.id })).worker_id, 'w-live');
        await repo.complete(claimed.id, claimed.lease_token);
        return { heartbeats: 4 };
      });

    // ================= Job queue: owner transitions ==================================
    await check('concurrent-retry-one-winner',
      'concurrent manual retries of a failed job requeue it exactly once',
      async () => {
        const scope = scopeFor('retry');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'retry' });
        const claimed = await repo.claim({ workerId: 'w-retry', id: job.id });
        await repo.fail(claimed.id, claimed.lease_token, { code: 'FAILED' }, { retryable: false });
        const results = await Promise.all(Array.from({ length: 8 }, () => repo.retryOwned({ ...scope, id: job.id })));
        const winners = results.filter(Boolean);
        assert.equal(winners.length, 1, `exactly one retry won, saw ${winners.length}`);
        const after = await repo.getOwned({ ...scope, id: job.id });
        assert.equal(after.status, 'queued');
        assert.equal(after.attempts, 0, 'a manual retry resets the attempt budget');
        await repo.cancelOwned({ ...scope, id: job.id });
        return { winners: winners.length };
      });

    await check('concurrent-cancel-one-winner',
      'concurrent cancellations flip a queued job to cancelled exactly once',
      async () => {
        const scope = scopeFor('cancel');
        await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'cancel-head' });
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'cancel-target' });
        const results = await Promise.all(Array.from({ length: 8 }, () => repo.cancelOwned({ ...scope, id: job.id })));
        assert.equal(results.filter(Boolean).length, 1, 'exactly one cancellation wins');
        assert.equal((await repo.getOwned({ ...scope, id: job.id })).status, 'cancelled');
        return { winners: 1 };
      });

    await check('cancel-then-claim-no-resurrect',
      'a cancelled head-of-line job is never leased and does not block the next job',
      async () => {
        const scope = scopeFor('resurrect');
        const { job: first } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'first' });
        const { job: second } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'second' });
        await repo.cancelOwned({ ...scope, id: first.id });
        assert.equal(await repo.claim({ workerId: 'w-cancel', id: first.id }), null, 'the cancelled job is not resurrected');
        const claim = await repo.claim({ workerId: 'w-cancel', id: second.id });
        assert.ok(claim, 'the following job is still claimable');
        assert.equal(claim.id, second.id);
        await repo.complete(claim.id, claim.lease_token);
        return { skipped: true };
      });

    await check('tenant-isolation-under-race',
      'identical mailbox ids and keys in two tenants never cross claim or read',
      async () => {
        const mailboxId = `conc-${suffix}-shared`;
        const a = { tenantId: 'tenant-a', ownerId: 'owner-a', mailboxId };
        const b = { tenantId: 'tenant-b', ownerId: 'owner-b', mailboxId };
        const [jobA, jobB] = await Promise.all([
          repo.enqueue({ ...a, kind: 'probe', idempotencyKey: 'same' }),
          repo.enqueue({ ...b, kind: 'probe', idempotencyKey: 'same' }),
        ]);
        assert.notEqual(jobA.job.id, jobB.job.id, 'tenants own separate rows for identical keys');
        assert.equal(await repo.getOwned({ ...a, id: jobB.job.id }), null, 'a tenant cannot read the other tenant job');
        assert.equal(await repo.cancelOwned({ ...a, id: jobB.job.id }), null, 'a tenant cannot cancel the other tenant job');
        const ids = [jobA.job.id, jobB.job.id];
        const targets = Array.from({ length: 8 }, (_, index) => ids[index % 2]);
        const leased = (await Promise.all(targets.map((id, index) => repo.claim({ workerId: `iso-${index}`, id })))).filter(Boolean);
        assert.equal(leased.length, 2, `exactly one lease per tenant job, saw ${leased.length}`);
        assert.equal(new Set(leased.map(job => `${job.tenant_id}/${job.id}`)).size, 2, 'no cross-tenant duplicate lease');
        for (const job of leased) await repo.complete(job.id, job.lease_token);
        return { leased: leased.length };
      });

    // ================= Outbox / broker ===============================================
    await check('outbox-confirm-once',
      'enqueue writes one outbox row and only one concurrent confirm wins',
      async () => {
        const scope = scopeFor('outbox');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'outbox' });
        const claimed = await repo.claim({ workerId: 'w-outbox', id: job.id });
        await repo.complete(claimed.id, claimed.lease_token);
        const all = (await pool.query('SELECT id, attempts, published_at FROM daylight_job_outbox WHERE job_id=$1', [job.id])).rows;
        const unpublished = all.filter(row => !row.published_at);
        assert.equal(unpublished.length, 1, `exactly one unpublished outbox row exists, saw ${JSON.stringify(all)}`);
        const claimedRow = await outboxRowFor(job.id);
        assert.ok(claimedRow, 'the outbox row is claimable');
        const confirms = await Promise.all(Array.from({ length: 8 }, () => repo.confirmOutbox(claimedRow.id, claimedRow.lease_token)));
        assert.equal(confirms.filter(Boolean).length, 1, 'exactly one confirm wins');
        const after = (await pool.query('SELECT published_at FROM daylight_job_outbox WHERE id=$1', [claimedRow.id])).rows[0];
        assert.ok(after.published_at, 'the row is marked published');
        return { rows: all.length, confirms: 1 };
      });

    await check('outbox-stale-token-rejected',
      'a stale outbox lease token cannot confirm after a takeover',
      async () => {
        const scope = scopeFor('outbox-stale');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'stale' });
        const firstRow = await outboxRowFor(job.id, 200);
        assert.ok(firstRow, 'a short-lived outbox lease was taken');
        await pause(260);
        const [secondRow] = await repo.claimOutbox({ limit: 1, leaseMs: 5000 });
        assert.ok(secondRow, 'the row is claimable again after the lease expired');
        assert.equal(secondRow.id, firstRow.id);
        assert.notEqual(secondRow.lease_token, firstRow.lease_token);
        assert.equal(await repo.confirmOutbox(firstRow.id, firstRow.lease_token), false, 'the stale token is refused');
        assert.equal(await repo.confirmOutbox(secondRow.id, secondRow.lease_token), true, 'the live token confirms');
        return { fenced: true };
      });

    await check('mq-wakeup-and-duplicate-delivery',
      'the broker delivers a confirmed wake-up and re-delivery never double-executes',
      async () => {
        const scope = scopeFor('mq');
        const { job } = await repo.enqueue({ ...scope, kind: 'probe', idempotencyKey: 'mq' });
        const wakeups = [];
        const transport = new JobTransport(repo, { url: brokerUrl, queue, operationMs: 2000, pollMs: 50,
          onWake: message => { wakeups.push(message.messageId); } });
        const controller = new AbortController();
        const running = transport.run({ signal: controller.signal }).catch(() => {});
        try {
          await until(() => transport.status().ok, 'RabbitMQ transport connection');
          await until(() => wakeups.length >= 1, 'a confirmed wake-up');
          // Consuming and confirming are separate paths: the wake-up can be delivered on the
          // consumer channel before the publisher's confirmOutbox transaction is visible here.
          // The invariant is that a broker-confirmed publish does end up as a confirmed row.
          await until(async () => (await pool.query('SELECT published_at FROM daylight_job_outbox WHERE job_id=$1', [job.id])).rows[0]?.published_at,
            'the outbox row to be confirmed after a real publish confirm');
          const published = (await pool.query('SELECT published_at FROM daylight_job_outbox WHERE job_id=$1', [job.id])).rows[0];
          assert.ok(published.published_at, 'the outbox row was confirmed after a real publish confirm');
          // Re-delivery is expected by design: the second wake-up must find nothing to do.
          const first = await repo.claim({ workerId: 'w-mq', id: job.id });
          assert.equal(first.id, job.id);
          await repo.complete(first.id, first.lease_token);
          assert.equal(await repo.claim({ workerId: 'w-mq', id: job.id }), null, 'a duplicate wake-up cannot execute the job twice');
          assert.ok(wakeups.filter(Boolean).length >= 1, 'at least one wake-up carried a broker message id');
        } finally {
          controller.abort();
          await running;
        }
        assert.equal(transport.status().ok, false, 'the transport stops cleanly on abort');
        return { wakeups: wakeups.length };
      });

    // ================= Storage snapshot / CAS ========================================
    await check('snapshot-cas-conflict',
      'two writers on one snapshot version: exactly one commits, the loser is discarded',
      async () => {
        const mailboxId = `conc-${suffix}-box`;
        const before = await storage.createStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] });
        const beforeVersion = await storage.runStorageSnapshot(before, async () => storage.readSnapshotDocument(storage.calendarKey(mailboxId)).version);
        const [left, right] = await Promise.all([
          storage.createStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] }),
          storage.createStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] }),
        ]);
        assert.equal(left.version, right.version, 'both writers start from the same version');
        const writeInto = (snapshot, marker) => storage.runStorageSnapshot(snapshot, async () => {
          const doc = storage.readSnapshotDocument(storage.calendarKey(mailboxId));
          storage.stageSnapshotDocument(storage.calendarKey(mailboxId), { ...doc, note: marker });
          await storage.commitStorage();
        });
        const results = await Promise.allSettled([writeInto(left, 'left'), writeInto(right, 'right')]);
        const ok = results.filter(result => result.status === 'fulfilled');
        const conflicts = results.filter(result => result.status === 'rejected');
        assert.equal(ok.length, 1, 'exactly one commit succeeded');
        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0].reason.code, 'STORAGE_VERSION_CONFLICT');
        const winner = results[0].status === 'fulfilled' ? 'left' : 'right';
        const head = await storage.createStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] });
        const observed = await storage.runStorageSnapshot(head, async () => {
          const doc = storage.readSnapshotDocument(storage.calendarKey(mailboxId));
          return { note: doc.note, version: Number(doc.version) };
        });
        assert.equal(observed.note, winner, 'only the winner write is persisted');
        assert.equal(observed.version, Number(beforeVersion) + 1, 'the version advanced exactly once');
        return { winner, from: Number(beforeVersion), to: observed.version };
      });

    await check('concurrent-append-partial-conflicts',
      'concurrent appends conflict safely and a bounded retry loses no event',
      async () => {
        const mailboxId = `conc-${suffix}-box`;
        const markers = Array.from({ length: 8 }, (_, index) => `event-${index}`);
        const pending = new Set(markers);
        let conflicts = 0;
        let rounds = 0;
        while (pending.size && rounds < 60) {
          rounds += 1;
          const batch = [...pending];
          const results = await Promise.all(batch.map(marker => storage.withStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] }, async () => {
            const doc = storage.readSnapshotDocument(storage.calendarKey(mailboxId));
            const events = [...(doc.events || []), { id: marker }];
            storage.stageSnapshotDocument(storage.calendarKey(mailboxId), { ...doc, events });
            await storage.commitStorage();
            return marker;
          }).then(() => ({ ok: true, marker })).catch(error => ({ ok: false, marker, error }))));
          for (const result of results) {
            if (result.ok) pending.delete(result.marker);
            else {
              assert.equal(result.error.code, 'STORAGE_VERSION_CONFLICT', `unexpected error ${result.error.message}`);
              conflicts += 1;
            }
          }
        }
        assert.equal(pending.size, 0, 'every append eventually landed');
        assert.ok(conflicts >= 7, `concurrent appends produced conflicts, saw ${conflicts}`);
        const head = await storage.createStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] });
        const ids = await storage.runStorageSnapshot(head, async () => {
          const doc = storage.readSnapshotDocument(storage.calendarKey(mailboxId));
          return (doc.events || []).map(event => event.id);
        });
        for (const marker of markers) assert.ok(ids.includes(marker), `${marker} survived`);
        assert.equal(new Set(ids).size, ids.length, 'no duplicated event');
        return { rounds, conflicts, events: ids.length };
      });

    await check('failed-commit-rolls-back',
      'a failing commit leaves the row byte-identical and the version unchanged',
      async () => {
        const mailboxId = `conc-${suffix}-box`;
        const before = (await pool.query('SELECT payload, version FROM mailbox_calendars WHERE mailbox_id=$1', [mailboxId])).rows[0];
        await assert.rejects(storage.withStorageSnapshot({ pool, system: true, mailboxIds: [mailboxId] }, async () => {
          const doc = storage.readSnapshotDocument(storage.calendarKey(mailboxId));
          storage.stageSnapshotDocument(storage.calendarKey(mailboxId), { ...doc, note: 'must-not-persist' });
          await storage.commitStorage({ beforeCommit: async () => { throw Object.assign(new Error('synthetic batch failure'), { code: 'SYNTHETIC_FAIL' }); } });
        }), { code: 'SYNTHETIC_FAIL' });
        const after = (await pool.query('SELECT payload, version FROM mailbox_calendars WHERE mailbox_id=$1', [mailboxId])).rows[0];
        assert.deepEqual(after.payload, before.payload, 'nothing was written');
        assert.equal(String(after.version), String(before.version), 'the version did not advance');
        return { version: before.version };
      });

    // ================= Authentication ================================================
    await check('concurrent-create-user-single-row',
      'the unique email constraint survives 8 concurrent inserts',
      async () => {
        const email = `race-${suffix}@example.test`;
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => pgInfra.createUser({
          id: `race-${suffix}-${index}`, email, username: `race-${suffix}-${index}`, passwordHash: 'hash',
        })));
        const ok = results.filter(result => result.status === 'fulfilled');
        assert.equal(ok.length, 1, `exactly one insert succeeded, saw ${ok.length}`);
        assert.equal(results.filter(result => result.status === 'rejected').length, 7);
        clientCount += 1;
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email]);
        assert.equal(rows[0].n, 1);
        return { created: ok.length };
      });

    await check('concurrent-register-single-user',
      'one email code consumed by 8 concurrent registrations creates one account',
      async () => {
        const email = `register-${suffix}@example.test`;
        const code = '246810';
        await redisInfra.redisSet(`email-code:register:${email}`, code, 60);
        const attempts = await Promise.allSettled(Array.from({ length: 8 }, async (_, index) => {
          const captchaId = `captcha-${suffix}-${index}`;
          await redisInfra.redisSet(`captcha:${captchaId}`, 'abcd', 60);
          return auth.registerUser({ email, username: `注册用户${suffix}${index}`, password: 'synthetic-password', captchaId, captchaText: 'abcd', emailCode: code });
        }));
        const created = attempts.filter(result => result.status === 'fulfilled');
        assert.equal(created.length, 1, `exactly one registration won, saw ${created.length}`);
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email]);
        assert.equal(rows[0].n, 1, 'the code was consumed atomically');
        const rejected = attempts.filter(result => result.status === 'rejected');
        assert.ok(rejected.every(result => [400, 409].includes(result.reason.status)), 'losers fail with a client-visible conflict');
        return { created: created.length, rejected: rejected.length };
      });

    await check('concurrent-session-revoke-touch',
      'revocation wins any concurrent touch and the session never resurrects',
      async () => {
        const user = await pgInfra.createUser({ id: `sess-${suffix}`, email: `sess-${suffix}@example.test`, username: `sess-${suffix}`, passwordHash: 'hash' });
        const first = await sessions.createUserSession(user);
        await Promise.all([sessions.touchUserSession(user.id, first.jti), sessions.revokeUserSession(user.id, first.jti)]);
        assert.equal(await sessions.touchUserSession(user.id, first.jti), null, 'a revoked session cannot be touched back to life');
        assert.equal(await sessions.getUserSession(user.id, first.jti), null, 'the session record stays gone');

        const second = await sessions.createUserSession(await pgInfra.findUserById(user.id));
        const jwt = (await import('jsonwebtoken')).default;
        const token = jwt.sign({ sub: user.id, jti: second.jti, sv: 0 }, jwtSecret, { expiresIn: '1h' });
        assert.ok(await auth.currentUserFromAuthHeader(`Bearer ${token}`), 'the fresh session authenticates');
        await Promise.all([
          sessions.revokeUserSession(user.id, second.jti),
          auth.currentUserFromAuthHeader(`Bearer ${token}`),
          pgInfra.bumpSessionVersion(user.id),
        ]);
        assert.equal(await auth.currentUserFromAuthHeader(`Bearer ${token}`), null, 'the token is rejected after the race');
        assert.equal((await pgInfra.findUserById(user.id)).session_version, 1, 'the session epoch advanced exactly once');
        return { sessions: 2 };
      });

    // ---- Evidence -------------------------------------------------------------------
    const failed = checks.filter(item => item.status === 'fail');
    const summary = {
      schema, queue, redis: resolvedRedis.replace(/\/\/.*@/, '//'), startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks,
    };
    fs.writeFileSync(path.join(dir, 'concurrency-evidence.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(dir, 'concurrency-evidence.jsonl'), checks.map(item => JSON.stringify(item)).join('\n') + '\n');
    if (failed.length) {
      const error = new Error(`${failed.length}/${checks.length} concurrency checks failed:\n${failed.map(item => `FAIL ${item.name}: ${item.error}`).join('\n')}`);
      error.evidence = dir;
      throw error;
    }
    process.stdout.write(`${checks.map(item => `PASS ${item.name} (${item.ms}ms)`).join('\n')}\n`);
    process.stdout.write(`Concurrency verification passed: ${checks.length}/${checks.length} checks in ${summary.durationMs}ms. Evidence ${dir}\n`);
    return summary;
  } catch (error) {
    process.stdout.write(`${checks.map(item => `${item.status === 'pass' ? 'PASS' : 'FAIL'} ${item.name}${item.error ? `: ${item.error}` : ''}`).join('\n')}\n`);
    throw error;
  } finally {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    for (const child of children) { try { await once(child, 'exit'); } catch { /* already gone */ } }
    try { const infra = await import('../server/infra/postgres.js'); await infra.closePostgres?.(); } catch { /* ignore */ }
    try { const redis = await import('../server/infra/redis.js'); await redis.closeRedis?.(); } catch { /* ignore */ }
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* ignore */ }
    await admin.end().catch(() => {});
    if (!keepEvidence) { /* evidence is intentionally retained under work/ for review */ }
    if (previousDataDir === undefined) delete process.env.DAYLIGHT_DATA_DIR; else process.env.DAYLIGHT_DATA_DIR = previousDataDir;
    if (previousRuntime === undefined) delete process.env.DAYLIGHT_RUNTIME; else process.env.DAYLIGHT_RUNTIME = previousRuntime;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyConcurrency()
    .then(summary => { process.exitCode = 0; void summary; })
    .catch(error => {
      process.stderr.write(`Concurrency verification failed: ${error.message}\n`);
      if (error.evidence) process.stderr.write(`Evidence: ${error.evidence}\n`);
      process.exitCode = 1;
    });
}
