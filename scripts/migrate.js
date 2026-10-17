import { existsSync } from 'node:fs';
import pg from 'pg';
import { SCHEMA } from '../server/infra/postgres.js';
import { migrateJobs } from '../server/jobs/schema.js';
import { AUXILIARY_SCHEMA } from '../server/storage/aux-schema.js';
import { bootstrapSettings } from './bootstrap-settings.js';

// Deliberately independent of runtime initialization: no JSON imports or dependency fallback.
const connectionString = process.env.DAYLIGHT_DATABASE_URL;
if (!connectionString) throw new Error('DAYLIGHT_DATABASE_URL is required for migration');
const pool = new pg.Pool({ connectionString,
  ssl: process.env.DAYLIGHT_DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined,
  max: 2, connectionTimeoutMillis: 10000 });
pool.on('error', () => {});
let client;
try {
  client = await pool.connect();
  // Session lock covers all migration modules, including their own transactions.
  await client.query("SELECT pg_advisory_lock(711804, 0)");
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query(SCHEMA);
  await client.query('COMMIT');
  await migrateJobs(pool);
  const storageSchema = new URL('../server/storage/schema.js', import.meta.url);
  if (existsSync(storageSchema)) {
    const { migrateStorage, STORAGE_SCHEMA } = await import(storageSchema.href);
    if (typeof migrateStorage === 'function') await migrateStorage(pool);
    else if (typeof STORAGE_SCHEMA === 'string' && STORAGE_SCHEMA.trim()) {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query(STORAGE_SCHEMA);
      await client.query('COMMIT');
    } else throw new Error('storage/schema.js must export migrateStorage(pool) or STORAGE_SCHEMA');
  } else {
    console.warn('Storage schema module is not present; only core and jobs schemas were migrated');
  }
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query(AUXILIARY_SCHEMA);
  const initialized = await bootstrapSettings(client);
  await client.query('COMMIT');
  console.log(initialized ? 'Empty shared settings initialized' : 'Existing shared settings preserved');
  console.log('Daylight database migrations completed (no local data imported)');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  // Avoid printing connection strings or credentials from driver error messages.
  console.error(`Daylight migration failed (${error.code || error.name || 'unknown'})`);
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query('SELECT pg_advisory_unlock(711804, 0)').catch(() => {});
    client.release();
  }
  await pool.end();
}
