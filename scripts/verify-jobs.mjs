/** Real dependencies only. Creates/removes its own schema and queue, never reads app data.
 * JOBS_TEST_DATABASE_URL and JOBS_TEST_AMQP_URL must point to dedicated test instances.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import amqp from 'amqplib';
import { migrateJobs } from '../server/jobs/schema.js';
import { JobRepository, LeaseLostError, mailboxBackoffMs, failureStreak } from '../server/jobs/repository.js';
import { JobWorker, pause, bounded } from '../server/jobs/runtime.js';
import { JobTransport } from '../server/jobs/rabbit.js';

if (!process.env.JOBS_TEST_DATABASE_URL || !process.env.JOBS_TEST_AMQP_URL) throw new Error('Dedicated JOBS_TEST_DATABASE_URL and JOBS_TEST_AMQP_URL required');
const schema = `jobs_verify_${randomUUID().replaceAll('-', '')}`;
const queue = schema;
const admin = new pg.Pool({ connectionString: process.env.JOBS_TEST_DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 5000 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: process.env.JOBS_TEST_DATABASE_URL,
  options: `-c search_path=${schema} -c statement_timeout=4000 -c lock_timeout=3000`,
  connectionTimeoutMillis: 3000, query_timeout: 5000, max: 8 });
const controller = new AbortController();
let transportRun;
let workerRun;
let connection;
const scope = { tenantId: 'tenant', ownerId: 'owner', mailboxId: 'mailbox' };
const enqueue = (key, extra = {}) => repository.enqueue({ ...scope, kind: 'probe', idempotencyKey: key, ...extra });
const repository = new JobRepository(pool, { leaseMs: 1000, retry: { baseMs: 30, maxMs: 60, random: () => 0 } });
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error(`Timed out: ${label}`);
}
async function report(name, fn) { await fn(); console.log(`PASS ${name}`); }
try {
  await migrateJobs(pool);
  await migrateJobs(pool);
  await pool.query('CREATE TABLE effects (name text PRIMARY KEY, value integer NOT NULL)');
  await report('concurrent idempotent enqueue, owner/tenant isolation, mailbox ordering', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue('same')));
    assert.equal(results.filter(r => r.created).length, 1);
    const first = results[0].job;
    const second = (await enqueue('second')).job;
    assert.equal(await repository.getOwned({ ...scope, tenantId: 'other', id: first.id }), null);
    assert.equal(await repository.getOwned({ ...scope, ownerId: 'other', id: first.id }), null);
    assert.equal(await repository.claim({ workerId: 'w', id: second.id }), null);
    const claims = await Promise.all([repository.claim({ workerId: 'a' }), repository.claim({ workerId: 'b' })]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find(Boolean);
    assert.equal(claimed.id, first.id);
    await repository.fail(claimed.id, claimed.lease_token, { code: 'RETRY' });
    assert.equal(await repository.claim({ workerId: 'w', id: second.id }), null);
    await pause(40);
    const retry = await repository.claim({ workerId: 'w', id: first.id });
    await repository.complete(retry.id, retry.lease_token);
    const next = await repository.claim({ workerId: 'w', id: second.id });
    await repository.complete(next.id, next.lease_token);
  });
  await report('expired leases fence stale writes and checkpoint effects survive redelivery exactly once', async () => {
    const { job } = await enqueue('fence');
    const old = await repository.claim({ workerId: 'old', id: job.id });
    const write = client => client.query("INSERT INTO effects VALUES ('checkpoint',1)");
    await repository.checkpoint(old.id, old.lease_token, 'saved', { ok: true }, write);
    await pool.query("UPDATE daylight_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await repository.recoverExpired();
    await pause(40);
    const fresh = await repository.claim({ workerId: 'fresh', id: job.id });
    assert.ok(Number(fresh.generation) > Number(old.generation));
    await assert.rejects(repository.checkpoint(old.id, old.lease_token, 'stale', {}, write), LeaseLostError);
    await assert.rejects(repository.complete(old.id, old.lease_token), LeaseLostError);
    await repository.checkpoint(fresh.id, fresh.lease_token, 'saved', {}, write);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM effects')).rows[0].count, 1);
    await repository.complete(fresh.id, fresh.lease_token);
    assert.equal(await repository.claim({ workerId: 'duplicate', id: job.id }), null);
  });
  await report('lease expiry inside a transaction rolls back both effects and checkpoint', async () => {
    const { job } = await enqueue('rollback');
    const claimed = await repository.claim({ workerId: 'slow', id: job.id });
    await assert.rejects(repository.checkpoint(job.id, claimed.lease_token, 'slow', {}, async client => {
      await client.query("INSERT INTO effects VALUES ('rolled-back',1)");
      await client.query('SELECT pg_sleep(1.1)');
    }), LeaseLostError);
    assert.equal((await pool.query("SELECT * FROM effects WHERE name='rolled-back'")).rowCount, 0);
    await repository.recoverExpired();
    await repository.cancelOwned({ ...scope, id: job.id });
  });
  await report('execution failures exhaust a bounded budget; manual retry retains fencing', async () => {
    const { job } = await enqueue('budget', { maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      await pause(40);
      const claimed = await repository.claim({ workerId: 'failure', id: job.id });
      await repository.fail(job.id, claimed.lease_token, { code: 'TEST' });
    }
    assert.equal((await repository.getOwned({ ...scope, id: job.id })).status, 'failed');
    assert.equal(await repository.claim({ workerId: 'exhausted', id: job.id }), null);
    const retried = await repository.retryOwned({ ...scope, id: job.id });
    assert.equal(retried.attempts, 0);
    const claimed = await repository.claim({ workerId: 'manual', id: job.id });
    await repository.complete(job.id, claimed.lease_token);
  });
  await report('mailbox sync history drives consecutive-failure backoff (real SQL ordering)', async () => {
    const box = { ...scope, mailboxId: 'backoff-box' };
    // A mailbox with no terminal history is never gated: the first scheduled sync runs.
    assert.deepEqual(await repository.mailboxSyncOutcomes({ ...box, limit: 8 }), []);
    for (const minute of [1, 2, 3]) {
      const { job } = await repository.enqueue({ ...box, kind: 'mailbox.sync', idempotencyKey: `scheduled:${minute}`, payload: { trigger: 'scheduled' } });
      const claimed = await repository.claim({ workerId: `fail-${minute}`, id: job.id });
      assert.ok(claimed, `scheduled job ${minute} must be claimable`);
      await repository.fail(job.id, claimed.lease_token, { code: 'MAIL_NOT_CONFIGURED' }, { retryable: false });
    }
    const history = await repository.mailboxSyncOutcomes({ ...box, limit: 8 });
    assert.deepEqual(history.map(row => row.status), ['failed', 'failed', 'failed'], 'newest first');
    assert.ok(history[0].finished_at, 'a terminal job carries finished_at so the window can be computed');
    assert.equal(failureStreak(history), 3);
    assert.equal(mailboxBackoffMs(3), 1200000, 'third consecutive failure waits twenty minutes');
    // A different job kind must not gate the mailbox scheduler: the streak is still 3.
    const { job: plan } = await repository.enqueue({ ...box, kind: 'plan.item', idempotencyKey: 'plan:1', payload: {} });
    const planClaim = await repository.claim({ workerId: 'planner', id: plan.id });
    await repository.fail(plan.id, planClaim.lease_token, { code: 'PLAN_FAILED' }, { retryable: false });
    assert.equal(failureStreak(await repository.mailboxSyncOutcomes({ ...box, limit: 8 })), 3, 'only mailbox.sync rows count');
    // Only mailbox.sync rows count, and another mailbox is unaffected.
    assert.deepEqual(await repository.mailboxSyncOutcomes({ ...scope, mailboxId: 'unrelated-box', limit: 8 }), []);
    // One success at the head of the history clears the streak, so a repaired mailbox syncs next minute.
    const { job: healthy } = await repository.enqueue({ ...box, kind: 'mailbox.sync', idempotencyKey: 'scheduled:9', payload: { trigger: 'scheduled' } });
    const claim = await repository.claim({ workerId: 'repaired', id: healthy.id });
    await repository.complete(healthy.id, claim.lease_token);
    assert.equal(failureStreak(await repository.mailboxSyncOutcomes({ ...box, limit: 8 })), 0);
  });
  await report('outbox claims reject stale confirms after lease takeover', async () => {
    const [old] = await repository.claimOutbox({ limit: 1, leaseMs: 100 });
    await pool.query("UPDATE daylight_job_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    const fresh = (await repository.claimOutbox({ limit: 100 })).find(row => row.id === old.id);
    assert.ok(fresh);
    assert.equal(await repository.confirmOutbox(old.id, old.lease_token), false);
    assert.equal(await repository.confirmOutbox(fresh.id, fresh.lease_token), true);
    for (const row of await repository.claimOutbox({ limit: 100 })) await repository.releaseOutbox(row.id, row.lease_token, 'reset', 1);
    await pool.query('UPDATE daylight_job_outbox SET lease_token=NULL,lease_until=NULL WHERE published_at IS NULL');
  });
  let connects = 0;
  let wakes = 0;
  const delivered = new Map();
  let lostConfirm = false;
  const realConfirm = repository.confirmOutbox.bind(repository);
  repository.confirmOutbox = async (...args) => {
    if (!lostConfirm) { lostConfirm = true; throw new Error('Injected process failure after broker confirm'); }
    return realConfirm(...args);
  };
  const transport = new JobTransport(repository, { url: process.env.JOBS_TEST_AMQP_URL, queue, pollMs: 20,
    operationMs: 1000, onWake: ({ messageId }) => {
      wakes++;
      delivered.set(messageId, (delivered.get(messageId) ?? 0) + 1);
    }, connect: async (...args) => {
      connection = await amqp.connect(...args); connects++; return connection;
    } });
  transportRun = transport.run({ signal: controller.signal });
  await report('real RabbitMQ confirms, duplicate delivery after lost outbox commit, consumer reconnect', async () => {
    await until(async () => {
      const rows = await pool.query('SELECT count(*)::integer AS count FROM daylight_job_outbox WHERE published_at IS NULL');
      return rows.rows[0].count === 0 && wakes > 0 && lostConfirm;
    }, 'confirmed outbox');
    await until(() => [...delivered.values()].some(count => count >= 2), 'duplicate wakeup after broker confirm / DB commit gap');
    await connection.close();
    await until(() => connects >= 2, 'consumer reconnect');
    const prior = wakes;
    await enqueue('after-reconnect');
    await until(() => wakes > prior, 'wake after reconnect');
  });
  await report('worker heartbeat spans multiple leases and checkpoint resumes without duplicate effects', async () => {
    let runs = 0;
    const worker = new JobWorker(repository, { probe: async (job, ctx) => {
      runs++;
      await ctx.checkpoint('effect', {}, client => client.query("INSERT INTO effects VALUES ($1,1)", [job.id]));
      await pause(2200, ctx.signal);
      ctx.signal.throwIfAborted();
      return { ok: true };
    } }, { pollMs: 20, timeoutMs: 5000, onError: error => console.log('worker diagnostic', error.code, error.message) });
    workerRun = worker.run({ signal: controller.signal });
    await until(async () => (await repository.listOwned({ ...scope })).every(j => !['queued', 'running'].includes(j.status)), 'worker completion');
    assert.ok(runs > 0);
    const jobs = await repository.listOwned({ ...scope });
    const latest = jobs.find(j => j.idempotency_key === 'after-reconnect');
    assert.equal(latest.status, 'succeeded');
    assert.equal(latest.attempts, 1);
    assert.equal((await pool.query('SELECT * FROM effects WHERE name=$1', [latest.id])).rowCount, 1);
  });
  console.log('Real isolated PostgreSQL/RabbitMQ verification passed. No mailbox/model calls.');
} finally {
  controller.abort();
  await bounded(Promise.allSettled([transportRun, workerRun]), 10000);
  const cleanup = await amqp.connect(process.env.JOBS_TEST_AMQP_URL, { timeout: 3000 });
  try { const channel = await cleanup.createChannel(); await channel.deleteQueue(queue); }
  finally { await cleanup.close(); }
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
