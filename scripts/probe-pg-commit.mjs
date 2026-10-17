/**
 * Explains job-platform throughput on a given host: each job commits several short
 * transactions, so the per-commit latency of the local PostgreSQL sets the ceiling.
 * Read-only with respect to business data: creates and drops its own scratch table.
 */
import pg from 'pg';

const connectionString = process.env.DAYLIGHT_DATABASE_URL || process.env.JOBS_TEST_DATABASE_URL;
if (!connectionString) throw new Error('DAYLIGHT_DATABASE_URL or JOBS_TEST_DATABASE_URL required');
const ROUNDS = Number(process.env.PROBE_ROUNDS || 300);
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
const settings = ['synchronous_commit', 'fsync', 'full_page_writes', 'shared_buffers', 'wal_sync_method', 'max_wal_size'];
try {
  for (const name of settings) {
    const { rows } = await pool.query('SELECT setting, unit FROM pg_settings WHERE name=$1', [name]);
    console.log(`pg.${name}=${rows[0]?.setting}${rows[0]?.unit ? ` ${rows[0].unit}` : ''}`);
  }
  const version = (await pool.query('SHOW server_version')).rows[0].server_version;
  const wal = (await pool.query('SELECT pg_walfile_name(pg_current_wal_lsn()) AS name')).rows[0];
  console.log(`pg.version=${version} wal=${wal.name.slice(0, 8)}`);
  await pool.query('CREATE TABLE IF NOT EXISTS commit_probe (id serial PRIMARY KEY, v integer NOT NULL)');
  // Warm the connection and the WAL, then measure one committed transaction per round.
  for (let i = 0; i < 20; i++) await commit(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < ROUNDS; i++) await commit(i);
  const perCommitMs = Number(process.hrtime.bigint() - start) / 1e6 / ROUNDS;
  console.log(`commits=${ROUNDS} perCommitMs=${perCommitMs.toFixed(3)} maxCommitsPerSecond=${(1000 / perCommitMs).toFixed(1)}`);
  await pool.query('DROP TABLE commit_probe');
} finally { await pool.end(); }

async function commit(v) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO commit_probe (v) VALUES ($1)', [v]);
    await client.query('COMMIT');
  } finally { client.release(); }
}
