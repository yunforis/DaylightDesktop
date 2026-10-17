import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = 'settings, calendars, scenarios; users and auxiliary modules require separate migration';
const refused = () => new Error('Storage import refused; verify backup structure, ownership and database availability');

// Explicit import only. Application startup never infers authority from files.
// Reject symlinks on every path component beneath the chosen backup root.
export async function collectStorageBackup(source) {
  const root = await fs.realpath(path.resolve(source));
  if (!(await fs.stat(root)).isDirectory()) throw refused();
  const documents = [];
  async function collect(relative, table, id, required = false) {
    const parts = relative.split('/');
    let current = root;
    try {
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw refused();
      }
      const file = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try { bytes = await file.readFile(); } finally { await file.close(); }
      const payload = JSON.parse(bytes.toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw refused();
      documents.push({ table, id, payload, digest: hash(bytes) });
    } catch (error) {
      if (error.code === 'ENOENT' && !required) return;
      throw refused();
    }
  }
  await collect('settings.json', 'app_settings', 'default', true);
  const settings = documents[0].payload;
  if (!Array.isArray(settings.mailboxes)) throw refused();
  const ids = new Set(), owners = new Set();
  for (const mailbox of settings.mailboxes) {
    if (!mailbox || typeof mailbox.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(mailbox.id) || ids.has(mailbox.id)) throw refused();
    const owner = mailbox.ownerUserId || mailbox.userId;
    if (typeof owner !== 'string' || !owner.trim()
      || (mailbox.ownerUserId && mailbox.userId && mailbox.ownerUserId !== mailbox.userId)) throw refused();
    ids.add(mailbox.id);
    owners.add(owner);
    await collect(mailbox.id === 'default' ? 'calendar.json' : `mailboxes/${mailbox.id}/calendar.json`, 'mailbox_calendars', mailbox.id);
  }
  for (const owner of owners) await collect(`scenarios/${hash(owner)}.json`, 'app_settings', `scenarios:${owner}`);
  return { documents, summary: { documents: documents.length,
    checksum: hash(documents.map(doc => `${doc.table}:${hash(doc.id)}:${doc.digest}`).sort().join('\n')), scope } };
}

export async function applyStorageBackup(pool, documents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(711804, 2)');
    for (const doc of documents) {
      if (!['app_settings', 'mailbox_calendars'].includes(doc.table)) throw refused();
      const column = doc.table === 'app_settings' ? 'id' : 'mailbox_id';
      const { rows } = await client.query(`SELECT payload FROM ${doc.table} WHERE ${column}=$1 FOR UPDATE`, [doc.id]);
      if (rows.length) {
        if (!isDeepStrictEqual(rows[0].payload, doc.payload)) throw refused();
      } else {
        await client.query(`INSERT INTO ${doc.table} (${column},payload,updated_at,version) VALUES ($1,$2::jsonb,clock_timestamp(),1)`, [doc.id, JSON.stringify(doc.payload)]);
      }
    }
    await client.query('COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* preserve generic refusal */ }
    throw refused();
  } finally { client.release(); }
}

export async function runStorageImport(args = process.argv.slice(2)) {
  const sourceArgs = args.filter(arg => arg.startsWith('--source='));
  if (sourceArgs.length !== 1 || !sourceArgs[0].slice(9) || args.some(arg => !arg.startsWith('--source=') && arg !== '--apply')) {
    throw new Error('Use --source=/path/to/backup [--apply]; default is dry-run');
  }
  const { documents, summary } = await collectStorageBackup(sourceArgs[0].slice(9));
  const apply = args.includes('--apply');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }));
  if (!apply) return;
  if (!process.env.DAYLIGHT_DATABASE_URL) throw new Error('DAYLIGHT_DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DAYLIGHT_DATABASE_URL, max: 1,
    ssl: process.env.DAYLIGHT_DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined });
  try {
    await applyStorageBackup(pool, documents);
    console.log('Import committed; source backup was not modified');
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runStorageImport().catch(() => {
    // Never print JSON parse excerpts, paths, database URLs or driver messages.
    console.error('Storage import refused; no successful import was reported. Verify arguments, backup ownership and database availability.');
    process.exitCode = 1;
  });
}
