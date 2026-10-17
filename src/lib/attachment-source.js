/** Preserve the stored source; an attachment ID alone is the legacy resume format. */
export function sourceUrl(file = {}) {
  if (file.skipped) return '';
  if (file.proxyUrl) return file.proxyUrl;
  if (file.url) return file.url;
  if (file.key) return `/api/attachments/${encodeURIComponent(file.key)}`;
  if (!file.id) return '';
  const mailbox = file.mailboxId ? `?mailbox=${encodeURIComponent(file.mailboxId)}` : '';
  return `/api/recruitment/attachments/${encodeURIComponent(file.id)}${mailbox}`;
}
