import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { emailReference, sanitizeSnapshot, usageMetrics } from './traces.js';
import { emailLabels, inferDeadline, normalizeTask, normalizeTaskTitle, taskPriority, tasksForMode } from './tasks.js';
import { findConflicts, suggestTimeSlots } from './conflicts.js';
import { normalizeMailbox, readSettings } from './store.js';
import { readPrompts } from './prompts.js';
import { resolveFetchSince, resolveFetchUntil } from './fetch-policy.js';
import { putAttachment } from './infra/oss.js';
import { categoryPromptBlock, resolveEventCategory } from './calendar-categories.js';
import { findMatchingFilter } from './mail-filters.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function uploadParsedAttachments(parsed, {
  mailboxId = 'default',
  userId = '',
  username = '',
} = {}) {
  const list = parsed.attachments || [];
  const uploaded = [];
  for (const file of list) {
    const filename = file.filename || file.cid || 'attachment.bin';
    const contentType = file.contentType || 'application/octet-stream';
    const buffer = file.content;
    if (!buffer || !Buffer.isBuffer(buffer)) continue;
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      uploaded.push({
        filename,
        contentType,
        size: buffer.length,
        skipped: true,
        reason: '附件超过 25MB，已跳过上传',
      });
      continue;
    }
    try {
      const stored = await putAttachment({
        buffer,
        filename,
        contentType,
        mailboxId,
        userId,
        username,
      });
      uploaded.push({
        filename: stored.filename || filename,
        contentType: stored.contentType || contentType,
        size: stored.size,
        key: stored.key,
        url: stored.url,
        proxyUrl: stored.proxyUrl,
        storage: stored.storage,
        userFolder: username || userId || 'workspace',
      });
    } catch (error) {
      uploaded.push({
        filename,
        contentType,
        size: buffer.length,
        skipped: true,
        reason: error.message || '附件上传失败',
      });
    }
  }
  return uploaded;
}

export function completionUrl(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** Quick IMAP login probe — does not download mail. */
export async function testMailboxConnection(settings, { clientFactory = (options) => new ImapFlow(options) } = {}) {
  const mailbox = normalizeMailbox(settings);
  if (!settings.email || !settings.authorizationCode) {
    throw new Error('请先填写邮箱地址和授权码后再测试。');
  }
  if (!mailbox.imapHost) throw new Error('请填写 IMAP 主机。');
  const client = clientFactory({
    host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.imapSecure,
    ...(!mailbox.imapSecure ? { doSTARTTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode }, logger: false,
    clientInfo: { name: 'Daylight', version: '0.1.0', vendor: 'Local demo' },
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox?.exists ?? 0;
      return { ok: true, message: `IMAP 连接成功，收件箱约 ${exists} 封。` };
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

/** Minimal chat completion probe against OpenAI-compatible endpoint. */
export async function testModelConnection(settings, { timeoutMs = 20_000 } = {}) {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw new Error('请先填写 Base URL、API Key 和模型名称后再测试。');
  }
  const endpoint = completionUrl(settings.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: 'Reply with a tiny JSON object only.' },
          { role: 'user', content: '{"ping":true}' },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 32,
      }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new Error(`模型接口返回非 JSON（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `模型接口 HTTP ${response.status}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    return {
      ok: true,
      message: content ? `模型响应正常：${String(content).slice(0, 80)}` : '模型接口可连通。',
      model: settings.model,
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('模型连通性测试超时。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readMailboxEmails(settings, { onProgress = () => {}, recorder, processedIds = new Set(),
  clientFactory = (options) => new ImapFlow(options), retryMode = 'manual' } = {}) {
  const mailbox = normalizeMailbox(settings);
  const sessionStart = Date.now();
  onProgress({ stage: '连接邮箱', received: 0, total: 0 });
  const client = clientFactory({
    host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.imapSecure,
    ...(!mailbox.imapSecure ? { doSTARTTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode }, logger: false,
    clientInfo: { name: 'Daylight', version: '0.1.0', vendor: 'Local demo' },
  });
  let lock;
  let readFailed = false;
  const readContexts = [];
  try {
    await client.connect();
    const connectionMs = Date.now() - sessionStart;
    onProgress({ stage: '打开收件箱', shared_connection_ms: connectionMs });
    lock = await client.getMailboxLock('INBOX');
    if (!client.mailbox.exists) return [];
    const since = resolveFetchSince(mailbox);
    const until = resolveFetchUntil(mailbox);
    const emails = [];
    const pendingUids = [];
    const messageId = (uid) => `${mailbox.id === 'default' ? 'qq' : 'imap'}:${settings.email.toLowerCase()}:${client.mailbox.uidValidity}:${uid}`;
    let total = 0;
    let checked = 0;
    onProgress({ stage: '检查邮件 ID', received: 0, total: 0 });
    // Finish this command before fetching sources: commands inside a fetch iterator can deadlock IMAP.
    if (since) {
      const query = { since };
      if (until) query.before = until;
      onProgress({ stage: '按日期筛选邮件', received: 0, total: 0 });
      const candidateUids = await client.search(query, { uid: true });
      candidateUids.sort((a, b) => a - b);
      total = candidateUids.length;
      onProgress({ stage: '检查邮件 ID', received: 0, total });
      if (candidateUids.length) {
        for await (const message of client.fetch(candidateUids.join(','), { uid: true, internalDate: true }, { uid: true })) {
          const id = messageId(message.uid);
          if (processedIds.has(id)) emails.push({ id, receivedAt: message.internalDate.toISOString() });
          else pendingUids.push(message.uid);
          onProgress({ stage: '检查邮件 ID', received: ++checked, total });
        }
      }
    } else {
      const limit = Math.max(1, Math.min(200, Number(settings.fetchLimit) || 15));
      const first = Math.max(1, client.mailbox.exists - limit + 1);
      total = client.mailbox.exists - first + 1;
      onProgress({ stage: '检查邮件 ID', received: 0, total });
      for await (const message of client.fetch(`${first}:*`, { uid: true, internalDate: true })) {
        const id = messageId(message.uid);
        if (processedIds.has(id)) emails.push({ id, receivedAt: message.internalDate.toISOString() });
        else pendingUids.push(message.uid);
        onProgress({ stage: '检查邮件 ID', received: ++checked, total });
      }
    }
    if (!pendingUids.length) {
      onProgress({ stage: '邮件读取完成', received: emails.length, total, shared_read_ms: Date.now() - sessionStart });
      return emails.reverse();
    }
    const sourceRange = pendingUids.join(',');
    const iterator = client.fetch(sourceRange, { source: true, uid: true, internalDate: true }, { uid: true })[Symbol.asyncIterator]();
    while (true) {
      onProgress({ stage: '读取邮件原文', received: emails.length, total });
      const fetchStart = new Date().toISOString();
      const next = await iterator.next();
      if (next.done) break;
      const fetchEnd = new Date().toISOString();
      const message = next.value;
      // Keep the original prefix for legacy data; changing a provider preset does not reprocess the same mailbox.
      const id = messageId(message.uid);
      // Matching failures are checked against the latest calendar in processEmails first.
      const waitingForMatch = retryMode !== 'manual' && recorder?.traces.some((trace) =>
        trace.email_ref === emailReference(id) && trace.mode === 'qq' && trace.status === 'failed' && trace.match_retry);
      const context = !processedIds.has(id) && !waitingForMatch ? recorder?.beginEmail({ id }, 'qq') : null;
      if (context) {
        readContexts.push(context);
        const receive = context.startSpan('receive_email', '收取邮件', { started_at: fetchStart,
          thought: '最近邮件已按 ID 去重，只取得尚未成功处理的原始消息。',
          input_snapshot: { mailbox: 'INBOX', uid: message.uid, range: sourceRange },
          tool_calls: [{ name: 'imap.fetch', arguments: { mailbox: 'INBOX', uid: message.uid, source: true, uid_mode: true },
            result_summary: { raw_bytes: message.source?.length || 0, internal_date: message.internalDate?.toISOString(),
              shared_connection_ms: connectionMs,
              timing_scope: '等待此消息的实际时间；shared_connection_ms 属于本次同步共享开销，不分摊到单封。' } }] });
        context.finishSpan(receive, { ended_at: fetchEnd, observation: '已收到邮件源数据，开始解析。',
          output_snapshot: { raw_bytes: message.source?.length || 0 } });
      }
      onProgress({ stage: '解析邮件正文', received: emails.length, total });
      const parseStart = new Date().toISOString();
      const parseSpan = context?.startSpan('parse', '解析邮件', { started_at: parseStart,
        thought: '提取主题、发件人、发送时间和正文；纯文本优先，HTML 去标签作为备用。',
        input_snapshot: { raw_bytes: message.source?.length || 0 },
        tool_calls: [{ name: 'mailparser.simpleParser', arguments: { raw_bytes: message.source?.length || 0 }, result_summary: null }] });
      try {
        const parsed = await simpleParser(message.source);
        const attachments = await uploadParsedAttachments(parsed, {
          mailboxId: mailbox.id,
          userId: mailbox.ownerUserId || mailbox.userId || settings.ownerUserId || '',
          username: mailbox.ownerUsername || settings.ownerUsername || '',
        });
        const email = { id, subject: parsed.subject || '（无主题）', sender: parsed.from?.text || '',
          senderAddress: parsed.from?.value?.[0]?.address || '', replyTo: parsed.replyTo?.text || '',
          messageId: parsed.messageId || '', references: parsed.references || [], inReplyTo: parsed.inReplyTo || '',
          receivedAt: (parsed.date || message.internalDate).toISOString(),
          body: parsed.text || parsed.html?.replace(/<[^>]*>/g, ' ') || '',
          html: typeof parsed.html === 'string' ? parsed.html.slice(0, 200_000) : '',
          attachments };
        Object.defineProperty(email, '_pdfAttachments', { value: (parsed.attachments || []).filter((item) => item.contentType === 'application/pdf' || /\.pdf$/i.test(item.filename || '')) });
        const parsedSnapshot = emailSnapshot(email);
        if (context) {
          context.update({ subject: email.subject, received_at: email.receivedAt });
          context.finishSpan(parseSpan, { observation: '邮件字段解析完成，原文仅记录有限脱敏片段。', output_snapshot: parsedSnapshot,
            tool_calls: [{ name: 'mailparser.simpleParser', arguments: { raw_bytes: message.source?.length || 0 }, result_summary: parsedSnapshot }] });
          context.queue_span = context.startSpan('queue_wait', '等待顺序处理', {
            thought: '等待本次读取结束，再按邮件时间从早到晚处理，避免调整通知早于原邀请执行。',
            input_snapshot: { order: 'received_at_ascending' },
            tool_calls: [{ name: 'mail.chronological_queue', arguments: { order: 'received_at_ascending' }, result_summary: '等待处理' }] });
          email.trace_id = context.trace.trace_id;
          Object.defineProperty(email, '_traceContext', { value: context });
        } else {
          // Not enumerable: raw timings never become part of stored mail text or the model request.
          Object.defineProperty(email, '_traceTimings', { value: { fetchStart, fetchEnd, parseStart, parseEnd: new Date().toISOString() } });
        }
        emails.push(email);
      } catch (error) {
        if (context) {
          context.finishSpan(parseSpan, { status: 'failed', error: error.message, observation: '邮件解析失败，此封未调用模型。' });
          context.finish('failed', { decision: '解析失败，可再次同步重试', error: error.message });
        }
        throw error;
      }
    }
    onProgress({ stage: '邮件读取完成', received: emails.length, total, shared_read_ms: Date.now() - sessionStart });
    return emails.reverse();
  } catch (error) {
    readFailed = true;
    for (const context of readContexts.filter((item) => item.trace.status === 'running')) {
      if (context.queue_span) context.finishSpan(context.queue_span, { status: 'failed', error: error.message,
        observation: '批量读取中断，此封尚未调用模型，可再次同步。' });
      context.finish('failed', { decision: '批量读取中断，可再次同步重试', error: error.message });
    }
    throw error;
  } finally {
    lock?.release();
    // Failed connect/select/fetch must not leave a socket or wait for another network command.
    if (readFailed) client.close();
    else await client.logout();
  }
}

export async function sendMailboxReply(settings, email, draft) {
  const mailbox = normalizeMailbox(settings);
  const recipient = [email.replyTo, email.senderAddress, email.sender]
    .flatMap((source) => addressparser(source || '', { flatten: true }))
    .find((item) => item.address?.includes('@'))?.address;
  if (!recipient) throw new Error('原邮件没有可回复的发件人地址。');
  const references = Array.isArray(email.references) ? email.references : (email.references || '').split(/\s+/);
  return sendMailboxMessage(settings, { to: recipient,
    subject: /^\s*re\s*:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || '（无主题）'}`,
    text: draft, ...(email.messageId ? { inReplyTo: email.messageId } : {}),
    references: [...new Set([...references, email.messageId].filter(Boolean))] });
}

export async function sendMailboxMessage(settings, message) {
  const mailbox = normalizeMailbox(settings);
  const recipient = message.to;
  // Use system DNS so local proxy/hosts rules apply; keep the configured TLS hostname.
  const { address } = await dns.lookup(mailbox.smtpHost);
  const transport = nodemailer.createTransport({
    host: address, port: mailbox.smtpPort, secure: mailbox.smtpSecure, tls: { servername: mailbox.smtpHost },
    ...(!mailbox.smtpSecure ? { requireTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode }, logger: false, debug: false,
  });
  const info = await transport.sendMail({ ...message, from: settings.email });
  if (!info.accepted?.some((address) => address.toLowerCase() === recipient.toLowerCase())) {
    throw new Error('邮箱未接受这封回复，请检查收件人后重试。');
  }
  return info;
}

// Existing scripts and stored real-mail traces use the original QQ entry names.
export const readQQEmails = readMailboxEmails;
export const sendQQReply = sendMailboxReply;

function emailSnapshot(email) {
  return { subject: email.subject, sender: email.sender, sent_at: email.receivedAt,
    body_length: email.body?.length || 0 };
}

function taskContextSnapshot(tasks) {
  return tasks.map((task) => ({ ...task, sources: (task.sources || []).map(({ emailId, emailUrl, ...source }) =>
    ({ ...source, email_ref: emailReference(emailId), emailUrl: emailUrl?.split(/[?#]/)[0] || '/' })) }));
}

export function parseExtraction(content) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed.events)) throw new Error('模型返回格式不正确：缺少 events 数组。');
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) throw new Error('模型返回格式不正确：tasks 必须是数组。');
  return { summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '', ...emailLabels(parsed),
    events: parsed.events.map(normalizeAction),
    ...(parsed.tasks !== undefined ? { tasks: parsed.tasks.map(normalizeTask) } : {}) };
}

function eventFields(event, partial = false) {
  const fields = {};
  for (const name of ['title', 'start', 'end', 'allDay', 'category', 'location', 'description']) {
    if (partial && event[name] === undefined) continue;
    fields[name] = event[name];
  }
  if ('allDay' in fields) fields.allDay = Boolean(fields.allDay);
  if ('category' in fields) {
    fields.category = resolveEventCategory(fields.category, readSettings().calendarCategories);
  }
  if ('location' in fields) fields.location = fields.location || '';
  if ('description' in fields) fields.description = fields.description || '';
  if (!partial && (!fields.title || !fields.start || !fields.end || !Number.isFinite(Date.parse(fields.start)) ||
      !Number.isFinite(Date.parse(fields.end)) || Date.parse(fields.end) <= Date.parse(fields.start))) {
    throw new Error('模型返回的日程缺少标题或有效的起止时间，请调整模型后重试。');
  }
  return fields;
}

function normalizeAction(event) {
  const action = event.action ?? 'create';
  if (!['create', 'cancel', 'reschedule'].includes(action)) throw new Error('模型返回了不支持的日程操作。');
  if (action === 'create') return eventFields(event);
  if (typeof event.targetEventId !== 'string' || !event.targetEventId.trim()) {
    throw new Error('取消或调整邮件未匹配到唯一日程，请补充原活动标题、时间或地点后重试。');
  }
  return { ...(action === 'reschedule' ? eventFields(event, true) : {}),
    action, targetEventId: event.targetEventId, reason: event.reason || '' };
}

function activeEventsForMode(events, mode) {
  return events.filter((event) => event.status !== 'cancelled' &&
    (mode === 'demo' ? event.source === 'demo' : event.source !== 'demo'));
}

export const EXTRACTION_VERSION = 'mail-calendar-tasks-resume-v4';

export async function extractEvents(email, settings, existingEvents = [], traceContext, existingTasks = [], { timeoutMs = 60_000 } = {}) {
  const endpoint = completionUrl(settings.baseUrl);
  const candidates = activeEventsForMode(existingEvents, 'qq').map((event) => ({
    id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay,
    category: event.category, location: event.location, description: event.description, source: event.source,
    emailSubject: event.emailSubject, emailSender: event.emailSender,
  }));
  const taskCandidates = tasksForMode(existingTasks, 'qq').map(({ id, title, description, dueAt, deadlineText, priority, status, sources, assignee }) =>
    ({ id, title, description, dueAt, deadlineText, priority, status, assignee: assignee || '', sources }));
  const taskEvidence = taskContextSnapshot(taskCandidates);
  const currentTime = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+08:00';
  const calendarCategories = settings.calendarCategories || readSettings().calendarCategories;
  const systemPrompt = [
    readPrompts().extractionSystem,
    categoryPromptBlock(calendarCategories),
  ].filter(Boolean).join('\n\n');
  const request = { model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ sentAt: email.receivedAt, subject: email.subject, sender: email.sender, body: email.body,
          attachments: (email.attachments || email._pdfAttachments || []).map((item) => ({ filename: item.filename })), currentTime, existingEvents: candidates, existingTasks: taskCandidates }) },
      ],
      response_format: { type: 'json_object' },
    };
  if (new URL(endpoint).hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model)) {
    request.thinking = { type: 'disabled' };
  }
  const ownsSpan = Boolean(traceContext && !traceContext.extract_span);
  const span = traceContext?.extract_span || traceContext?.startSpan('extract', '模型提取');
  const tool = { name: 'llm.chat_completions', arguments: { method: 'POST', endpoint,
    model: settings.model, response_format: request.response_format, prompt_version: EXTRACTION_VERSION,
    timeout_ms: timeoutMs, ...(request.thinking ? { thinking: request.thinking } : {}),
    system_prompt: request.messages[0].content, current_time: currentTime, email: emailSnapshot(email), existing_events: candidates,
    existing_tasks: taskEvidence }, result_summary: null };
  traceContext?.updateSpan(span, { thought: '调用配置的模型，一次提取分类、摘要、优先级、日程操作和待办，并与已有事项匹配。',
    input_snapshot: { model: settings.model, current_time: currentTime, email: emailSnapshot(email), existing_events: candidates, existing_tasks: taskEvidence,
      full_body_sent_to_model: true, snapshot_note: '模型接收完整正文；日志只保留脱敏、截断快照。' },
    tool_calls: [tool], llm_request: true });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(request), signal: timeoutSignal,
    });
    const rawResponse = await response.text();
    let result;
    try { result = JSON.parse(rawResponse); }
    catch {
      tool.result_summary = { http_status: response.status, response_chars: rawResponse.length, error: '响应不是有效 JSON' };
      traceContext?.updateSpan(span, { ...usageMetrics(null, settings), output_snapshot: tool.result_summary, tool_calls: [tool] });
      throw new Error('模型响应不是有效 JSON，请检查接口地址或服务商返回格式。');
    }
    const content = result.choices?.[0]?.message?.content || '';
    const metrics = usageMetrics(result.usage, settings);
    // Only message.content and numeric usage are evidence. Provider reasoning_content is never recorded.
    tool.result_summary = { http_status: response.status, finish_reason: result.choices?.[0]?.finish_reason || null,
      usage: { prompt_tokens: metrics.llm_tokens_in, completion_tokens: metrics.llm_tokens_out, cached_tokens: metrics.llm_tokens_cached_in },
      content_length: content.length, content_preview: content,
      ...(response.ok ? {} : { error: result.error?.message || String(response.status) }) };
    traceContext?.updateSpan(span, { ...metrics, output_snapshot: tool.result_summary, tool_calls: [tool] });
    if (!response.ok) throw new Error(`模型请求失败：${result.error?.message || response.status}`);
    const extraction = parseExtraction(content);
    traceContext?.updateSpan(span, { output_snapshot: { ...tool.result_summary, parsed: extraction } });
    if (ownsSpan) traceContext.finishSpan(span, { observation: `模型返回 ${extraction.events.length} 项日程操作、${extraction.tasks?.length || 0} 项待办，内容摘要和邮件标签已解析。` });
    return extraction;
  } catch (error) {
    const safeMessage = sanitizeSnapshot(timeoutSignal.aborted
      ? `模型请求超过 ${timeoutMs / 1000} 秒，已停止等待；请再次同步重试。`
      : error.message, [settings.apiKey, settings.authorizationCode]);
    if (span && !tool.result_summary) {
      tool.result_summary = { error: safeMessage, response_received: false };
      traceContext.updateSpan(span, { ...usageMetrics(null, settings), tool_calls: [tool], output_snapshot: tool.result_summary });
    }
    if (ownsSpan) traceContext.finishSpan(span, { status: 'failed', error: safeMessage, observation: safeMessage });
    throw new Error(safeMessage);
  }
}

function prepareTasks(store, email, extractedTasks, mode, priority, processedAt) {
  const candidates = tasksForMode(store.tasks || [], mode).map((task) => ({ ...task, sources: [...(task.sources || [])] }));
  const created = new Set();
  const merged = new Set();
  const reopened = new Set();
  const touched = new Set();
  const source = { emailId: email.id, emailSubject: email.subject, emailSender: email.sender,
    emailUrl: `/?email=${encodeURIComponent(email.id)}` };
  for (const raw of extractedTasks) {
    const fields = normalizeTask(raw);
    const dueAt = inferDeadline(fields.deadlineText, email.receivedAt, fields.dueAt);
    let task;
    if (fields.existingTaskId) {
      task = candidates.find((candidate) => candidate.id === fields.existingTaskId);
      if (!task) throw new Error('待办匹配目标不存在或来源不一致，请核对任务后重试。');
    } else {
      task = candidates.find((candidate) => normalizeTaskTitle(candidate.title) === normalizeTaskTitle(fields.title) &&
        (candidate.dueAt ? Date.parse(candidate.dueAt) : null) === (dueAt ? Date.parse(dueAt) : null));
    }
    if (!task) {
      task = { id: randomUUID(), title: fields.title, description: fields.description, dueAt, deadlineText: fields.deadlineText,
        assignee: fields.assignee || '',
        priority: taskPriority(dueAt, priority, processedAt), status: 'pending', source: mode === 'demo' ? 'demo' : 'email',
        createdAt: processedAt, sources: [] };
      candidates.push(task);
      created.add(task.id);
    } else {
      if (!created.has(task.id)) merged.add(task.id);
      if (dueAt) {
        task.dueAt = dueAt;
        task.deadlineText = fields.deadlineText || task.deadlineText;
      }
      if (fields.description) task.description = fields.description;
      if (fields.assignee) task.assignee = fields.assignee;
      const nextPriority = taskPriority(task.dueAt, priority, processedAt);
      task.priority = nextPriority;
      // 提醒/变更邮件命中已完成任务时重新打开，避免「完成后再催」被忽略
      if (task.status === 'done') {
        task.status = 'pending';
        task.completedAt = null;
        task.reopenedAt = processedAt;
        task.reopenedByEmailId = email.id;
        reopened.add(task.id);
      }
    }
    if (!task.sources.some((item) => item.emailId === email.id)) task.sources.push(source);
    touched.add(task.id);
  }
  const drafts = candidates.filter((task) => touched.has(task.id));
  return { drafts, taskIds: [...touched], createdTaskIds: [...created], mergedTaskIds: [...merged], reopenedTaskIds: [...reopened],
    snapshots: drafts.map(({ id, title, description, dueAt, deadlineText, priority, status, assignee }) =>
      ({ taskId: id, title, description, dueAt, deadlineText, priority, status, assignee: assignee || '',
        action: created.has(id) ? 'create' : reopened.has(id) ? 'reopen' : 'merge' })) };
}

export function importEmail(store, email, extracted, mode) {
  const extraction = extracted?.category === 'resume' ? { ...extracted, events: [], tasks: [] } : Array.isArray(extracted) ? { summary: '', events: extracted } : extracted;
  if (!Array.isArray(extraction?.events)) throw new Error('模型返回格式不正确：缺少 events 数组。');
  if (extraction.tasks !== undefined && !Array.isArray(extraction.tasks)) throw new Error('模型返回格式不正确：tasks 必须是数组。');
  const labels = emailLabels(extraction);
  const processedAt = new Date().toISOString();
  const candidates = activeEventsForMode(store.events, mode);
  const targets = new Set();
  // Validate the whole email first so a failed action cannot leave half-applied changes.
  const actions = extraction.events.map(normalizeAction).map((action) => {
    if (!action.action) return { action: 'create', event: eventFields(action), id: randomUUID() };
    const matches = candidates.filter((event) => event.id === action.targetEventId);
    if (matches.length !== 1) throw new Error('取消或调整目标不存在、已取消或不唯一，请核对原日程后重试。');
    if (targets.has(action.targetEventId)) throw new Error('同一封邮件重复修改了同一个日程，请调整模型后重试。');
    targets.add(action.targetEventId);
    const target = matches[0];
    return { ...action, target, ...(action.action === 'reschedule'
      ? { event: eventFields({ ...target, ...action }), id: randomUUID() } : {}) };
  });
  // Compare the final arrangements: cancelled and replaced originals no longer occupy time.
  const pending = actions.filter((action) => action.event);
  const calendar = [...candidates.filter((event) => !targets.has(event.id)),
    ...pending.map((action) => ({ ...action.event, id: action.id, source: mode === 'demo' ? 'demo' : 'email' }))];
  for (const action of pending) {
    action.conflicts = findConflicts(action.event, calendar.filter((event) => event.id !== action.id));
  }
  const conflicts = actions.flatMap((action, actionIndex) => action.conflicts?.length ? [{
    actionIndex, action: action.action, eventId: action.id, event: { ...action.event },
    ...(action.target ? { targetEventId: action.target.id } : {}),
    existingEvents: action.conflicts.map((event) => ({ id: event.id, ...eventFields(event), source: event.source })),
    suggestedSlots: suggestTimeSlots(action.event, calendar, Date.parse(processedAt)),
  }] : []);
  // Keep processing-time fields independent from later calendar edits or deletions.
  const actionSnapshots = actions.map((action) => ({
    ...eventFields(action.event || action.target), action: action.action,
    ...(action.target ? { targetEventId: action.target.id, reason: action.reason } : {}),
    ...(action.id ? { eventId: action.id } : {}),
    ...(action.conflicts?.length ? { outcome: 'conflict' } : {}),
  }));
  // Draft merged tasks without touching the store so any invalid field fails the whole email.
  const tasks = prepareTasks(store, email, extraction.tasks || [], mode, labels.priority, processedAt);
  if (labels.priority !== undefined && tasks.snapshots.length) {
    const pendingTasks = tasks.snapshots.filter((task) => task.status !== 'done');
    const imminentTask = pendingTasks.some((task) => task.priority === 'high');
    const imminentMeeting = actions.some((action) => action.event && taskPriority(action.event.start, 'normal', processedAt) === 'high');
    const undatedAction = pendingTasks.some((task) => !task.dueAt);
    if (imminentTask) labels.priority = 'high';
    else if (labels.priority === 'high' && !imminentMeeting && !undatedAction) labels.priority = 'normal';
    else if (labels.priority === 'low' && pendingTasks.length) labels.priority = 'normal';
  }
  const createdEventIds = [];
  const cancelledEventIds = [];
  const rescheduledEventIds = [];
  for (const action of actions) {
    if (action.target) {
      Object.assign(action.target, {
        status: 'cancelled', cancellationType: action.action, cancelReason: action.reason,
        cancelledAt: processedAt, cancelledByEmailId: email.id,
        changeEmailId: email.id, changeEmailSubject: email.subject, changeEmailSender: email.sender,
        ...(action.action === 'reschedule' ? { replacementEventId: action.id } : {}),
      });
      (action.action === 'cancel' ? cancelledEventIds : rescheduledEventIds).push(action.target.id);
    }
    if (action.event) {
      store.events.push({ ...action.event, id: action.id, status: 'active', source: mode === 'demo' ? 'demo' : 'email',
        emailId: email.id, emailSubject: email.subject, emailSender: email.sender,
        ...(action.conflicts?.length ? { hasConflict: true, conflictEventIds: action.conflicts.map((event) => event.id) } : {}),
        ...(action.target ? { previousEventId: action.target.id } : {}) });
      createdEventIds.push(action.id);
    }
  }
  if (extraction.tasks !== undefined) store.tasks ||= [];
  for (const task of tasks.drafts) {
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index === -1) store.tasks.push(task);
    else Object.assign(store.tasks[index], task);
  }
  const affectedEventIds = [...cancelledEventIds, ...rescheduledEventIds];
  const summary = [createdEventIds.length > rescheduledEventIds.length ? `新增 ${createdEventIds.length - rescheduledEventIds.length} 项日程` : '',
    cancelledEventIds.length ? `取消 ${cancelledEventIds.length} 项日程` : '',
    rescheduledEventIds.length ? `调整 ${rescheduledEventIds.length} 项日程` : '',
    tasks.createdTaskIds.length ? `新增 ${tasks.createdTaskIds.length} 项待办` : '',
    tasks.mergedTaskIds.length ? `合并 ${tasks.mergedTaskIds.length} 项待办提醒` : '',
    tasks.reopenedTaskIds?.length ? `重开 ${tasks.reopenedTaskIds.length} 项已完成待办` : '',
    conflicts.length ? `${conflicts.length} 项日程冲突，已加入日历并标记，回复草稿待确认` : ''].filter(Boolean).join('；') ||
      (extraction.tasks !== undefined ? '已分类并保存摘要，无需新增日程或待办' : '未发现需要处理的日程');
  const record = { ...email, events: undefined, tasks: undefined, mode, ...labels,
    ...(Object.keys(labels).length ? { tags: [labels.category, labels.priority].filter(Boolean) } : {}),
    eventIds: [...affectedEventIds, ...createdEventIds], createdEventIds, cancelledEventIds, rescheduledEventIds, affectedEventIds,
    taskIds: tasks.taskIds, createdTaskIds: tasks.createdTaskIds, mergedTaskIds: tasks.mergedTaskIds,
    status: conflicts.length ? 'conflict' : actions.length || tasks.taskIds.length ? 'imported' : 'skipped', summary, processedAt, conflicts,
    extraction: { summary: typeof extraction.summary === 'string' ? extraction.summary.trim() : '', ...labels, actions: actionSnapshots,
      ...(extraction.tasks !== undefined ? { tasks: tasks.snapshots } : {}) } };
  if (labels.category === 'resume') Object.assign(record, { status: 'imported', recruitmentStatus: 'no_pdf', summary: '求职邮件已分类，未发现可提取的 PDF 简历。' });
  if (record.category !== 'resume' && record.recruitmentStatus === 'partial') { record.recruitmentStatus = 'not_resume'; record.resumeErrors = []; }
  const existingIndex = store.emails.findIndex((item) => item.id === record.id);
  if (existingIndex < 0) store.emails.unshift(record); else store.emails[existingIndex] = record;
  return record;
}

function replyDate(value, allDay) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(value));
}

function replyTime(event) {
  const first = replyDate(event.start, event.allDay);
  const last = replyDate(event.allDay ? new Date(Date.parse(event.end) - 1).toISOString() : event.end, event.allDay);
  return `${first}${event.allDay ? `${last === first ? '' : ` 至 ${last}`}（全天）` : ` 至 ${last}`}（北京时间）`;
}

export function buildReplyDraft(record) {
  const actions = record.extraction.actions;
  const tasks = record.extraction.tasks || [];
  if (!actions.length && !tasks.length) return `已收到「${record.subject}」。本封邮件未识别出需要新增、取消或调整的日程，也没有需要完成的待办，我会保留邮件供查阅。`;
  const lines = actions.map((action, index) => {
    const conflict = record.conflicts?.find((item) => item.actionIndex === index);
    if (conflict) {
      const occupied = conflict.existingEvents.map((event) => `- 「${event.title}」：${replyTime(event)}${event.location ? `，地点：${event.location}` : ''}`).join('\n');
      const alternatives = conflict.suggestedSlots.map((slot, slotIndex) => `${slotIndex + 1}. ${replyTime(slot)}`).join('\n');
      return `感谢${action.action === 'reschedule' ? '告知调整' : '邀请'}「${action.title}」。${action.action === 'reschedule' ? '调整后的' : '原定'} ${replyTime(action)} 与以下已有安排冲突：\n${occupied}\n\n这次${action.action === 'reschedule' ? '调整已按通知更新日历并标记冲突，原安排已取消' : '邀请已加入日历并标记冲突'}。根据我的当前日历，以下 3 个时段可供选择（保留原时长）：\n${alternatives}\n以上仅代表我当前的空闲时间，尚未预订，请确认你方便的时段。`;
    }
    if (action.action === 'cancel') return `已知悉「${action.title}」取消${action.reason ? `（${action.reason}）` : ''}，原日程已标记取消。`;
    const time = replyTime(action);
    const place = action.location ? `，地点：${action.location}` : '';
    return action.action === 'reschedule' ? `已知悉「${action.title}」调整为 ${time}${place}，已按新安排更新日历。`
      : `已收到「${action.title}」邀请，已记录 ${time}${place}。`;
  });
  lines.push(...tasks.map((task) => {
    const who = task.assignee ? `（责任人：${task.assignee}）` : '';
    if (task.action === 'reopen') {
      return `「${task.title}」此前已完成，根据最新提醒已重新打开${who}${task.dueAt ? `，截止 ${replyDate(task.dueAt, false)}（北京时间）` : ''}。`;
    }
    return `已记录待办「${task.title}」${who}${task.dueAt ? `，截止 ${replyDate(task.dueAt, false)}（北京时间）` : '，邮件未指定截止时间'}。`;
  }));
  return `您好，\n\n${lines.join('\n')}\n\n谢谢。`;
}

function decisionFor(record) {
  if (record.conflicts.length) return '日程已保存并标记冲突 / 等待确认回复草稿';
  if (record.rescheduledEventIds.length) return '调整安排';
  if (record.cancelledEventIds.length) return '取消安排';
  if (record.createdEventIds.length) return '接受邀请 / 记录日程';
  if (record.createdTaskIds.length) return '记录待办';
  if (record.mergedTaskIds.length) return '合并待办提醒';
  return '仅保留通知';
}

function matchingContextKey(store, mode, modelContext) {
  // Hash only the fields the extractor sees. lastSync and trace history do not change a match.
  const events = activeEventsForMode(store.events, mode).map(({ id, title, start, end, allDay,
    category, location, description, source, emailSubject, emailSender }) =>
    ({ id, title, start, end, allDay, category, location, description, source, emailSubject, emailSender }));
  const tasks = tasksForMode(store.tasks || [], mode).map(({ id, title, description, dueAt,
    deadlineText, priority, status, sources }) => ({ id, title, description, dueAt, deadlineText, priority, status, sources }));
  events.sort((a, b) => a.id.localeCompare(b.id));
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ mode, modelContext, events, tasks })).digest('hex');
}

const matchingErrors = new Set([
  '取消或调整邮件未匹配到唯一日程，请补充原活动标题、时间或地点后重试。',
  '取消或调整目标不存在、已取消或不唯一，请核对原日程后重试。',
]);

function recordFilteredEmail(store, email, rule, mode) {
  const processedAt = new Date().toISOString();
  const record = {
    id: email.id,
    subject: email.subject,
    sender: email.sender,
    receivedAt: email.receivedAt,
    body: email.body,
    attachments: email.attachments || [],
    mode,
    status: 'filtered',
    summary: `已按规则「${rule.name}」跳过，未调用模型`,
    processedAt,
    conflicts: [],
    eventIds: [],
    createdEventIds: [],
    cancelledEventIds: [],
    rescheduledEventIds: [],
    taskIds: [],
    createdTaskIds: [],
    mergedTaskIds: [],
    filterRuleId: rule.id,
    filterRuleName: rule.name,
    extraction: {
      summary: `规则过滤：${rule.name}`,
      category: 'promo',
      priority: 'low',
      actions: [],
      tasks: [],
    },
  };
  store.emails = [record, ...(store.emails || [])];
  return record;
}

export async function processEmails(store, emails, extractor, mode, { recorder, onProcessed = () => {}, beforeImport = () => {},
  retryMode = 'manual', modelContext = '', handleSpecialEmail, mailFilters } = {}) {
  let added = 0;
  let cancelled = 0;
  let rescheduled = 0;
  let tasksAdded = 0;
  let tasksMerged = 0;
  let conflicts = 0;
  let skipped = 0;
  let filtered = 0;
  let duplicate = 0;
  let deferred = 0;
  const errors = [];
  const filters = mailFilters ?? readSettings().mailFilters;
  const processed = new Set(store.emails.filter((email) => email.recruitmentStatus !== 'partial').map((email) => email.id));
  const chronologicalEmails = [...emails].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  for (let email of chronologicalEmails) {
    if (!email.body && store.emails.some((item) => item.id === email.id && item.recruitmentStatus === 'partial')) email = { ...store.emails.find((item) => item.id === email.id) };
    if (processed.has(email.id)) { duplicate++; continue; }
    const matchedFilter = mode === 'qq' ? findMatchingFilter(email, filters) : null;
    if (matchedFilter) {
      const context = recorder?.beginEmail(email, mode);
      const record = recordFilteredEmail(store, email, matchedFilter, mode);
      if (context) {
        const span = context.startSpan('filter', '规则过滤', {
          thought: '用户配置的过滤规则命中，跳过模型提取。',
          input_snapshot: { ruleId: matchedFilter.id, ruleName: matchedFilter.name },
        });
        context.finishSpan(span, {
          observation: record.summary,
          output_snapshot: { filterRuleId: matchedFilter.id, filterRuleName: matchedFilter.name },
        });
        context.finish('skipped', {
          decision: record.summary,
          extraction_snapshot: record.extraction,
          calendar_summary: record.summary,
        });
        record.trace_id = context.trace.trace_id;
      }
      processed.add(email.id);
      filtered++;
      skipped++;
      await onProcessed(record, store);
      continue;
    }
    const previousTrace = recorder?.traces.find((trace) => trace.email_ref === emailReference(email.id) && trace.mode === mode);
    const contextKey = mode === 'qq' ? matchingContextKey(store, mode, modelContext) : null;
    if (retryMode !== 'manual' && previousTrace?.status === 'failed' && previousTrace.match_retry?.context_key === contextKey) {
      deferred++;
      errors.push({ subject: email.subject || previousTrace.subject, message: '未能唯一匹配原日程；日历未变化，本轮没有重复调用模型。补充或修正原日程后会自动重试，也可点击同步真实邮箱手动重试。', deferred: true });
      continue;
    }
    const reusedReadContext = email._traceContext?.attempt.status === 'running';
    const context = reusedReadContext ? email._traceContext : recorder?.beginEmail(email, mode);
    context?.update({ match_retry: null });
    let currentSpan;
    try {
      if (context?.queue_span) {
        context.finishSpan(context.queue_span, { observation: '轮到此邮件，开始检查当前日历和待办。',
          output_snapshot: { order: 'received_at_ascending' },
          tool_calls: [{ name: 'mail.chronological_queue', arguments: { order: 'received_at_ascending' }, result_summary: '已出队' }] });
        delete context.queue_span;
      }
      if (context && !reusedReadContext) {
        const timings = email._traceTimings;
        currentSpan = context.startSpan('receive_email', mode === 'demo' ? '读取预置示例' : '收取邮件', {
          ...(timings ? { started_at: timings.fetchStart } : {}),
          thought: mode === 'demo' ? '加载本地预置示例，未连接邮箱。' : '取得待处理邮件，邮件 ID 尚未成功处理。',
          input_snapshot: { source: mode === 'demo' ? 'preset_fixture' : timings ? 'imap' : 'provided_email' },
          tool_calls: [{ name: mode === 'demo' ? 'fixtures.load' : timings ? 'imap.fetch' : 'mail.received',
            arguments: { mode }, result_summary: { subject: email.subject, body_length: email.body?.length || 0 } }] });
        context.finishSpan(currentSpan, { ...(timings ? { ended_at: timings.fetchEnd } : {}), observation: '邮件已取得，进入字段解析。' });
        currentSpan = context.startSpan('parse', '解析邮件', { ...(timings ? { started_at: timings.parseStart } : {}),
          thought: mode === 'demo' ? '读取示例已有的主题、发件人、时间和正文。' : '读取邮件结构中的主题、发件人、时间和正文。',
          input_snapshot: { body_length: email.body?.length || 0 },
          tool_calls: [{ name: timings ? 'mailparser.simpleParser' : 'mail.read_fields', arguments: { mode }, result_summary: emailSnapshot(email) }] });
        context.finishSpan(currentSpan, { ...(timings ? { ended_at: timings.parseEnd } : {}),
          observation: '可用于提取的邮件字段已就绪。', output_snapshot: emailSnapshot(email) });
      }
      if (handleSpecialEmail) {
        const special = await handleSpecialEmail(email, context);
        if (special) {
          const index = store.emails.findIndex((item) => item.id === email.id);
          const record = { ...special, trace_id: context?.trace.trace_id || special.trace_id };
          if (index < 0) store.emails.unshift(record); else store.emails[index] = record;
          if (record.recruitmentStatus === 'partial') errors.push({ subject: email.subject, message: '部分简历附件提取失败，可在邮件详情或人才库重试。' });
          else processed.add(email.id);
          context?.finish(record.recruitmentStatus === 'partial' ? 'failed' : 'imported', { decision: record.summary,
            calendar_summary: '招聘处理未自动修改日历或待办。' });
          await onProcessed(record, store);
          continue;
        }
      }
      currentSpan = context?.startSpan('check_calendar', '检查日历与待办', {
        thought: mode === 'demo' ? '选择有效示例日程和已有示例待办，待办包括已完成项用于去重。'
          : '选择当前有效真实/手动日程和已有真实待办，用于日程变更及任务去重，待办包含已完成项。',
        input_snapshot: { stored_event_count: store.events.length, stored_task_count: store.tasks?.length || 0, mode } });
      const candidates = activeEventsForMode(store.events, mode);
      const taskCandidates = tasksForMode(store.tasks || [], mode);
      const candidateSnapshot = candidates.map(({ id, title, start, end, location, source }) => ({ id, title, start, end, location, source }));
      const taskSnapshot = taskContextSnapshot(taskCandidates.map(({ id, title, dueAt, status, priority, sources }) => ({ id, title, dueAt, status, priority, sources })));
      if (context) context.finishSpan(currentSpan, {
        observation: `找到 ${candidates.length} 项有效日程、${taskCandidates.length} 项已有待办。`,
        output_snapshot: { count: candidates.length, candidates: candidateSnapshot, task_count: taskCandidates.length, tasks: taskSnapshot },
        tool_calls: [{ name: 'calendar.active_events', arguments: { mode, exclude_cancelled: true },
          result_summary: { count: candidates.length, candidates: candidateSnapshot } },
        { name: 'tasks.existing', arguments: { mode, include_done: true }, result_summary: { count: taskCandidates.length, tasks: taskSnapshot } }] });
      currentSpan = context?.startSpan('extract', mode === 'demo' ? '读取预置提取结果' : '模型提取', {
        thought: mode === 'demo' ? '使用预置邮件标签、摘要、日程和待办，本步骤没有调用真实模型。'
          : '将邮件、当前日程和已有待办交给模型，一次返回邮件标签、摘要及需处理事项。',
        input_snapshot: { email: emailSnapshot(email), candidate_count: candidates.length, task_candidate_count: taskCandidates.length },
        ...(mode === 'demo' ? { llm_request: false, llm_tokens_in: 0, llm_tokens_out: 0, llm_tokens_cached_in: 0,
          cost_cny: 0, cost_status: 'preset' } : { llm_request: true, cost_status: 'usage_missing' }) });
      if (context) context.extract_span = currentSpan;
      const extraction = await extractor(email, candidates, context, taskCandidates);
      if (context) {
        const extractionSnapshot = Array.isArray(extraction) ? { summary: '', events: extraction } : extraction;
        context.finishSpan(currentSpan, { observation: `已取得 ${extractionSnapshot.events?.length || 0} 项日程操作、${extractionSnapshot.tasks?.length || 0} 项待办，下一步验证后保存。`,
          ...(!currentSpan.output_snapshot ? { output_snapshot: extractionSnapshot } : {}),
          ...(mode === 'demo' ? { tool_calls: [{ name: 'fixtures.preset_extraction', arguments: { mode: 'demo' }, result_summary: extractionSnapshot }] } : {}) });
        delete context.extract_span;
      }
      await beforeImport(store);
      currentSpan = context?.startSpan('create_task', '检测冲突并保存日程与待办', {
        thought: '验证整封邮件并保存日程与待办；按更新后的日历标记时间冲突，并提供空闲候选供回复确认。', input_snapshot: extraction,
        tool_calls: [{ name: 'calendar.apply_actions', arguments: { mode,
          operation_count: (Array.isArray(extraction) ? extraction : extraction.events)?.length,
          task_count: extraction.tasks?.length || 0 }, result_summary: null }] });
      const record = importEmail(store, email, extraction, mode);
      if (context) {
        record.trace_id = context.trace.trace_id;
        const changes = { summary: record.summary, event_ids: record.eventIds, created: record.createdEventIds.length,
          cancelled: record.cancelledEventIds.length, rescheduled: record.rescheduledEventIds.length,
          task_ids: record.taskIds, tasks_created: record.createdTaskIds.length, tasks_merged: record.mergedTaskIds.length,
          category: record.category, priority: record.priority, conflicts: record.conflicts, extraction: record.extraction };
        context.finishSpan(currentSpan, { observation: record.summary, output_snapshot: changes,
          tool_calls: [{ name: 'calendar.check_conflicts', arguments: { mode, exclude_cancelled: true, exclude_all_day: true, adjacent_is_conflict: false },
            result_summary: { conflict_count: record.conflicts.length, conflicts: record.conflicts } },
          { name: 'calendar.apply_actions', arguments: { mode, operation_count: record.extraction.actions.length,
            task_count: record.extraction.tasks?.length || 0 }, result_summary: changes }] });
      }
      if (record.category !== 'resume') {
      currentSpan = context?.startSpan('draft_reply', '生成回复草稿', { thought: '依据已验证的处理快照套用本地回复模板，供用户检查；不调用模型、不发送邮件。',
        input_snapshot: { subject: email.subject, actions: record.extraction.actions, tasks: record.extraction.tasks || [] },
        tool_calls: [{ name: 'reply.local_template', arguments: { template: record.conflicts.length ? 'calendar-conflict-v2' : 'calendar-tasks-confirmation-v2', sent: false }, result_summary: null }] });
      record.draftReply = buildReplyDraft(record);
      record.draftSource = 'local_template';
      if (context) {
        const draft = { source: 'local_template', body: record.draftReply, sent: false };
        context.finishSpan(currentSpan, { observation: '回复草稿已生成，等待用户采纳、修改或拒绝，尚未发送。', output_snapshot: draft,
          tool_calls: [{ name: 'reply.local_template', arguments: { template: record.conflicts.length ? 'calendar-conflict-v2' : 'calendar-tasks-confirmation-v2', sent: false }, result_summary: draft }] });
        context.finish(record.status, { decision: decisionFor(record), draft_reply: record.draftReply, draft_source: 'local_template',
          extraction_snapshot: record.extraction, calendar_summary: record.summary });
      }
      } else context?.finish('imported', { decision: record.summary });
      processed.add(email.id);
      added += record.createdEventIds.length;
      cancelled += record.cancelledEventIds.length;
      rescheduled += record.rescheduledEventIds.length;
      tasksAdded += record.createdTaskIds.length;
      tasksMerged += record.mergedTaskIds.length;
      conflicts += record.conflicts.length;
      if (record.status === 'skipped') skipped++;
      await onProcessed(record, store);
    } catch (error) {
      if (context) {
        if (currentSpan?.status === 'running') context.finishSpan(currentSpan, { status: 'failed', error: error.message, observation: error.message });
        const awaitingMatch = mode === 'qq' && matchingErrors.has(error.message);
        context.finish('failed', { decision: awaitingMatch ? '待匹配原日程；日历变化或手动同步时重试' : '处理失败，可再次同步重试', error: error.message,
          match_retry: awaitingMatch ? { context_key: contextKey, message: error.message } : null });
        delete context.extract_span;
      }
      errors.push({ subject: email.subject, message: context ? context.sanitize(error.message) : error.message });
    }
  }
  store.lastSync = new Date().toISOString();
  return { added, cancelled, rescheduled, tasksAdded, tasksMerged, conflicts, skipped, filtered, duplicate, deferred, errors, total: emails.length, mode };
}
