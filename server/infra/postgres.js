import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInfraConfig } from './config.js';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';
import { counter, timer } from '../metrics.js';
import {
  normalizeWorkspaceMode,
  normalizeWorkspaceModeChanges,
  workspaceModePublicMeta,
} from '../workspace-mode.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const usersPath = path.join(dataDir, 'users.json');

let pool = null;
let mode = 'file';
let lastConnectionError = null;

/** Per-process connection pool size. Defaults to the previous behaviour (5). */
function poolMax() {
  const raw = Number(process.env.DAYLIGHT_PG_POOL_MAX || 5);
  return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 5;
}

/** Low-cardinality label: the leading SQL keyword, never the statement or its values. */
function sqlOp(input) {
  const text = typeof input === 'string' ? input : String(input?.text ?? '');
  return text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'other';
}

/**
 * Wraps `pool.connect` so every pooled connection times its own statements. `Pool.query`
 * borrows a connection through `this.connect`, so this covers both query styles with a
 * single sample per statement (wrapping `pool.query` as well would double count).
 */
function instrumentPool(target) {
  const connect = target.connect.bind(target);
  target.connect = (...args) => {
    const result = connect(...args);
    if (result && typeof result.then === 'function') return result.then(client => instrumentClient(client));
    return instrumentClient(result);
  };
  return target;
}

function instrumentClient(client) {
  if (!client || client.__daylightTimed) return client;
  client.__daylightTimed = true;
  const run = client.query.bind(client);
  client.query = (...args) => {
    const stop = timer('pg.query.ms', { op: sqlOp(args[0]) });
    let result;
    try { result = run(...args); }
    catch (error) { stop({ outcome: 'error' }); throw error; }
    if (result && typeof result.then === 'function') {
      return result.then(value => { stop({ outcome: 'ok' }); return value; },
        error => { stop({ outcome: 'error' }); throw error; });
    }
    stop({ outcome: 'ok' });
    return result;
  };
  return client;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  workspace_mode TEXT NOT NULL DEFAULT 'personal',
  workspace_mode_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_login_at TIMESTAMPTZ,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_mode TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_mode_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS mailbox_calendars (
  mailbox_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`;

export function getPostgresPool() {
  return pool;
}

export async function closePostgres() {
  const previous = pool;
  pool = null;
  lastConnectionError = null;
  mode = isProductionRuntime() ? 'unavailable' : 'file';
  await previous?.end();
}

/** Read-only migration contract; never create schema or import files here. */
export async function postgresRuntimeReady({ requireSettings = true } = {}) {
  if (!pool) return false;
  await pool.query('SELECT id, session_version, workspace_mode_changes FROM users LIMIT 0');
  await pool.query('SELECT token, user_id, expires_at, used_at FROM password_resets LIMIT 0');
  await pool.query('SELECT mailbox_id, payload, version FROM mailbox_calendars LIMIT 0');
  await pool.query('SELECT id, payload, version FROM app_settings LIMIT 0');
  await pool.query('SELECT id, sequence, lease_token, generation FROM daylight_jobs LIMIT 0');
  await pool.query('SELECT job_id, name, generation FROM daylight_job_steps LIMIT 0');
  await pool.query('SELECT id, job_id, lease_token FROM daylight_job_outbox LIMIT 0');
  await pool.query('SELECT tenant_id, mailbox_id FROM daylight_job_mailboxes LIMIT 0');
  await pool.query('SELECT id, mailbox_id, owner_user_id, content, embedding FROM rag_chunks LIMIT 0');
  if (requireSettings) {
    const { rows } = await pool.query("SELECT payload FROM app_settings WHERE id = 'default'");
    if (!rows[0]?.payload || typeof rows[0].payload !== 'object' || Array.isArray(rows[0].payload)) return false;
  }
  return true;
}

function ensureUsersFile() {
  requireLocalRuntime('File-backed users');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(usersPath)) {
    fs.writeFileSync(usersPath, `${JSON.stringify({ users: [], resets: [] }, null, 2)}\n`);
  }
}

function readUsersFile() {
  ensureUsersFile();
  return JSON.parse(fs.readFileSync(usersPath, 'utf8'));
}

function writeUsersFile(data) {
  ensureUsersFile();
  fs.writeFileSync(usersPath, `${JSON.stringify(data, null, 2)}\n`);
}

export function postgresMode() {
  return mode;
}

export async function initPostgres() {
  const config = readInfraConfig({ force: true }).postgres;
  if (pool) {
    try { await pool.end(); } catch { /* ignore */ }
  }
  pool = null;
  mode = 'file';
  lastConnectionError = null;
  if (!config.enabled) {
    ensureUsersFile();
    return { ok: true, mode };
  }

  let next;
  try {
    const pg = await import('pg');
    const connectionString = config.connectionString
      || `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`;
    next = new pg.default.Pool({
      connectionString,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: 5000,
      query_timeout: 4500,
      statement_timeout: 4500,
      // Per-process pool size is a deployment tunable: a pod that runs several workers
      // needs more connections than one, and the default stays conservative.
      max: poolMax(),
    });
    next.on('error', () => { counter('pg.pool_error_total'); });
    instrumentPool(next);
    await next.query('select 1');
    if (!isProductionRuntime()) await next.query(SCHEMA);
    else {
      await next.query('select id, session_version, workspace_mode_changes from users limit 0');
      await next.query('select token from password_resets limit 0');
      await next.query('select mailbox_id, payload from mailbox_calendars limit 0');
      await next.query('select id, payload from app_settings limit 0');
    }
    pool = next;
    mode = 'postgres';
    if (isProductionRuntime()) return { ok: true, mode };
    // 首次启用本机 PG 时，把 users.json 导入一次，避免管理员账号丢失。
    try {
      const { rows } = await pool.query('select count(*)::int as count from users');
      if ((rows[0]?.count || 0) === 0) {
        const file = readUsersFile();
        for (const user of file.users || []) {
          await pool.query(
            `insert into users (id, email, username, password_hash, role, last_login_at, session_version, created_at, updated_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (id) do nothing`,
            [
              user.id,
              user.email,
              user.username,
              user.password_hash,
              user.role === 'admin' ? 'admin' : 'user',
              user.last_login_at || null,
              Number(user.session_version) || 0,
              user.created_at || new Date().toISOString(),
              user.updated_at || new Date().toISOString(),
            ],
          );
        }
      }
    } catch { /* ignore migration errors */ }
    return { ok: true, mode };
  } catch (error) {
    if (next) { try { await next.end(); } catch { /* preserve connection error */ } }
    pool = null;
    lastConnectionError = error.message;
    if (isProductionRuntime()) { mode = 'unavailable'; throw error; }
    mode = 'file';
    ensureUsersFile();
    return { ok: false, mode, error: error.message };
  }
}

export async function postgresStatus() {
  if (mode === 'postgres' && pool) {
    try {
      await pool.query('select 1');
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, mode: 'unavailable', error: error.message };
    }
  }
  if (isProductionRuntime() || readInfraConfig().postgres.enabled) {
    return { ok: false, mode: 'unavailable', error: lastConnectionError || 'PostgreSQL is enabled but not connected' };
  }
  return { ok: true, mode: 'file', note: '未启用本机 PostgreSQL 时用户数据落在 data/users.json' };
}

export async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (pool) {
    const { rows } = await pool.query('select * from users where lower(email) = $1 limit 1', [normalized]);
    return rows[0] || null;
  }
  return readUsersFile().users.find((user) => user.email.toLowerCase() === normalized) || null;
}

export async function findUserByUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (pool) {
    const { rows } = await pool.query('select * from users where lower(username) = $1 limit 1', [normalized]);
    return rows[0] || null;
  }
  return readUsersFile().users.find((user) => user.username.toLowerCase() === normalized) || null;
}

export async function findUserById(id) {
  if (pool) {
    const { rows } = await pool.query('select * from users where id = $1 limit 1', [id]);
    return rows[0] || null;
  }
  return readUsersFile().users.find((user) => user.id === id) || null;
}

export async function createUser({
  id, email, username, passwordHash, role = 'user', workspaceMode = 'personal',
}) {
  const now = new Date().toISOString();
  const row = {
    id,
    email: email.trim().toLowerCase(),
    username: username.trim(),
    password_hash: passwordHash,
    role: role === 'admin' ? 'admin' : 'user',
    workspace_mode: normalizeWorkspaceMode(workspaceMode),
    workspace_mode_changes: [],
    last_login_at: null,
    session_version: 0,
    created_at: now,
    updated_at: now,
  };
  if (pool) {
    await pool.query(
      `insert into users (id, email, username, password_hash, role, workspace_mode, workspace_mode_changes,
        last_login_at, session_version, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
      [
        row.id, row.email, row.username, row.password_hash, row.role, row.workspace_mode,
        JSON.stringify(row.workspace_mode_changes), row.last_login_at, row.session_version,
        row.created_at, row.updated_at,
      ],
    );
    return row;
  }
  const data = readUsersFile();
  data.users.push(row);
  writeUsersFile(data);
  return row;
}

export async function listUsers() {
  if (pool) {
    const { rows } = await pool.query('select * from users order by created_at desc');
    return rows;
  }
  return [...readUsersFile().users].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function updateUser(userId, patch = {}) {
  const now = new Date().toISOString();
  const current = await findUserById(userId);
  if (!current) throw Object.assign(new Error('用户不存在'), { status: 404 });

  const nextEmail = patch.email !== undefined ? String(patch.email).trim().toLowerCase() : current.email;
  const nextUsername = patch.username !== undefined ? String(patch.username).trim() : current.username;
  const nextRole = patch.role !== undefined
    ? (patch.role === 'admin' ? 'admin' : 'user')
    : (current.role || 'user');
  const nextHash = patch.passwordHash !== undefined ? patch.passwordHash : current.password_hash;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    throw Object.assign(new Error('请输入有效邮箱'), { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(nextUsername)) {
    throw Object.assign(new Error('用户名需为 2–24 位字母、数字、下划线或中文'), { status: 400 });
  }

  const byEmail = await findUserByEmail(nextEmail);
  if (byEmail && byEmail.id !== userId) {
    throw Object.assign(new Error('该邮箱已注册'), { status: 409 });
  }
  const byUsername = await findUserByUsername(nextUsername);
  if (byUsername && byUsername.id !== userId) {
    throw Object.assign(new Error('该用户名已被占用'), { status: 409 });
  }

  const nextLastLogin = patch.lastLoginAt !== undefined ? patch.lastLoginAt : (current.last_login_at || null);
  const nextSessionVersion = patch.sessionVersion !== undefined
    ? Number(patch.sessionVersion) || 0
    : (Number(current.session_version) || 0);
  // Preserve legacy metadata without allowing it to gate or change capabilities.
  const nextWorkspaceMode = normalizeWorkspaceMode(current.workspace_mode);
  const nextWorkspaceModeChanges = normalizeWorkspaceModeChanges(current.workspace_mode_changes);

  if (pool) {
    await pool.query(
      `update users set email = $1, username = $2, role = $3, password_hash = coalesce($4, password_hash),
       workspace_mode = $5, workspace_mode_changes = $6::jsonb,
       last_login_at = coalesce($7, last_login_at), session_version = greatest(session_version, coalesce($8, session_version)), updated_at = $9 where id = $10`,
      [
        nextEmail, nextUsername, nextRole, patch.passwordHash ?? null, nextWorkspaceMode,
        JSON.stringify(nextWorkspaceModeChanges), patch.lastLoginAt ?? null,
        patch.sessionVersion === undefined ? null : nextSessionVersion, now, userId,
      ],
    );
    return findUserById(userId);
  }
  const data = readUsersFile();
  const user = data.users.find((item) => item.id === userId);
  user.email = nextEmail;
  user.username = nextUsername;
  user.role = nextRole;
  if (patch.passwordHash !== undefined) user.password_hash = nextHash;
  user.workspace_mode = nextWorkspaceMode;
  user.workspace_mode_changes = nextWorkspaceModeChanges;
  if (patch.lastLoginAt !== undefined) user.last_login_at = nextLastLogin;
  if (patch.sessionVersion !== undefined) user.session_version = Math.max(Number(user.session_version) || 0, nextSessionVersion);
  user.updated_at = now;
  writeUsersFile(data);
  return user;
}

export async function touchUserLogin(userId) {
  const now = new Date().toISOString();
  if (pool) {
    await pool.query('update users set last_login_at = $1, updated_at = $1 where id = $2', [now, userId]);
    return findUserById(userId);
  }
  const data = readUsersFile();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  user.last_login_at = now;
  user.updated_at = now;
  writeUsersFile(data);
  return user;
}

export async function bumpSessionVersion(userId) {
  if (pool) {
    const { rows } = await pool.query('update users set session_version = session_version + 1, updated_at = $2 where id = $1 returning *', [userId, new Date().toISOString()]);
    if (!rows[0]) throw Object.assign(new Error('用户不存在'), { status: 404 });
    return rows[0];
  }
  const data = readUsersFile();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  user.session_version = (Number(user.session_version) || 0) + 1;
  user.updated_at = new Date().toISOString();
  writeUsersFile(data);
  return user;
}

export async function deleteUser(userId) {
  if (pool) {
    const result = await pool.query('delete from users where id = $1', [userId]);
    if (!result.rowCount) throw Object.assign(new Error('用户不存在'), { status: 404 });
    return;
  }
  const data = readUsersFile();
  const before = data.users.length;
  data.users = data.users.filter((item) => item.id !== userId);
  if (data.users.length === before) throw Object.assign(new Error('用户不存在'), { status: 404 });
  data.resets = (data.resets || []).filter((item) => item.user_id !== userId);
  writeUsersFile(data);
}

export async function updateUserPassword(userId, passwordHash) {
  const now = new Date().toISOString();
  if (pool) {
    await pool.query('update users set password_hash = $1, updated_at = $2 where id = $3', [passwordHash, now, userId]);
    return;
  }
  const data = readUsersFile();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new Error('用户不存在');
  user.password_hash = passwordHash;
  user.updated_at = now;
  writeUsersFile(data);
}

export async function savePasswordReset({ token, userId, expiresAt }) {
  if (pool) {
    await pool.query(
      'insert into password_resets (token, user_id, expires_at) values ($1,$2,$3)',
      [token, userId, expiresAt],
    );
    return;
  }
  const data = readUsersFile();
  data.resets = data.resets.filter((item) => item.user_id !== userId);
  data.resets.push({ token, user_id: userId, expires_at: expiresAt, used_at: null });
  writeUsersFile(data);
}

export async function consumePasswordReset(token) {
  const now = new Date();
  if (pool) {
    const { rows } = await pool.query(
      'update password_resets set used_at = CURRENT_TIMESTAMP where token = $1 and used_at is null and expires_at > CURRENT_TIMESTAMP returning *',
      [token],
    );
    return rows[0] || null;
  }
  const data = readUsersFile();
  const row = data.resets.find((item) => item.token === token && !item.used_at);
  if (!row || new Date(row.expires_at) < now) return null;
  row.used_at = now.toISOString();
  writeUsersFile(data);
  return row;
}

// Hashing is performed by the caller before acquiring a connection. The token
// claim, password and session epoch commit together, or all remain unchanged.
export async function resetPasswordWithToken(token, passwordHash) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'update password_resets set used_at = CURRENT_TIMESTAMP where token = $1 and used_at is null and expires_at > CURRENT_TIMESTAMP returning user_id', [token],
      );
      if (!rows[0]) { await client.query('ROLLBACK'); return null; }
      const result = await client.query(
        'update users set password_hash = $2, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP where id = $1 returning *',
        [rows[0].user_id, passwordHash],
      );
      if (!result.rows[0]) { await client.query('ROLLBACK'); return null; }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  const data = readUsersFile();
  const now = new Date();
  const reset = data.resets.find((item) => item.token === token && !item.used_at && new Date(item.expires_at) > now);
  if (!reset) return null;
  const user = data.users.find((item) => item.id === reset.user_id);
  if (!user) return null;
  reset.used_at = now.toISOString();
  user.password_hash = passwordHash;
  user.session_version = (Number(user.session_version) || 0) + 1;
  user.updated_at = now.toISOString();
  writeUsersFile(data);
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  const modeMeta = workspaceModePublicMeta({
    workspace_mode: user.workspace_mode,
    workspace_mode_changes: user.workspace_mode_changes,
  });
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role === 'admin' ? 'admin' : 'user',
    ...modeMeta,
    lastLoginAt: user.last_login_at || null,
    sessionVersion: Number(user.session_version) || 0,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}
