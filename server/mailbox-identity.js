import { createHash } from 'node:crypto';

/** A temporary empty profile is separate from historical short-ID mailboxes. */
export function pendingMailboxId(userId) {
  if (!userId) throw new TypeError('A pending mailbox requires an authenticated owner');
  return `mb-pending-${createHash('sha256').update(String(userId)).digest('hex')}`;
}

export function isRegisteredMailbox(mailboxId, settings, userId) {
  return (settings?.mailboxes || []).some(box => box.id === mailboxId && box.pendingSetup !== true
    && (!userId || (box.ownerUserId || box.userId) === userId));
}
