/**
 * Hybrid persistence for Daylight (local demo scale).
 *
 * Why not “JSON only” forever:
 * - Per-mailbox calendar blobs stay easy to inspect/backup as JSON.
 * - Prompt edits need hot-reload + revision history → SQLite (sql.js, no native build).
 * - Secrets stay in settings.json (gitignored data/), never copied into docs/logs.
 *
 * Why not Postgres/MySQL yet:
 * - Single-process local demo; no concurrent writers; Node 21 broke better-sqlite3 native.
 * - sql.js gives a real SQL file (data/daylight.sqlite) without native addons.
 * - When multi-user / cloud is needed, migrate tables to Postgres and keep the same schema.
 *
 * Layout:
 * - data/settings.json — credentials + mailbox list (source of truth for auth)
 * - data/mailbox-<id>/calendar.json — events / emails / tasks per mailbox
 * - data/prompts.json — live prompt (hot-read on each extract)
 * - data/daylight.sqlite — prompt_revisions + kv meta (audit / future indexes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const dbPath = path.join(dataDir, 'daylight.sqlite');

let SQL;
let db;
let ready;

async function open() {
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

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export async function setKv(key, value) {
  const database = await open();
  const now = new Date().toISOString();
  database.run(
    'INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    [key, JSON.stringify(value), now],
  );
  persist();
}

export async function getKv(key, fallback = null) {
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
  const database = await open();
  const now = new Date().toISOString();
  database.run('INSERT INTO prompt_revisions(kind, body, created_at) VALUES(?, ?, ?)', [kind, body, now]);
  persist();
  await setKv('prompts.updatedAt', now);
  return { kind, createdAt: now };
}

export async function listPromptRevisions(limit = 20) {
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
  await open();
  return {
    engine: 'sql.js',
    path: dbPath,
    exists: fs.existsSync(dbPath),
    note: 'Hybrid: JSON mailbox stores + SQLite prompt revisions / kv',
  };
}
