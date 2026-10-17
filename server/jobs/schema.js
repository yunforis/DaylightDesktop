/** Run in the same search_path as the injected pool. No extension privileges required. */
export const JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS daylight_job_mailboxes (
  tenant_id text NOT NULL, mailbox_id text NOT NULL,
  PRIMARY KEY (tenant_id, mailbox_id)
);
CREATE TABLE IF NOT EXISTS daylight_jobs (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL,
  mailbox_id text NOT NULL, kind text NOT NULL, idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}', result jsonb, error jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  generation bigint NOT NULL DEFAULT 0,
  lease_token uuid, worker_id text, lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  UNIQUE (tenant_id, mailbox_id, idempotency_key),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES daylight_job_mailboxes,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS daylight_jobs_due ON daylight_jobs (available_at, created_at) WHERE status = 'queued';
ALTER TABLE daylight_jobs ADD COLUMN IF NOT EXISTS sequence bigserial;
CREATE INDEX IF NOT EXISTS daylight_jobs_mailbox_sequence ON daylight_jobs (tenant_id, mailbox_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS daylight_jobs_mailbox_running ON daylight_jobs (tenant_id, mailbox_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS daylight_jobs_owner ON daylight_jobs (tenant_id, owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS daylight_jobs_expired ON daylight_jobs (lease_until) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS daylight_job_steps (
  job_id uuid NOT NULL REFERENCES daylight_jobs ON DELETE CASCADE,
  name text NOT NULL, result jsonb NOT NULL,
  generation bigint NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, name)
);
CREATE TABLE IF NOT EXISTS daylight_job_outbox (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES daylight_jobs ON DELETE CASCADE,
  available_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, last_error text
);
CREATE INDEX IF NOT EXISTS daylight_job_outbox_due ON daylight_job_outbox (available_at) WHERE published_at IS NULL;
`;

export async function migrateJobs(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize first-start migrations across processes sharing this database.
    await client.query("SELECT pg_advisory_xact_lock(711804, 1)");
    await client.query(JOBS_SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
