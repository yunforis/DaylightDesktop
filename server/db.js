/**
 * Shared prompt revisions and key/value metadata use PostgreSQL app_settings.
 * Local development without PostgreSQL retains sql.js in data/daylight.sqlite.
 * Production never initializes SQLite or falls back to an instance-local database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { randomUUID } from 'node:crypto';
import { getPostgresPool } from './infra/postgres.js';
import { isProductionRuntime, requireLocalRuntime } from './runtime-mode.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const dbPath = path.join(dataDir, 'daylight.sqlite');

let SQL;
let db;
let ready;

async function open() {
  requireLocalRuntime('SQLite persistence');
  if (db) return db;
  if (!ready) {
    ready = (async () => {
      fs.mkdirSync(dataDir, { recursive: true });
      SQL = await initSqlJs();
      if (fs.existsSync(dbPath)) {
        db = new SQL.Database(fs.readFileSync(dbPath));
      } else {
        db = new SQL.Database();
      }
      db.run(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      persist();
      return db;
    })();
  }
  return ready;
}

function sharedPool() {
  const pool = getPostgresPool();
  if (!pool && isProductionRuntime()) {
    throw Object.assign(new Error('PostgreSQL audit storage is unavailable'), { status: 503 });
  }
  return pool;
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export async function setKv(key, value) {
  const pool = sharedPool();
  if (pool) {
    await pool.query(
      `insert into app_settings (id, payload, updated_at) values ($1, $2::jsonb, NOW())
       on conflict (id) do update set payload = excluded.payload, updated_at = NOW(), version = app_settings.version + 1`,
      [`aux-kv:${key}`, JSON.stringify({ value })],
    );
    return;
  }
  const database = await open();
  const now = new Date().toISOString();
  database.run(
    'INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    [key, JSON.stringify(value), now],
  );
  persist();
}

export async function getKv(key, fallback = null) {
  const pool = sharedPool();
  if (pool) {
    const { rows } = await pool.query('select payload from app_settings where id = $1', [`aux-kv:${key}`]);
    return rows.length ? rows[0].payload.value : fallback;
  }
  const database = await open();
  const row = database.exec('SELECT value FROM kv WHERE key = ?', [key]);
  if (!row.length || !row[0].values.length) return fallback;
  try {
    return JSON.parse(row[0].values[0][0]);
  } catch {
    return fallback;
  }
}

export async function appendPromptRevision(kind, body) {
  const pool = sharedPool();
  if (pool) {
    const now = new Date().toISOString();
    const revision = { id: randomUUID(), kind, body, createdAt: now };
    // A single statement appends against the latest row, without holding a connection
    // during the model request or relying on an instance-local revision list.
    await pool.query(
      `insert into app_settings (id, payload, updated_at) values ($1, $2::jsonb, NOW())
       on conflict (id) do update set
         payload = app_settings.payload || excluded.payload, updated_at = NOW(), version = app_settings.version + 1`,
      ['aux-prompt-revisions', JSON.stringify([revision])],
    );
    await setKv('prompts.updatedAt', now);
    return { kind, createdAt: now };
  }
  const database = await open();
  const now = new Date().toISOString();
  database.run('INSERT INTO prompt_revisions(kind, body, created_at) VALUES(?, ?, ?)', [kind, body, now]);
  persist();
  await setKv('prompts.updatedAt', now);
  return { kind, createdAt: now };
}

export async function listPromptRevisions(limit = 20) {
  const pool = sharedPool();
  if (pool) {
    const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 20;
    const { rows } = await pool.query(
      `select entry.value as revision from app_settings,
       jsonb_array_elements(payload) with ordinality as entry(value, position)
       where id = $1 order by entry.position desc limit $2`,
      ['aux-prompt-revisions', count],
    );
    return rows.map((row) => row.revision);
  }
  const database = await open();
  const result = database.exec(
    'SELECT id, kind, body, created_at FROM prompt_revisions ORDER BY id DESC LIMIT ?',
    [limit],
  );
  if (!result.length) return [];
  return result[0].values.map(([id, kind, body, created_at]) => ({
    id, kind, body, createdAt: created_at,
  }));
}

export async function dbStatus() {
  const pool = sharedPool();
  if (pool) {
    await pool.query('select 1');
    return { engine: 'postgres', note: 'Shared prompt revisions and key/value metadata in app_settings' };
  }
  await open();
  return {
    engine: 'sql.js',
    path: dbPath,
    exists: fs.existsSync(dbPath),
    note: 'Hybrid: JSON mailbox stores + SQLite prompt revisions / kv',
  };
}
