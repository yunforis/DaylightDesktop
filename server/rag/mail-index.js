import { chunkPages } from './chunk.js';
import { ingestAttachmentChunks } from './ingest.js';
import { mailAttachmentKey, mailBodyKey } from './mail-ref.js';

function plainText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
}

function emailPlain(email) {
  const body = plainText(email?.body);
  const html = plainText(email?.html);
  const text = body.length >= html.length ? body : html;
  return text.slice(0, 20_000);
}

/**
 * 把一封已处理邮件的主题、正文和附件摘录写入当前邮箱的知识库。
 * 招聘 PDF 仍走原有按页入库；这里覆盖普通邮件，失败不抛给同步主流程。
 */
export async function ingestEmailKnowledge({ mailboxId, email, settings = {}, context } = {}) {
  if (!mailboxId || !email?.id) return { skipped: true, reason: 'missing_email', chunkCount: 0 };
  const subject = String(email.subject || '').trim();
  const body = emailPlain(email);
  const header = [
    subject ? `主题：${subject}` : '',
    email.sender ? `发件人：${email.sender}` : '',
    email.summary ? `摘要：${email.summary}` : '',
  ].filter(Boolean).join('\n');
  const bodyText = [header, body].filter(Boolean).join('\n\n').trim();
  const bodyAttachment = {
    id: mailBodyKey(email.id),
    filename: subject || '邮件正文',
    pages: bodyText ? [{ page: 1, text: bodyText }] : [],
  };
  const bodyResult = await ingestAttachmentChunks({
    mailboxId,
    attachment: bodyAttachment,
    settings,
    context,
  });

  let attachmentCount = bodyResult.chunkCount || 0;
  const texts = Array.isArray(email.attachmentTexts) ? email.attachmentTexts : [];
  for (const [index, file] of texts.entries()) {
    const text = plainText(file?.text).slice(0, 12_000);
    if (!text) continue;
    const result = await ingestAttachmentChunks({
      mailboxId,
      attachment: {
        id: mailAttachmentKey(email.id, file.attachmentId || file.filename || index),
        filename: file.filename || '附件',
        pages: [{ page: 1, text: `附件：${file.filename || '未命名'}\n所属邮件：${subject}\n\n${text}` }],
      },
      settings,
      context,
    });
    attachmentCount += result.chunkCount || 0;
  }
  return {
    skipped: Boolean(bodyResult.skipped),
    reason: bodyResult.reason,
    chunkCount: attachmentCount,
    emailId: email.id,
  };
}

export async function reindexMailboxEmails({ mailboxId, emails = [], settings = {}, context } = {}) {
  let processed = 0;
  let chunkCount = 0;
  for (const email of emails) {
    if (!email?.id) continue;
    const result = await ingestEmailKnowledge({ mailboxId, email, settings, context });
    if (!result.skipped) {
      processed += 1;
      chunkCount += result.chunkCount || 0;
    }
  }
  return { processed, chunkCount };
}

export function chunkEmailPreview(email) {
  return chunkPages([{ page: 1, text: emailPlain(email) }]).length;
}
