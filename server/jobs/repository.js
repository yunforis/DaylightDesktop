import { randomUUID } from 'node:crypto';

export class LeaseLostError extends Error {
  constructor() { super('Job lease is no longer owned'); this.name = 'LeaseLostError'; this.code = 'JOB_LEASE_LOST'; }
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new TypeError(`Invalid ${name}`);
  return value;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  return value;
}
function scope(value) { text(value.tenantId, 'tenantId'); text(value.ownerId, 'ownerId'); }
const json = value => JSON.stringify(value ?? null);
const first = result => result.rows[0] ?? null;

/** Equal jitter: bounded exponential delay, never a zero-delay retry storm. */
export function retryDelay(attempt, { baseMs = 1000, maxMs = 300000, random = Math.random } = {}) {
  integer(baseMs, 'baseMs', 1, 86400000);
  integer(maxMs, 'maxMs', baseMs, 86400000);
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new TypeError('Invalid random sample');
  return Math.ceil(ceiling / 2 + sample * ceiling / 2);
}

/**
 * Scheduled-sync backoff after consecutive terminal failures for one mailbox.
 * A disabled mailbox (for example an IMAP account whose provider turned off basic
 * authentication) must not be dialled once a minute forever: the delay doubles per
 * consecutive failure so the account's rate limit is not consumed by our retries.
 */
export function mailboxBackoffMs(streak, { baseMs = 300000, maxMs = 3600000 } = {}) {
  integer(baseMs, 'baseMs', 1000, 86400000);
  integer(maxMs, 'maxMs', baseMs, 604800000);
  const failures = Math.max(1, Math.min(30, Math.trunc(Number(streak) || 1)));
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

/** Consecutive terminal failures at the head of a newest-first history. */
export function failureStreak(history) {
  if (!Array.isArray(history)) throw new TypeError('A job history array is required');
  let streak = 0;
  for (const row of history) {
    if (row?.status !== 'failed') break;
    streak += 1;
  }
  return streak;
}

/** Worker methods are privileged; HTTP callers must use the owner-scoped methods. */
export class JobRepository {
  constructor(pool, { leaseMs = 60000, retry = {} } = {}) {
    if (!pool?.connect || !pool?.query) throw new TypeError('A pg Pool is required');
    this.pool = pool;
    this.leaseMs = integer(leaseMs, 'leaseMs', 100, 86400000);
    this.retryOptions = retry;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async notify(client, job) {
    await client.query(`INSERT INTO daylight_job_outbox (id, job_id, available_at) VALUES ($1,$2,$3)`,
      [randomUUID(), job.id, job.available_at]);
  }

  async enqueue({ tenantId, ownerId, mailboxId, kind, idempotencyKey, payload = {}, maxAttempts = 5, availableAt = new Date() }) {
    scope({ tenantId, ownerId });
    text(mailboxId, 'mailboxId'); text(kind, 'kind'); text(idempotencyKey, 'idempotencyKey');
    integer(maxAttempts, 'maxAttempts', 1, 100);
    const date = new Date(availableAt);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid availableAt');
    return this.transaction(async client => {
      await client.query(`INSERT INTO daylight_job_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenantId, mailboxId]);
      // Serialize enqueue order with claims for this mailbox, including concurrent producers.
      await client.query('SELECT 1 FROM daylight_job_mailboxes WHERE tenant_id=$1 AND mailbox_id=$2 FOR UPDATE', [tenantId, mailboxId]);
      let job = first(await client.query(`INSERT INTO daylight_jobs
        (id, tenant_id, owner_id, mailbox_id, kind, idempotency_key, payload, max_attempts, available_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(), tenantId, ownerId, mailboxId, kind, idempotencyKey, json(payload), maxAttempts, date]));
      if (job) { await this.notify(client, job); return { job, created: true }; }
      job = first(await client.query(`SELECT * FROM daylight_jobs WHERE tenant_id=$1 AND mailbox_id=$2 AND idempotency_key=$3`, [tenantId, mailboxId, idempotencyKey]));
      if (job.owner_id !== ownerId || job.kind !== kind) throw new Error('Idempotency key belongs to another owner or job kind');
      return { job, created: false };
    });
  }

  async getOwned({ tenantId, ownerId, id }) {
    scope({ tenantId, ownerId });
    return first(await this.pool.query(`SELECT * FROM daylight_jobs WHERE tenant_id=$1 AND owner_id=$2 AND id=$3`, [tenantId, ownerId, id]));
  }

  /**
   * Terminal mailbox-sync history for one mailbox, newest first. The scheduler reads this
   * to back off a mailbox that keeps failing, so the decision survives restarts and is
   * shared by every scheduler replica instead of living in process memory.
   */
  async mailboxSyncOutcomes({ tenantId, ownerId, mailboxId, limit = 8 }) {
    scope({ tenantId, ownerId });
    text(mailboxId, 'mailboxId');
    integer(limit, 'limit', 1, 50);
    return (await this.pool.query(`SELECT status, attempts, error, finished_at FROM daylight_jobs
      WHERE tenant_id=$1 AND owner_id=$2 AND mailbox_id=$3 AND kind='mailbox.sync'
      AND status IN ('succeeded','failed','cancelled')
      ORDER BY sequence DESC LIMIT $4`, [tenantId, ownerId, mailboxId, limit])).rows;
  }

  /**
   * True while this mailbox still has a queued or running sync. The scheduler reads it so a
   * slow sync is not dialled again every minute: without this, a mailbox that takes longer
   * than the scheduler cadence accumulates one duplicate job per minute without bound.
   * Manual syncs are unaffected; they go through enqueueMail and stay explicit.
   */
  async hasPendingSync({ tenantId, ownerId, mailboxId }) {
    scope({ tenantId, ownerId });
    text(mailboxId, 'mailboxId');
    const { rows } = await this.pool.query(`SELECT 1 FROM daylight_jobs
      WHERE tenant_id=$1 AND owner_id=$2 AND mailbox_id=$3 AND kind='mailbox.sync'
      AND status IN ('queued','running') LIMIT 1`, [tenantId, ownerId, mailboxId]);
    return rows.length > 0;
  }

  async listOwned({ tenantId, ownerId, mailboxId = null, status = null, limit = 50, offset = 0 }) {
    scope({ tenantId, ownerId }); integer(limit, 'limit', 1, 200); integer(offset, 'offset', 0, 1000000);
    return (await this.pool.query(`SELECT * FROM daylight_jobs WHERE tenant_id=$1 AND owner_id=$2
      AND ($3::text IS NULL OR mailbox_id=$3) AND ($4::text IS NULL OR status=$4)
      ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6`, [tenantId, ownerId, mailboxId, status, limit, offset])).rows;
  }

  async claim({ workerId, id = null } = {}) {
    text(workerId, 'workerId');
    return this.transaction(async client => {
      // Lock a persistent mailbox row, not a candidate job: different jobs in one mailbox cannot race.
      const mailbox = first(await client.query(`SELECT m.* FROM daylight_job_mailboxes m
        WHERE EXISTS (SELECT 1 FROM daylight_jobs j WHERE j.tenant_id=m.tenant_id AND j.mailbox_id=m.mailbox_id
          AND j.status='queued' AND j.available_at<=clock_timestamp() AND j.attempts<j.max_attempts AND ($1::uuid IS NULL OR j.id=$1)
          AND NOT EXISTS (SELECT 1 FROM daylight_jobs earlier WHERE earlier.tenant_id=j.tenant_id
            AND earlier.mailbox_id=j.mailbox_id AND earlier.status IN ('queued','running') AND earlier.sequence<j.sequence))
        AND NOT EXISTS (SELECT 1 FROM daylight_jobs r WHERE r.tenant_id=m.tenant_id AND r.mailbox_id=m.mailbox_id AND r.status='running')
        ORDER BY m.tenant_id,m.mailbox_id FOR UPDATE OF m SKIP LOCKED LIMIT 1`, [id]));
      if (!mailbox) return null;
      return first(await client.query(`UPDATE daylight_jobs SET status='running', attempts=attempts+1,
        generation=generation+1, lease_token=$4, worker_id=$3,
        lease_until=clock_timestamp()+$5 * interval '1 millisecond', updated_at=clock_timestamp()
        WHERE id=(SELECT id FROM daylight_jobs WHERE tenant_id=$1 AND mailbox_id=$2 AND status='queued'
          AND available_at<=clock_timestamp() AND attempts<max_attempts AND ($6::uuid IS NULL OR id=$6)
           AND NOT EXISTS (SELECT 1 FROM daylight_jobs earlier WHERE earlier.tenant_id=$1 AND earlier.mailbox_id=$2
             AND earlier.status IN ('queued','running') AND earlier.sequence<daylight_jobs.sequence)
           ORDER BY sequence FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      [mailbox.tenant_id, mailbox.mailbox_id, workerId, randomUUID(), this.leaseMs, id]));
    });
  }

  async lockLease(client, id, token) {
    const job = first(await client.query(`SELECT * FROM daylight_jobs WHERE id=$1 AND lease_token=$2
      AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`, [id, token]));
    if (!job) throw new LeaseLostError();
    return job;
  }

  async heartbeat(id, token) {
    const job = first(await this.pool.query(`UPDATE daylight_jobs SET lease_until=clock_timestamp()+$3 * interval '1 millisecond',
      updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp() RETURNING *`, [id, token, this.leaseMs]));
    if (!job) throw new LeaseLostError();
    return job;
  }

  async checkpoint(id, token, name, result, write = null) {
    text(name, 'step name');
    return this.transaction(async client => {
      const job = await this.lockLease(client, id, token);
      const existing = first(await client.query(`SELECT * FROM daylight_job_steps WHERE job_id=$1 AND name=$2`, [id, name]));
      if (existing) return existing;
      // Database effects and checkpoint commit together. Never perform network effects inside write.
      if (write) await write(client, job);
      const step = first(await client.query(`INSERT INTO daylight_job_steps (job_id,name,result,generation)
        VALUES ($1,$2,$3::jsonb,$4) RETURNING *`, [id, name, json(result), job.generation]));
      await this.lockLease(client, id, token);
      return step;
    });
  }

  async steps(id, token) {
    return this.transaction(async client => {
      await this.lockLease(client, id, token);
      return (await client.query('SELECT * FROM daylight_job_steps WHERE job_id=$1 ORDER BY completed_at,name', [id])).rows;
    });
  }

  async complete(id, token, result = null, write = null) {
    return this.transaction(async client => {
      const job = await this.lockLease(client, id, token);
      if (write) await write(client, job);
      await this.lockLease(client, id, token);
      return first(await client.query(`UPDATE daylight_jobs SET status='succeeded', result=$3::jsonb,
        error=NULL, lease_token=NULL, lease_until=NULL, worker_id=NULL, finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 RETURNING *`, [id, token, json(result)]));
    });
  }

  async scheduleFailure(client, job, error, retryable) {
    const retry = retryable && job.attempts < job.max_attempts;
    const delay = retry ? retryDelay(job.attempts, this.retryOptions) : 0;
    const updated = first(await client.query(`UPDATE daylight_jobs SET status=$2,error=$3::jsonb,
      available_at=clock_timestamp()+$4 * interval '1 millisecond', lease_token=NULL, lease_until=NULL,worker_id=NULL,
      finished_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END, updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`, [job.id, retry ? 'queued' : 'failed', json(error), delay]));
    if (retry) await this.notify(client, updated);
    return updated;
  }

  async fail(id, token, error, { retryable = true } = {}) {
    return this.transaction(async client => {
      const job = await this.lockLease(client, id, token);
      return this.scheduleFailure(client, job, error, retryable);
    });
  }

  async recoverExpired({ limit = 100 } = {}) {
    integer(limit, 'limit', 1, 1000);
    return this.transaction(async client => {
      const jobs = (await client.query(`SELECT * FROM daylight_jobs WHERE status='running' AND lease_until<=clock_timestamp()
        ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])).rows;
      const recovered = [];
      for (const job of jobs) recovered.push(await this.scheduleFailure(client, job, { code: 'LEASE_EXPIRED', message: 'Worker lease expired' }, true));
      return recovered;
    });
  }

  async cancelOwned({ tenantId, ownerId, id }) {
    scope({ tenantId, ownerId });
    return first(await this.pool.query(`UPDATE daylight_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,worker_id=NULL,
      finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND owner_id=$2 AND id=$3
      AND status IN ('queued','running') RETURNING *`, [tenantId, ownerId, id]));
  }

  async retryOwned({ tenantId, ownerId, id }) {
    scope({ tenantId, ownerId });
    return this.transaction(async client => {
      // Manual retry grants a fresh bounded budget but retains checkpoints and fencing generation.
      const job = first(await client.query(`UPDATE daylight_jobs SET status='queued', attempts=0,error=NULL,result=NULL,
        finished_at=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND status IN ('failed','cancelled') RETURNING *`, [tenantId, ownerId, id]));
      if (job) await this.notify(client, job);
      return job;
    });
  }

  async claimOutbox({ limit = 50, leaseMs = 30000 } = {}) {
    integer(limit, 'limit', 1, 1000); integer(leaseMs, 'leaseMs', 100, 86400000);
    return (await this.pool.query(`UPDATE daylight_job_outbox SET lease_token=$1,
      lease_until=clock_timestamp()+$3 * interval '1 millisecond',attempts=attempts+1
      WHERE id IN (SELECT id FROM daylight_job_outbox WHERE published_at IS NULL AND available_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY available_at
        FOR UPDATE SKIP LOCKED LIMIT $2) RETURNING *`, [randomUUID(), limit, leaseMs])).rows;
  }

  async confirmOutbox(id, token) {
    return !!first(await this.pool.query(`UPDATE daylight_job_outbox SET published_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND published_at IS NULL AND lease_until>clock_timestamp() RETURNING id`, [id, token]));
  }

  async releaseOutbox(id, token, error, delayMs = 1000) {
    integer(delayMs, 'delayMs', 1, 86400000);
    return !!first(await this.pool.query(`UPDATE daylight_job_outbox SET lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+$4 * interval '1 millisecond',last_error=$3
      WHERE id=$1 AND lease_token=$2 AND published_at IS NULL RETURNING id`, [id, token, String(error?.message ?? error).slice(0, 2000), delayMs]));
  }
}
