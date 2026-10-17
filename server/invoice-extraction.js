import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { enrichEmailWithAttachmentText, isSupportedTextAttachment } from './attachment-text.js';
import { extractEvents, invoiceExtractionFields } from './agent.js';
import { getAttachmentObject, putAttachment, resolveLocalAttachment } from './infra/oss.js';
import { getAttachment, attachmentPath } from './recruitment-store.js';

async function readSavedAttachment(file, { mailboxId, emailId }) {
  if (file.key) {
    const local = resolveLocalAttachment(file.key);
    return local ? { buffer: fs.readFileSync(local) } : await getAttachmentObject(file.key);
  }
  // Older PDF mail records used the recruitment file store. Restore their preview link on explicit retry.
  const legacy = getAttachment(mailboxId, file.id);
  const legacyPath = legacy?.emailId === emailId && attachmentPath(mailboxId, file.id);
  if (!legacyPath || !fs.existsSync(legacyPath)) return null;
  const buffer = fs.readFileSync(legacyPath);
  const stored = await putAttachment({ buffer, filename: file.filename, contentType: file.contentType || 'application/pdf', mailboxId });
  return { buffer, metadata: stored };
}

/** Re-extract a saved invoice mail without touching any calendar events or tasks. */
export async function reextractInvoiceEmail(email, settings, {
  mailboxId = settings.activeMailboxId, context,
  readAttachment = readSavedAttachment, extract = extractEvents, enrich = enrichEmailWithAttachmentText,
} = {}) {
  const record = { ...email, attachments: (email.attachments || []).map((file, index) => ({
    ...file,
    id: file.id || `attachment-${createHash('sha256').update(`${email.id}\0${index}`).digest('hex').slice(0, 24)}`,
  })), attachmentTexts: [], attachmentTextErrors: [] };
  const raw = [];
  const readErrors = [];
  try {
    for (const file of record.attachments) {
      if (!isSupportedTextAttachment(file)) continue;
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('附件超过 25MB，未读取');
        const saved = await readAttachment(file, { mailboxId, emailId: email.id });
        if (!saved?.buffer?.length) throw new Error('附件文件不可用，请检查原附件是否仍保存在本地或对象存储');
        if (saved.metadata) Object.assign(file, saved.metadata);
        raw.push({ ...file, content: saved.buffer });
      } catch (error) {
        file.textStatus = 'failed';
        file.textError = context?.sanitize(error.message) || error.message;
        readErrors.push(`${file.filename || '附件'}：${file.textError}`);
      }
    }
    Object.defineProperty(record, '_textAttachments', { value: raw });
    await enrich(record, { context, skipRecruitment: false });
    record.attachmentTextErrors = [...readErrors, ...(record.attachmentTextErrors || [])];
    const extraction = record.attachmentTexts.length
      ? await extract(record, settings, [], context, [])
      : { summary: '', invoices: [] };
    const fields = invoiceExtractionFields(record, extraction.invoices);
    // A failed file must not erase an earlier successful extraction from that same file.
    if (fields.invoiceErrors.length) {
      const previousInvoices = email.extraction?.invoices || [];
      const replacedIds = new Set();
      fields.invoices = fields.invoices.map((invoice) => {
        const previous = previousInvoices.find((item) => item.id === invoice.id || (item.attachmentId === invoice.attachmentId
          && invoice.invoiceNumber && item.invoiceNumber === invoice.invoiceNumber && item.invoiceCode === invoice.invoiceCode));
        if (!previous) return invoice;
        replacedIds.add(previous.id);
        return Object.fromEntries(Object.entries(invoice).map(([key, value]) => [key, value === null ? previous[key] ?? null : value]));
      });
      fields.invoices.push(...previousInvoices.filter((invoice) => !replacedIds.has(invoice.id)));
      if (fields.invoices.length) fields.invoiceStatus = 'partial';
      if (previousInvoices.length) fields.invoiceErrors.push('本次部分识别失败，已保留此前提取的信息，请对照原件核对。');
    }
    Object.assign(record, { category: 'invoice', intent: 'invoice', invoiceStatus: fields.invoiceStatus,
      invoiceErrors: fields.invoiceErrors, invoiceAttemptedAt: new Date().toISOString(),
      summary: fields.invoices.length ? `已提取 ${fields.invoices.length} 张发票${fields.invoiceErrors.length ? '，部分附件或字段需核对' : '，可在发票助手复制'}`
        : fields.invoiceErrors.length ? '发票附件提取未完成，可重试' : '附件中未提取到发票信息',
      extraction: { ...(email.extraction || {}), category: 'invoice', intent: 'invoice',
        summary: extraction.summary || email.extraction?.summary || '', invoices: fields.invoices },
    });
    return { email: record };
  } catch (error) {
    const message = context?.sanitize(error.message) || error.message;
    Object.assign(record, { invoiceStatus: email.extraction?.invoices?.length ? 'partial' : 'failed',
      invoiceErrors: [...new Set([...readErrors, ...record.attachmentTextErrors, message])], invoiceAttemptedAt: new Date().toISOString() });
    return { email: record, error: message };
  }
}
