import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Explicit empty-install bootstrap; never reads files or overwrites existing settings. */
export async function bootstrapSettings(client) {
  const settings = { email: '', authorizationCode: '', baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '', model: 'deepseek-chat', fetchLimit: 15, mailboxes: [], userPrefs: {} };
  const result = await client.query(`INSERT INTO app_settings (id, payload, updated_at)
    VALUES ('default', $1::jsonb, clock_timestamp()) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(settings)]);
  return result.rowCount === 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.env.DAYLIGHT_DATABASE_URL) throw new Error('DAYLIGHT_DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DAYLIGHT_DATABASE_URL,
    ssl: process.env.DAYLIGHT_DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 10000 });
  try { console.log(await bootstrapSettings(pool) ? 'Empty shared settings initialized' : 'Existing shared settings preserved'); }
  catch (error) { console.error(`Settings bootstrap failed (${error.code || error.name})`); process.exitCode = 1; }
  finally { await pool.end(); }
}
