import { randomUUID } from 'node:crypto';
import { readInfraConfig } from './config.js';
import { redisDel, redisGet, redisKeys, redisSet } from './redis.js';

function sessionTtlSeconds() {
  const days = Number(readInfraConfig().auth.sessionDays) || 14;
  return Math.max(1, days) * 24 * 60 * 60;
}

function sessionKey(userId, jti) {
  return `session:${userId}:${jti}`;
}

export async function createUserSession(user, meta = {}) {
  const jti = randomUUID();
  const ttl = sessionTtlSeconds();
  const payload = {
    jti,
    userId: user.id,
    email: user.email,
    username: user.username,
    role: user.role || 'user',
    sessionVersion: Number(user.session_version) || 0,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    userAgent: meta.userAgent || '',
    ip: meta.ip || '',
  };
  await redisSet(sessionKey(user.id, jti), JSON.stringify(payload), ttl);
  return payload;
}

export async function touchUserSession(userId, jti) {
  if (!userId || !jti) return null;
  const key = sessionKey(userId, jti);
  const raw = await redisGet(key);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    payload.lastSeenAt = new Date().toISOString();
    await redisSet(key, JSON.stringify(payload), sessionTtlSeconds());
    return payload;
  } catch {
    return null;
  }
}

export async function getUserSession(userId, jti) {
  if (!userId || !jti) return null;
  const raw = await redisGet(sessionKey(userId, jti));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listUserSessions(userId) {
  const keys = await redisKeys(`session:${userId}:`);
  const sessions = [];
  for (const key of keys) {
    const raw = await redisGet(key);
    if (!raw) continue;
    try {
      sessions.push(JSON.parse(raw));
    } catch { /* ignore */ }
  }
  sessions.sort((a, b) => String(b.lastSeenAt || b.createdAt || '').localeCompare(String(a.lastSeenAt || a.createdAt || '')));
  return sessions;
}

export async function revokeUserSession(userId, jti) {
  await redisDel(sessionKey(userId, jti));
  return { ok: true };
}

export async function revokeAllUserSessions(userId) {
  const keys = await redisKeys(`session:${userId}:`);
  for (const key of keys) await redisDel(key);
  return { ok: true, revoked: keys.length };
}
