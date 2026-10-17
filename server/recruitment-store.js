import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mailboxDirectory } from './store.js';
import { usesStorageSnapshot, readSnapshotDocument, stageSnapshotDocument, settingsKey } from './storage/index.js';
import { isProductionRuntime, requireLocalRuntime } from './runtime-mode.js';
import { putAttachment, getAttachmentObject, ossMode } from './infra/oss.js';
import { getRequestUserId } from './request-context.js';

const empty = () => ({ candidates: [], attachments: [], messages: [], interviews: [], traces: [] });
const filename = (mailboxId) => path.join(mailboxDirectory(mailboxId), 'recruitment.json');
const sharedStorageModes = new Set(['aliyun', 'us3', 's3', 'qiniu', 'upyun']);
export const recruitmentId = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 28);

export function readRecruitment(mailboxId) {
  if (usesStorageSnapshot()) return { ...empty(), ...readSnapshotDocument(settingsKey(`recruitment:${mailboxId}`)) };
  const file = filename(mailboxId);
  return fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();
}

// Mutators are synchronous: each commit reads the latest file after any awaited tool/model call.
export function updateRecruitment(mailboxId, mutator) {
  const data = readRecruitment(mailboxId);
  mutator(data);
  if (usesStorageSnapshot()) {
    stageSnapshotDocument(settingsKey(`recruitment:${mailboxId}`), data);
    return data;
  }
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
  requireLocalRuntime('Local recruitment attachment path');
  if (!getAttachment(mailboxId, id)) return null;
  return path.join(mailboxDirectory(mailboxId), 'attachments', `${id}.pdf`);
}

export function storeAttachment(mailboxId, emailId, attachment, index = 0) {
  requireLocalRuntime('Local recruitment attachment storage');
  const id = attachment.id || recruitmentId('attachment', emailId, String(index));
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

// Authorization of mailbox ownership belongs to the API/job caller. Only keys
// registered in that mailbox's recruitment document may be read here.
export async function readAttachmentBytes(mailboxId, id) {
  const record = getAttachment(mailboxId, id);
  if (!record) return null;
  if (record.key) {
    if (isProductionRuntime() && (record.storage === 'local' || !sharedStorageModes.has(ossMode()))) {
      throw new Error('Production recruitment attachments require shared object storage');
    }
    const object = await getAttachmentObject(record.key);
    if (!object?.buffer) return null;
    return object.buffer;
  }
  requireLocalRuntime('Legacy local recruitment attachment read');
  const file = attachmentPath(mailboxId, id);
  return fs.readFileSync(file);
}

export async function storeAttachmentAsync(mailboxId, emailId, attachment, index = 0) {
  if (!isProductionRuntime() && ossMode() === 'local') return storeAttachment(mailboxId, emailId, attachment, index);
  if (!sharedStorageModes.has(ossMode())) throw new Error('Recruitment attachments require available shared object storage');
  const id = attachment.id || recruitmentId('attachment', emailId, String(index));
  const existing = getAttachment(mailboxId, id);
  if (existing?.key && existing.storage !== 'local') return existing;
  const content = Buffer.from(attachment.content);
  const filename = path.basename(String(attachment.filename || `简历-${index + 1}.pdf`).replace(/\\/g, '/'));
  const object = await putAttachment({ buffer: content, filename,
    contentType: attachment.contentType || 'application/pdf', mailboxId, userId: getRequestUserId() });
  if (!object?.key || object.storage === 'local') throw new Error('Recruitment attachment upload did not use shared object storage');
  const record = { ...(existing || { id, emailId, status: 'pending', pages: [], error: null,
    candidateId: null, createdAt: new Date().toISOString() }), filename,
    contentType: attachment.contentType || 'application/pdf', size: content.length,
    key: object.key, storage: object.storage };
  updateRecruitment(mailboxId, (data) => {
    const current = data.attachments.find((item) => item.id === id);
    if (current) Object.assign(current, record);
    else data.attachments.push(record);
  });
  return record;
}
