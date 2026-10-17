/** Durable assistant state. Mutations contain no network calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { readSettings, mailboxDirectory } from './store.js';
import { getRequestUserId } from './request-context.js';
import { readInfraConfig } from './infra/config.js';
import { getPostgresPool } from './infra/postgres.js';
import { publishAssistantFileLock } from './assistant-file-lock.js';
import { isProductionRuntime } from './runtime-mode.js';
import { isRegisteredMailbox } from './mailbox-identity.js';

export function assistantMailbox(mailboxId, settings = readSettings()) {
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId);
  if (!mailbox || (isProductionRuntime() && getRequestUserId()
    && (mailbox.ownerUserId || mailbox.userId) !== getRequestUserId())) {
    throw Object.assign(new Error('邮箱不存在或无权访问。'), { status: 404 });
  }
  return mailbox;
}

function pendingMailbox(mailboxId) {
  if (!isProductionRuntime()) return false;
  const settings = readSettings();
  const mailbox = assistantMailbox(mailboxId, settings);
  return mailbox.pendingSetup === true && !isRegisteredMailbox(mailboxId, settings, getRequestUserId());
}

const setupRequired = () => Object.assign(new Error('请先在设置中保存并配置自己的邮箱，再使用小 D 执行操作。'),
  { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });

const initial = () => ({ schemaVersion: 1, items: [] });
const queues = new Map();

function location(mailboxId, namespace) {
  if (namespace !== 'meetings' || isProductionRuntime()) assistantMailbox(mailboxId);
  if (!['drafts', 'requests', 'recruitment-effects', 'meetings'].includes(namespace)) throw new Error('无效的小 D 存储类型。');
  const identity = createHash('sha256').update(`${getRequestUserId() || 'local'}\0${mailboxId}`).digest('hex');
  return { id: namespace === 'meetings' ? `assistant-meetings:${mailboxId}` : `assistant:${namespace}:${identity}`,
    file: isProductionRuntime() ? null : path.join(mailboxDirectory(mailboxId), `assistant-${namespace}.json`) };
}

function database(file) {
  if (isProductionRuntime()) {
    const pool = getPostgresPool();
    if (!pool) throw Object.assign(new Error('共享操作存储不可用。'), { status: 503 });
    return pool;
  }
  const enabled = readInfraConfig().postgres.enabled;
  if (!enabled) {
    if (fs.existsSync(`${file}.postgres`)) {
      throw Object.assign(new Error('此邮箱的小 D 操作记录已由 PostgreSQL 管理，请恢复数据库后再操作。切回 JSON 前须先迁移最新记录，避免重复执行。'), { status: 503 });
    }
    return null;
  }
  const pool = getPostgresPool();
  if (!pool) {
    throw Object.assign(new Error('小 D 操作存储所需的 PostgreSQL 当前不可用，请恢复连接后重试；尚未执行外部操作。'), { status: 503 });
  }
  return pool;
}

function load(file) {
  return fs.existsSync(file) ? { ...initial(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : initial();
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function readAssistantState(mailboxId, namespace) {
  if (pendingMailbox(mailboxId)) return initial();
  const { id, file } = location(mailboxId, namespace);
  const pool = database(file);
  if (!pool) return load(file);
  const { rows } = await pool.query('select payload from app_settings where id=$1', [id]);
  if (rows[0]) {
    if (file) save(`${file}.postgres`, { authoritative: 'postgres', id });
    return { ...initial(), ...rows[0].payload };
  }
  if (file && fs.existsSync(`${file}.postgres`)) throw Object.assign(new Error('小 D 的数据库权威记录缺失，请恢复数据库备份后重试。'), { status: 503, code: 'MEETING_STORAGE_AUTHORITY_MISSING' });
  return file ? load(file) : initial();
}

function reapDeadLock(lock) {
  const guard = `${lock}.reap`;
  try { publishAssistantFileLock(guard, { pid: process.pid }); }
  catch (failure) { if (failure.code === 'EEXIST') return; throw failure; }
  try {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    let alive = true;
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); }
      catch (failure) { alive = failure.code !== 'ESRCH'; }
    }
    if (!alive) fs.unlinkSync(lock);
  } catch (failure) { if (failure.code !== 'ENOENT' && !(failure instanceof SyntaxError)) throw failure; }
  finally { fs.unlinkSync(guard); }
}

async function fileMutation(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const started = performance.now();
  const token = randomUUID();
  let acquired = false;
  while (!acquired) {
    try {
      publishAssistantFileLock(lock, { pid: process.pid, token });
      acquired = true;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reapDeadLock(lock);
      if (performance.now() - started > 5_000) throw Object.assign(new Error('小 D 操作存储正被占用，请稍后重试。'), { status: 409 });
      await delay(25);
    }
  }
  try {
    const data = load(file);
    const result = change(data);
    if (result?.then) throw new Error('小 D 存储事务中不能执行异步操作。');
    save(file, data);
    return result;
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock);
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
}

export async function mutateAssistantState(mailboxId, namespace, change) {
  if (pendingMailbox(mailboxId)) throw setupRequired();
  const { id, file } = location(mailboxId, namespace);
  const previous = queues.get(id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const pool = database(file);
    if (!pool) return fileMutation(file, change);
    const client = await pool.connect();
    try {
      await client.query('begin');
      let { rows } = await client.query('select payload from app_settings where id=$1 for update', [id]);
      if (!rows[0]) {
        if (file && fs.existsSync(`${file}.postgres`)) throw Object.assign(new Error('小 D 的数据库权威记录缺失，请恢复数据库备份后重试。'), { status: 503, code: 'MEETING_STORAGE_AUTHORITY_MISSING' });
        await client.query('insert into app_settings (id,payload,updated_at) values ($1,$2::jsonb,$3) on conflict (id) do nothing',
          [id, JSON.stringify(file ? load(file) : initial()), new Date().toISOString()]);
        ({ rows } = await client.query('select payload from app_settings where id=$1 for update', [id]));
      }
      const data = { ...initial(), ...rows[0].payload };
      const result = change(data);
      if (result?.then) throw new Error('小 D 存储事务中不能执行异步操作。');
      await client.query('update app_settings set payload=$2::jsonb,updated_at=$3 where id=$1', [id, JSON.stringify(data), new Date().toISOString()]);
      await client.query('commit');
      // This durable barrier prevents an old pending JSON copy resurfacing after PG is disabled.
      if (file) save(`${file}.postgres`, { authoritative: 'postgres', id });
      if (file && namespace === 'meetings') { try { save(file, data); } catch { /* PG remains authoritative. */ } }
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally { client.release(); }
  });
  queues.set(id, task);
  try { return await task; }
  finally { if (queues.get(id) === task) queues.delete(id); }
}
