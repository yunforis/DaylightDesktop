import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getRequestUserId } from '../request-context.js';
import { usesStorageSnapshot, readSnapshotDocument, stageSnapshotDocument, settingsKey, mutateSnapshot, withStorageCommit } from '../storage/index.js';
import { getPostgresPool, postgresMode } from '../infra/postgres.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const directory = path.join(process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data'), 'scenarios');
const empty = () => ({ schemaVersion: 1, workbenches: [], templates: [], items: [], actions: [], materials: [], previews: [], executions: [], history: [] });
const pending = new Map();
export function ownerId() {
  const id = getRequestUserId();
  if (!id) throw Object.assign(new Error('请先登录'), { status: 401 });
  return id;
}
const filename = (id) => path.join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
const loadFile = (id) => fs.existsSync(filename(id)) ? { ...empty(), ...JSON.parse(fs.readFileSync(filename(id),'utf8')) } : empty();
function saveFile(id, data) {
  fs.mkdirSync(directory,{recursive:true});
  const target = filename(id);
  fs.writeFileSync(`${target}.tmp`,JSON.stringify(data,null,2), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`,target);
}
export async function readScenarioData() {
  const userId = ownerId();
  if (usesStorageSnapshot()) return { ...empty(), ...readSnapshotDocument(settingsKey(`scenarios:${userId}`)) };
  if (postgresMode() === 'postgres') {
    const db = getPostgresPool();
    if (!db) throw Object.assign(new Error('PostgreSQL storage is unavailable'), { code: 'STORAGE_UNAVAILABLE', status: 503 });
    const { rows } = await db.query('SELECT payload FROM app_settings WHERE id = $1', [`scenarios:${userId}`]);
    return { ...empty(), ...rows[0]?.payload };
  }
  return loadFile(userId);
}

/** PG changes stage alongside calendars; the caller MUST await the outer commit before responding. */
export async function mutateScenarioData(change) {
  const userId = ownerId();
  if (!usesStorageSnapshot() && postgresMode() === 'postgres') {
    // Standalone development callers get the same short snapshot/CAS protocol as HTTP.
    // Do not hold a PG transaction while running business callbacks or network work.
    return withStorageCommit({ userId }, () => mutateScenarioData(change));
  }
  if (usesStorageSnapshot()) {
    return mutateSnapshot(() => {
      const key = settingsKey(`scenarios:${userId}`);
      const data = { ...empty(), ...readSnapshotDocument(key) };
      const result = change(data);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw Object.assign(new Error('Scenario mutation callbacks must be synchronous'), { code: 'STORAGE_ASYNC_MUTATOR', status: 400 });
      }
      stageSnapshotDocument(key, data);
      return result;
    });
  }
  const previous = pending.get(userId) || Promise.resolve();
  const task = previous.catch(()=>{}).then(async () => {
    const data = loadFile(userId);
    const result = await change(data);
    saveFile(userId,data);
    return result;
  });
  pending.set(userId,task);
  try { return await task; }
  finally { if (pending.get(userId) === task) pending.delete(userId); }
}
