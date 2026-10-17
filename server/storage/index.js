import { AsyncLocalStorage } from 'node:async_hooks';
import { getPostgresPool, postgresMode } from '../infra/postgres.js';
import { isProductionRuntime } from '../runtime-mode.js';
import { getRequestContext, getRequestUserId, runWithRequestContext } from '../request-context.js';
import { auxiliarySnapshotDocuments } from './documents.js';
import { counter, timer } from '../metrics.js';

export { STORAGE_SCHEMA } from './schema.js';
export { createMailJobStorage } from './mail-job.js';
const storage = new AsyncLocalStorage();
const clone = value => structuredClone(value);
const fail = (message, code, status = 503) => Object.assign(new Error(message), { code, status });
const emptyCalendar = () => ({ events: [], emails: [], tasks: [], lastSync: null });
export const calendarKey = id => `calendar:${id}`;
export const settingsKey = id => `settings:${id}`;

export function storageContext() { return storage.getStore() || null; }
export function usesStorageSnapshot() { return Boolean(storageContext()) || isProductionRuntime(); }
function current() {
  const context = storageContext();
  if (!context || context.closed) throw fail('An active storage snapshot is required', 'STORAGE_SNAPSHOT_REQUIRED');
  if (context.committing) throw fail('Storage commit is in progress', 'STORAGE_COMMIT_IN_PROGRESS');
  if (context.failed) throw fail('Reload the snapshot after a failed commit', 'STORAGE_SNAPSHOT_FAILED');
  if (context.userId !== getRequestUserId()) throw fail('Storage identity changed', 'STORAGE_SCOPE_MISMATCH', 403);
  return context;
}
export function readSnapshotDocument(key) {
  const context = current();
  const document = context.documents.get(key);
  if (!document) throw fail(`Document was not loaded: ${key}`, 'STORAGE_DOCUMENT_NOT_LOADED');
  return clone(document.payload);
}
export function stageSnapshotDocument(key, payload) {
  const context = current();
  if (!context.documents.has(key)) throw fail(`Document was not loaded: ${key}`, 'STORAGE_DOCUMENT_NOT_LOADED');
  context.documents.get(key).payload = clone(payload);
  context.dirty.add(key);
}

/** Abandon a failed HTTP operation, including detached continuations using this context. */
export function discardStorage() {
  const context = storageContext();
  if (!context || context.closed) return;
  if (context.committing) throw fail('Storage commit is in progress', 'STORAGE_COMMIT_IN_PROGRESS');
  context.dirty.clear();
  context.closed = true;
}

/** Synchronous business callback; exceptions restore all staged documents, including calendars. */
export function mutateSnapshot(change) {
  const context = current();
  const child = { ...context, documents: clone(context.documents), dirty: new Set(context.dirty) };
  try {
    const result = storage.run(child, change);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw fail('Storage mutation callbacks must be synchronous', 'STORAGE_ASYNC_MUTATOR', 400);
    }
    context.documents = child.documents;
    context.dirty = child.dirty;
    return result;
  } finally { child.closed = true; }
}

async function loadDocument(client, context, table, id, initial) {
  if (!['app_settings', 'mailbox_calendars'].includes(table) || typeof id !== 'string' || !id) throw fail('Invalid document descriptor', 'STORAGE_DOCUMENT_INVALID', 400);
  const key = table === 'app_settings' ? settingsKey(id) : calendarKey(id);
  if (context.documents.has(key)) return;
  const column = table === 'app_settings' ? 'id' : 'mailbox_id';
  const { rows } = await client.query(`SELECT payload, version FROM ${table} WHERE ${column} = $1`, [id]);
  const row = rows[0];
  if (!row && initial === undefined) throw fail('Shared settings are missing; run the explicit migration', 'STORAGE_SETTINGS_MISSING');
  context.documents.set(table === 'app_settings' ? settingsKey(id) : calendarKey(id), {
    table, column, id, version: row ? String(row.version) : null, payload: clone(row ? row.payload : initial),
  });
}

/** Load a short consistent PG snapshot, release the client, then execute application/network work. */
export async function createStorageSnapshot(options = {}) {
  options ||= {};
  if (storageContext()) throw fail('Nested storage snapshots are not supported', 'STORAGE_NESTED_SNAPSHOT', 400);
  const identity = { ...getRequestContext(), ...options.context };
  if (options.userId !== undefined) identity.userId = options.userId;
  if (options.user !== undefined) identity.user = options.user;
  const userId = identity.userId || null;
  if (!userId && options.system !== true) throw fail('An authenticated storage owner is required', 'STORAGE_OWNER_REQUIRED', 401);
  const pool = options.pool || getPostgresPool();
  if (!pool) throw fail('PostgreSQL storage is unavailable', 'STORAGE_UNAVAILABLE');
  if (options.mailboxId !== undefined) identity.mailboxId = options.mailboxId;
  const context = { pool, userId, identity, documents: new Map(), dirty: new Set(), closed: false, committing: false, failed: false };
  const stop = timer('storage.snapshot.ms', { system: options.system === true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await loadDocument(client, context, 'app_settings', 'default');
    const settings = context.documents.get(settingsKey('default')).payload;
    const mailboxes = (settings.mailboxes || []).filter(box => !userId || (box.ownerUserId || box.userId) === userId);
    const allowed = new Set(mailboxes.map(box => box.id));
    if (identity.mailboxId !== undefined && !allowed.has(identity.mailboxId)) throw fail('Mailbox does not belong to this storage owner', 'STORAGE_MAILBOX_FORBIDDEN', 403);
    const ids = [...new Set(options.mailboxIds || [...allowed])];
    for (const id of ids) {
      if (!allowed.has(id)) throw fail('Mailbox does not belong to this storage owner', 'STORAGE_MAILBOX_FORBIDDEN', 403);
      await loadDocument(client, context, 'mailbox_calendars', id, emptyCalendar());
    }
    if (userId) await loadDocument(client, context, 'app_settings', `scenarios:${userId}`, {});
    // Trusted server configuration only; never pass request-controlled descriptors here.
    for (const descriptor of [...auxiliarySnapshotDocuments(ids), ...(options.documents || [])]) {
      const doc = typeof descriptor === 'string' ? { id: descriptor, initial: {} } : descriptor;
      const table = doc.table || 'app_settings';
      if (table === 'mailbox_calendars' && !allowed.has(doc.id)) throw fail('Mailbox does not belong to this storage owner', 'STORAGE_MAILBOX_FORBIDDEN', 403);
      await loadDocument(client, context, table, doc.id, doc.initial);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally { client.release(); stop(); }
  context.version = JSON.stringify([...context.documents].map(([key, doc]) => [key, doc.version]).sort());
  return context;
}

/** Capturable snapshot execution, staging only. Each invocation closes its detached continuations. */
export async function runStorageSnapshot(snapshot, fn) {
  if (storageContext()) throw fail('Nested storage snapshots are not supported', 'STORAGE_NESTED_SNAPSHOT', 400);
  if (!snapshot || snapshot.closed || snapshot.failed || snapshot.running) throw fail('Snapshot is unavailable or already running', 'STORAGE_SNAPSHOT_REQUIRED');
  snapshot.running = true;
  const context = { ...snapshot, documents: clone(snapshot.documents), dirty: new Set(snapshot.dirty) };
  return runWithRequestContext(snapshot.identity, () => storage.run(context, async () => {
    try {
      const result = await fn();
      snapshot.documents = context.documents;
      snapshot.dirty = context.dirty;
      snapshot.closed = context.closed;
      return result;
    } catch (error) {
      snapshot.failed = true;
      throw error;
    } finally {
      snapshot.failed ||= context.failed;
      context.closed = true;
      snapshot.running = false;
    }
  }));
}

export async function withStorageSnapshot(options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const snapshot = await createStorageSnapshot(options);
  try {
    return await runStorageSnapshot(snapshot, async () => {
      const context = current();
      const result = await fn();
      if (context.dirty.size) throw fail('Commit staged storage before returning a successful result', 'STORAGE_UNCOMMITTED');
      return result;
    });
  } finally { snapshot.closed = true; }
}

/** CAS writes and optional job fencing/checkpoint SQL share one short transaction. No network in beforeCommit. */
export async function commitStorage({ beforeCommit, afterWrite, client: suppliedClient, snapshot, expectedVersion } = {}) {
  if (snapshot) {
    if (expectedVersion !== undefined && expectedVersion !== snapshot.version) throw fail('Snapshot version does not match', 'STORAGE_VERSION_CONFLICT', 409);
    return runStorageSnapshot(snapshot, () => commitStorage({ beforeCommit, afterWrite, client: suppliedClient }));
  }
  const context = current();
  const dirty = [...context.dirty].sort();
  context.committing = true;
  let client;
  const versions = new Map();
  let outcome = 'committed';
  const stop = timer('storage.commit.ms', { docs: dirty.length });
  try {
    client = suppliedClient || await context.pool.connect();
    if (!suppliedClient) await client.query('BEGIN');
    // Fence job ownership before writing business data; callback may also insert checkpoint SQL.
    if (beforeCommit) await beforeCommit(client);
    // Lock every input in one order, choosing the final lock mode without upgrades.
    // Advisory locks also cover absent rows: row locks alone cannot protect a missing input.
    for (const key of [...context.documents.keys()].sort()) {
      const doc = context.documents.get(key);
      const writing = context.dirty.has(key);
      await client.query(`SELECT pg_advisory_xact_lock${writing ? '' : '_shared'}(hashtextextended($1, 0))`, [`daylight:storage:${key}`]);
      const { rows } = await client.query(`SELECT version FROM ${doc.table} WHERE ${doc.column} = $1 FOR ${writing ? 'UPDATE' : 'SHARE'}`, [doc.id]);
      const version = rows.length ? String(rows[0].version) : null;
      if (version !== doc.version) throw fail('Storage input changed concurrently; reload and revalidate', 'STORAGE_VERSION_CONFLICT', 409);
    }
    for (const key of dirty) {
      const doc = context.documents.get(key);
      let result;
      if (doc.version === null) {
        result = await client.query(`INSERT INTO ${doc.table} (${doc.column}, payload, updated_at, version)
          VALUES ($1, $2::jsonb, clock_timestamp(), 1) ON CONFLICT DO NOTHING RETURNING version`, [doc.id, JSON.stringify(doc.payload)]);
      } else {
        result = await client.query(`UPDATE ${doc.table} SET payload = $2::jsonb, updated_at = clock_timestamp(), version = version + 1
          WHERE ${doc.column} = $1 AND version = $3::bigint RETURNING version`, [doc.id, JSON.stringify(doc.payload), doc.version]);
      }
      if (!result.rows.length) throw fail('Storage changed concurrently; reload and revalidate', 'STORAGE_VERSION_CONFLICT', 409);
      versions.set(key, String(result.rows[0].version));
    }
    if (afterWrite) await afterWrite(client);
    if (!suppliedClient) {
      await client.query('COMMIT');
      for (const [key, version] of versions) context.documents.get(key).version = version;
      context.dirty.clear();
    } else {
      // Outer checkpoint owns the outcome: consume speculative state, never claim it committed.
      context.dirty.clear();
      context.closed = true;
    }
    return { committed: dirty.length };
  } catch (error) {
    context.failed = true;
    outcome = error?.code === 'STORAGE_VERSION_CONFLICT' ? 'conflict' : 'failed';
    if (outcome === 'conflict') counter('storage.conflict_total', { docs: dirty.length });
    if (client && !suppliedClient) try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally { context.committing = false; if (!suppliedClient) client?.release(); stop({ outcome }); }
}

/** Return only a result object here; HTTP response/SSE done must be sent after this promise resolves. */
export async function withStorageCommit(options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  options ||= {};
  return withStorageSnapshot(options, async () => {
    const result = await fn();
    await commitStorage({ beforeCommit: options.beforeCommit, afterWrite: options.afterWrite });
    return result;
  });
}
export const flushStorage = commitStorage;
export const withStorageTransaction = withStorageCommit;

export function storageStatus() {
  return { required: isProductionRuntime(), connected: Boolean(getPostgresPool()) && postgresMode() === 'postgres' };
}
