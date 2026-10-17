import { createHash } from 'node:crypto';

export function mailboxSnapshotDocuments(id) {
  return [
    { id: `external-sync:${id}`, initial: { intents: [], targets: {} } },
    { id: `traces:${id}`, initial: [] },
    { id: `recruitment:${id}`, initial: { candidates: [], attachments: [], messages: [], interviews: [], traces: [] } },
  ];
}

/** Reserve all durable mailbox namespaces before assigning an unregistered ID. */
export function mailboxRegistrationDocuments(id, ownerId) {
  const identities = new Set([ownerId || 'local', 'local']);
  return [...mailboxSnapshotDocuments(id),
    { id: `assistant-meetings:${id}`, initial: { schemaVersion: 1, operations: [] } },
    ...[...identities].flatMap(owner => {
      const identity = createHash('sha256').update(`${owner}\0${id}`).digest('hex');
      return ['drafts', 'requests', 'recruitment-effects'].map(namespace => ({
        id: `assistant:${namespace}:${identity}`, initial: { schemaVersion: 1, items: [] },
      }));
    }),
  ];
}

/** app_settings documents needed by synchronous auxiliary modules.
 * The storage loader must apply mailbox ownership checks before loading mailbox keys.
 * Missing rows use these defaults; importing local files is an explicit migration.
 */
export function auxiliarySnapshotDocuments(mailboxIds = []) {
  return [
    { id: 'prompts', initial: {} },
    { id: 'report-prompts', initial: {} },
    { id: 'mail-templates', initial: {} },
    { id: 'aux-prompt-revisions', initial: [] },
    ...mailboxIds.flatMap(mailboxSnapshotDocuments),
  ];
}
