import { readInfraConfig } from './config.js';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';
import { timer } from '../metrics.js';

const memory = new Map();
let client = null;
let mode = 'memory';

export function redisMode() {
  return mode;
}

export async function closeRedis({ timeoutMs = 1000 } = {}) {
  const previous = client;
  client = null;
  mode = isProductionRuntime() ? 'unavailable' : 'memory';
  if (!previous) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => previous.quit()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Redis quit timed out')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    previous.disconnect();
  }
}

export async function initRedis() {
  const config = readInfraConfig({ force: true }).redis;
  await closeRedis().catch(() => {});
  mode = 'memory';
  if (!config.enabled) return { ok: true, mode };

  let instance;
  try {
    const Redis = (await import('ioredis')).default;
    // Retry indefinitely with a bounded delay so a broker restart is recoverable.
    // Commands have their own bounded retries and never fall back in production.
    const options = { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000,
      commandTimeout: 4500, enableOfflineQueue: false,
      retryStrategy: isProductionRuntime() ? times => Math.min(200 * times, 3000) : () => null };
    instance = config.url
      ? new Redis(config.url, options)
      : new Redis({
        host: config.host,
        port: Number(config.port) || 6379,
        password: config.password || undefined,
        db: Number(config.db) || 0,
        ...options,
      });
    instance.on('error', () => { /* surfaced through commands and health checks */ });
    await instance.connect();
    await instance.ping();
    instrumentRedis(instance);
    client = instance;
    mode = 'redis';
    return { ok: true, mode };
  } catch (error) {
    instance?.disconnect();
    client = null;
    if (isProductionRuntime()) { mode = 'unavailable'; throw error; }
    mode = 'memory';
    return { ok: false, mode, error: error.message };
  }
}

/**
 * Times every command issued through the pooled client. ioredis routes all generated
 * helpers through `sendCommand`, so one wrapper covers the whole command surface.
 */
function instrumentRedis(instance) {
  const send = instance.sendCommand.bind(instance);
  instance.sendCommand = (command, stream) => {
    const stop = timer('redis.command.ms', { command: String(command?.name || 'unknown').toLowerCase() });
    let result;
    try { result = send(command, stream); }
    catch (error) { stop({ outcome: 'error' }); throw error; }
    if (result && typeof result.then === 'function') {
      return result.then(value => { stop({ outcome: 'ok' }); return value; },
        error => { stop({ outcome: 'error' }); throw error; });
    }
    stop({ outcome: 'ok' });
    return result;
  };
  return instance;
}

export async function redisGet(key) {
  if (client) return client.get(key);
  requireLocalRuntime('In-memory Redis fallback');
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
  requireLocalRuntime('In-memory Redis fallback');
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
  return 'OK';
}

export async function redisDel(key) {
  if (client) return client.del(key);
  requireLocalRuntime('In-memory Redis fallback');
  memory.delete(key);
  return 1;
}

// Keep read/consume and read/update operations in one Redis command. The local
// branches deliberately contain no await so they have the same atomic boundary.
export async function redisGetDel(key) {
  if (client) return client.eval("local v = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v", 1, key);
  requireLocalRuntime('In-memory Redis fallback');
  const hit = memory.get(key);
  memory.delete(key);
  return hit && (!hit.expiresAt || hit.expiresAt > Date.now()) ? hit.value : null;
}

export async function redisConsumeIfEqual(key, expected) {
  if (client) return Boolean(await client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0", 1, key, String(expected)));
  requireLocalRuntime('In-memory Redis fallback');
  const hit = memory.get(key);
  if (!hit || (hit.expiresAt && hit.expiresAt <= Date.now()) || hit.value !== String(expected)) return false;
  memory.delete(key);
  return true;
}

export async function redisTouchSession(key, lastSeenAt, ttlSeconds) {
  if (client) return client.eval(`
    local raw = redis.call('GET', KEYS[1])
    if not raw then return nil end
    local ok, payload = pcall(cjson.decode, raw)
    if not ok or type(payload) ~= 'table' then return nil end
    payload.lastSeenAt = ARGV[1]
    local updated = cjson.encode(payload)
    redis.call('SET', KEYS[1], updated, 'EX', ARGV[2], 'XX')
    return updated
  `, 1, key, lastSeenAt, ttlSeconds);
  requireLocalRuntime('In-memory Redis fallback');
  const hit = memory.get(key);
  if (!hit || (hit.expiresAt && hit.expiresAt <= Date.now())) return null;
  try {
    const payload = JSON.parse(hit.value);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    payload.lastSeenAt = lastSeenAt;
    const value = JSON.stringify(payload);
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return value;
  } catch { return null; }
}

/** 简单前缀扫描：本机 Redis 或内存回退均可。 */
export async function redisKeys(prefix) {
  const needle = String(prefix || '');
  if (client) {
    const keys = await client.keys(`${needle}*`);
    return keys;
  }
  requireLocalRuntime('In-memory Redis fallback');
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
      return { ok: false, mode: 'unavailable', error: error.message };
    }
  }
  if (isProductionRuntime()) return { ok: false, mode: 'unavailable', error: 'Redis is not connected' };
  return { ok: true, mode: 'memory', note: '未启用本机 Redis 时使用进程内存' };
}
