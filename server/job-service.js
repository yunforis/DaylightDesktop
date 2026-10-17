import { createHash, randomUUID } from 'node:crypto';
import { JobRepository, mailboxBackoffMs, failureStreak } from './jobs/repository.js';
import { getPostgresPool, findUserById } from './infra/postgres.js';
import { withStorageSnapshot, storageContext, commitStorage, readSnapshotDocument, settingsKey } from './storage/index.js';
import { readSettings, publicSettings } from './store.js';
import { readTraces, saveTraces, createTraceRecorder } from './traces.js';
import { runMailJob } from './mail-job.js';
import { createMailJobStorage } from './storage/mail-job.js';
import { readScenarioData } from './scenarios/repository.js';
import { findWorkbench, proposeItemPlan } from './scenarios/service.js';
import { queueExternalSync } from './external-calendar.js';

/** Stage only; storageHttpMiddleware commits the intent before delivering HTTP 202. */
export function queueCalendarExport(store, events, connections) {
  const result = queueExternalSync(store, events, 'update', { force: true });
  if (!result?.durable) throw Object.assign(new Error('Durable calendar intent was not staged'), { status: 503 });
  return { ...result, total: events.length, connections: connections.length,
    status: 'queued', message: '外部日历同步已持久排队，尚未完成远端推送。' };
}

let repository;
export function jobRepository() {
  const pool = getPostgresPool();
  if (!pool) throw Object.assign(new Error('任务数据库不可用'), { status: 503 });
  if (!repository || repository.pool !== pool) repository = new JobRepository(pool);
  return repository;
}
export function requestJobKey(value, prefix) {
  if (value && (typeof value !== 'string' || value.length > 200)) throw Object.assign(new Error('Idempotency-Key 无效'), { status: 400 });
  return `${prefix}:${createHash('sha256').update(value || randomUUID()).digest('hex')}`;
}
export function enqueueMail({ tenantId, ownerId, mailboxId, idempotencyKey, trigger = 'manual' }, jobs = jobRepository()) {
  if (!ownerId || tenantId !== ownerId) throw Object.assign(new Error('任务身份无效'), { status: 403 });
  const mailbox = readSettings().mailboxes.find(item => item.id === mailboxId && (item.ownerUserId || item.userId) === ownerId);
  if (!mailbox) throw Object.assign(new Error('邮箱不存在'), { status: 404 });
  return jobs.enqueue({ tenantId, ownerId, mailboxId, kind: 'mailbox.sync', idempotencyKey, payload: { trigger } });
}
export async function enqueuePlan({ ownerId, workbenchId, itemId, useModel, idempotencyKey }, jobs = jobRepository()) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  if (!data.items.some(item => item.id === itemId && item.workbenchId === workbenchId)) throw Object.assign(new Error('事项不存在'), { status: 404 });
  const mailboxId = workbench.mailboxIds?.[0];
  if (!readSettings().mailboxes.some(box => box.id === mailboxId && (box.ownerUserId || box.userId) === ownerId)) throw Object.assign(new Error('工作台邮箱不存在'), { status: 403 });
  return jobs.enqueue({ tenantId: ownerId, ownerId, mailboxId, kind: 'scenario.plan', idempotencyKey,
    payload: { workbenchId, itemId, useModel: Boolean(useModel) } });
}

function assertJobScope(job) {
  if (!job || ['id', 'lease_token', 'tenant_id', 'owner_id', 'mailbox_id'].some(key => typeof job[key] !== 'string' || !job[key].trim())
    || job.tenant_id !== job.owner_id) throw Object.assign(new Error('Invalid task scope'), { retryable: false });
}
function assertLeaseScope(current, job) {
  if (!current || ['tenant_id', 'owner_id', 'mailbox_id'].some(key => current[key] !== job[key])) {
    throw Object.assign(new Error('Task lease scope changed'), { retryable: false });
  }
}

export function createPlanHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot, propose = proposeItemPlan, commit = commitStorage } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    if (!job.payload || ['workbenchId', 'itemId'].some(key => typeof job.payload[key] !== 'string' || !job.payload[key].trim())) {
      throw Object.assign(new Error('Invalid plan task input'), { retryable: false });
    }
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    context.signal.throwIfAborted();
    return snapshot({ userId: user.id, user, mailboxId: job.mailbox_id }, async () => {
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
      const saved = (await context.steps()).find(step => step.name === 'plan.persist');
      if (saved) return saved.result;
      const data = await readScenarioData();
      const workbench = findWorkbench(data, job.payload.workbenchId);
      if (!workbench.mailboxIds?.includes(job.mailbox_id)) throw Object.assign(new Error('Task workbench scope changed'), { retryable: false });
      if (!data.items.some(item => item.id === job.payload.itemId && item.workbenchId === workbench.id)) throw Object.assign(new Error('Task item unavailable'), { retryable: false });
      if (job.payload.useModel && !publicSettings(readSettings()).modelReady) throw Object.assign(new Error('Task model settings unavailable'), { code: 'MODEL_NOT_CONFIGURED' });
      await propose(job.payload.workbenchId, job.payload.itemId, { useModel: Boolean(job.payload.useModel) });
      context.signal.throwIfAborted();
      const result = { workbenchId: job.payload.workbenchId, itemId: job.payload.itemId, completed: true };
      await commit({ beforeCommit: async client => {
        context.signal.throwIfAborted();
        const current = await jobs.lockLease(client, job.id, job.lease_token);
        assertLeaseScope(current, job);
        await client.query('INSERT INTO daylight_job_steps (job_id,name,result,generation) VALUES ($1,$2,$3::jsonb,$4)',
          [job.id, 'plan.persist', JSON.stringify(result), current.generation]);
      }, afterWrite: async client => {
        context.signal.throwIfAborted();
        assertLeaseScope(await jobs.lockLease(client, job.id, job.lease_token), job);
      } });
      return result;
    });
  };
}

export function createMailHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot,
  storageFactory = createMailJobStorage, run = runMailJob } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    const options = { userId: user.id, user, mailboxId: job.mailbox_id };
    const settings = await snapshot(options, () => readSettings());
    if (!settings.mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) {
      throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
    }
    const ready = publicSettings(settings);
    if (!ready.mailboxReady || !ready.modelReady) throw Object.assign(new Error('Task mail/model settings unavailable'), { code: 'MAIL_NOT_CONFIGURED' });
    context.signal.throwIfAborted();
    // Traces back the processing log, token/cost accounting and the reply drafts the user
    // reviews. Production syncs run in this worker, so the recorder must be bound to the
    // mailbox trace document here; without it real syncs silently lose every trace.
    const recorder = await snapshot(options, () => createTraceRecorder({ settings,
      traces: readTraces(job.mailbox_id),
      // The IMAP read phase runs before any snapshot is open: keep those traces in the
      // recorder's array and stage them on the first write that happens inside a snapshot.
      persist: (next) => { if (storageContext()) saveTraces(next, job.mailbox_id); } }));
    return run({ job, repository: jobs, settings, storage: storageFactory(options), signal: context.signal, recorder });
  };
}

/** Enumerate authoritative settings, never the process's active mailbox. */
export async function scheduleMailboxes(jobs, now = new Date(), { snapshot = withStorageSnapshot,
  baseBackoffMs = Number(process.env.DAYLIGHT_MAIL_BACKOFF_BASE_MS) || 300000,
  maxBackoffMs = Number(process.env.DAYLIGHT_MAIL_BACKOFF_MAX_MS) || 3600000 } = {}) {
  return snapshot({ system: true, mailboxIds: [] }, async () => {
    const raw = readSnapshotDocument(settingsKey('default'));
    const minute = Math.floor(now.getTime() / 60000);
    let scheduled = 0;
    let deferred = 0;
    for (const mailbox of raw.mailboxes || []) {
      const ownerId = mailbox.ownerUserId || mailbox.userId;
      if (!ownerId || mailbox.disabled || mailbox.autoSync === false) continue;
      if (mailbox.syncStrategy === 'idle' && minute % 5) continue;
      const prefs = raw.userPrefs?.[ownerId] || {};
      const settings = { ...raw, ...prefs, ...mailbox, mailboxes: [mailbox], activeMailboxId: mailbox.id };
      if (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady) continue;
      // A mailbox that keeps failing is backed off instead of dialled every minute. Manual
      // syncs bypass this (they go through enqueueMail), so a user fix takes effect at once.
      const history = await jobs.mailboxSyncOutcomes({ tenantId: ownerId, ownerId, mailboxId: mailbox.id, limit: 8 });
      const streak = failureStreak(history);
      if (streak) {
        const readyAt = new Date(history[0].finished_at).getTime() + mailboxBackoffMs(streak, { baseMs: baseBackoffMs, maxMs: maxBackoffMs });
        if (now.getTime() < readyAt) { deferred += 1; continue; }
      }
      // One in-flight sync per mailbox. A sync that outlives the minute cadence must not
      // queue a duplicate every minute; the next free minute schedules the following run.
      if (await jobs.hasPendingSync({ tenantId: ownerId, ownerId, mailboxId: mailbox.id })) { deferred += 1; continue; }
      await jobs.enqueue({ tenantId: ownerId, ownerId, mailboxId: mailbox.id, kind: 'mailbox.sync',
        idempotencyKey: `scheduled:${minute}`, payload: { trigger: 'scheduled' } });
      scheduled += 1;
    }
    return { scheduled, deferred };
  });
}
