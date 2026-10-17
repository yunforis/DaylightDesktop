import { randomUUID } from 'node:crypto';
import { findUserById } from './infra/postgres.js';
import { withStorageSnapshot, commitStorage, readSnapshotDocument, stageSnapshotDocument, mutateSnapshot } from './storage/index.js';
import { readCalendarSync, readSettings, readStore, saveStore } from './store.js';
import { externalSyncKey, pushExternalCalendarTarget, verifyExternalCalendarIdentity } from './external-calendar.js';
import { getRequestUserId } from './request-context.js';

const failure = (message, code, retryable = false) => Object.assign(new Error(message), { code, retryable });
const targetKey = (eventId, connectionId) => JSON.stringify([eventId, connectionId]);

/** For an authenticated, explicitly confirmed API call inside a storage snapshot.
 * Caller commits before returning. Verification is GET only, outside a transaction;
 * CAS protects against concurrent worker/reconciliation changes. No jobs are sent,
 * reset or enqueued. An absent result closes this attempt; new work needs a separate
 * business action. Interrupted sending must first be normalized by the fenced worker.
 */
export async function reconcileUnknownCalendarResult(mailboxId, intentId, input = {},
  { verify = verifyExternalCalendarIdentity, signal } = {}) {
  if (input.confirmed !== true || !['found', 'absent'].includes(input.outcome)
    || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000) {
    throw Object.assign(failure('Explicit manual confirmation and verification note required', 'CALENDAR_CONFIRMATION_REQUIRED'), { status: 400 });
  }
  const ownerId = getRequestUserId();
  if (!ownerId || !readSettings().mailboxes.some(box => box.id === mailboxId && (box.ownerUserId || box.userId) === ownerId)) {
    throw Object.assign(failure('Calendar mailbox unavailable', 'CALENDAR_SCOPE_INVALID'), { status: 403 });
  }
  const key = externalSyncKey(mailboxId);
  const initial = readSnapshotDocument(key);
  const intent = initial.intents.find(item => item.id === intentId && item.ownerId === ownerId && item.mailboxId === mailboxId);
  const connectionId = input.connectionId;
  const receipt = intent?.receipts?.[connectionId];
  if (!intent?.connectionIds.includes(connectionId) || receipt?.status !== 'unknown') {
    throw Object.assign(failure('Only unknown calendar results can be reconciled', 'CALENDAR_NOT_UNKNOWN'), { status: 409 });
  }
  const targetId = targetKey(intent.event.id, connectionId);
  if (initial.targets?.[targetId]?.status !== 'unknown') {
    throw Object.assign(failure('Calendar target changed; reload before verification', 'CALENDAR_NOT_UNKNOWN'), { status: 409 });
  }
  let remoteId = null;
  if (input.outcome === 'found') {
    const connection = readCalendarSync().connections?.find(item => item.id === connectionId);
    if (!connection) throw failure('Calendar connection unavailable', 'CALENDAR_CONNECTION_UNAVAILABLE');
    remoteId = await verify(connection, input.remoteId, { signal });
    if (!remoteId || remoteId !== input.remoteId) throw failure('Remote identity mismatch', 'CALENDAR_VERIFICATION_FAILED');
  } else if (input.remoteId) {
    throw Object.assign(failure('Absent result cannot bind a remote identity', 'CALENDAR_REMOTE_ID_INVALID'), { status: 400 });
  }
  signal?.throwIfAborted();
  return mutateSnapshot(() => {
    const document = readSnapshotDocument(key);
    if (JSON.stringify(document) !== JSON.stringify(initial)) throw failure('Calendar result changed during verification', 'STORAGE_VERSION_CONFLICT');
    const current = document.intents.find(item => item.id === intentId);
    const audit = { outcome: input.outcome, note: input.note.trim(), actorId: ownerId, at: new Date().toISOString(), remoteId };
    current.receipts[connectionId] = { ...receipt, status: 'skipped', reconciliation: audit };
    current.status = current.connectionIds.every(id => ['succeeded', 'skipped'].includes(current.receipts[id]?.status)) ? 'reconciled' : 'unknown';
    // A manually verified absence must not release already queued work into a
    // fresh automatic create. Keep a target barrier for a separate reviewed action.
    document.targets[targetId] = { status: input.outcome === 'absent' ? 'manual_absent' : 'verified', remoteId, reconciliation: audit };
    const store = readStore(mailboxId);
    const event = store.events.find(item => item.id === current.event.id);
    if (event) {
      event.externalIds = { ...event.externalIds };
      if (remoteId) event.externalIds[connectionId] = remoteId;
      else delete event.externalIds[connectionId];
      saveStore(store, mailboxId);
    }
    stageSnapshotDocument(key, document);
    return { intentId, connectionId, status: current.status, reconciliation: audit };
  });
}

/** Poll the durable intent documents. Job, notification and scheduled marker share
 * one short transaction. Safe to run on every scheduler replica. The original
 * business transaction has already committed the intent alongside its calendar.
 * No network effects or repository.enqueue (which opens a transaction) here.
 */
export async function scheduleExternalCalendars(jobs, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid calendar schedule limit');
  return jobs.transaction(async client => {
    const { rows } = await client.query(`SELECT id,payload FROM app_settings
      WHERE id LIKE 'external-sync:%' AND EXISTS
        (SELECT 1 FROM jsonb_array_elements(payload->'intents') intent WHERE intent->>'status'='pending')
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
    let count = 0;
    for (const row of rows) {
      for (const intent of row.payload.intents || []) {
        if (intent.status !== 'pending') continue;
        if (!intent.id || !intent.ownerId || row.id !== `external-sync:${intent.mailboxId}`) {
          throw failure('Invalid external calendar intent scope', 'CALENDAR_SCOPE_INVALID');
        }
        await client.query('INSERT INTO daylight_job_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING', [intent.ownerId, intent.mailboxId]);
        await client.query('SELECT 1 FROM daylight_job_mailboxes WHERE tenant_id=$1 AND mailbox_id=$2 FOR UPDATE', [intent.ownerId, intent.mailboxId]);
        const { rows: inserted } = await client.query(`INSERT INTO daylight_jobs
          (id,tenant_id,owner_id,mailbox_id,kind,idempotency_key,payload,max_attempts)
          VALUES ($1,$2,$2,$3,'calendar.sync',$4,$5::jsonb,5) ON CONFLICT DO NOTHING RETURNING *`,
        [randomUUID(), intent.ownerId, intent.mailboxId, `calendar:${intent.id}`, JSON.stringify({ intentId: intent.id })]);
        if (inserted[0]) await jobs.notify(client, inserted[0]);
        intent.status = 'scheduled';
        count++;
      }
      await client.query('UPDATE app_settings SET payload=$2::jsonb,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [row.id, JSON.stringify(row.payload)]);
    }
    return count;
  });
}

/** Registered as handlers['calendar.sync'] by the service entrypoint.
 * Each prepare/result transaction fences the current lease. Provider calls run
 * after prepare commits and before the receipt transaction starts. Remote IDs
 * also survive deletion of the local event in the mailbox intent document.
 */
export function createCalendarHandler(jobs, { findUser = findUserById,
  snapshot = withStorageSnapshot, commit = commitStorage, push = pushExternalCalendarTarget } = {}) {
  return async (job, context) => {
    if (!job?.id || !job.lease_token || !job.owner_id || job.tenant_id !== job.owner_id
      || !job.mailbox_id || !job.payload?.intentId) throw failure('Invalid calendar job scope', 'CALENDAR_SCOPE_INVALID');
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw failure('Calendar owner unavailable', 'CALENDAR_OWNER_UNAVAILABLE');
    const options = { userId: user.id, user, mailboxId: job.mailbox_id };
    const check = () => context.signal?.throwIfAborted();
    const key = externalSyncKey(job.mailbox_id);
    const fence = async client => {
      check();
      const current = await jobs.lockLease(client, job.id, job.lease_token);
      if (['tenant_id', 'owner_id', 'mailbox_id'].some(field => current[field] !== job[field])) {
        throw failure('Calendar lease scope changed', 'CALENDAR_SCOPE_INVALID');
      }
    };
    const persist = () => commit({ beforeCommit: fence, afterWrite: fence });
    const read = () => {
      check();
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === job.owner_id)) {
        throw failure('Calendar mailbox unavailable', 'CALENDAR_SCOPE_INVALID');
      }
      const document = readSnapshotDocument(key);
      const intent = document.intents.find(item => item.id === job.payload.intentId);
      if (!intent || intent.ownerId !== job.owner_id || intent.mailboxId !== job.mailbox_id) {
        throw failure('Calendar intent unavailable', 'CALENDAR_SCOPE_INVALID');
      }
      intent.receipts ||= {};
      document.targets ||= {};
      return { document, intent };
    };
    const connectionIds = await snapshot(options, () => read().intent.connectionIds);
    for (const connectionId of connectionIds) {
      const prepared = await snapshot(options, async () => {
        const { document, intent } = read();
        const receipt = intent.receipts[connectionId];
        if (receipt?.status === 'succeeded' || receipt?.status === 'skipped') return { skip: true };
        const target = document.targets[targetKey(intent.event.id, connectionId)] || {};
        const connection = readCalendarSync().connections?.find(item => item.id === connectionId && item.enabled !== false);
        const deleting = intent.action === 'delete' || intent.event.status === 'cancelled';
        const remoteId = Object.hasOwn(target, 'remoteId') ? target.remoteId : intent.event.externalIds?.[connectionId];
        const creating = !deleting && !remoteId;
        if (receipt?.status === 'unknown' || ['unknown', 'manual_absent'].includes(target.status) || (target.status === 'sending' && target.creating)
          || (receipt?.status === 'sending' && receipt.creating)) {
          intent.receipts[connectionId] = { ...receipt, status: 'unknown' };
          document.targets[targetKey(intent.event.id, connectionId)] = { ...target, status: 'unknown' };
          intent.status = 'unknown';
          stageSnapshotDocument(key, document);
          await persist();
          throw failure('Calendar create result requires remote verification', 'CALENDAR_RESULT_UNKNOWN');
        }
        if (!connection || (deleting && !remoteId && !['caldav', 'icloud'].includes(connection.provider))) {
          intent.receipts[connectionId] = { status: 'skipped' };
          stageSnapshotDocument(key, document);
          await persist();
          return { skip: true };
        }
        intent.receipts[connectionId] = { status: 'sending', creating, at: new Date().toISOString() };
        document.targets[targetKey(intent.event.id, connectionId)] = { status: 'sending', creating, remoteId: remoteId || null };
        stageSnapshotDocument(key, document);
        await persist();
        const externalIds = { ...intent.event.externalIds };
        if (remoteId) externalIds[connectionId] = remoteId;
        else delete externalIds[connectionId];
        return { connection, event: { ...intent.event, externalIds }, action: intent.action, creating };
      });
      if (prepared.skip) continue;
      check();
      // A fresh snapshot captures token refresh writes, but holds no PG client
      // during provider I/O. A receipt CAS failure leaves durable 'sending'.
      await snapshot(options, async () => {
        const { document, intent } = read();
        let remoteId, error;
        const connection = readCalendarSync().connections?.find(item => item.id === connectionId && item.enabled !== false);
        if (!connection) throw failure('Calendar connection removed before execution', 'CALENDAR_CONNECTION_UNAVAILABLE');
        try { remoteId = await push(connection, prepared.event, prepared.action, { signal: context.signal }); }
        catch (caught) { error = caught; }
        check();
        const status = error ? (prepared.creating ? 'unknown' : 'retry') : 'succeeded';
        intent.receipts[connectionId] = { status, creating: prepared.creating, remoteId: remoteId || null, at: new Date().toISOString(),
          ...(error ? { code: prepared.creating ? 'CALENDAR_RESULT_UNKNOWN' : 'CALENDAR_REMOTE_FAILED' } : {}) };
        document.targets[targetKey(intent.event.id, connectionId)] = { status, remoteId: error ? prepared.event.externalIds?.[connectionId] : (remoteId || null) };
        if (status === 'unknown') intent.status = 'unknown';
        stageSnapshotDocument(key, document);
        const store = readStore(job.mailbox_id);
        const event = store.events.find(item => item.id === intent.event.id);
        if (event) {
          event.externalIds = { ...event.externalIds };
          if (!error) {
            if (remoteId) event.externalIds[connectionId] = remoteId;
            else delete event.externalIds[connectionId];
          }
          event.externalSync = { at: new Date().toISOString(), status, connectionId };
          saveStore(store, job.mailbox_id);
        }
        await persist();
        if (error) throw failure('External calendar operation failed', prepared.creating ? 'CALENDAR_RESULT_UNKNOWN' : 'CALENDAR_REMOTE_FAILED', !prepared.creating);
      });
    }
    return snapshot(options, async () => {
      const { document, intent } = read();
      intent.status = 'succeeded';
      stageSnapshotDocument(key, document);
      await persist();
      return { intentId: intent.id, status: intent.status };
    });
  };
}
