/** 邮件正文与普通附件在 rag_chunks.attachment_id 上的编码，避免改表。 */

export function mailBodyKey(emailId) {
  return `mailbody:${encodeURIComponent(String(emailId || ''))}`;
}

export function mailAttachmentKey(emailId, attachmentId) {
  return `mailatt:${encodeURIComponent(String(emailId || ''))}:${encodeURIComponent(String(attachmentId || 'file'))}`;
}

export function parseMailRef(attachmentId) {
  const id = String(attachmentId || '');
  if (id.startsWith('mailbody:')) {
    return { source: 'email', emailId: safeDecode(id.slice(9)), kind: 'email' };
  }
  if (id.startsWith('mailatt:')) {
    const rest = id.slice(8);
    const split = rest.indexOf(':');
    if (split < 0) return { source: 'attachment', emailId: safeDecode(rest), kind: 'attachment' };
    return {
      source: 'attachment',
      emailId: safeDecode(rest.slice(0, split)),
      fileId: safeDecode(rest.slice(split + 1)),
      kind: 'attachment',
    };
  }
  return { source: 'resume', emailId: null, kind: 'resume' };
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
