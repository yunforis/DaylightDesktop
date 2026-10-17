import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mailboxDirectory } from './store.js';

const empty = () => ({ candidates: [], attachments: [], messages: [], interviews: [], traces: [] });
const filename = (mailboxId) => path.join(mailboxDirectory(mailboxId), 'recruitment.json');
export const recruitmentId = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 28);

export function readRecruitment(mailboxId) {
  const file = filename(mailboxId);
  return fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();
}

// Mutators are synchronous: each commit reads the latest file after any awaited tool/model call.
export function updateRecruitment(mailboxId, mutator) {
  const data = readRecruitment(mailboxId);
  mutator(data);
  const file = filename(mailboxId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return data;
}

export function getAttachment(mailboxId, id) {
  return readRecruitment(mailboxId).attachments.find((attachment) => attachment.id === id) || null;
}

export function attachmentPath(mailboxId, id) {
  if (!getAttachment(mailboxId, id)) return null;
  return path.join(mailboxDirectory(mailboxId), 'attachments', `${id}.pdf`);
}

export function storeAttachment(mailboxId, emailId, attachment, index = 0) {
  const id = recruitmentId('attachment', emailId, String(index));
  const existing = getAttachment(mailboxId, id);
  const directory = path.join(mailboxDirectory(mailboxId), 'attachments');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.pdf`);
  const content = Buffer.from(attachment.content);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  if (existing) return existing;
  const record = { id, emailId, filename: path.basename(String(attachment.filename || `简历-${index + 1}.pdf`).replace(/\\/g, '/')),
    contentType: attachment.contentType || 'application/pdf', size: content.length,
    status: 'pending', pages: [], error: null, candidateId: null, createdAt: new Date().toISOString() };
  updateRecruitment(mailboxId, (data) => data.attachments.push(record));
  return record;
}
