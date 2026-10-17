import { createHash, randomUUID } from 'node:crypto';
import { assistantMailbox, mutateAssistantState, readAssistantState } from './assistant-state.js';
import { readSettings, readStore } from './store.js';
import { sanitizeSnapshot } from './traces.js';
import { readInfraConfig } from './infra/config.js';
import { getPostgresPool } from './infra/postgres.js';
import { usesStorageSnapshot } from './storage/index.js';
import { meetingLinkParts } from '../shared/meeting-link.js';

const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function normalizeAssistantRecipients(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;，；]/) : [];
  if (!values.length || values.length > 30) fail('请填写 1 到 30 个明确的收件人邮箱地址。');
  const recipients = values.map((item) => {
    if (typeof item !== 'string') fail('收件人必须是明确的邮箱地址。');
    const email = item.trim();
    if (email.length > 254 || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(email)) {
      fail('请填写有效的裸邮箱地址，多个收件人用逗号分隔。');
    }
    return email.toLowerCase();
  });
  return [...new Set(recipients)];
}

function copyFields(input) {
  const to = normalizeAssistantRecipients(input.to);
  if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 300 || /[\r\n\0]/.test(input.subject)) fail('邮件主题须为 1 到 300 字的单行文字。');
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 60_000 || input.body.includes('\0')) fail('邮件正文须为 1 到 60000 字的文字。');
  return { to, subject: input.subject.trim(), body: input.body.trim() };
}

function displayDraft(value) {
  const { operationKey, fingerprint, ...draft } = value;
  if (draft.status === 'sending' && Date.now() - Date.parse(draft.attemptedAt) > 120_000) {
    draft.status = 'unknown';
    draft.error = '发送请求尚未取得可核验结果，请在发件邮箱核对；已停止重复发送。';
  }
  return { ...draft, canRetry: draft.status === 'failed' && draft.retryable === true };
}

function find(data, id) {
  const draft = data.items.find((item) => item.id === id);
  if (!draft) fail('邮件草稿不存在或不属于当前邮箱。', 404);
  return draft;
}

function checkRevision(draft, revision) {
  if (!Number.isSafeInteger(revision) || draft.revision !== revision) fail('草稿已更新，请重新打开并核对最新版本后确认。', 409);
}

function editable(draft) {
  if (!['pending', 'failed'].includes(draft.status) || (draft.status === 'failed' && draft.retryable !== true)) fail('此草稿已发送、已放弃或发送结果待核对，不能修改或重新发送。', 409);
}

export async function createAssistantDraft(mailboxId, input, settings = readSettings()) {
  const mailbox = assistantMailbox(mailboxId, settings);
  const from = String(mailbox.email || '').trim().toLowerCase();
  if (!from) fail('请先配置当前邮箱地址，才能生成可审核的发信草稿。');
  const fields = copyFields(input);
  const kind = input.kind === 'meeting_invitation' ? 'meeting_invitation' : 'email';
  if (kind === 'meeting_invitation' && (!input.eventId || !input.meeting?.url || !fields.body.includes(input.meeting.url))) fail('会议邀约须包含已创建的会议链接和关联日程。');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...fields, kind, eventId: input.eventId || null })).digest('hex');
  const operationKey = input.operationKey ? String(input.operationKey).slice(0, 512) : null;
  const draft = await mutateAssistantState(mailboxId, 'drafts', (data) => {
    const existing = operationKey && data.items.find((item) => item.operationKey === operationKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('相同操作编号的草稿内容不一致，请重新发起请求。', 409);
      return existing;
    }
    const value = { id: randomUUID(), mailboxId, from, kind, ...fields, status: 'pending', revision: 1,
      createdAt: now(), updatedAt: now(), sentAt: null, error: null, retryable: false, delivery: null,
      operationKey, fingerprint,
      ...(kind === 'meeting_invitation' ? { eventId: input.eventId, meeting: input.meeting } : {}) };
    data.items.push(value);
    return value;
  });
  return { ok: true, draft: displayDraft(draft) };
}

export async function listAssistantDrafts(mailboxId) {
  const data = await readAssistantState(mailboxId, 'drafts');
  return { drafts: data.items.map(displayDraft).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) };
}

export async function getAssistantDraft(mailboxId, id) {
  return { draft: displayDraft(find(await readAssistantState(mailboxId, 'drafts'), id)) };
}

export async function updateAssistantDraft(mailboxId, id, input) {
  const draft = await mutateAssistantState(mailboxId, 'drafts', (data) => {
    const value = find(data, id);
    checkRevision(value, input.revision);
    editable(value);
    Object.assign(value, copyFields({ ...value, ...input }), { status: 'pending', error: null, retryable: false,
      revision: value.revision + 1, updatedAt: now() });
    return value;
  });
  return { draft: displayDraft(draft) };
}

export async function discardAssistantDraft(mailboxId, id, input) {
  const draft = await mutateAssistantState(mailboxId, 'drafts', (data) => {
    const value = find(data, id);
    checkRevision(value, input.revision);
    editable(value);
    Object.assign(value, { status: 'discarded', revision: value.revision + 1, updatedAt: now() });
    return value;
  });
  return { draft: displayDraft(draft) };
}

function safeFailure(error, settings) {
  return sanitizeSnapshot(String(error?.message || '发送失败'), [settings.authorizationCode, settings.apiKey,
    settings.feishu?.appSecret, ...(settings.mailboxes || []).map((mailbox) => mailbox.authorizationCode)]);
}

function definitelyUnsent(error) {
  // Errors after DATA or an interrupted connection may already have delivered the mail.
  if (error.accepted?.length) return false;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EAUTH'].includes(error.code)) return true;
  if (['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM'].includes(error.command)) return true;
  return error.code === 'EENVELOPE' && !error.accepted?.length;
}

function meetingInvitationHtml(draft) {
  const escape = (value) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const body = meetingLinkParts(draft.body, draft.meeting?.url).map((part) => part.href
    ? `<a href="${escape(part.href)}" target="_blank" rel="noopener noreferrer">${escape(part.text)}</a>`
    : escape(part.text)).join('').replace(/\r\n|\r|\n/g, '<br>');
  return `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${body}</div>`;
}

export async function sendAssistantDraft(mailboxId, id, input, settings = readSettings(), dependencies = {}) {
  const mailbox = assistantMailbox(mailboxId, settings);
  if (input.confirmed !== true) fail('请先在审核卡核对收件人、主题和正文，再确认发送真实邮件。');
  const sendSettings = { ...settings, ...mailbox, activeMailboxId: mailboxId };
  const current = (await getAssistantDraft(mailboxId, id)).draft;
  let meetingEvent;
  if (current.kind === 'meeting_invitation' && current.status !== 'sent') {
    if (usesStorageSnapshot()) meetingEvent = readStore(mailboxId).events?.find(event => event.id === current.eventId);
    else if (readInfraConfig().postgres.enabled) {
      const pool = getPostgresPool();
      if (!pool) fail('数据库当前不可用，尚未发送邀约；请恢复连接后再核对日程。', 503);
      const { rows } = await pool.query('select payload from mailbox_calendars where mailbox_id=$1', [mailboxId]);
      meetingEvent = rows[0]?.payload?.events?.find((event) => event.id === current.eventId);
    } else meetingEvent = readStore(mailboxId).events?.find((event) => event.id === current.eventId);
  }
  const prepared = await mutateAssistantState(mailboxId, 'drafts', (data) => {
    const value = find(data, id);
    if (value.status === 'sent') return { draft: value, alreadySent: true };
    checkRevision(value, input.revision);
    editable(value);
    if (value.from !== String(mailbox.email || '').trim().toLowerCase()) fail('发件邮箱地址已变化，请重新生成草稿并审核。', 409);
    if (!mailbox.authorizationCode || !mailbox.smtpHost || !mailbox.smtpPort) fail('请先在设置中配置当前邮箱的 SMTP 服务和授权码。');
    copyFields(value);
    if (value.kind === 'meeting_invitation') {
      if (!value.body.includes(value.meeting.url)) fail('邀约正文缺少真实会议链接，请补充后重新审核。');
      if (Date.parse(value.meeting.expiresAt) <= Date.now()) fail('飞书会议链接已过期，请重新安排会议。');
      const event = meetingEvent;
      if (!event || event.status === 'cancelled') fail('关联会议日程已取消或删除，请核对后重新安排。', 409);
      if (Date.parse(event.end) <= Date.now()) fail('会议已经结束，请重新安排会议。');
      if (value.meeting.scheduledStart && (value.meeting.scheduledStart !== event.start || value.meeting.scheduledEnd !== event.end)) fail('日程时间已变化，请重新生成包含最新时间的会议邀约。', 409);
    }
    Object.assign(value, { status: 'sending', attemptedAt: now(), updatedAt: now(), error: null, retryable: false,
      revision: value.revision + 1, outgoingMessageId: value.outgoingMessageId || `<daylight-${value.id}@${value.from.split('@')[1]}>` });
    return { draft: structuredClone(value), alreadySent: false };
  });
  if (prepared.alreadySent) return { draft: displayDraft(prepared.draft) };
  let result;
  try {
    const send = dependencies.sendMail || (await import('./agent.js')).sendMailboxMessage;
    const info = await send(sendSettings, { to: prepared.draft.to, subject: prepared.draft.subject,
      text: prepared.draft.body, messageId: prepared.draft.outgoingMessageId,
      ...(prepared.draft.kind === 'meeting_invitation' ? { html: meetingInvitationHtml(prepared.draft) } : {}) });
    const accepted = (info.accepted || []).map((value) => String(typeof value === 'string' ? value : value.address).toLowerCase());
    const rejected = (info.rejected || []).map((value) => String(typeof value === 'string' ? value : value.address).toLowerCase());
    const complete = prepared.draft.to.every((recipient) => accepted.includes(recipient));
    result = { status: complete ? 'sent' : 'unknown', sentAt: complete ? now() : null, retryable: false,
      delivery: { messageId: info.messageId || prepared.draft.outgoingMessageId, accepted, rejected },
      error: complete ? null : (accepted.length ? '部分收件人已被 SMTP 服务接受，请核对下方接收与拒绝名单；为避免重复发信，不能整封重发。' : 'SMTP 未返回全部收件人的接收凭据，请在发件邮箱核对，不能重复发送。') };
  } catch (error) {
    const retryable = definitelyUnsent(error);
    result = { status: retryable ? 'failed' : 'unknown', retryable,
      error: `${safeFailure(error, sendSettings)}${retryable ? '；邮件尚未被服务接受，可核对后重试。' : '；投递结果待核对，请在发件邮箱确认，已停止重复发送。'}` };
  }
  try {
    const draft = await mutateAssistantState(mailboxId, 'drafts', (data) => {
      const value = find(data, id);
      Object.assign(value, result, { updatedAt: now(), revision: value.revision + 1 });
      return value;
    });
    return { draft: displayDraft(draft) };
  } catch {
    // The durable 'sending' marker prevents a second SMTP call even if saving its receipt fails.
    return { draft: displayDraft({ ...prepared.draft, ...result, status: 'unknown', retryable: false,
      error: 'SMTP 调用已结束，但回执保存失败；请在发件邮箱核对结果，已停止重复发送。' }) };
  }
}
