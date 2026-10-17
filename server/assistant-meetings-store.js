import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mailboxDirectory, readStore } from './store.js';
import { saveCalendarWithExternalSync } from './external-calendar.js';
import { readInfraConfig } from './infra/config.js';
import { getPostgresPool, postgresMode } from './infra/postgres.js';
import { publishAssistantFileLock } from './assistant-file-lock.js';
import { mutateAssistantState, readAssistantState } from './assistant-state.js';
import { isProductionRuntime } from './runtime-mode.js';
import { usesStorageSnapshot, commitStorage } from './storage/index.js';

const waiting = new Map();
const empty = () => ({ schemaVersion: 1, operations: [] });
const filename = (mailboxId) => path.join(mailboxDirectory(mailboxId), 'assistant-meetings.json');
const authorityFilename = (mailboxId) => `${filename(mailboxId)}.postgres`;
const error = (message, code) => Object.assign(new Error(message), { code });

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readFile(mailboxId) {
  const file = filename(mailboxId);
  return fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();
}

function hasPostgresAuthority(mailboxId) {
  return fs.existsSync(authorityFilename(mailboxId));
}

function markPostgresAuthority(mailboxId) {
  atomicWrite(authorityFilename(mailboxId), {
    authoritative: 'postgres', id: `assistant-meetings:${mailboxId}`, schemaVersion: 1,
  });
}

function missingAuthority() {
  return error('会议操作的 PostgreSQL 权威记录缺失，请恢复数据库备份后再重试；未从旧 JSON 记录恢复。', 'MEETING_STORAGE_AUTHORITY_MISSING');
}

function database(mailboxId) {
  if (isProductionRuntime()) {
    const pool = getPostgresPool();
    if (!pool) throw error('共享会议存储不可用。', 'MEETING_STORAGE_UNAVAILABLE');
    return pool;
  }
  if (!readInfraConfig().postgres.enabled) {
    if (hasPostgresAuthority(mailboxId)) {
      throw error('此邮箱的会议操作记录已由 PostgreSQL 管理，请恢复数据库后再操作。切回 JSON 前须明确迁移最新记录，避免重复建会。', 'MEETING_STORAGE_AUTHORITY_REQUIRED');
    }
    return null;
  }
  const pool = postgresMode() === 'postgres' ? getPostgresPool() : null;
  if (!pool) throw error('会议操作需要已配置的 PostgreSQL，但当前数据库未连接。请恢复连接后重试。', 'MEETING_STORAGE_UNAVAILABLE');
  return pool;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (failure) { return failure.code !== 'ESRCH'; }
}

function reapDeadLock(file) {
  // Only one process may remove a crashed owner's lock. Re-read after acquiring this guard, so a
  // competing recovery cannot mistake a newly created live lock for the old, dead one.
  const guard = `${file}.reap`;
  try { publishAssistantFileLock(guard, { pid: process.pid }); }
  catch (failure) { if (failure.code === 'EEXIST') return; throw failure; }
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!processAlive(owner.pid)) fs.unlinkSync(file);
  } catch (failure) { if (failure.code !== 'ENOENT' && !(failure instanceof SyntaxError)) throw failure; }
  finally {
    fs.unlinkSync(guard);
  }
}

async function localLock(mailboxId) {
  const file = `${filename(mailboxId)}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      publishAssistantFileLock(file, { pid: process.pid, token });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
        } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      };
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      // A crashed process may leave a lock. The durable "preparing" record still prevents a duplicate reserve.
      reapDeadLock(file);
      if (Date.now() >= deadline) throw error('当前邮箱正在安排会议，请稍后查看执行结果再重试。', 'MEETING_BUSY');
      await delay(50);
    }
  }
}

function fileRepository(mailboxId) {
  return {
    read: async () => readFile(mailboxId),
    save: async (data) => atomicWrite(filename(mailboxId), data),
    readCalendar: async () => readStore(mailboxId),
    saveCalendar: async (data) => atomicWrite(path.join(mailboxDirectory(mailboxId), 'calendar.json'), {
      ...data, updatedAt: new Date().toISOString(),
    }),
  };
}

function postgresRepository(mailboxId, client) {
  const id = `assistant-meetings:${mailboxId}`;
  return {
    async read() {
      const { rows } = await client.query('select payload from app_settings where id = $1', [id]);
      if (rows[0]) {
        // Persist the authority barrier before any subsequent external call. Never parse an obsolete cache here.
        markPostgresAuthority(mailboxId);
        return { ...empty(), ...rows[0].payload };
      }
      if (hasPostgresAuthority(mailboxId)) throw missingAuthority();
      return readFile(mailboxId);
    },
    async save(data) {
      await client.query(`insert into app_settings (id, payload, updated_at) values ($1,$2::jsonb,$3)
        on conflict (id) do update set payload=excluded.payload, updated_at=excluded.updated_at`,
      [id, JSON.stringify(data), new Date().toISOString()]);
      // Failure to persist this barrier must stop execution before the next external side effect.
      markPostgresAuthority(mailboxId);
      // The database commit is authoritative. A cache failure must not turn it into an unknown external result.
      try { atomicWrite(filename(mailboxId), data); } catch { /* Rebuilt from the database on the next read. */ }
    },
    async readCalendar() {
      const { rows } = await client.query('select payload from mailbox_calendars where mailbox_id = $1', [mailboxId]);
      return rows[0] ? { tasks: [], ...rows[0].payload } : readStore(mailboxId);
    },
    async saveCalendar(data) {
      const payload = { ...data, updatedAt: new Date().toISOString() };
      await client.query(`insert into mailbox_calendars (mailbox_id,payload,updated_at) values ($1,$2::jsonb,$3)
        on conflict (mailbox_id) do update set payload=excluded.payload, updated_at=excluded.updated_at`,
      [mailboxId, JSON.stringify(payload), payload.updatedAt]);
      try { atomicWrite(path.join(mailboxDirectory(mailboxId), 'calendar.json'), payload); } catch { /* Database remains authoritative. */ }
    },
  };
}

/** Serialize each mailbox across processes. Every checkpoint commits before the next external side effect. */
export async function withAssistantMeetingMailboxLock(mailboxId, change) {
  const previous = waiting.get(mailboxId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const pool = database(mailboxId);
    if (!pool) {
      const release = await localLock(mailboxId);
      try { return await change(fileRepository(mailboxId)); }
      finally { release(); }
    }
    const token = randomUUID();
    const claim = () => mutateAssistantState(mailboxId, 'meetings', (data) => {
      if (data.lease && data.lease.expiresAt > Date.now()) return false;
      data.lease = { token, expiresAt: Date.now() + 120_000 };
      return true;
    });
    const deadline = Date.now() + 10_000;
    while (!await claim()) {
      if (Date.now() >= deadline) throw error('当前邮箱正在安排会议，请稍后查看结果。', 'MEETING_BUSY');
      await delay(100);
    }
    const fenced = (change) => mutateAssistantState(mailboxId, 'meetings', (data) => {
      if (data.lease?.token !== token || data.lease.expiresAt <= Date.now()) throw error('会议操作租约已过期，请核对已有结果。', 'MEETING_LEASE_LOST');
      return change(data);
    });
    try {
      const legacy = postgresRepository(mailboxId, pool);
      return await change({
        read: () => fenced(data => structuredClone({ ...empty(), ...data })),
        save: data => fenced(current => { current.operations = structuredClone(data.operations); }),
        readCalendar: () => usesStorageSnapshot() ? readStore(mailboxId) : legacy.readCalendar(),
        saveCalendar: async data => {
          await fenced(() => {});
          if (usesStorageSnapshot()) { saveCalendarWithExternalSync(data, mailboxId); await commitStorage(); }
          else await legacy.saveCalendar(data);
        },
      });
    } finally {
      await mutateAssistantState(mailboxId, 'meetings', data => {
        if (data.lease?.token === token) delete data.lease;
      }).catch(() => {});
    }
  });
  waiting.set(mailboxId, task);
  try { return await task; }
  finally { if (waiting.get(mailboxId) === task) waiting.delete(mailboxId); }
}

export async function readAssistantMeetingOperations(mailboxId) {
  const pool = database(mailboxId);
  if (!pool) return readFile(mailboxId);
  return { ...empty(), ...await readAssistantState(mailboxId, 'meetings') };
}
