import { createStorageSnapshot, runStorageSnapshot, commitStorage } from './index.js';
import { readStore, readSettings } from '../store.js';
import { saveCalendarWithExternalSync } from '../external-calendar.js';

/** Adapter for server/mail-job.js; checkpoint repository owns the write transaction. */
export function createMailJobStorage(options = {}) {
  const assertScope = (job, snapshot) => {
    if (!job?.owner_id || !job.mailbox_id || !job.tenant_id
      || (snapshot && (snapshot.ownerId !== job.owner_id || snapshot.mailboxId !== job.mailbox_id || snapshot.tenantId !== job.tenant_id))) {
      throw Object.assign(new Error('Mail snapshot scope mismatch'), { code: 'STORAGE_SCOPE_MISMATCH', status: 403 });
    }
  };
  return {
    async load({ job, signal }) {
      signal?.throwIfAborted();
      assertScope(job);
      const context = await createStorageSnapshot({ ...options, userId: job.owner_id, mailboxId: job.mailbox_id });
      const result = { context, version: context.version, ownerId: job.owner_id, mailboxId: job.mailbox_id, tenantId: job.tenant_id };
      await runStorageSnapshot(context, () => {
        result.store = readStore(job.mailbox_id);
        result.peerTasks = readSettings().mailboxes.filter(box => box.id !== job.mailbox_id)
          .flatMap(box => readStore(box.id).tasks || []);
      });
      signal?.throwIfAborted();
      return result;
    },
    runSnapshot(snapshot, fn) {
      return runStorageSnapshot(snapshot.context, async () => {
        const result = await fn();
        saveCalendarWithExternalSync(snapshot.store, snapshot.mailboxId);
        return result;
      });
    },
    async commit({ client, job, snapshot, expectedVersion, signal }) {
      signal?.throwIfAborted();
      assertScope(job, snapshot);
      if (!client) throw new TypeError('Mail storage commit requires the checkpoint client');
      try {
        return await commitStorage({ client, snapshot: snapshot.context, expectedVersion,
          afterWrite: () => signal?.throwIfAborted() });
      } catch (error) {
        if (error.code === 'STORAGE_VERSION_CONFLICT') error.code = 'MAIL_SNAPSHOT_CONFLICT';
        throw error;
      }
    },
  };
}
