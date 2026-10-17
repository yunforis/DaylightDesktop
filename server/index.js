import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mountDesktopHttp } from './desktop-http.js';
import {
  readStore, saveStore, readSettings, saveSettings, publicSettings, normalizeMailbox,
  normalizeMailboxTag, mailboxTagLabel, mailboxProviders,
} from './store.js';
import { exampleEmails, exampleChanges, exampleTasks, exampleConflicts } from './fixtures.js';
import {
  readMailboxEmails, sendMailboxReply, extractEvents, importEmail, processEmails, EXTRACTION_VERSION,
  testMailboxConnection, testModelConnection,
} from './agent.js';
import { createTraceRecorder, readTraces, saveTraces, summarizeTraces, sanitizeReplyDraft, emailReference } from './traces.js';
import { readPrompts, savePrompts, resetPrompts } from './prompts.js';
import { dbStatus, listPromptRevisions } from './db.js';
import { exportBackup, restoreBackup } from './backup.js';
import { refreshIdleWatcher, idleStatus } from './idle-sync.js';
import { bootInfra, infraHealth, publicInfraConfig, readInfraConfig, reloadInfra } from './infra/index.js';
import { mergeInfraSecrets } from './infra/config.js';
import { enqueue, listJobs, registerWorker, testQueueConnection } from './infra/queue.js';
import { getAttachmentObject, resolveLocalAttachment, testOssConnection } from './infra/oss.js';
import {
  adminCreateUser, adminDeleteUser, adminForceLogoutUser, adminGetUser,
  adminListUsers, adminRevokeUserSession, adminUpdateUser,
  createCaptcha, currentUserFromAuthHeader, loginUser, registerUser,
  requestPasswordReset, requireAdminFromHeader, resetPassword,
  sendRegisterEmailCode,
} from './auth.js';
import { findUserByEmail, findUserById, listUsers } from './infra/postgres.js';
import { sendTemplatedMail, systemMailReady } from './mailer.js';
import {
  TEMPLATE_META, readMailTemplates, resetMailTemplates, saveMailTemplates,
} from './mail-templates.js';
import { runAssistantChat } from './assistant.js';
import { normalizeCalendarCategories } from './calendar-categories.js';
import { normalizeMailFilters } from './mail-filters.js';
import { runWithRequestContext } from './request-context.js';
import { getRecruitmentState, runRecruitmentChat, updateInterview, prepareInterviewMeeting, sendInterview, importRecruitmentDemo, isRecruitmentBusy } from './recruitment.js';
import { readRecruitment, updateRecruitment, getAttachment, attachmentPath } from './recruitment-store.js';
import { processRecruitmentEmail, extractResumeAttachment, resumeRecord } from './resumes.js';
import {
  publicCalendarSync, saveCalendarOAuthApps, upsertCalendarConnection, removeCalendarConnection,
  buildOAuthStartUrl, completeOAuthCallback, storeToIcs, queueExternalSync, syncEventExternal,
} from './external-calendar.js';
import {
  listMaterials, addMaterial, updateMaterial, removeMaterial, readMaterialFile,
  generateEventReport, deleteReport, MATERIAL_KINDS,
} from './event-aftermath.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
mountDesktopHttp(app);
app.use(express.json({ limit: '12mb' }));

await bootInfra();

const AUTH_PUBLIC = new Set([
  '/auth/captcha', '/auth/login', '/auth/register', '/auth/register/send-code',
  '/auth/forgot-password', '/auth/reset-password',
  '/auth/config', '/infra/public',
  '/calendar-sync/oauth/callback',
  '/calendar.ics', // Mac/iOS 日历订阅无需登录态
]);

app.use('/api', (req, res, next) => {
  (async () => {
    let user = null;
    try {
      user = await currentUserFromAuthHeader(req.get('Authorization'));
    } catch {
      user = null;
    }
    const requireAuth = readInfraConfig().auth.requireAuth;
    if (requireAuth && !AUTH_PUBLIC.has(req.path) && !req.path.startsWith('/attachments/')) {
      if (!user) return res.status(401).json({ error: '请先登录' });
    }
    req.user = user || undefined;
    runWithRequestContext({ userId: user?.id || null, user }, () => {
      const mailboxId = req.get('X-Mailbox-Id');
      if (mailboxId && !['/state', '/settings'].includes(req.path) && !req.path.startsWith('/mailboxes/') &&
          mailboxId !== readSettings().activeMailboxId) {
        return res.status(409).json({ error: '当前邮箱已切换，请刷新后再操作。' });
      }
      next();
    });
  })().catch(next);
});
const api = (handler) => async (req, res, next) => {
  try { await handler(req, res); } catch (error) { next(error); }
};
const sendingReplies = new Set();

function saveTraceFields(mailboxId, traceId, fields) {
  const traces = readTraces(mailboxId);
  const trace = traces.find((item) => item.trace_id === traceId);
  Object.assign(trace, fields);
  // Sync can keep writing its in-memory traces while an SMTP request is awaiting.
  const live = activeRecorder?.mailboxId === mailboxId && activeRecorder.traces.find((item) => item.trace_id === traceId);
  if (live) Object.assign(live, fields);
  saveTraces(traces, mailboxId);
  return trace;
}

function decorateTasks(tasks, mailboxId) {
  return (tasks || []).map((task) => ({
    ...task,
    mailboxId,
    sources: (task.sources || []).map((source) => ({
      ...source,
      emailUrl: `/?mailbox=${encodeURIComponent(mailboxId)}&email=${encodeURIComponent(source.emailId)}`,
    })),
  }));
}

app.get('/api/state', (req, res) => {
  const settings = readSettings();
  const scope = String(req.query.scope || 'active');
  const tag = String(req.query.tag || '').trim();

  if (scope === 'all' || tag) {
    const mailboxes = (settings.mailboxes || []).filter((mailbox) => {
      if (!tag) return true;
      return mailbox.tag === tag || mailboxTagLabel(mailbox) === tag;
    });
    const events = [];
    const emails = [];
    const tasks = [];
    for (const mailbox of mailboxes) {
      const store = readStore(mailbox.id);
      for (const event of store.events || []) events.push({ ...event, mailboxId: mailbox.id, mailboxEmail: mailbox.email, mailboxTag: mailboxTagLabel(mailbox) });
      for (const email of store.emails || []) emails.push({ ...email, mailboxId: mailbox.id, mailboxEmail: mailbox.email, mailboxTag: mailboxTagLabel(mailbox) });
      tasks.push(...decorateTasks(store.tasks, mailbox.id).map((task) => ({
        ...task,
        mailboxEmail: mailbox.email,
        mailboxTag: mailboxTagLabel(mailbox),
      })));
    }
    return res.json({
      events,
      emails,
      tasks,
      lastSync: null,
      mailboxId: 'all',
      viewScope: tag ? `tag:${tag}` : 'all',
      settings: {
        ...publicSettings(settings),
        viewLabel: tag ? `${tag}（混合）` : '全部邮箱（混合）',
      },
    });
  }

  const mailboxId = settings.activeMailboxId;
  const store = readStore(mailboxId);
  const tasks = decorateTasks(store.tasks, mailboxId);
  res.json({ ...store, tasks, mailboxId, viewScope: 'active', settings: publicSettings(settings) });
});
app.get('/api/traces', (req, res) => {
  const settings = readSettings();
  const scope = String(req.query.scope || 'active');
  if (scope === 'all') {
    const traces = [];
    for (const mailbox of settings.mailboxes || []) {
      for (const trace of readTraces(mailbox.id)) {
        traces.push({ ...trace, mailboxId: mailbox.id, mailboxEmail: mailbox.email });
      }
    }
    traces.sort((a, b) => String(b.created_at || b.started_at || '').localeCompare(String(a.created_at || a.started_at || '')));
    return res.json({
      traces: traces.slice(0, 200),
      mailboxId: 'all',
      summary: summarizeTraces(traces),
      sync: syncState,
    });
  }
  const mailboxId = settings.activeMailboxId;
  const traces = readTraces();
  res.json({ traces, mailboxId, summary: summarizeTraces(traces), sync: syncState.mailboxId && syncState.mailboxId !== mailboxId
    ? { running: false, status: 'idle', stage: '', processed: 0, total: 0 } : syncState });
});
app.put('/api/traces/:id/feedback', (req, res) => {
  const { action, draft } = req.body;
  if (!['accepted', 'modified', 'rejected'].includes(action)) {
    return res.status(400).json({ error: '请选择采纳、修改或拒绝。' });
  }
  const traces = readTraces();
  const trace = traces.find((item) => item.trace_id === req.params.id);
  if (!trace) return res.status(404).json({ error: '处理日志不存在。' });
  if (sendingReplies.has(trace.trace_id) || trace.reply_delivery?.status === 'sent') {
    return res.status(409).json({ error: '回复正在发送或已经发送，不能再修改草稿。' });
  }
  const storedSettings = readSettings();
  const secrets = [storedSettings.email, storedSettings.authorizationCode, storedSettings.apiKey].filter(Boolean);
  if (action === 'modified') {
    const store = readStore();
    const email = store.emails.find((item) => item.trace_id === trace.trace_id);
    // The editable mail draft keeps its text; trace evidence remains redacted.
    if (email) {
      email.userDraft = String(draft || '');
      saveStore(store);
    }
  }
  res.json(saveTraceFields(storedSettings.activeMailboxId, trace.trace_id, { user_action: action, user_action_at: new Date().toISOString(),
    ...(action === 'modified' ? { user_draft: sanitizeReplyDraft(String(draft || ''), secrets) } : {}) }));
});
app.post('/api/traces/:id/send', api(async (req, res) => {
  const settings = readSettings();
  const mailboxId = settings.activeMailboxId;
  const trace = readTraces(mailboxId).find((item) => item.trace_id === req.params.id);
  if (!trace) return res.status(404).json({ error: '处理日志不存在。' });
  if (trace.reply_delivery?.status === 'sent') return res.json(trace);
  if (sendingReplies.has(trace.trace_id)) return res.status(409).json({ error: '这封回复正在发送，请稍候。' });
  const email = readStore(mailboxId).emails.find((item) => item.trace_id === trace.trace_id);
  if (trace.mode !== 'qq' || email?.mode !== 'qq') {
    return res.status(400).json({ error: '示例草稿只供演示，不发送邮件。' });
  }
  if (!publicSettings(settings).mailboxReady) return res.status(400).json({ error: '请先在设置中填写邮箱、授权码和收发服务器。' });
  const draft = email.userDraft ?? trace.user_draft ?? email.draftReply ?? trace.draft_reply;
  if (!draft?.trim()) return res.status(400).json({ error: '回复草稿为空，请先填写并保存草稿。' });
  const attempted_at = new Date().toISOString();
  sendingReplies.add(trace.trace_id);
  try {
    const info = await sendMailboxReply(settings, email, draft);
    const sent_at = new Date().toISOString();
    res.json(saveTraceFields(mailboxId, trace.trace_id, { user_action: 'accepted', user_action_at: sent_at,
      reply_delivery: { status: 'sent', sent_at, message_id: info.messageId } }));
  } catch (error) {
    const safeError = sanitizeReplyDraft(error.message, [settings.email, settings.authorizationCode, settings.apiKey].filter(Boolean));
    saveTraceFields(mailboxId, trace.trace_id, { reply_delivery: { status: 'failed', attempted_at, error: safeError } });
    res.status(502).json({ error: `回复发送失败：${safeError}` });
  } finally {
    sendingReplies.delete(trace.trace_id);
  }
}));
app.post('/api/events', (req, res) => {
  const store = readStore();
  const event = { ...req.body, id: randomUUID(), source: 'manual', status: 'active' };
  store.events.push(event);
  saveStore(store);
  queueExternalSync(store, event, 'create', { save: () => saveStore(store) });
  res.json(event);
});
app.put('/api/events/:id', (req, res) => {
  const store = readStore();
  const index = store.events.findIndex((event) => event.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: '日程不存在。' });
  store.events[index] = { ...store.events[index], ...req.body, id: req.params.id };
  saveStore(store);
  queueExternalSync(store, store.events[index], 'update', { save: () => saveStore(store) });
  res.json(store.events[index]);
});
app.delete('/api/events/:id', (req, res) => {
  const store = readStore();
  const event = store.events.find((item) => item.id === req.params.id);
  store.events = store.events.filter((item) => item.id !== req.params.id);
  saveStore(store);
  if (event) queueExternalSync(store, event, 'delete');
  res.json({ ok: true });
});
app.get('/api/events/:id/materials', (req, res) => {
  try { res.json(listMaterials(req.params.id)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.post('/api/events/:id/materials', api(async (req, res) => {
  try {
    const material = await addMaterial(req.params.id, req.body || {}, {
      userId: req.user?.id,
      username: req.user?.username,
      mailboxId: readSettings().activeMailboxId,
    });
    res.status(201).json(material);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.put('/api/events/:id/materials/:materialId', (req, res) => {
  try { res.json(updateMaterial(req.params.id, req.params.materialId, req.body || {})); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.delete('/api/events/:id/materials/:materialId', (req, res) => {
  try { res.json(removeMaterial(req.params.id, req.params.materialId)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.get('/api/events/:id/materials/:materialId/file', api(async (req, res) => {
  try {
    const file = await readMaterialFile(req.params.id, req.params.materialId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.send(file.buffer);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/events/:id/reports/generate', api(async (req, res) => {
  try {
    const report = await generateEventReport(req.params.id, req.body || {});
    res.status(201).json(report);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.delete('/api/events/:id/reports/:reportId', (req, res) => {
  try { res.json(deleteReport(req.params.id, req.params.reportId)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.get('/api/material-kinds', (_req, res) => {
  res.json({ kinds: MATERIAL_KINDS });
});
app.put('/api/tasks/:id', (req, res) => {
  const { status, assignee } = req.body;
  const store = readStore();
  const task = store.tasks.find((item) => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: '待办不存在。' });
  if (status !== undefined) {
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: '请选择待办或已完成。' });
    task.status = status;
    task.completedAt = status === 'done' ? new Date().toISOString() : null;
  }
  if (assignee !== undefined) task.assignee = String(assignee || '').trim();
  saveStore(store);
  res.json(task);
});
app.put('/api/settings', (req, res) => {
  if (syncing || sendingReplies.size || isRecruitmentBusy() || retryingAttachments.size) return res.status(409).json({ error: '请等当前邮件同步或回复发送结束后再保存设置。' });
  const existing = readSettings();
  const email = String(req.body.email ?? existing.email).trim();
  const requestedMailbox = existing.mailboxes.find((mailbox) => mailbox.id === req.body.mailboxId);
  if (!email && (requestedMailbox?.email || existing.email)) {
    return res.status(400).json({ error: '已配置的邮箱地址不能为空。填写其他地址会创建或切换到独立邮箱。' });
  }
  let mailbox = existing.mailboxes.find((item) => email && item.email.toLowerCase() === email.toLowerCase());
  // Filling the original empty profile keeps existing local/demo data. Changing an address is a different account.
  if (!mailbox && !existing.email && (!('mailboxId' in req.body) || requestedMailbox?.id === existing.activeMailboxId)) mailbox = requestedMailbox || existing.mailboxes[0];
  if (!mailbox && !email && requestedMailbox) mailbox = requestedMailbox;
  const provider = req.body.provider || mailbox?.provider || 'qq';
  if (!mailboxProviders.some((item) => item.id === provider)) return res.status(400).json({ error: '请选择支持的邮箱服务商，或使用自定义服务器。' });
  const sameAddress = mailbox?.email.toLowerCase() === email.toLowerCase();
  const tagged = normalizeMailboxTag(
    req.body.tag ?? mailbox?.tag,
    req.body.tagCustom ?? mailbox?.tagCustom,
  );
  const current = normalizeMailbox({ ...(mailbox?.provider === provider ? mailbox : {}),
    id: mailbox?.id || randomUUID(), provider, email,
    fetchLimit: Math.max(1, Math.min(200, Number(req.body.fetchLimit ?? mailbox?.fetchLimit) || 15)),
    fetchMode: req.body.fetchMode === 'range' ? 'range' : 'recent',
    fetchRange: ['today', 'yesterday', 'week', 'month', 'year', 'custom'].includes(req.body.fetchRange)
      ? req.body.fetchRange : (mailbox?.fetchRange || 'week'),
    fetchSince: String(req.body.fetchSince ?? mailbox?.fetchSince ?? ''),
    fetchUntil: String(req.body.fetchUntil ?? mailbox?.fetchUntil ?? ''),
    syncStrategy: req.body.syncStrategy === 'idle' || req.body.syncStrategy === 'poll'
      ? req.body.syncStrategy
      : (mailbox?.syncStrategy === 'idle' ? 'idle' : 'poll'),
    pollIntervalSec: Math.max(30, Math.min(3600, Number(req.body.pollIntervalSec ?? mailbox?.pollIntervalSec) || 60)),
    ...tagged,
    authorizationCode: req.body.authorizationCode || (sameAddress ? mailbox.authorizationCode : '') });
  for (const field of ['imapHost', 'smtpHost']) current[field] = String(req.body[field] ?? current[field]).trim();
  for (const field of ['imapPort', 'smtpPort']) {
    current[field] = Number(req.body[field] ?? current[field]);
    if (!Number.isInteger(current[field]) || current[field] < 1 || current[field] > 65535) {
      return res.status(400).json({ error: '邮箱服务器端口请填写 1–65535 的整数。' });
    }
  }
  for (const field of ['imapSecure', 'smtpSecure']) current[field] = req.body[field] === undefined ? current[field] : Boolean(req.body[field]);
  const settings = { ...existing, activeMailboxId: current.id,
    mailboxes: mailbox ? existing.mailboxes.map((item) => item.id === current.id ? current : item) : [...existing.mailboxes, current],
    baseUrl: String(req.body.baseUrl ?? existing.baseUrl).trim(), model: String(req.body.model ?? existing.model).trim(),
    apiKey: req.body.apiKey || existing.apiKey };
  for (const field of ['tokenPriceIn', 'tokenPriceOut', 'tokenPriceCachedIn']) {
    const value = req.body[field] === undefined ? existing[field] : req.body[field];
    settings[field] = value === null || value === '' || value === undefined ? null : Number(value);
    if (settings[field] !== null && (!Number.isFinite(settings[field]) || settings[field] < 0)) {
      return res.status(400).json({ error: 'Token 单价请填写大于等于 0 的人民币金额，或留空。' });
    }
  }
  if (req.body.feishu) settings.feishu = { appId: String(req.body.feishu.appId ?? existing.feishu?.appId ?? '').trim(),
    ownerId: String(req.body.feishu.ownerId ?? existing.feishu?.ownerId ?? '').trim(),
    appSecret: req.body.feishu.appSecret || existing.feishu?.appSecret || '' };
  saveSettings(settings);
  const saved = readSettings();
  refreshIdleWatcher(runSync);
  const syncStarted = current.id !== existing.activeMailboxId && startMailboxSync(saved);
  res.json({ ...publicSettings(saved), syncStarted: Boolean(syncStarted) });
});
app.post('/api/mailboxes/:id/activate', (req, res) => {
  if (syncing || sendingReplies.size || isRecruitmentBusy() || retryingAttachments.size) return res.status(409).json({ error: '请等当前邮件同步或回复发送结束后再切换邮箱。' });
  const settings = readSettings();
  if (!settings.mailboxes.some((mailbox) => mailbox.id === req.params.id)) return res.status(404).json({ error: '邮箱配置不存在。' });
  const changed = settings.activeMailboxId !== req.params.id;
  if (changed) saveSettings({ ...settings, activeMailboxId: req.params.id });
  const saved = readSettings();
  refreshIdleWatcher(runSync);
  const syncStarted = changed && startMailboxSync(saved);
  res.json({ ...publicSettings(saved), syncStarted: Boolean(syncStarted) });
});

app.get('/api/prompts', (req, res) => {
  res.json(readPrompts());
});
app.put('/api/prompts', (req, res) => {
  const extractionSystem = String(req.body.extractionSystem || '').trim();
  if (extractionSystem.length < 40) {
    return res.status(400).json({ error: '提取提示词过短，请保留必要的分类与日程规则。' });
  }
  res.json(savePrompts({ extractionSystem }));
});
app.post('/api/prompts/reset', (req, res) => {
  res.json(resetPrompts());
});
app.get('/api/prompts/revisions', api(async (req, res) => {
  res.json({ revisions: await listPromptRevisions(30) });
}));
app.get('/api/persistence', api(async (req, res) => {
  const health = await infraHealth();
  const db = await dbStatus();
  const settings = publicSettings(readSettings());
  res.json({
    ...db,
    idle: idleStatus(),
    infra: health.status,
    storageNote: settings.calendarStorage?.note
      || '默认本地 JSON；可选 PostgreSQL / Redis / 消息队列 / 对象存储，在管理端配置。',
    calendarStorage: settings.calendarStorage,
    modelScope: settings.modelScope,
  });
}));

app.get('/api/calendar-sync', (req, res) => {
  res.json(publicCalendarSync());
});
app.put('/api/calendar-sync/oauth-apps', (req, res) => {
  saveCalendarOAuthApps(req.body || {});
  res.json(publicCalendarSync());
});
app.post('/api/calendar-sync/connections', (req, res) => {
  res.json(upsertCalendarConnection(req.body || {}));
});
app.delete('/api/calendar-sync/connections/:id', (req, res) => {
  res.json(removeCalendarConnection(req.params.id));
});
app.get('/api/calendar-sync/oauth/start/:provider', (req, res) => {
  try {
    const { url } = buildOAuthStartUrl(req.params.provider, req);
    res.json({ url });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});
app.get('/api/calendar-sync/oauth/callback', api(async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(`/app/settings?calendarSync=error&message=${encodeURIComponent(req.query.error)}`);
    }
    await completeOAuthCallback({ code: req.query.code, state: req.query.state, req });
    res.redirect('/app/settings?tab=calendar&calendarSync=ok');
  } catch (error) {
    res.redirect(`/app/settings?tab=calendar&calendarSync=error&message=${encodeURIComponent(error.message)}`);
  }
}));
app.post('/api/calendar-sync/test/:id', api(async (req, res) => {
  const sync = publicCalendarSync();
  const connection = (readSettings().calendarSync?.connections || []).find((item) => item.id === req.params.id);
  if (!connection) return res.status(404).json({ error: '未找到日历连接' });
  const probe = {
    id: `probe-${Date.now()}`,
    title: 'Daylight 连通性测试',
    start: new Date(Date.now() + 3600_000).toISOString(),
    end: new Date(Date.now() + 7200_000).toISOString(),
    allDay: false,
    description: '可删除的测试事件',
    status: 'active',
  };
  const { results } = await syncEventExternal(probe, 'create');
  const hit = results.find((item) => item.connectionId === connection.id) || results[0];
  if (hit?.ok && hit.remoteId) {
    await syncEventExternal({ ...probe, externalIds: { [connection.id]: hit.remoteId } }, 'delete').catch(() => {});
  }
  if (!hit?.ok) return res.status(502).json({ error: hit?.error || '外部日历写入失败', results });
  res.json({ ok: true, message: '已成功写入并删除测试事件', results });
}));
app.get('/api/calendar.ics', (req, res) => {
  const store = readStore(req.query.mailboxId || undefined);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daylight.ics"');
  res.send(storeToIcs(store));
});
app.post('/api/calendar-sync/export', api(async (req, res) => {
  const store = readStore();
  const active = (store.events || []).filter((event) => event.status !== 'cancelled');
  if (!active.length) return res.status(400).json({ error: '当前没有可导出的有效日程。' });
  const connections = (readSettings().calendarSync?.connections || []).filter((item) => item.enabled !== false);
  if (!connections.length) {
    return res.status(400).json({
      error: '尚未连接外部日历。请先到设置 → 外部日历完成 Google / Outlook / CalDAV 连接，或先下载 ICS。',
      icsPath: '/api/calendar.ics',
    });
  }
  let ok = 0;
  let failed = 0;
  const details = [];
  for (const event of active) {
    const { event: next, results } = await syncEventExternal(event, event.externalIds ? 'update' : 'create');
    const hit = results.filter((item) => item.ok);
    const miss = results.filter((item) => !item.ok);
    if (hit.length) {
      ok += 1;
      const index = store.events.findIndex((item) => item.id === next.id);
      if (index >= 0) {
        store.events[index].externalIds = next.externalIds;
        store.events[index].externalSync = { at: new Date().toISOString(), results };
      }
    }
    if (miss.length) failed += 1;
    details.push({ eventId: event.id, title: event.title, results });
  }
  saveStore(store);
  res.json({
    ok: true,
    exported: ok,
    failed,
    total: active.length,
    connections: connections.length,
    message: failed
      ? `已推送 ${ok}/${active.length} 项；${failed} 项有连接失败，可在设置里查看 lastError。`
      : `已将 ${ok} 项日程推送到 ${connections.length} 个外部日历。`,
    details: details.slice(0, 20),
  });
}));
app.get('/api/backup', (req, res) => {
  const backup = exportBackup();
  res.setHeader('Content-Disposition', `attachment; filename="daylight-backup-${backup.exportedAt.slice(0, 10)}.json"`);
  res.json(backup);
});
app.post('/api/backup/restore', (req, res) => {
  if (syncing || sendingReplies.size) return res.status(409).json({ error: '请等当前同步或发信结束后再恢复备份。' });
  const result = restoreBackup(req.body);
  refreshIdleWatcher(runSync);
  res.json({ ...result, settings: publicSettings(readSettings()) });
});

app.post('/api/test/mailbox', api(async (req, res) => {
  const existing = readSettings();
  const email = String(req.body.email ?? existing.email).trim();
  const mailbox = existing.mailboxes.find((item) => item.email && email && item.email.toLowerCase() === email.toLowerCase())
    || existing.mailboxes.find((item) => item.id === (req.body.mailboxId || existing.activeMailboxId))
    || normalizeMailbox({});
  const merged = normalizeMailbox({
    ...mailbox,
    ...req.body,
    email,
    authorizationCode: req.body.authorizationCode || mailbox.authorizationCode || existing.authorizationCode,
  });
  const result = await testMailboxConnection({ ...existing, ...merged });
  res.json(result);
}));

app.post('/api/test/model', api(async (req, res) => {
  const existing = readSettings();
  const result = await testModelConnection({
    baseUrl: String(req.body.baseUrl ?? existing.baseUrl).trim(),
    apiKey: req.body.apiKey || existing.apiKey,
    model: String(req.body.model ?? existing.model).trim(),
  });
  res.json(result);
}));

app.delete('/api/demo', (req, res) => {
  if (syncing || isRecruitmentBusy()) return res.status(409).json({ error: '请等当前处理结束后再清除示例。' });
  const store = readStore();
  store.events = store.events.filter((event) => event.source !== 'demo');
  store.emails = store.emails.filter((email) => email.mode !== 'demo');
  store.tasks = store.tasks.filter((task) => task.source !== 'demo');
  saveStore(store);
  saveTraces(readTraces().filter((trace) => trace.mode !== 'demo'));
  updateRecruitment(readSettings().activeMailboxId, (data) => {
    for (const key of ['candidates', 'interviews', 'attachments', 'messages']) data[key] = data[key].filter((item) => item.source !== 'demo');
    data.traces = data.traces.filter((trace) => trace.mode !== 'demo');
  });
  res.json({ ok: true });
});

let syncing = false;
let syncState = { running: false, status: 'idle', stage: '', processed: 0, total: 0 };
let activeRecorder = null;
app.post('/api/sync/:mode', api(async (req, res) => {
  const requestedMode = ['mail', 'mailbox'].includes(req.params.mode) ? 'qq' : req.params.mode;
  const mode = ['demo-changes', 'demo-tasks', 'demo-conflicts'].includes(requestedMode) ? 'demo' : requestedMode;
  if (!['demo', 'qq'].includes(mode)) return res.status(400).json({ error: '未知导入方式。' });
  if (syncing || retryingAttachments.size) return res.status(409).json({ error: '正在处理邮件，请稍候。' });
  const settings = readSettings();
  if (mode === 'qq' && (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady)) {
    return res.status(400).json({ error: '请先在设置中填写邮箱、客户端授权码、收发服务器和模型接口。' });
  }
  res.json(await runSync(requestedMode, settings));
}));

function startMailboxSync(settings) {
  if (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady) return false;
  runSync('qq', settings, 'mailbox-switch').catch(() => {});
  return true;
}

async function withMailboxOwner(settings) {
  const mailboxes = settings.mailboxes || [];
  const active = mailboxes.find((item) => item.id === settings.activeMailboxId) || mailboxes[0] || {};
  let owner = null;
  if (active.ownerUserId) owner = await findUserById(active.ownerUserId);
  if (!owner && active.email) owner = await findUserByEmail(active.email);
  if (!owner) return settings;
  return {
    ...settings,
    ownerUserId: owner.id,
    ownerUsername: owner.username,
    mailboxes: mailboxes.map((mailbox) => (
      mailbox.id === active.id
        ? { ...mailbox, ownerUserId: owner.id, ownerUsername: owner.username }
        : mailbox
    )),
  };
}

async function runSync(requestedMode, settings, trigger = 'manual') {
  const mailboxId = settings.activeMailboxId;
  const demoChanges = requestedMode === 'demo-changes';
  const demoTasks = requestedMode === 'demo-tasks';
  const demoConflicts = requestedMode === 'demo-conflicts';
  const mode = demoChanges || demoTasks || demoConflicts ? 'demo' : requestedMode;
  syncing = true;
  const startedAt = new Date().toISOString();
  syncState = { id: randomUUID(), mailboxId, running: true, status: 'running', mode, trigger, stage: mode === 'qq' ? '连接邮箱' : '读取预置示例',
    started_at: startedAt, processed: 0, total: 0, duplicate: 0 };
  const recorder = createTraceRecorder({ settings, traces: readTraces(mailboxId), persist: (traces) => saveTraces(traces, mailboxId) });
  recorder.mailboxId = mailboxId;
  activeRecorder = recorder;
  try {
    // 归属查询与 IMAP 并行：不阻塞 connect（自动同步 mock tick 需首拍可见 reads）；处理前再合并 owner。
    const ownerPromise = withMailboxOwner(settings);
    const emails = mode === 'qq' ? await readMailboxEmails(settings, {
      recorder, retryMode: trigger, processedIds: new Set(readStore(mailboxId).emails.map((email) => email.id)),
      onProgress: (progress) => { Object.assign(syncState, typeof progress === 'string' ? { stage: progress } : progress); },
    }) :
      demoChanges ? exampleChanges(readStore(mailboxId).events) : demoTasks ? exampleTasks() : demoConflicts ? exampleConflicts() : exampleEmails();
    settings = await ownerPromise;
    // Merge additions and cancellation metadata so manual edits during model calls remain intact.
    const snapshot = readStore(mailboxId);
    let previousEvents = new Map(snapshot.events.map((event) => [event.id, { ...event }]));
    let previousTasks = new Map(snapshot.tasks.map((task) => [task.id, structuredClone(task)]));
    const previousEmailIds = new Set(snapshot.emails.map((email) => email.id));
    const touchedRecruitmentEmails = new Set();
    syncState.total = emails.length;
    syncState.stage = '按邮件时间处理';
    const refreshCalendar = () => {
      // Check against edits made while the model was awaiting its response.
      const current = readStore(mailboxId);
      snapshot.events = current.events;
      snapshot.tasks = current.tasks;
      previousEvents = new Map(current.events.map((event) => [event.id, { ...event }]));
      previousTasks = new Map(current.tasks.map((task) => [task.id, structuredClone(task)]));
    };
    const persistCalendar = () => {
      const current = readStore(mailboxId);
      for (const event of snapshot.events) {
        const previous = previousEvents.get(event.id);
        if (!previous) { current.events.push(event); continue; }
        const existing = current.events.find((item) => item.id === event.id);
        if (existing) {
          for (const [key, value] of Object.entries(event)) {
            if (value !== previous[key]) existing[key] = value;
          }
        }
      }
      for (const task of snapshot.tasks) {
        const previous = previousTasks.get(task.id);
        if (!previous) { current.tasks.push(task); continue; }
        const existing = current.tasks.find((item) => item.id === task.id);
        if (existing) {
          const reopened = Boolean(task.reopenedAt && task.reopenedAt !== previous.reopenedAt)
            || (previous.status === 'done' && task.status === 'pending');
          for (const [key, value] of Object.entries(task)) {
            // 勾选完成仍由清单控制；提醒邮件重开已完成任务时允许写回 status/completedAt。
            if ((key === 'status' || key === 'completedAt') && !reopened) continue;
            if (JSON.stringify(value) !== JSON.stringify(previous[key])) existing[key] = value;
          }
        }
      }
      current.emails.unshift(...snapshot.emails.filter((email) => !previousEmailIds.has(email.id)));
      for (const id of touchedRecruitmentEmails) {
        const incoming = snapshot.emails.find((item) => item.id === id);
        const index = current.emails.findIndex((item) => item.id === id);
        if (incoming && index >= 0) current.emails[index] = incoming;
      }
      current.lastSync = snapshot.lastSync;
      saveStore(current, mailboxId);
      const created = snapshot.events.filter((event) => !previousEvents.has(event.id) && event.status !== 'cancelled');
      const cancelled = snapshot.events.filter((event) => {
        const before = previousEvents.get(event.id);
        return before && before.status !== 'cancelled' && event.status === 'cancelled';
      });
      const updated = snapshot.events.filter((event) => {
        const before = previousEvents.get(event.id);
        return before && before.status !== 'cancelled' && event.status !== 'cancelled'
          && (before.start !== event.start || before.end !== event.end || before.title !== event.title
            || before.location !== event.location || before.description !== event.description);
      });
      queueExternalSync(current, created, 'create', { save: () => saveStore(current, mailboxId) });
      queueExternalSync(current, updated, 'update', { save: () => saveStore(current, mailboxId) });
      queueExternalSync(current, cancelled, 'delete');
      previousEvents = new Map(snapshot.events.map((event) => [event.id, { ...event }]));
      previousTasks = new Map(snapshot.tasks.map((task) => [task.id, structuredClone(task)]));
      for (const email of snapshot.emails) previousEmailIds.add(email.id);
    };
    const result = await processEmails(snapshot, emails,
      mode === 'demo' ? async (email) => ({ summary: email.summary, events: email.events,
        category: email.category, priority: email.priority, tasks: email.tasks || [] }) :
        (email, events, traceContext, tasks) => extractEvents(email, settings, events, traceContext, tasks), mode, {
          recorder, beforeImport: refreshCalendar, retryMode: trigger,
          ...(mode === 'qq' ? { handleSpecialEmail: (email, context) => processRecruitmentEmail(mailboxId, email, settings, context) } : {}),
          modelContext: JSON.stringify({ endpoint: settings.baseUrl, model: settings.model, version: EXTRACTION_VERSION }),
          onProcessed: async (record) => { if (record.recruitmentStatus) touchedRecruitmentEmails.add(record.id); persistCalendar(); syncState.processed++; },
        });
    persistCalendar();
    Object.assign(syncState, { status: result.errors.length ? 'partial' : 'completed', stage: '处理完成', result,
      processed: result.total - result.duplicate - result.deferred, duplicate: result.duplicate, deferred: result.deferred });
    return result;
  } catch (error) {
    syncState.status = 'failed';
    syncState.stage = '同步失败';
    syncState.error = recorder.sanitize(error.message);
    throw new Error(syncState.error);
  } finally {
    syncing = false;
    activeRecorder = null;
    syncState.running = false;
    syncState.ended_at = new Date().toISOString();
    syncState.latency_ms = Date.now() - Date.parse(startedAt);
  }
}

registerWorker('mail.sync', async (payload = {}) => {
  const settings = readSettings();
  return runSync(payload.mode || 'qq', settings, payload.trigger || 'queue');
});

// 以 60s 为节拍。poll：每分钟同步；idle：IMAP IDLE 为主，此处每 5 分钟慢轮询兜底。
// 默认经消息队列投递（RabbitMQ 优先；连不上时 enqueue 回退进程内同步执行）。
let autoSyncTicks = 0;
const retryingAttachments = new Set();
setInterval(async () => {
  if (syncing || retryingAttachments.size) return;
  const settings = readSettings();
  const { mailboxReady, modelReady } = publicSettings(settings);
  if (!mailboxReady || !modelReady) return;
  const mailbox = settings.mailboxes.find((item) => item.id === settings.activeMailboxId) || settings;
  if ((mailbox.syncStrategy || 'poll') === 'idle') {
    autoSyncTicks += 1;
    if (autoSyncTicks % 5 !== 0) return;
  }
  try {
    await enqueue('mail.sync', { mode: 'qq', trigger: 'auto' });
  } catch {
    // runSync keeps the error in syncState; the next tick can retry.
  }
}, 60_000);

refreshIdleWatcher(runSync);

app.get('/api/auth/config', (req, res) => {
  const auth = readInfraConfig().auth;
  res.json({
    requireAuth: Boolean(auth.requireAuth),
    allowLocalDemoLogin: Boolean(auth.allowLocalDemoLogin),
    sessionDays: auth.sessionDays || 14,
    emailCodeRequired: true,
    systemMailReady: systemMailReady(),
  });
});
app.get('/api/auth/captcha', api(async (req, res) => {
  res.json(await createCaptcha());
}));
app.post('/api/auth/register/send-code', api(async (req, res) => {
  try {
    res.json(await sendRegisterEmailCode(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/auth/register', api(async (req, res) => {
  try {
    res.status(201).json(await registerUser(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/auth/login', api(async (req, res) => {
  try {
    res.json(await loginUser({
      ...(req.body || {}),
      userAgent: req.get('user-agent') || '',
      ip: req.ip || req.socket?.remoteAddress || '',
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/auth/forgot-password', api(async (req, res) => {
  try {
    res.json(await requestPasswordReset({ ...(req.body || {}), req }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/auth/reset-password', api(async (req, res) => {
  try {
    res.json(await resetPassword(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.get('/api/auth/me', api(async (req, res) => {
  const user = await currentUserFromAuthHeader(req.get('Authorization'));
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ user });
}));

function collectMailboxStats(settings = readSettings()) {
  return (settings.mailboxes || []).map((mailbox) => {
    const store = readStore(mailbox.id);
    const traces = readTraces(mailbox.id);
    const failed = traces.filter((item) => item.status === 'failed' || item.error).slice(-8);
    return {
      id: mailbox.id,
      email: mailbox.email,
      tag: mailbox.tag,
      tagLabel: mailboxTagLabel(mailbox),
      events: store.events?.length || 0,
      emails: store.emails?.length || 0,
      tasks: store.tasks?.length || 0,
      traces: traces.length,
      lastSync: store.lastSync || null,
      recentFailures: failed.map((item) => ({
        trace_id: item.trace_id,
        subject: item.subject || item.input?.subject || '',
        error: item.error || item.decision || '',
        created_at: item.created_at || item.started_at || null,
      })),
    };
  });
}

app.get('/api/admin/overview', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const settings = readSettings();
  const mailboxes = collectMailboxStats(settings);
  const health = await infraHealth();
  res.json({
    users: (await adminListUsers()).length,
    mailboxes: mailboxes.length,
    events: mailboxes.reduce((sum, item) => sum + item.events, 0),
    emails: mailboxes.reduce((sum, item) => sum + item.emails, 0),
    tasks: mailboxes.reduce((sum, item) => sum + item.tasks, 0),
    traces: mailboxes.reduce((sum, item) => sum + item.traces, 0),
    systemMailReady: systemMailReady(),
    infra: health.config,
    status: health.status,
    sync: syncState,
    idle: idleStatus(),
    jobs: listJobs(20),
    mailboxStats: mailboxes,
  });
}));

app.get('/api/admin/monitor', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const settings = readSettings();
  const health = await infraHealth();
  const mailboxes = collectMailboxStats(settings);
  const recentTraces = [];
  for (const mailbox of settings.mailboxes || []) {
    for (const trace of readTraces(mailbox.id).slice(-30)) {
      recentTraces.push({
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.email,
        trace_id: trace.trace_id,
        subject: trace.subject || trace.input?.subject || '',
        status: trace.status || trace.result || '',
        mode: trace.mode || '',
        created_at: trace.created_at || trace.started_at || null,
        error: trace.error || '',
        latency_ms: trace.latency_ms || null,
      });
    }
  }
  recentTraces.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  res.json({
    generatedAt: new Date().toISOString(),
    sync: syncState,
    idle: idleStatus(),
    jobs: listJobs(40),
    status: health.status,
    config: health.config,
    mailboxStats: mailboxes,
    recentTraces: recentTraces.slice(0, 80),
    dataDirExists: fs.existsSync(path.join(root, 'data')),
  });
}));
app.get('/api/admin/users', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ users: await adminListUsers() });
}));
app.get('/api/admin/users/:id', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const detail = await adminGetUser(req.params.id);
  const settings = readSettings();
  const mailboxes = (settings.mailboxes || [])
    .filter((mailbox) => {
      const email = String(mailbox.email || '').toLowerCase();
      const ownerId = mailbox.ownerUserId || mailbox.userId || '';
      return ownerId === detail.user.id || email === String(detail.user.email || '').toLowerCase();
    })
    .map((mailbox) => {
      const stats = collectMailboxStats(settings).find((item) => item.id === mailbox.id);
      return {
        id: mailbox.id,
        email: mailbox.email,
        tag: mailbox.tag,
        tagLabel: mailboxTagLabel(mailbox),
        provider: mailbox.provider,
        ownerUserId: mailbox.ownerUserId || mailbox.userId || null,
        linkedBy: (mailbox.ownerUserId || mailbox.userId) === detail.user.id ? 'owner' : 'email',
        ...(stats || {}),
      };
    });
  res.json({ ...detail, mailboxes, workspaceShared: !(settings.mailboxes || []).some((m) => m.ownerUserId || m.userId) });
}));
app.post('/api/admin/users', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.status(201).json({ user: await adminCreateUser(req.body || {}) });
}));
app.put('/api/admin/users/:id', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ user: await adminUpdateUser(req.params.id, req.body || {}) });
}));
app.post('/api/admin/users/:id/force-logout', api(async (req, res) => {
  const admin = await requireAdminFromHeader(req.get('Authorization'));
  res.json(await adminForceLogoutUser(req.params.id, admin.id));
}));
app.delete('/api/admin/users/:id/sessions/:jti', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await adminRevokeUserSession(req.params.id, req.params.jti));
}));
app.delete('/api/admin/users/:id', api(async (req, res) => {
  const admin = await requireAdminFromHeader(req.get('Authorization'));
  res.json(await adminDeleteUser(req.params.id, admin.id));
}));
app.get('/api/admin/mailboxes', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const settings = readSettings();
  const users = await listUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  const byEmail = new Map(users.map((u) => [String(u.email || '').toLowerCase(), u]));
  const mailboxes = collectMailboxStats(settings).map((item) => {
    const raw = (settings.mailboxes || []).find((m) => m.id === item.id) || {};
    const owner = (raw.ownerUserId && byId.get(raw.ownerUserId))
      || byEmail.get(String(item.email || '').toLowerCase())
      || null;
    return {
      ...item,
      provider: raw.provider || 'qq',
      ownerUserId: raw.ownerUserId || raw.userId || owner?.id || null,
      ownerUsername: owner?.username || null,
      ownerEmail: owner?.email || null,
    };
  });
  res.json({ mailboxes, activeMailboxId: settings.activeMailboxId });
}));
app.get('/api/admin/infra', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const { OSS_PROVIDERS } = await import('./infra/oss.js');
  res.json({ config: publicInfraConfig(), ossProviders: OSS_PROVIDERS });
}));
app.put('/api/admin/infra', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const current = readInfraConfig({ force: true });
  const next = mergeInfraSecrets(req.body || {}, current);
  if (next.auth.requireAuth && !current.auth.requireAuth) {
    const user = await currentUserFromAuthHeader(req.get('Authorization'));
    if (!user) {
      return res.status(400).json({ error: '开启「强制登录」前请先登录账号，以免无法再修改配置。' });
    }
  }
  res.json(await reloadInfra(next));
}));
app.post('/api/admin/infra/test-oss', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const current = readInfraConfig({ force: true });
  const merged = mergeInfraSecrets({ ...current, oss: { ...current.oss, ...(req.body || {}) } }, current);
  try {
    const result = await testOssConnection(merged.oss);
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
}));
app.post('/api/admin/infra/test-mq', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const current = readInfraConfig({ force: true });
  const merged = mergeInfraSecrets({ ...current, mq: { ...current.mq, ...(req.body || {}) } }, current);
  try {
    const result = await testQueueConnection(merged.mq);
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
}));
app.get('/api/admin/mail-templates', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ templates: readMailTemplates(), meta: TEMPLATE_META });
}));
app.put('/api/admin/mail-templates', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ templates: saveMailTemplates(req.body?.templates || req.body || {}) });
}));
app.post('/api/admin/mail-templates/reset', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ templates: resetMailTemplates() });
}));
app.post('/api/admin/mail-templates/preview', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const { id, vars } = req.body || {};
  const { renderMailTemplate } = await import('./mail-templates.js');
  res.json({ preview: renderMailTemplate(id, vars || {
    code: '123456',
    email: 'demo@example.com',
    username: '演示用户',
    minutes: 10,
    resetUrl: 'http://127.0.0.1:3000/reset-password?token=demo',
    title: '示例通知标题',
    body: '这是一封预览通知正文。',
    version: '0.1.0',
  }) });
}));
app.post('/api/admin/mail-templates/send-test', api(async (req, res) => {
  const admin = await requireAdminFromHeader(req.get('Authorization'));
  const { id, to } = req.body || {};
  const target = String(to || admin.email || '').trim();
  if (!target) return res.status(400).json({ error: '请填写收件人' });
  res.json(await sendTemplatedMail(id, {
    to: target,
    vars: {
      code: '123456',
      email: target,
      username: admin.username || '管理员',
      minutes: 10,
      resetUrl: `${req.protocol}://${req.get('host')}/reset-password?token=demo`,
      title: 'Daylight 测试通知',
      body: '这是一封由管理端发出的模板测试邮件。',
      version: '0.1.0',
    },
  }));
}));
app.get('/api/admin/settings', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json({ settings: publicSettings(readSettings()) });
}));
app.put('/api/admin/settings', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const current = readSettings();
  const body = req.body || {};
  const keepSecret = (next, prev) => (next && !String(next).startsWith('••••') ? next : prev);
  const byId = new Map((current.mailboxes || []).map((item) => [item.id, item]));
  const mailboxes = Array.isArray(body.mailboxes)
    ? body.mailboxes.map((item) => {
      const prev = byId.get(item.id) || {};
      return normalizeMailbox({
        ...prev,
        ...item,
        authorizationCode: keepSecret(item.authorizationCode, prev.authorizationCode || ''),
      });
    })
    : current.mailboxes;
  const next = {
    ...current,
    baseUrl: body.baseUrl !== undefined ? String(body.baseUrl).trim() : current.baseUrl,
    model: body.model !== undefined ? String(body.model).trim() : current.model,
    apiKey: keepSecret(body.apiKey, current.apiKey),
    activeMailboxId: body.activeMailboxId || current.activeMailboxId,
    mailboxes,
  };
  if (!next.mailboxes.some((item) => item.id === next.activeMailboxId) && next.mailboxes[0]) {
    next.activeMailboxId = next.mailboxes[0].id;
  }
  const saved = saveSettings(next);
  refreshIdleWatcher(runSync);
  res.json({ settings: publicSettings(saved) });
}));

app.get('/api/infra', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await infraHealth());
}));
app.put('/api/infra', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const current = readInfraConfig({ force: true });
  const next = mergeInfraSecrets(req.body || {}, current);
  // 开启强制登录前必须已登录，避免未登录保存后门禁立即生效、无法再改配置。
  if (next.auth.requireAuth && !current.auth.requireAuth) {
    const user = await currentUserFromAuthHeader(req.get('Authorization'));
    if (!user) {
      return res.status(400).json({ error: '开启「强制登录」前请先登录账号，以免无法再修改配置。' });
    }
  }
  res.json(await reloadInfra(next));
}));
app.post('/api/infra/reload', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await reloadInfra(readInfraConfig({ force: true })));
}));
app.get('/api/infra/public', (req, res) => {
  res.json({ config: publicInfraConfig() });
});

app.get(/^\/api\/attachments\/(.+)$/, api(async (req, res) => {
  const key = decodeURIComponent(req.params[0] || '');
  const download = String(req.query.download || '') === '1';
  const local = resolveLocalAttachment(key);
  if (local) {
    if (download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(key))}`);
    return res.sendFile(local);
  }
  try {
    const object = await getAttachmentObject(key);
    if (!object?.buffer) return res.status(404).json({ error: '附件不存在' });
    if (object.contentType) res.type(object.contentType);
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(key))}`);
    }
    res.send(object.buffer);
  } catch (error) {
    res.status(404).json({ error: error.message || '附件不存在' });
  }
}));

app.post('/api/assistant/chat', api(async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: '请输入问题' });
  const result = await runAssistantChat({ messages });
  res.json(result);
}));

app.put('/api/calendar-categories', (req, res) => {
  if (syncing || sendingReplies.size) return res.status(409).json({ error: '请等当前邮件同步或回复发送结束后再保存。' });
  const existing = readSettings();
  const calendarCategories = normalizeCalendarCategories(req.body?.categories ?? req.body);
  if (!calendarCategories.some((item) => item.enabled)) {
    return res.status(400).json({ error: '至少保留一个启用的日历分类。' });
  }
  saveSettings({ ...existing, calendarCategories });
  res.json(publicSettings(readSettings()));
});

app.put('/api/mail-filters', (req, res) => {
  if (syncing || sendingReplies.size) return res.status(409).json({ error: '请等当前邮件同步或回复发送结束后再保存。' });
  const existing = readSettings();
  const mailFilters = normalizeMailFilters(req.body?.filters ?? req.body);
  saveSettings({ ...existing, mailFilters });
  res.json(publicSettings(readSettings()));
});

app.get('/api/recruitment', (req, res) => {
  const mailboxId = readSettings().activeMailboxId;
  const data = getRecruitmentState(mailboxId);
  data.traces = [...data.traces, ...readTraces(mailboxId).filter((trace) => ['resume', 'recruitment'].includes(trace.kind))]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  data.busy = Boolean(data.busy || retryingAttachments.size || (syncing && syncState.mailboxId === mailboxId));
  res.json(data);
});
app.get('/api/recruitment/candidates/:id', (req, res) => {
  const candidate = readRecruitment(readSettings().activeMailboxId).candidates.find((item) => item.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: '候选人不存在。' });
  res.json(candidate);
});
app.post('/api/recruitment/chat', api(async (req, res) => {
  const settings = readSettings();
  res.json(await runRecruitmentChat(settings.activeMailboxId, String(req.body.message || '').trim(), settings));
}));
app.post('/api/recruitment/demo', api(async (req, res) => {
  if (syncing || isRecruitmentBusy()) return res.status(409).json({ error: '请等待当前处理完成。' });
  res.json(await importRecruitmentDemo(readSettings().activeMailboxId));
}));
app.put('/api/recruitment/interviews/:id', api(async (req, res) => res.json(await updateInterview(readSettings().activeMailboxId, req.params.id, req.body))));
app.post('/api/recruitment/interviews/:id/meeting', api(async (req, res) => {
  const settings = readSettings();
  res.json(await prepareInterviewMeeting(settings.activeMailboxId, req.params.id, settings));
}));
app.post('/api/recruitment/interviews/:id/send', api(async (req, res) => {
  const settings = readSettings();
  res.json(await sendInterview(settings.activeMailboxId, req.params.id, settings));
}));
app.get('/api/recruitment/attachments/:id', (req, res) => {
  const settings = readSettings();
  const mailboxId = String(req.query.mailbox || settings.activeMailboxId);
  if (!settings.mailboxes.some((mailbox) => mailbox.id === mailboxId)) return res.status(404).json({ error: '邮箱不存在。' });
  const attachment = getAttachment(mailboxId, req.params.id);
  if (!attachment) return res.status(404).json({ error: '附件不存在。' });
  const file = attachmentPath(mailboxId, attachment.id);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '附件文件不存在。' });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename || 'resume.pdf')}`);
  res.sendFile(path.resolve(file));
});
app.post('/api/recruitment/attachments/:id/retry', api(async (req, res) => {
  const settings = readSettings();
  const mailboxId = settings.activeMailboxId;
  if (syncing || isRecruitmentBusy() || retryingAttachments.size) return res.status(409).json({ error: '请等待当前处理完成再重试。' });
  const attachment = getAttachment(mailboxId, req.params.id);
  if (!attachment) return res.status(404).json({ error: '附件不存在。' });
  const email = readStore(mailboxId).emails.find((item) => item.id === attachment.emailId);
  if (!email) return res.status(404).json({ error: '来源邮件尚未保存，请同步邮箱重试。' });
  retryingAttachments.add(attachment.id);
  const recorder = createTraceRecorder({ settings,
    traces: readTraces(mailboxId).filter((trace) => trace.email_ref === emailReference(email.id)),
    persist: (traces) => {
      const merged = new Map(readTraces(mailboxId).map((trace) => [trace.trace_id, trace]));
      for (const trace of traces) {
        const latest = merged.get(trace.trace_id);
        if (latest?.reply_delivery) trace.reply_delivery = latest.reply_delivery;
        if (latest?.user_action_at) Object.assign(trace, { user_action_at: latest.user_action_at, user_action: latest.user_action, user_draft: latest.user_draft });
        merged.set(trace.trace_id, trace);
      }
      saveTraces([...merged.values()], mailboxId);
    } });
  const context = recorder.beginEmail(email, 'qq');
  context.update({ kind: 'resume', attachmentIds: [attachment.id] });
  try {
    const result = await extractResumeAttachment(mailboxId, email, attachment, settings, context);
    const attachments = readRecruitment(mailboxId).attachments.filter((item) => item.emailId === email.id);
    let record;
    if (attachments.some((item) => item.status === 'success') || email.category === 'resume') {
      record = resumeRecord(email, attachments);
    } else if (email.recruitmentStatus === 'partial' && attachments.every((item) => item.status === 'not_resume')) {
      const before = readStore(mailboxId);
      const extracted = await extractEvents(email, settings, before.events, context, before.tasks);
      const latest = readStore(mailboxId);
      record = importEmail(latest, { ...email, attachments: attachments.map(({ pages, ...item }) => ({ ...item, pageCount: pages?.length || 0 })) }, extracted, 'qq');
      saveStore(latest, mailboxId);
    } else {
      record = { ...email, attachments: attachments.map(({ pages, ...item }) => ({ ...item, pageCount: pages?.length || 0 })) };
    }
    record.trace_id = context.trace.trace_id;
    const current = readStore(mailboxId);
    const index = current.emails.findIndex((item) => item.id === email.id);
    current.emails[index] = record;
    saveStore(current, mailboxId);
    context.finish(result.status === 'failed' || record.recruitmentStatus === 'partial' ? 'failed' : 'imported', { decision: record.summary });
    res.json(record);
  } catch (error) {
    context.finish('failed', { decision: '附件重试未完成，保留原记录供下次重试。', error: context.sanitize(error.message) });
    throw error;
  } finally { retryingAttachments.delete(attachment.id); }
}));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message });
});
if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('*', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '127.0.0.1');
server.on('listening', () => {
  const actualPort = server.address().port;
  console.log(process.env.DAYLIGHT_DESKTOP === '1' ? `DAYLIGHT_READY ${actualPort}` : `Daylight is ready at http://127.0.0.1:${actualPort}`);
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && process.env.DAYLIGHT_DESKTOP === '1') server.listen(0, '127.0.0.1');
  else { console.error(error); process.exit(1); }
});
