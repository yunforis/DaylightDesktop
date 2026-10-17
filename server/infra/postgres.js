import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInfraConfig } from './config.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const usersPath = path.join(dataDir, 'users.json');

let pool = null;
let mode = 'file';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  last_login_at TIMESTAMPTZ,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
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

function ensureUsersFile() {
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
  if (!config.enabled) {
    ensureUsersFile();
    return { ok: true, mode };
  }

  try {
    const pg = await import('pg');
    const connectionString = config.connectionString
      || `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`;
    const next = new pg.default.Pool({
      connectionString,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    await next.query('select 1');
    await next.query(SCHEMA);
    pool = next;
    mode = 'postgres';
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
    pool = null;
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
      return { ok: false, mode: 'file', error: error.message };
    }
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

export async function createUser({ id, email, username, passwordHash, role = 'user' }) {
  const now = new Date().toISOString();
  const row = {
    id,
    email: email.trim().toLowerCase(),
    username: username.trim(),
    password_hash: passwordHash,
    role: role === 'admin' ? 'admin' : 'user',
    last_login_at: null,
    session_version: 0,
    created_at: now,
    updated_at: now,
  };
  if (pool) {
    await pool.query(
      `insert into users (id, email, username, password_hash, role, last_login_at, session_version, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.email, row.username, row.password_hash, row.role, row.last_login_at, row.session_version, row.created_at, row.updated_at],
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

  if (pool) {
    await pool.query(
      `update users set email = $1, username = $2, role = $3, password_hash = $4,
       last_login_at = $5, session_version = $6, updated_at = $7 where id = $8`,
      [nextEmail, nextUsername, nextRole, nextHash, nextLastLogin, nextSessionVersion, now, userId],
    );
    return findUserById(userId);
  }
  const data = readUsersFile();
  const user = data.users.find((item) => item.id === userId);
  user.email = nextEmail;
  user.username = nextUsername;
  user.role = nextRole;
  user.password_hash = nextHash;
  user.last_login_at = nextLastLogin;
  user.session_version = nextSessionVersion;
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
  const current = await findUserById(userId);
  if (!current) throw Object.assign(new Error('用户不存在'), { status: 404 });
  const next = (Number(current.session_version) || 0) + 1;
  return updateUser(userId, { sessionVersion: next });
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
      'select * from password_resets where token = $1 and used_at is null limit 1',
      [token],
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at) < now) return null;
    await pool.query('update password_resets set used_at = $1 where token = $2', [now.toISOString(), token]);
    return row;
  }
  const data = readUsersFile();
  const row = data.resets.find((item) => item.token === token && !item.used_at);
  if (!row || new Date(row.expires_at) < now) return null;
  row.used_at = now.toISOString();
  writeUsersFile(data);
  return row;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role === 'admin' ? 'admin' : 'user',
    lastLoginAt: user.last_login_at || null,
    sessionVersion: Number(user.session_version) || 0,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}
