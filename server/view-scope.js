import { mailboxTagLabel } from './store.js';

/**
 * 视图范围 → 邮箱 id 列表。
 *
 * 口径与 /api/state 的 scope=all / tag= 完全一致：邮件列表里能看到哪些邮箱的邮件，
 * 知识检索（邮件页问答、小 D 的 search_knowledge）就该覆盖同一批邮箱，
 * 否则会出现「列表里明明有这封信，检索却说没找到」。
 */
export function viewScopeMailboxIds(mailboxes = [], { scope = '', tag = '' } = {}) {
  const list = Array.isArray(mailboxes) ? mailboxes : [];
  if (tag) {
    return list
      .filter((mailbox) => mailbox.tag === tag || mailboxTagLabel(mailbox) === tag)
      .map((mailbox) => mailbox.id);
  }
  if (scope === 'all') return list.map((mailbox) => mailbox.id);
  return [];
}
