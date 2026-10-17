import { createHash } from 'node:crypto';
import { describeFailure } from './jobs/runtime.js';
import { readMailboxEmails, processEmails, extractEvents, EXTRACTION_VERSION } from './agent.js';

const counters = ['added', 'cancelled', 'rescheduled', 'tasksAdded', 'tasksMerged', 'invoices',
  'conflicts', 'skipped', 'filtered', 'duplicate', 'deferred'];
const stepName = id => `mail:${createHash('sha256').update(id).digest('hex')}`;
const done = record => record && record.recruitmentStatus !== 'partial';

/**
 * Retrieval is a side channel: a committed mail is copied into the mailbox knowledge base in
 * its own short transaction (rag_chunks has its own advisory lock, outside the business CAS).
 * Indexing must never decide whether a mail counts as processed, and in production the sync
 * runs here — not in the request handler — so without this hook the documented "processed
 * mail is searchable" behaviour would only hold in local development.
 */
async function defaultIndexEmail(email, { mailboxId, settings }) {
  const { ingestEmailKnowledge } = await import('./rag/mail-index.js');
  return ingestEmailKnowledge({ mailboxId, email, settings });
}

/**
 * Production adapter contract (no implicit file-store fallback):
 * load({job,settings,signal}) -> {version, store:{emails,events,tasks}, ...stagedState}
 * runSnapshot(snapshot, fn) -> fn's result, with ALL synchronous store/recruitment/
 * prompt reads and writes bound to this isolated snapshot. It must not commit.
 * commit({client,job,snapshot,expectedVersion,signal}) -> CAS all staged business
 * state using the supplied transaction; throw MAIL_SNAPSHOT_CONFLICT on conflict.
 * It must not open/commit its own transaction or perform external network calls.
 * Include recruitment/attachment metadata and optional external-calendar outbox in
 * this transaction. Blob uploads may precede it but must be idempotent by identity.
 *
 * The entrypoint supplies the mailbox owner's settings and this adapter. The worker
 * owns heartbeat, timeout, job completion and failure; this function only checkpoints
 * successfully processed mail. Failed/partial messages have no success checkpoint.
 */
export async function runMailJob({ job, repository, settings, storage, signal,
  readEmails = readMailboxEmails, extractor = extractEvents, process = processEmails,
  handleSpecialEmail, recorder, indexEmail = defaultIndexEmail, onProgress = () => {}, maxReplans = 2,
}) {
  if (!job?.id || !job.lease_token || !job.tenant_id || !job.owner_id || !job.mailbox_id
    || settings?.activeMailboxId !== job.mailbox_id) throw new TypeError('Mail job scope does not match settings');
  if (job.payload?.mode && job.payload.mode !== 'qq') throw new TypeError('Production mail jobs require real mailbox mode');
  if (!repository?.checkpoint || !storage?.load || !storage?.runSnapshot || !storage?.commit) {
    throw new TypeError('Mail jobs require a snapshot adapter and fenced checkpoint repository');
  }
  if (!Number.isInteger(maxReplans) || maxReplans < 0 || maxReplans > 10) throw new TypeError('Invalid maxReplans');
  const check = () => signal?.throwIfAborted();
  const load = async () => {
    check();
    const snapshot = await storage.load({ job, settings, signal });
    if (snapshot?.version === undefined || !Array.isArray(snapshot?.store?.emails)
      || !Array.isArray(snapshot?.store?.events)) throw new TypeError('Invalid mailbox snapshot');
    check();
    return snapshot;
  };
  const initial = await load();
  const emails = await readEmails(settings, { signal, onProgress, recorder,
    identityScope: JSON.stringify([job.tenant_id, job.owner_id, job.mailbox_id]),
    // Include partial IDs to preserve legacy identity; the reader returns a stub
    // which processEmails restores from the partial record for another attempt.
    processedIds: new Set(initial.store.emails.map(email => email.id)), retryMode: 'manual' });
  check();
  const result = { mode: 'qq', total: emails.length, errors: [], knowledgeChunks: 0,
    ...Object.fromEntries(counters.map(key => [key, 0])) };
  const special = handleSpecialEmail ?? (async (email, context) => {
    const { processRecruitmentEmail } = await import('./resumes.js');
    return processRecruitmentEmail(job.mailbox_id, email, settings, context);
  });
  for (const email of [...emails].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await load();
      if (done(snapshot.store.emails.find(record => record.id === email.id))) { result.duplicate++; break; }
      // processEmails catches extraction errors. Commit outside its callback so
      // lease loss, storage failure and CAS conflicts cannot be swallowed as mail errors.
      const outcome = await storage.runSnapshot(snapshot, () => process(snapshot.store, [email],
        (mail, events, context, tasks) => extractor(mail, settings, events, context, tasks,
          { peerTasks: snapshot.peerTasks || [] }), 'qq', {
          recorder, retryMode: 'manual', mailFilters: settings.mailFilters || [],
          peerTasks: snapshot.peerTasks || [], handleSpecialEmail: special,
          modelContext: JSON.stringify({ endpoint: settings.baseUrl, model: settings.model, version: EXTRACTION_VERSION }),
        }));
      check();
      const record = snapshot.store.emails.find(item => item.id === email.id);
      if (!done(record) || outcome.errors.length) {
        // Discard all speculative state, including partial recruitment mutations.
        // Retrying refetches/reuses the original mail and deterministic blob IDs.
        // Keep the redacted cause: an operator cannot act on a bare code, and the raw
        // model error is the only signal that distinguishes a bad key from a bad reply.
        result.errors.push({ emailId: email.id, code: 'MAIL_PROCESSING_FAILED',
          reason: describeFailure(new Error(outcome.errors[0]?.message || 'Mail record was not finalized'), 200) });
        break;
      }
      try {
        let wrote = false;
        await repository.checkpoint(job.id, job.lease_token, stepName(email.id),
          { emailId: email.id }, async (client, leasedJob) => {
            check();
            if (leasedJob.tenant_id !== job.tenant_id || leasedJob.owner_id !== job.owner_id
              || leasedJob.mailbox_id !== job.mailbox_id) throw new Error('Mail job lease scope changed');
            await storage.commit({ client, job: leasedJob, snapshot, expectedVersion: snapshot.version, signal });
            check();
            wrote = true;
          });
        if (wrote) {
          for (const key of counters) result[key] += outcome[key] || 0;
          // Only a committed mail is indexed, and never inside the business transaction.
          const indexed = await indexEmail(record, { mailboxId: job.mailbox_id, settings })
            .catch((error) => {
              // The derived index can be rebuilt from /api/rag/reindex, so a failure here
              // must not fail the mail. It is logged instead of dropped silently.
              console.warn(JSON.stringify({ event: 'knowledge_index_failed', mailboxId: job.mailbox_id,
                emailId: email.id, error: describeFailure(error, 200) }));
              return null;
            });
          if (indexed && !indexed.skipped) result.knowledgeChunks += indexed.chunkCount || 0;
          check();
        }
        else result.duplicate++;
        break;
      } catch (error) {
        if (error.code !== 'MAIL_SNAPSHOT_CONFLICT' || attempt >= maxReplans) throw error;
        // A manual edit/another writer invalidated model context: run the model
        // again on fresh state, rather than merging stale cancellation decisions.
      }
    }
    check();
  }
  if (result.errors.length) throw Object.assign(new Error(`Some mail could not be processed; retry required: ${result.errors.map(item => item.reason).join('; ')}`),
    { code: 'MAIL_PROCESSING_FAILED', retryable: true, result });
  return result;
}
