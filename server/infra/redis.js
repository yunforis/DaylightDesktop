import { readInfraConfig } from './config.js';

const memory = new Map();
let client = null;
let mode = 'memory';

export function redisMode() {
  return mode;
}

export async function initRedis() {
  const config = readInfraConfig({ force: true }).redis;
  if (client?.quit) {
    try { await client.quit(); } catch { /* ignore */ }
  }
  client = null;
  mode = 'memory';
  if (!config.enabled) return { ok: true, mode };

  try {
    const Redis = (await import('ioredis')).default;
    const instance = config.url
      ? new Redis(config.url, { maxRetriesPerRequest: 1, lazyConnect: true })
      : new Redis({
        host: config.host,
        port: Number(config.port) || 6379,
        password: config.password || undefined,
        db: Number(config.db) || 0,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
    await instance.connect();
    await instance.ping();
    client = instance;
    mode = 'redis';
    return { ok: true, mode };
  } catch (error) {
    client = null;
    mode = 'memory';
    return { ok: false, mode, error: error.message };
  }
}

export async function redisGet(key) {
  if (client) return client.get(key);
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

export async function redisSet(key, value, ttlSeconds) {
  if (client) {
    if (ttlSeconds) return client.set(key, value, 'EX', ttlSeconds);
    return client.set(key, value);
  }
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
  return 'OK';
}

export async function redisDel(key) {
  if (client) return client.del(key);
  memory.delete(key);
  return 1;
}

/** 简单前缀扫描：本机 Redis 或内存回退均可。 */
export async function redisKeys(prefix) {
  const needle = String(prefix || '');
  if (client) {
    const keys = await client.keys(`${needle}*`);
    return keys;
  }
  const now = Date.now();
  const out = [];
  for (const [key, hit] of memory.entries()) {
    if (hit.expiresAt && hit.expiresAt < now) {
      memory.delete(key);
      continue;
    }
    if (key.startsWith(needle)) out.push(key);
  }
  return out;
}

export async function redisStatus() {
  if (mode === 'redis' && client) {
    try {
      await client.ping();
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, mode: 'memory', error: error.message };
    }
  }
  return { ok: true, mode: 'memory', note: '未启用本机 Redis 时使用进程内存' };
}
