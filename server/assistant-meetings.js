import { createHash } from 'node:crypto';
import { prepareMeeting } from './feishu.js';
import { findConflicts, suggestTimeSlots } from './conflicts.js';
import { withAssistantMeetingMailboxLock } from './assistant-meetings-store.js';
import { isProductionRuntime } from './runtime-mode.js';
import { isRegisteredMailbox } from './mailbox-identity.js';
import { getRequestUserId } from './request-context.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const beijingIso = (time) => new Date(time + 8 * 3600_000).toISOString().replace(/(?:\.000)?Z$/, '+08:00');
const displayedTime = (value) => beijingIso(Date.parse(value)).slice(0, 16).replace('T', ' ');
const text = (value) => typeof value === 'string' ? value.trim() : '';

export const ASSISTANT_MEETING_NOTICE = '日程时间按北京时间保存。飞书链接的有效期不限制入会开始时间，请按约定的日程时间参会；邀约邮件需你审核确认后才发送。';

function meetingTime(value, label) {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/i);
  if (!match) throw new Error(`请提供明确的会议${label}日期和时间，例如 2026-10-20T14:00:00+08:00。`);
  const [, year, month, day, hour, minute, second = '00', fraction = '', zone = '+08:00'] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const offsetHour = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (Number(year) < 2000 || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error(`会议${label}日期或时间无效，请重新填写。`);
  }
  const zoned = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}${zone.toUpperCase()}`;
  const time = Date.parse(zoned);
  if (!Number.isFinite(time)) throw new Error(`会议${label}时间无效，请重新填写。`);
  return beijingIso(time);
}

async function normalizeInput(args, normalizeRecipients) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('请提供会议主题、起止时间和受邀邮箱。');
  const title = text(args.title);
  const description = args.description == null ? '' : text(args.description);
  if (!title || title.length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(title)) throw new Error('请填写 1–200 字、没有换行的会议主题。');
  if (args.description != null && typeof args.description !== 'string') throw new Error('会议说明必须是文本。');
  if (description.length > 20_000 || /\u0000/.test(description)) throw new Error('会议说明过长或包含无效字符，请调整。');
  const start = meetingTime(args.start, '开始');
  const end = meetingTime(args.end, '结束');
  if (Date.parse(end) <= Date.parse(start)) throw new Error('会议结束时间必须晚于开始时间。');
  const attendees = await normalizeRecipients(args.attendees);
  if (!attendees.length) throw new Error('请至少填写一个受邀邮箱。');
  const input = { title, start, end, attendees: [...attendees].sort(), description };
  const fingerprint = hash(JSON.stringify(input));
  if (args.operationKey != null && (typeof args.operationKey !== 'string' || !args.operationKey.trim() ||
      args.operationKey.length > 512 || /[\u0000-\u001f\u007f]/.test(args.operationKey))) {
    throw new Error('会议操作编号无效，请重新发起安排。');
  }
  return { ...input, fingerprint, operationKey: text(args.operationKey) || `meeting:${fingerprint}` };
}

function validateNewMeeting(input, settings) {
  const config = settings.feishu || {};
  if (!config.appId || !config.appSecret || !config.ownerId) throw new Error('请先在设置中填写飞书 App ID、App Secret 和会议归属人的 Open ID，再创建飞书会议。');
  if (Date.parse(input.start) <= Date.now()) throw new Error('会议开始时间已经过去，请重新选择未来的时间。');
  const limit = Date.now() + 30 * 86400_000;
  if (Date.parse(input.end) > limit - 60_000) throw new Error('飞书会议链接仅支持未来 30 天内的安排，请缩短预约范围后重试。');
}

function conflictDetails(events) {
  return events.map(({ id, title, start, end }) => ({ id, title, start, end }));
}

function invitation(input, meeting) {
  const lines = [
    '您好：', '', `诚邀您参加「${input.title}」会议。`, '',
    `会议时间：${displayedTime(input.start)} 至 ${displayedTime(input.end)}（北京时间，UTC+08:00）`,
    `受邀邮箱：${input.attendees.join('、')}`,
    `飞书会议链接：${meeting.url}`,
  ];
  if (meeting.meetingNo) lines.push(`会议号：${meeting.meetingNo}`);
  if (meeting.password) lines.push(`会议密码：${meeting.password}`);
  if (meeting.expiresAt && Number.isFinite(Date.parse(meeting.expiresAt))) {
    lines.push(`链接可用至：${displayedTime(meeting.expiresAt)}（北京时间）。链接有效期不限制入会开始时间，请按上述约定时间参会。`);
  } else lines.push('请按上述约定时间参会，会议链接不限制入会开始时间。');
  if (input.description) lines.push('', '会议说明：', input.description);
  lines.push('', '期待您的参加，谢谢。');
  return { subject: `会议邀约：${input.title}`, body: lines.join('\n') };
}

function safeFailure(failure, settings) {
  let message = String(failure?.message || '操作失败');
  for (const secret of [settings.feishu?.appSecret, settings.authorizationCode, settings.apiKey,
    ...(settings.mailboxes || []).map((mailbox) => mailbox.authorizationCode)]) {
    if (secret) message = message.split(secret).join('[已隐藏]');
  }
  return message.slice(0, 2000);
}

function recoveryResult(operation, message, code = 'MEETING_RECOVERY_REQUIRED') {
  return { ok: false, status: 'needs_attention', code, error: message, operationKey: operation.operationKey,
    ...(operation.meeting ? { meeting: operation.meeting } : {}),
    ...(operation.event ? { event: operation.event } : {}), ...(operation.draft ? { draft: operation.draft } : {}),
    notice: code === 'MEETING_CHECKPOINT_FAILED'
      ? '飞书已返回会议链接，但存储检查点未确认成功。请保留本次链接并到飞书核对；相同操作不会再次建会。'
      : operation.meeting
      ? '已取得飞书会议链接。本次没有再次建会；请核对日程和草稿，修复存储问题后用同一操作重试可继续保存。'
      : '飞书调用结果尚未确认，已阻止重复建会。请先在飞书核对是否已创建，再发起新的安排。' };
}

/** Create a real Feishu link and a local event, then prepare an invitation. This function never sends email. */
export async function createAssistantMeeting(mailboxId, args, settings, dependencies = {}) {
  if (!text(mailboxId)) throw new Error('请先选择当前邮箱。');
  const mailbox = settings?.mailboxes?.find((item) => item.id === mailboxId);
  if (!mailbox) throw Object.assign(new Error('邮箱不存在或无权访问。'), { status: 404 });
  if (isProductionRuntime() && mailbox.pendingSetup === true) {
    throw Object.assign(new Error('请先在设置中保存并配置自己的邮箱，再创建会议。'), { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
  }
  if (isProductionRuntime() && !isRegisteredMailbox(mailboxId, settings, getRequestUserId())) {
    throw Object.assign(new Error('邮箱不存在或无权访问。'), { status: 404 });
  }
  if (!text(mailbox.email)) throw new Error('请先配置当前邮箱地址，才能准备会议邀约草稿。');
  const actions = dependencies.createAssistantDraft && dependencies.normalizeAssistantRecipients
    ? dependencies : await import('./assistant-actions.js');
  const createDraft = dependencies.createAssistantDraft || actions.createAssistantDraft;
  const normalizeRecipients = dependencies.normalizeAssistantRecipients || actions.normalizeAssistantRecipients;
  const getDraft = dependencies.getAssistantDraft || actions.getAssistantDraft;
  const input = await normalizeInput(args, normalizeRecipients);
  const reserveMeeting = dependencies.prepareMeeting || prepareMeeting;
  const withLock = dependencies.withMailboxLock || withAssistantMeetingMailboxLock;
  return withLock(mailboxId, async (repository) => {
    const data = await repository.read();
    let operation = data.operations.find((item) => item.operationKey === input.operationKey);
    // Retrying the same request in a new chat must not bypass a previously unknown external outcome.
    if (!operation) operation = data.operations.find((item) => item.fingerprint === input.fingerprint && item.status !== 'completed');
    if (operation && operation.fingerprint !== input.fingerprint) throw new Error('该会议操作编号已经用于另一组安排，请为新的会议重新发起请求。');
    if (operation && !operation.meeting && ['preparing', 'needs_attention'].includes(operation.status)) {
      return recoveryResult(operation, operation.error || '此前的飞书建会结果未知，请先核对飞书中的会议。', 'MEETING_OUTCOME_UNKNOWN');
    }
    if (operation?.status === 'completed') {
      const calendar = await repository.readCalendar();
      const event = calendar.events.find((item) => item.id === operation.eventId) || null;
      let draft = operation.draft;
      if (getDraft) {
        try { draft = (await getDraft(mailboxId, operation.draft.id)).draft; }
        catch { return recoveryResult(operation, '此前已创建会议和日程，但审核草稿无法读取，请检查草稿列表。'); }
      }
      return { ok: true, status: 'completed', replayed: true, operationKey: operation.operationKey,
        draft, event, meeting: operation.meeting,
        notice: `${ASSISTANT_MEETING_NOTICE}${event ? '' : ' 此前创建的日程目前已删除，本次未重新添加。'}` };
    }
    if (!operation) {
      validateNewMeeting(input, settings);
      const calendar = await repository.readCalendar();
      const conflicts = findConflicts({ ...input, allDay: false }, calendar.events);
      if (conflicts.length) return { ok: false, status: 'conflict', code: 'MEETING_TIME_CONFLICT',
        operationKey: input.operationKey, conflicts: conflictDetails(conflicts),
        suggestedSlots: suggestTimeSlots(input, calendar.events),
        error: '这个时间与当前邮箱的已有日程冲突，请选择其他时间后安排。', notice: '尚未创建飞书会议、日程或邀约草稿。' };
      operation = { operationKey: input.operationKey, fingerprint: input.fingerprint,
        eventId: `assistant-meeting-${hash(`${mailboxId}\0${input.operationKey}`).slice(0, 28)}`,
        input: { title: input.title, start: input.start, end: input.end, attendees: input.attendees, description: input.description },
        status: 'preparing', createdAt: stamp(), updatedAt: stamp() };
      data.operations.push(operation);
      await repository.save(data); // Commit the marker before calling an external API.
      try {
        const meeting = await reserveMeeting(settings, { topic: input.title, start: input.start, end: input.end });
        let url;
        try { url = new URL(meeting?.url); } catch { /* The external outcome must be reconciled manually. */ }
        if (!meeting?.id || !url || url.protocol !== 'https:' || url.username || url.password ||
            !Number.isFinite(Date.parse(meeting.expiresAt)) || Date.parse(meeting.expiresAt) < Date.parse(input.end)) {
          throw new Error('飞书未返回有效的会议编号、真实 HTTPS 链接和覆盖会议结束时间的有效期，无法创建可发送的邀约。');
        }
        operation.meeting = { ...meeting, provider: 'feishu', scheduledStart: input.start,
          scheduledEnd: input.end, timeZone: 'Asia/Shanghai', reservationOnly: true };
        operation.status = 'meeting_created';
        operation.updatedAt = stamp();
        await repository.save(data);
      } catch (failure) {
        operation.status = 'needs_attention';
        operation.error = safeFailure(failure, settings);
        operation.updatedAt = stamp();
        try { await repository.save(data); } catch { /* The earlier preparing checkpoint still prohibits another reserve. */ }
        return recoveryResult(operation, operation.meeting
          ? `飞书会议已创建，但保存会议结果失败：${operation.error}`
          : `飞书会议创建未确认成功：${operation.error}`,
        operation.meeting ? 'MEETING_CHECKPOINT_FAILED' : 'MEETING_OUTCOME_UNKNOWN');
      }
    }
    try {
      if (Date.parse(operation.meeting.expiresAt) <= Date.now() || Date.parse(input.end) <= Date.now()) {
        return recoveryResult(operation, '已创建的会议或链接已经过期，未继续生成邀约。请重新选择未来的时间安排。');
      }
      const calendar = await repository.readCalendar();
      let event = calendar.events.find((item) => item.id === operation.eventId);
      if (!event) {
        if (operation.event) return recoveryResult(operation, '已写入的日程现在已被删除，未自动重新创建。请核对日历后重新安排。');
        const conflicts = findConflicts({ ...input, allDay: false }, calendar.events);
        if (conflicts.length) {
          operation.status = 'calendar_conflict';
          operation.conflicts = conflictDetails(conflicts);
          operation.updatedAt = stamp();
          await repository.save(data);
          return { ok: false, status: 'conflict', code: 'MEETING_TIME_CONFLICT', operationKey: operation.operationKey,
            meeting: operation.meeting, conflicts: operation.conflicts, suggestedSlots: suggestTimeSlots(input, calendar.events),
            error: '飞书链接已创建，但日历出现新的时间冲突，尚未写入日程和生成邀约草稿。',
            notice: '请核对冲突。相同操作重试只继续保存已有会议，不会重复建会。' };
        }
        event = { id: operation.eventId, title: input.title, start: input.start, end: input.end,
          allDay: false, category: 'work', location: `飞书会议 ${operation.meeting.url}`,
          description: [input.description, `飞书会议链接：${operation.meeting.url}`, ASSISTANT_MEETING_NOTICE].filter(Boolean).join('\n\n'),
          source: 'assistant', status: 'active', attendees: input.attendees,
          meeting: operation.meeting, meetingId: operation.meeting.id, meetingUrl: operation.meeting.url,
          meetingSource: 'feishu', meetingExpiresAt: operation.meeting.expiresAt || null,
          operationKey: operation.operationKey, invitationStatus: 'pending_review', createdAt: stamp() };
        calendar.events.push(event);
        await repository.saveCalendar(calendar);
      } else if (event.status === 'cancelled') {
        return recoveryResult(operation, '这个会议日程已取消，未继续生成邀约草稿。');
      }
      operation.event = event;
      operation.status = 'event_saved';
      operation.error = null;
      operation.updatedAt = stamp();
      await repository.save(data);
      const copy = invitation(input, operation.meeting);
      const prepared = await createDraft(mailboxId, { kind: 'meeting_invitation', to: input.attendees,
        ...copy, eventId: event.id, meeting: operation.meeting, operationKey: operation.operationKey }, settings);
      if (!prepared?.draft?.id) throw new Error('邀约草稿未成功保存，请检查审核列表后重试。');
      operation.draft = prepared.draft;
      operation.status = 'completed';
      operation.updatedAt = stamp();
      await repository.save(data);
      return { ok: true, status: 'completed', operationKey: operation.operationKey,
        draft: prepared.draft, event, meeting: operation.meeting, notice: ASSISTANT_MEETING_NOTICE };
    } catch (failure) {
      operation.status = 'needs_attention';
      operation.error = safeFailure(failure, settings);
      operation.updatedAt = stamp();
      try { await repository.save(data); } catch { /* Last committed meeting checkpoint remains recoverable. */ }
      return recoveryResult(operation, `会议链接已创建，日程或邀约草稿尚未全部保存：${operation.error}`);
    }
  });
}
