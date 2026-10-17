import { consumeCalendarOAuthState } from './calendar-oauth-state.js';
import { createCalendarSubscription, resolveCalendarSubscription } from './calendar-subscription.js';
import { mobileCors } from './mobile-cors.js';
import { decideInvitation, invitationStates, saveInvitationPreferences } from './invitations.js';
import { scenarioRouter } from './scenarios/routes.js';
import { reminderRouter } from './reminders-api.js';
import { classifyApiPath } from './api-surface.js';
import { isProductionRuntime } from './runtime-mode.js';
import { productionStorageMiddleware, productionWorkflowMiddleware, ownsAttachmentKey, readProductionAdminJobs } from './production-api.js';
import { serviceHealth, installShutdown } from './service-health.js';
import { counter, gauge, metricsEnabled, timer } from './metrics.js';
import { jobRepository, enqueueMail, requestJobKey, queueCalendarExport } from './job-service.js';
import { createJobRouter, publicJob } from './job-api.js';
import { createCalendarRecoveryRouter } from './calendar-api.js';
import { getPostgresPool } from './infra/postgres.js';
import { commitStorage } from './storage/index.js';
import { syncLocalTaskStatus, syncLocalEventStatus } from './scenarios/service.js';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// [desktop patch] 原生壳层的桌面会话引导；vite 改为按需动态导入（见文件末尾）。
import { mountDesktopHttp } from './desktop-http.js';
import {
  readStore, saveStore, readSettings, saveSettings, publicSettings, normalizeMailbox,
  normalizeMailboxTag, mailboxTagLabel, mailboxProviders, normalizeMailboxWriteBack, updateStoredEmail,
} from './store.js';
import { viewScopeMailboxIds } from './view-scope.js';
import { exampleEmails, exampleChanges, exampleTasks, exampleConflicts } from './fixtures.js';
import {
  readMailboxEmails, sendMailboxReply, extractEvents, importEmail, processEmails, EXTRACTION_VERSION,
  resolveEmailMatch, testMailboxConnection, testModelConnection,
  parseMailboxMessageRef, resolveMailWriteBack, resolveMailFolder, listMailboxFolders,
  readMailboxFlags, writeBackMailboxMessage,
} from './agent.js';
import { assertTaskCompletable } from './tasks.js';
import { createTraceRecorder, readTraces, saveTraces, summarizeTraces, sanitizeReplyDraft, emailReference, appendRecruitmentTraces } from './traces.js';
import { readPrompts, savePrompts, resetPrompts } from './prompts.js';
import {
  readReportPrompts, saveReportPrompts, resetReportPrompts,
  upsertReportPreset, deleteReportPreset,
} from './report-prompts.js';
import { dbStatus, listPromptRevisions } from './db.js';
import { exportBackup, restoreBackup } from './backup.js';
import { refreshIdleWatcher, idleStatus } from './idle-sync.js';
import { bootInfra, infraHealth, publicInfraConfig, readInfraConfig, reloadInfra, sharedRuntimeReady } from './infra/index.js';
import { mergeInfraSecrets } from './infra/config.js';
import { enqueue, listJobs, registerWorker, testQueueConnection } from './infra/queue.js';
import { getAttachmentObject, resolveLocalAttachment, testOssConnection } from './infra/oss.js';
import {
  adminCreateUser, adminDeleteUser, adminForceLogoutUser, adminGetUser,
  adminListUsers, adminRevokeUserSession, adminUpdateUser,
  createCaptcha, currentUserFromAuthHeader,
  loginUser, registerUser,
  requestPasswordReset, requireAdminFromHeader, resetPassword,
  sendRegisterEmailCode,
} from './auth.js';
import { findUserByEmail, findUserById, listUsers } from './infra/postgres.js';
import { sendTemplatedMail, systemMailReady } from './mailer.js';
import {
  TEMPLATE_META, readMailTemplates, resetMailTemplates, saveMailTemplates,
} from './mail-templates.js';
import {
  readOnboardingGuideAsync, resetOnboardingGuide, saveOnboardingGuide,
} from './onboarding-guide.js';
import { runAssistantChat, normalizeTime, requiredTitle, validPriority } from './assistant.js';
import { runAssistantRequest } from './assistant-requests.js';
import { listAssistantDrafts, getAssistantDraft, updateAssistantDraft, discardAssistantDraft, sendAssistantDraft, createAssistantDraft } from './assistant-actions.js';
import { buildAdminSearchIndex, runAdminAssistantChat } from './admin-assistant.js';
import { normalizeCalendarCategories } from './calendar-categories.js';
import { normalizeMailFilters } from './mail-filters.js';
import { runWithRequestContext } from './request-context.js';
import { getRecruitmentState, runRecruitmentChat, updateInterview, prepareInterviewMeeting, sendInterview, importRecruitmentDemo, isRecruitmentBusy } from './recruitment.js';
import { readRecruitment, updateRecruitment, getAttachment, readAttachmentBytes } from './recruitment-store.js';
import { processRecruitmentEmail, extractResumeAttachment, resumeRecord, mergeRecruitmentAttachments, recruitmentAttachmentTexts } from './resumes.js';
import { reextractInvoiceEmail } from './invoice-extraction.js';
import { enrichEmailWithAttachmentText } from './attachment-text.js';
import {
  publicCalendarSync, saveCalendarOAuthApps, upsertCalendarConnection, removeCalendarConnection,
  buildOAuthStartUrl, completeOAuthCallback, storeToIcs, queueExternalSync, syncEventExternal,
  setExternalSyncRequireConfirm, confirmPendingExternalSync, dismissPendingExternalSync,
} from './external-calendar.js';
import {
  listMaterials, addMaterial, updateMaterial, removeMaterial, readMaterialFile,
  generateEventReport, deleteReport, MATERIAL_KINDS,
} from './event-aftermath.js';
import {
  isRagEnabled, isRagEmbeddings, listChunks, ragSearch, reindexMailboxAttachments,
  ingestEmailKnowledge, reindexMailboxEmails, ensureMailboxEmailsIndexed, askMailboxKnowledge,
} from './rag/index.js';

function collectPeerTasks(activeMailboxId) {
  const settings = readSettings();
  const peers = [];
  for (const mailbox of settings.mailboxes || []) {
    if (mailbox.id === activeMailboxId) continue;
    const store = readStore(mailbox.id);
    for (const task of store.tasks || []) {
      if (task.source === 'demo') continue;
      peers.push({
        id: task.id,
        title: task.title,
        description: task.description,
        dueAt: task.dueAt,
        deadlineText: task.deadlineText,
        priority: task.priority,
        status: task.status,
        assignee: task.assignee || '',
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.email || '',
      });
    }
  }
  return peers;
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
// [desktop patch] 必须在任何业务中间件之前挂载：校验回环地址 / Origin / 壳层一次性 token。
mountDesktopHttp(app);
// [desktop patch] 桌面端是单用户本地应用，不提供管理端接口（保留代码，仅屏蔽路由）。
if (process.env.DAYLIGHT_DESKTOP === '1') app.use('/api/admin', (req, res) => res.status(404).json({ error: '接口不存在。' }));
app.use('/api', mobileCors());
const productionRuntime = isProductionRuntime();
const health = serviceHealth({ role: 'api', checkReady: async () => {
  if (!productionRuntime) return true;
  if (!await sharedRuntimeReady()) return false;
  await getPostgresPool().query('SELECT 1 FROM daylight_jobs LIMIT 1');
  return true;
} });
app.use((req, res, next) => { health.respond(req, res).then(handled => { if (!handled) next(); }).catch(next); });
app.use(express.json({ limit: '12mb' }));
// Request-level metrics: one sample per finished request plus an in-flight gauge.
// Health probes are excluded so readiness polling cannot drown out business traffic.
let httpInflight = 0;
app.use((req, res, next) => {
  if (!metricsEnabled() || req.path.startsWith('/health')) return next();
  const stop = timer('http.request.ms', { method: req.method });
  httpInflight += 1;
  gauge('http.inflight', httpInflight, 'count');
  res.on('finish', () => {
    httpInflight -= 1;
    const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    const klass = `${Math.floor(res.statusCode / 100)}xx`;
    stop({ status: res.statusCode, class: klass, route });
    counter('http.requests_total', { method: req.method, status: res.statusCode, class: klass, route });
  });
  next();
});

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
    if(!user && req.path==='/calendar.ics' && req.query.subscription) {
      const subscription=await resolveCalendarSubscription(req.query.subscription);
      if(subscription) {user=subscription.user;req.subscriptionMailboxId=subscription.mailboxId;}
    }
    const requireAuth = readInfraConfig().auth.requireAuth;
    if(req.path==='/calendar.ics' && requireAuth && !user) return res.status(401).json({error:'需要有效的私密日历订阅。'});
    // Attachments stay open in development, but in production a bucket key alone is not
    // permission: the request must pass authentication and the ownership check below.
    if (requireAuth && !AUTH_PUBLIC.has(req.path) && (productionRuntime || !req.path.startsWith('/attachments/'))) {
      if (!user) return res.status(401).json({ error: '请先登录' });
    }
    req.user = user || undefined;
    runWithRequestContext({ userId: user?.id || null, user }, next);
  })().catch(next);
});
if (productionRuntime) app.use('/api', productionStorageMiddleware());
app.use('/api', (req, res, next) => {
  try {
      const mailboxId = req.get('X-Mailbox-Id');
      const settingsForMailbox = readSettings();
      const ownedMailbox = Boolean(mailboxId) && (settingsForMailbox.mailboxes || []).some((item) => item.id === mailboxId);
      const workbenchScoped = req.path.startsWith('/recruitment') || req.path.startsWith('/rag/') || req.path.startsWith('/jobs');
      if (mailboxId && mailboxId !== settingsForMailbox.activeMailboxId && !(ownedMailbox && workbenchScoped) &&
          !['/state', '/settings'].includes(req.path) && !req.path.startsWith('/mailboxes/') &&
          !/^\/emails\/[^/]+\/extract-invoices$/.test(req.path) &&
          !/^\/emails\/[^/]+\/mail-action$/.test(req.path)) {
        return res.status(409).json({ error: '当前邮箱已切换，请刷新后再操作。' });
      }
      next();
  } catch (error) { next(error); }
});
const api = (handler) => async (req, res, next) => {
  try { await handler(req, res); } catch (error) { next(error); }
};

// Only shared-storage business paths are enabled until legacy network workflows migrate.
// Two-tier gate, and refusals stay visible:
//  - `api-surface.js` is the primary record (one entry per area with the reason it may run in
//    production) and `api-surface.test.js` checks that every registered route is a deliberate
//    decision rather than an oversight.
//  - `productionWorkflowMiddleware` is the explicit allow-list for workflows migrated to
//    shared storage after that table was written (administrator reads, prompts/mail-template
//    settings, attachment downloads), so a path is refused only when neither tier knows it.
//  - A path in neither tier is logged instead of leaving operators to guess why a feature 503s.
if (productionRuntime) app.use('/api', (req, res, next) => {
  const verdict = classifyApiPath(req.path);
  if (verdict.status === 'production') return next();
  if (verdict.status === 'unclassified') {
    console.warn(JSON.stringify({ event: 'unclassified_api_path', path: req.path, method: req.method }));
  }
  return productionWorkflowMiddleware(req, res, next);
});

app.use('/api/scenarios', scenarioRouter);
app.use('/api/reminders', reminderRouter);
app.use('/api/calendar-sync', createCalendarRecoveryRouter());
if (productionRuntime) app.use('/api/jobs', createJobRouter({ repository: jobRepository(), enqueueMail }));
const sendingReplies = new Set();
const invoiceExtractions = new Set();

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
  const requestedMailbox = String(req.query.mailbox || '').trim();
  if (requestedMailbox) {
    const mailbox = (settings.mailboxes || []).find((item) => item.id === requestedMailbox);
    if (!mailbox) return res.status(404).json({ error: '邮箱不存在。' });
    const store = readStore(mailbox.id);
    const events = (store.events || []).map((event) => ({ ...event, mailboxId: mailbox.id, mailboxEmail: mailbox.email, mailboxTag: mailboxTagLabel(mailbox) }));
    const emails = (store.emails || []).map((email) => ({ ...email, mailboxId: mailbox.id, mailboxEmail: mailbox.email, mailboxTag: mailboxTagLabel(mailbox) }));
    const tasks = decorateTasks(store.tasks, mailbox.id).map((task) => ({
      ...task, mailboxEmail: mailbox.email, mailboxTag: mailboxTagLabel(mailbox),
    }));
    return res.json({
      ...store, events, emails, tasks, mailboxId: mailbox.id, viewScope: 'mailbox', settings: publicSettings(settings),
    });
  }
  const scope = String(req.query.scope || 'active');
  const tag = String(req.query.tag || '').trim();

  if (scope === 'all' || tag) {
    // 与知识检索共用同一份范围定义，避免「列表有、检索没有」。
    const scopedIds = new Set(viewScopeMailboxIds(settings.mailboxes, { scope, tag }));
    const mailboxes = (settings.mailboxes || []).filter((mailbox) => scopedIds.has(mailbox.id));
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
      const mailboxTraces = readTraces(mailbox.id).map((trace) => ({ ...trace, mailboxId: mailbox.id, mailboxEmail: mailbox.email }));
      traces.push(...appendRecruitmentTraces(mailboxTraces, readRecruitment(mailbox.id).traces, mailbox));
    }
    traces.sort((a, b) => String(b.created_at || b.started_at || '').localeCompare(String(a.created_at || a.started_at || '')));
    return res.json({
      traces: traces.slice(0, 200),
      mailboxId: 'all',
      summary: summarizeTraces(traces, { mailOnly: true }),
      sync: syncState,
    });
  }
  const mailboxId = settings.activeMailboxId;
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId) || { id: mailboxId, email: '' };
  const traces = appendRecruitmentTraces(readTraces(), readRecruitment(mailboxId).traces, mailbox);
  res.json({ traces, mailboxId, summary: summarizeTraces(traces, { mailOnly: true }), sync: syncState.mailboxId && syncState.mailboxId !== mailboxId
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
app.get('/api/invitations', api(async (req,res)=>res.json(await invitationStates())));
app.put('/api/invitation-preferences', api(async (req,res)=>res.json(saveInvitationPreferences(req.body))));
app.put('/api/invitations/:id', api(async (req,res)=>{
  if(syncing) return res.status(409).json({error:'正在同步邮件，请稍后确认邀请。'});
  const key=`attendance:${readSettings().activeMailboxId}:${req.params.id}`;
  if(sendingReplies.has(key)) return res.status(409).json({error:'邀请正在保存，请稍后重试。'});
  sendingReplies.add(key);
  try {res.json(await decideInvitation(req.params.id,req.body?.decision));}
  finally {sendingReplies.delete(key);}
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
  const mailboxId = findOwningMailbox(req, (store) => (store.events || []).some((event) => event.id === req.params.id));
  if (!mailboxId) return res.status(404).json({ error: '日程不存在。' });
  const store = readStore(mailboxId);
  const index = store.events.findIndex((event) => event.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: '日程不存在。' });
  store.events[index] = { ...store.events[index], ...req.body, id: req.params.id };
  saveStore(store, mailboxId);
  queueExternalSync(store, store.events[index], 'update', { save: () => saveStore(store, mailboxId) });
  res.json(store.events[index]);
});
app.delete('/api/events/:id', (req, res) => {
  const mailboxId = findOwningMailbox(req, (store) => (store.events || []).some((event) => event.id === req.params.id));
  if (!mailboxId) return res.status(404).json({ error: '日程不存在。' });
  const store = readStore(mailboxId);
  const event = store.events.find((item) => item.id === req.params.id);
  store.events = store.events.filter((item) => item.id !== req.params.id);
  saveStore(store, mailboxId);
  if (event) queueExternalSync(store, event, 'delete');
  if (!event?.scenarioActionId) return res.json({ ok: true });
  syncLocalEventStatus(event.scenarioActionId, 'removed')
    .then(() => res.json({ ok: true }))
    .catch((error) => res.status(error.status || 500).json({ error: error.message }));
});
app.get('/api/events/:id/materials', (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try { res.json(listMaterials(req.params.id, { mailboxId })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.post('/api/events/:id/materials', api(async (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try {
    const material = await addMaterial(req.params.id, req.body || {}, {
      userId: req.user?.id,
      username: req.user?.username,
      mailboxId,
    });
    res.status(201).json(material);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.put('/api/events/:id/materials/:materialId', (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try { res.json(updateMaterial(req.params.id, req.params.materialId, req.body || {}, { mailboxId })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.delete('/api/events/:id/materials/:materialId', (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try { res.json(removeMaterial(req.params.id, req.params.materialId, { mailboxId })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.get('/api/events/:id/materials/:materialId/file', api(async (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try {
    const file = await readMaterialFile(req.params.id, req.params.materialId, { mailboxId });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.send(file.buffer);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.post('/api/events/:id/reports/generate', api(async (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try {
    const report = await generateEventReport(req.params.id, req.body || {}, { mailboxId });
    res.status(201).json(report);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.delete('/api/events/:id/reports/:reportId', (req, res) => {
  const mailboxId = eventMailboxOr404(req, res);
  if (!mailboxId) return;
  try { res.json(deleteReport(req.params.id, req.params.reportId, { mailboxId })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.get('/api/material-kinds', (_req, res) => {
  res.json({ kinds: MATERIAL_KINDS });
});
app.post('/api/tasks', (req,res)=>{
  try {
    const input=req.body || {};
    const task={id:randomUUID(),title:requiredTitle(input.title,'待办'),dueAt:input.dueAt ? normalizeTime(input.dueAt,'截止时间','18:00:00') : null,
      priority:input.priority===undefined?'normal':validPriority(input.priority),assignee:String(input.assignee||'').trim().slice(0,200),
      description:String(input.description||'').trim().slice(0,20000),status:'pending',completedAt:null,source:'manual',createdAt:new Date().toISOString(),sources:[]};
    const store=readStore();store.tasks.push(task);saveStore(store);res.status(201).json(task);
  } catch(error) {res.status(error.status||400).json({error:error.message});}
});
app.put('/api/tasks/:id', (req, res) => {
  const { title, status, assignee, dueAt, priority, description, evidenceEmailId } = req.body;
  // 混合视图里待办也可能来自别的邮箱，按 id 定位真正拥有它的邮箱再改。
  const mailboxId = findOwningMailbox(req, (store) => (store.tasks || []).some((item) => item.id === req.params.id));
  if (!mailboxId) return res.status(404).json({ error: '待办不存在。' });
  const store = readStore(mailboxId);
  const task = store.tasks.find((item) => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: '待办不存在。' });
  if(title!==undefined) {try {task.title=requiredTitle(title,'待办');}catch(error){return res.status(400).json({error:error.message});}}
  if (status !== undefined) {
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: '请选择待办或已完成。' });
    if (status === 'done') {
      try {
        const verified = assertTaskCompletable(task, {
          emails: store.emails || [],
          traces: readTraces(mailboxId),
          evidenceEmailId,
        });
        if (verified.verifiedAt) {
          task.verification = {
            ...(task.verification || {}),
            mode: verified.mode || task.verification?.mode || 'manual',
            status: 'verified',
            verifiedAt: verified.verifiedAt,
            ...(verified.evidenceEmailId ? { evidenceEmailId: verified.evidenceEmailId } : {}),
          };
        }
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    }
    task.status = status;
    task.completedAt = status === 'done' ? new Date().toISOString() : null;
    if (status === 'pending' && task.verification) {
      task.verification = { ...task.verification, status: 'pending', verifiedAt: null };
    }
  }
  if (assignee !== undefined) task.assignee = String(assignee || '').trim();
  if (description !== undefined) task.description = String(description || '').trim();
  if (dueAt !== undefined) {
    try {task.dueAt=dueAt ? normalizeTime(dueAt,'截止时间','18:00:00') : null;}
    catch(error){return res.status(400).json({error:error.message});}
  }
  if (priority !== undefined) {
    if (!['high', 'normal', 'low'].includes(priority)) return res.status(400).json({ error: '优先级无效。' });
    task.priority = priority;
  }
  saveStore(store, mailboxId);
  if (!task.scenarioActionId || status === undefined) return res.json(task);
  syncLocalTaskStatus(task.scenarioActionId, task.status)
    .then(() => res.json(task))
    .catch((error) => res.status(error.status || 500).json({ error: error.message }));
});
app.post('/api/emails/:id/resolve-match', (req, res) => {
  try {
    const store = readStore();
    const email = resolveEmailMatch(store, req.params.id, {
      pendingActionId: req.body?.pendingActionId,
      targetEventId: req.body?.targetEventId,
      resolution: req.body?.resolution || 'apply',
      mode: req.body?.mode || 'qq',
    });
    saveStore(store);
    if (req.body?.resolution === 'create' || req.body?.resolution === 'apply') {
      const created = (email.createdEventIds || []).map((id) => store.events.find((item) => item.id === id)).filter(Boolean);
      const cancelled = (email.cancelledEventIds || []).map((id) => store.events.find((item) => item.id === id)).filter(Boolean);
      queueExternalSync(store, created, 'create', { save: () => saveStore(store) });
      queueExternalSync(store, cancelled.filter((item) => item.status === 'cancelled'), 'delete');
    }
    res.json(email);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});
app.put('/api/settings', api(async (req, res) => {
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
  // 写回开关是危险设置：请求体没带这个字段时必须保留原值，绝不能被任何一次保存顺手关掉。
  current.writeBack = normalizeMailboxWriteBack(req.body.writeBack === undefined ? mailbox?.writeBack : req.body.writeBack);
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
  if (req.body.feishu) {
    settings.feishu = { appId: String(req.body.feishu.appId ?? existing.feishu?.appId ?? '').trim(),
      ownerId: String(req.body.feishu.ownerId ?? existing.feishu?.ownerId ?? '').trim(),
      appSecret: req.body.feishu.appSecret || existing.feishu?.appSecret || '' };
  }
  if (req.body.ragEnabled !== undefined) settings.ragEnabled = Boolean(req.body.ragEnabled);
  if (req.body.ragEmbeddings !== undefined) settings.ragEmbeddings = Boolean(req.body.ragEmbeddings);
  if (req.body.embeddingModel !== undefined) {
    settings.embeddingModel = String(req.body.embeddingModel || '').trim();
  }
  saveSettings(settings, { registerMailboxIds: [current.id] });
  const saved = readSettings();
  if (!productionRuntime) refreshIdleWatcher(runSync);
  const job = productionRuntime && current.id !== existing.activeMailboxId ? await enqueueSwitchSync(req, saved) : null;
  const syncStarted = job || (current.id !== existing.activeMailboxId && startMailboxSync(saved));
  res.json({ ...publicSettings(saved), syncStarted: Boolean(syncStarted), ...(job ? { job: publicJob(job) } : {}) });
}));
app.post('/api/mailboxes/:id/activate', api(async (req, res) => {
  if (syncing || sendingReplies.size || isRecruitmentBusy() || retryingAttachments.size) return res.status(409).json({ error: '请等当前邮件同步或回复发送结束后再切换邮箱。' });
  const settings = readSettings();
  if (!settings.mailboxes.some((mailbox) => mailbox.id === req.params.id)) return res.status(404).json({ error: '邮箱配置不存在。' });
  const changed = settings.activeMailboxId !== req.params.id;
  if (changed) saveSettings({ ...settings, activeMailboxId: req.params.id });
  const saved = readSettings();
  if (!productionRuntime) refreshIdleWatcher(runSync);
  const job = productionRuntime && changed ? await enqueueSwitchSync(req, saved) : null;
  const syncStarted = job || (changed && startMailboxSync(saved));
  res.json({ ...publicSettings(saved), syncStarted: Boolean(syncStarted), ...(job ? { job: publicJob(job) } : {}) });
}));

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
app.get('/api/report-prompts', (req, res) => {
  res.json(readReportPrompts());
});
app.put('/api/report-prompts', (req, res) => {
  try {
    res.json(saveReportPrompts(req.body?.presets));
  } catch (error) {
    res.status(400).json({ error: error.message || '保存失败' });
  }
});
app.post('/api/report-prompts/reset', (req, res) => {
  res.json(resetReportPrompts());
});
app.post('/api/report-prompts/presets', (req, res) => {
  try {
    res.json(upsertReportPreset(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message || '保存失败' });
  }
});
app.delete('/api/report-prompts/presets/:id', (req, res) => {
  res.json(deleteReportPreset(req.params.id));
});
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
app.put('/api/calendar-sync/require-confirm', (req, res) => {
  res.json(setExternalSyncRequireConfirm(Boolean(req.body?.requireConfirm)));
});
app.post('/api/calendar-sync/pending/confirm', (req, res) => {
  const store = readStore();
  const result = confirmPendingExternalSync(store, {
    ids: req.body?.ids,
    all: Boolean(req.body?.all),
    save: () => saveStore(store),
  });
  res.status(productionRuntime ? 202 : 200).json({ ...result, ...publicCalendarSync() });
});
app.post('/api/calendar-sync/pending/dismiss', (req, res) => {
  const result = dismissPendingExternalSync({ ids: req.body?.ids, all: Boolean(req.body?.all) });
  res.json({ ...result, ...publicCalendarSync() });
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
app.get('/api/calendar-sync/oauth/start/:provider', api(async (req, res) => {
  try {
    const { url } = await buildOAuthStartUrl(req.params.provider, req);
    res.json({ url });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));
app.get('/api/calendar-sync/oauth/callback', api(async (req, res) => {
  let nativeReturn=false;
  try {
    if (req.query.error) {
      nativeReturn=(await consumeCalendarOAuthState(req.query.state)).native;
      throw new Error('日历授权未完成，请重新连接。');
    }
    const connection=await completeOAuthCallback({ code: req.query.code, state: req.query.state, req });
    res.redirect(connection.native ? 'daylight://calendar-connected?status=ok' : '/app/settings?tab=calendar&calendarSync=ok');
  } catch (error) {
    res.redirect(nativeReturn || error.nativeOAuth ? 'daylight://calendar-connected?status=error' : `/app/settings?tab=calendar&calendarSync=error&message=${encodeURIComponent(error.message)}`);
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
app.post('/api/calendar-sync/subscription', api(async (req,res)=>res.json(await createCalendarSubscription())));
app.get('/api/calendar.ics', (req, res) => {
  const settings=readSettings();
  const mailboxId=req.subscriptionMailboxId || req.query.mailboxId || settings.activeMailboxId;
  if(!settings.mailboxes.some(box=>box.id===mailboxId) || (req.subscriptionMailboxId && req.query.mailboxId && req.query.mailboxId!==req.subscriptionMailboxId)) return res.status(403).json({error:'无权访问这个日历。'});
  const store = readStore(mailboxId);
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
  if (productionRuntime) {
    return res.status(202).json(queueCalendarExport(store, active, connections));
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
  if (!productionRuntime) refreshIdleWatcher(runSync);
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
  const mailboxId = readSettings().activeMailboxId;
  const recruitment = readRecruitment(mailboxId);
  const realCandidateIds = new Set(recruitment.interviews.filter((interview) => interview.source !== 'demo').map((interview) => interview.candidateId));
  const preservedVersions = recruitment.candidates.filter((candidate) => candidate.source === 'demo' && realCandidateIds.has(candidate.id))
    .flatMap((candidate) => candidate.versions);
  const preservedEmailIds = new Set(preservedVersions.map((version) => version.emailId));
  const preservedAttachmentIds = new Set(preservedVersions.map((version) => version.attachmentId));
  const store = readStore();
  store.events = store.events.filter((event) => event.source !== 'demo');
  store.emails = store.emails.filter((email) => email.mode !== 'demo' || preservedEmailIds.has(email.id));
  store.tasks = store.tasks.filter((task) => task.source !== 'demo');
  saveStore(store);
  saveTraces(readTraces().filter((trace) => trace.mode !== 'demo'));
  updateRecruitment(mailboxId, (data) => {
    data.candidates = data.candidates.filter((candidate) => candidate.source !== 'demo' || realCandidateIds.has(candidate.id));
    data.attachments = data.attachments.filter((attachment) => attachment.source !== 'demo' || preservedAttachmentIds.has(attachment.id));
    for (const key of ['interviews', 'messages']) data[key] = data[key].filter((item) => item.source !== 'demo');
    data.traces = data.traces.filter((trace) => trace.mode !== 'demo');
  });
  res.json({ ok: true });
});

let syncing = false;
let syncState = { running: false, status: 'idle', stage: '', processed: 0, total: 0 };
let activeRecorder = null;
app.post('/api/emails/:id/extract-invoices', api(async (req, res) => {
  const settings = readSettings();
  const mailboxId = req.get('X-Mailbox-Id') || settings.activeMailboxId;
  if (!settings.mailboxes.some((mailbox) => mailbox.id === mailboxId)) return res.status(404).json({ error: '邮箱不存在。' });
  if (syncing || retryingAttachments.size || invoiceExtractions.size) return res.status(409).json({ error: '正在处理邮件，请稍候再提取发票。' });
  const email = readStore(mailboxId).emails.find((item) => item.id === req.params.id);
  if (!email) return res.status(404).json({ error: '原邮件不存在。' });
  if ((email.category || email.extraction?.category) !== 'invoice') return res.status(400).json({ error: '请从发票报销邮件中提取发票。' });
  if (!publicSettings(settings).modelReady) return res.status(400).json({ error: '请先在设置中填写模型接口。' });
  invoiceExtractions.add(email.id);
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
  context.update({ kind: 'invoice' });
  try {
    const result = await reextractInvoiceEmail(email, settings, { mailboxId, context });
    const current = readStore(mailboxId);
    const index = current.emails.findIndex((item) => item.id === email.id);
    if (index < 0) return res.status(404).json({ error: '原邮件已删除。' });
    const updated = result.email;
    current.emails[index] = { ...current.emails[index],
      category: 'invoice', intent: 'invoice', tags: ['invoice', updated.priority, 'invoice'].filter(Boolean),
      status: 'imported', summary: updated.summary,
      attachments: updated.attachments, attachmentTexts: updated.attachmentTexts, attachmentTextErrors: updated.attachmentTextErrors,
      invoiceStatus: updated.invoiceStatus, invoiceErrors: updated.invoiceErrors, invoiceAttemptedAt: updated.invoiceAttemptedAt,
      trace_id: context.trace.trace_id,
      extraction: { ...(current.emails[index].extraction || {}), category: 'invoice', intent: 'invoice',
        summary: updated.extraction?.summary || '', invoices: updated.extraction?.invoices || [] },
    };
    saveStore(current, mailboxId);
    context.finish(result.error ? 'failed' : 'imported', { decision: updated.summary,
      calendar_summary: '仅更新发票字段，未修改日程或待办。', extraction_snapshot: current.emails[index].extraction,
      ...(result.error ? { error: result.error } : {}) });
    // Failed extraction is a saved business result too: retain partial fields and
    // its trace before the HTTP wrapper discards an unsuccessful response.
    if (productionRuntime && result.error) await commitStorage();
    res.status(result.error ? 502 : 200).json({ ...result, email: current.emails[index] });
  } finally { invoiceExtractions.delete(email.id); }
}));
/**
 * 邮件的真实文件夹列表：设置页用它选归档 / 废纸篓目录。
 * 只读一次 IMAP LIST，不改任何邮件。
 */
app.get('/api/mailboxes/:id/folders', api(async (req, res) => {
  const settings = readSettings();
  const mailbox = (settings.mailboxes || []).find((item) => item.id === req.params.id);
  if (!mailbox) return res.status(404).json({ error: '没有这个邮箱。' });
  if (syncing) return res.status(409).json({ error: '正在同步邮件，请稍候再读取文件夹。' });
  try {
    const folders = await listMailboxFolders(settingsForMailbox(settings, mailbox.id));
    res.json({
      folders,
      suggested: { archive: resolveMailFolder(folders, 'archive'), trash: resolveMailFolder(folders, 'trash') },
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
}));

/**
 * 写回真实邮箱（已读 / 未读 / 星标 / 归档 / 废纸篓 / 移动）。
 * 默认关闭：只有该邮箱在设置里显式打开 writeBack 才会真的连 IMAP 改，否则直接报错。
 * 顺序固定为「先写真邮箱 → 再改本地镜像」，真邮箱失败就如实返回失败，本地不动。
 */
app.post('/api/emails/:id/mail-action', api(async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const folder = String(req.body?.folder || '').trim();
  const settings = readSettings();
  const mailboxId = req.get('X-Mailbox-Id') || settings.activeMailboxId;
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId);
  if (!mailbox) return res.status(404).json({ error: '邮箱不存在。' });
  const writeBack = normalizeMailboxWriteBack(mailbox.writeBack);
  if (writeBack.enabled !== true) {
    return res.status(400).json({ error: '这个邮箱还没开启「写回真实邮箱」。到设置 → 邮箱里打开后再试（本地记录不会先改）。',
      code: 'MAIL_WRITE_BACK_DISABLED' });
  }
  const email = readStore(mailboxId).emails.find((item) => item.id === req.params.id);
  if (!email) return res.status(404).json({ error: '本地没有这封邮件，先同步一次再试。' });
  if (syncing || sendingReplies.size || retryingAttachments.size) return res.status(409).json({ error: '正在处理邮件，请稍候再写回。' });
  const reference = parseMailboxMessageRef(email.id);
  if (!reference) return res.status(400).json({ error: '这封邮件的来源无法定位，已跳过写回（本地记录未改）。', code: 'MAIL_REF_UNKNOWN' });
  const now = new Date();
  const needsFolder = ['archive', 'trash'].includes(action) && !folder
    && !(action === 'archive' ? writeBack.archiveFolder : writeBack.trashFolder);
  let folders = [];
  if (needsFolder) {
    try {
      folders = await listMailboxFolders(settingsForMailbox(settings, mailboxId));
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  }
  let resolved;
  try {
    resolved = resolveMailWriteBack({ action, folder, folders, reference, writeBack, now });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  let written;
  try {
    written = await writeBackMailboxMessage(settingsForMailbox(settings, mailboxId), resolved.call);
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.message, code: error.code });
  }
  const updated = updateStoredEmail(mailboxId, email.id, {
    ...resolved.patch,
    folder: written.folder,
    mailActions: [...(email.mailActions || []), { type: action, at: now.toISOString(), folder: written.folder }].slice(-20),
  });
  if (!updated) return res.status(409).json({ error: '真邮箱已改好，但本地记录刚被同步替换，请刷新后再看。' });
  res.json({ ok: true, action, folder: written.folder, email: updated });
}));

app.post('/api/sync/:mode', api(async (req, res) => {
  const requestedMode = ['mail', 'mailbox'].includes(req.params.mode) ? 'qq' : req.params.mode;
  const mode = ['demo-changes', 'demo-tasks', 'demo-conflicts'].includes(requestedMode) ? 'demo' : requestedMode;
  if (!['demo', 'qq'].includes(mode)) return res.status(400).json({ error: '未知导入方式。' });
  if (productionRuntime) {
    if (mode !== 'qq') return res.status(400).json({ error: '生产模式不支持预置示例同步。' });
    const mailboxId = String(req.body?.mailboxId || req.get('X-Mailbox-Id') || readSettings().activeMailboxId);
    const { job } = await enqueueMail({ tenantId: req.user.id, ownerId: req.user.id, mailboxId,
      idempotencyKey: requestJobKey(req.get('Idempotency-Key'), 'manual') });
    return res.status(202).json({ job: publicJob(job) });
  }
  if (syncing || retryingAttachments.size || invoiceExtractions.size) return res.status(409).json({ error: '正在处理邮件，请稍候。' });
  const settings = readSettings();
  if (mode === 'qq' && (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady)) {
    return res.status(400).json({ error: '请先在设置中填写邮箱、客户端授权码、收发服务器和模型接口。' });
  }
  res.json(await runSync(requestedMode, settings));
}));

function startMailboxSync(settings) {
  if (productionRuntime) return false;
  if (invoiceExtractions.size) return false;
  if (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady) return false;
  runSync('qq', settings, 'mailbox-switch').catch(() => {});
  return true;
}

async function enqueueSwitchSync(req, settings) {
  const ready = publicSettings(settings);
  if (!ready.mailboxReady || !ready.modelReady) return null;
  // Publish only after the mailbox/configuration is visible to another process.
  await commitStorage();
  const { job } = await enqueueMail({ tenantId: req.user.id, ownerId: req.user.id, mailboxId: settings.activeMailboxId,
    idempotencyKey: requestJobKey(req.get('Idempotency-Key'), 'switch'), trigger: 'mailbox-switch' });
  return job;
}

/**
 * 把设置收敛到某一个邮箱：IMAP / SMTP 认证读的是 settings.email 与 settings.authorizationCode，
 * 服务器地址读的是 mailbox.imapHost / smtpHost。写回和枚举文件夹都要用这个形态。
 */
function settingsForMailbox(settings, mailboxId) {
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId);
  return mailbox ? { ...settings, ...mailbox, mailboxes: [mailbox], activeMailboxId: mailbox.id } : settings;
}

/**
 * 把真邮箱的 \Seen / \Flagged 镜像回本地（只读，绝不改真邮箱）。
 * 只在开启写回的邮箱上做：既尊重「默认只读」，也避免每次同步多一次 IMAP 往返。
 */
async function refreshMailboxFlags(settings) {
  const mailboxId = settings.activeMailboxId;
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId) || settings;
  if (mailbox.writeBack?.enabled !== true) return 0;
  const store = readStore(mailboxId);
  const indexById = new Map();
  const uidToId = new Map();
  (store.emails || []).forEach((email, index) => {
    indexById.set(email.id, index);
    // 已归档 / 已删除的邮件不在收件箱里，跳过，免得 uid 命中别的邮件。
    if (email.folder && email.folder !== 'INBOX') return;
    const ref = parseMailboxMessageRef(email.id);
    if (ref) uidToId.set(ref.uid, email.id);
  });
  if (!uidToId.size) return 0;
  let flags;
  try {
    flags = await readMailboxFlags(settings, [...uidToId.keys()]);
  } catch {
    return 0; // 邮箱状态刷新失败不影响同步结果，下次再试。
  }
  const at = new Date().toISOString();
  let changed = 0;
  for (const [uid, state] of flags) {
    const index = indexById.get(uidToId.get(uid));
    if (index === undefined) continue;
    const email = store.emails[index];
    if (email.seen === state.seen && email.flagged === state.flagged) continue;
    store.emails[index] = { ...email, seen: state.seen, flagged: state.flagged, flagsSyncedAt: at };
    changed += 1;
  }
  if (changed) saveStore(store, mailboxId);
  return changed;
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
  if (invoiceExtractions.size) throw Object.assign(new Error('正在提取发票，请稍候再同步。'), { status: 409 });
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
    const peerTasks = mode === 'qq' ? collectPeerTasks(mailboxId) : [];
    const result = await processEmails(snapshot, emails,
      mode === 'demo' ? async (email) => ({ summary: email.summary, events: email.events,
        category: email.category, priority: email.priority, intent: email.intent, tasks: email.tasks || [], invoices: email.invoices || [] }) :
        (email, events, traceContext, tasks) => extractEvents(email, settings, events, traceContext, tasks, { peerTasks }), mode, {
          recorder, beforeImport: refreshCalendar, retryMode: trigger, peerTasks,
          ...(mode === 'qq' ? { handleSpecialEmail: (email, context) => processRecruitmentEmail(mailboxId, email, settings, context) } : {}),
          modelContext: JSON.stringify({ endpoint: settings.baseUrl, model: settings.model, version: EXTRACTION_VERSION }),
          onProcessed: async (record) => {
            if (record.recruitmentStatus) touchedRecruitmentEmails.add(record.id);
            persistCalendar();
            syncState.processed++;
            try {
              await ingestEmailKnowledge({ mailboxId, email: record, settings });
            } catch { /* 知识库写入失败不阻断邮件处理 */ }
          },
        });
    persistCalendar();
    // 只读地把真邮箱的已读 / 星标状态镜像回本地；失败不阻断同步。
    if (mode === 'qq') {
      try { syncState.flagsRefreshed = await refreshMailboxFlags(settings); } catch { /* 忽略 */ }
    }
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

if (!productionRuntime) registerWorker('mail.sync', async (payload = {}) => {
  const settings = readSettings();
  return runSync(payload.mode || 'qq', settings, payload.trigger || 'queue');
});

// 以 60s 为节拍。poll：每分钟同步；idle：IMAP IDLE 为主，此处每 5 分钟慢轮询兜底。
// 默认经消息队列投递（RabbitMQ 优先；连不上时 enqueue 回退进程内同步执行）。
let autoSyncTicks = 0;
const retryingAttachments = new Set();
if (!productionRuntime) setInterval(async () => {
  if (syncing || retryingAttachments.size || invoiceExtractions.size) return;
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

if (!productionRuntime) refreshIdleWatcher(runSync);

app.get('/api/auth/config', (req, res) => {
  const auth = readInfraConfig().auth;
  res.json({
    requireAuth: Boolean(auth.requireAuth),
    mobileApiVersion: 1,
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

const adminMonitorJobs = limit => productionRuntime ? readProductionAdminJobs(limit) : Promise.resolve(listJobs(limit));

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
    jobs: await adminMonitorJobs(20),
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
    jobs: await adminMonitorJobs(40),
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
app.get('/api/onboarding/guide', api(async (_req, res) => {
  res.json(await readOnboardingGuideAsync());
}));
app.get('/api/admin/onboarding-guide', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await readOnboardingGuideAsync());
}));
app.put('/api/admin/onboarding-guide', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await saveOnboardingGuide(req.body || {}));
}));
app.post('/api/admin/onboarding-guide/reset', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await resetOnboardingGuide());
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
app.get('/api/admin/search', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  res.json(await buildAdminSearchIndex({ syncState, jobs: await adminMonitorJobs(30) }));
}));

app.post('/api/admin/assistant/chat', api(async (req, res) => {
  await requireAdminFromHeader(req.get('Authorization'));
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: '请输入问题' });
  const stream = Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream');
  const auth = req.get('Authorization');
  if (!stream) {
    return res.json(await runAdminAssistantChat({ messages, authorization: auth, syncState }));
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const writeEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await runAdminAssistantChat({ messages, authorization: auth, syncState }, { onEvent: writeEvent });
  } catch (error) {
    writeEvent({ type: 'error', message: error.message || '管理助手请求失败' });
  }
  res.end();
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
  if (!productionRuntime) refreshIdleWatcher(runSync);
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
  if (productionRuntime && !ownsAttachmentKey(key)) return res.status(404).json({ error: '附件不存在或无权访问。' });
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
    const timedOut = error.status === 504;
    res.status(timedOut ? 504 : 502).json({ error: timedOut
      ? '对象存储下载超时，请稍后重试。' : '对象存储暂时无法读取附件，请稍后重试。' });
  }
}));

app.get('/api/assistant/drafts', api(async (req, res) => {
  res.json(await listAssistantDrafts(readSettings().activeMailboxId));
}));
app.post('/api/assistant/drafts', api(async (req, res) => {
  const settings = readSettings();
  const requested = String(req.body?.mailboxId || '').trim();
  const owned = (settings.mailboxes || []).some((item) => item.id === requested);
  if (requested && !owned) return res.status(404).json({ error: '邮箱不存在或无权访问。' });
  const mailboxId = requested || settings.activeMailboxId;
  res.status(201).json(await createAssistantDraft(mailboxId, req.body || {}, settings));
}));
app.get('/api/assistant/drafts/:id', api(async (req, res) => {
  res.json(await getAssistantDraft(readSettings().activeMailboxId, req.params.id));
}));
app.patch('/api/assistant/drafts/:id', api(async (req, res) => {
  res.json(await updateAssistantDraft(readSettings().activeMailboxId, req.params.id, req.body || {}));
}));
app.post('/api/assistant/drafts/:id/discard', api(async (req, res) => {
  res.json(await discardAssistantDraft(readSettings().activeMailboxId, req.params.id, req.body || {}));
}));
app.post('/api/assistant/drafts/:id/send', api(async (req, res) => {
  const settings = readSettings();
  res.json(await sendAssistantDraft(settings.activeMailboxId, req.params.id, req.body || {}, settings));
}));

app.post('/api/assistant/chat', api(async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: '请输入问题' });
  if (messages.length > 40 || messages.some((message) => typeof message?.content !== 'string' || message.content.length > 60_000)) {
    return res.status(400).json({ error: '对话过长，请缩短消息后重试。' });
  }
  const input = { messages, requestId: req.body?.requestId };
  const scopeIds = ownedRequestMailboxScope(req);
  if (scopeIds.length > 1) input.mailboxIds = scopeIds;
  const stream = Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream');
  if (!stream) {
    const result = await runAssistantRequest(input, runAssistantChat);
    return res.json(result);
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const writeEvent = (event) => {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await runAssistantRequest(input, runAssistantChat, { onEvent: writeEvent });
  } catch (error) {
    writeEvent({ type: 'error', message: error.message || '助手请求失败' });
  }
  res.end();
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

function ownedRequestMailbox(req) {
  const settings = readSettings();
  const requested = String(req.get('X-Mailbox-Id') || '').trim();
  if (requested && (settings.mailboxes || []).some((item) => item.id === requested)) return requested;
  return settings.activeMailboxId;
}

/**
 * 视图检索范围：和 /api/state 的 scope=all / tag= 口径保持一致。
 * 混合视图下列表里能看到多个邮箱的邮件，知识检索也必须覆盖同一批邮箱，
 * 否则会出现「列表里明明有这封信、检索却说没有」。
 */
function ownedRequestMailboxScope(req) {
  const settings = readSettings();
  const scope = String(req.query?.scope || req.body?.scope || '').trim();
  const tag = String(req.query?.tag || req.body?.tag || '').trim();
  const owned = new Set((settings.mailboxes || []).map((mailbox) => mailbox.id));
  const scoped = viewScopeMailboxIds(settings.mailboxes, { scope, tag }).filter((id) => owned.has(id));
  if (scoped.length) return scoped;
  return [ownedRequestMailbox(req)];
}

/**
 * 单条记录（日程 / 待办 / 材料）的归属邮箱查找顺序：活动邮箱 → 当前视图范围 → 其余本人邮箱。
 *
 * 混合视图下列表把多个邮箱的日程合并显示，但修改、删除原先只查「活动邮箱」，
 * 点开别的邮箱的日程就会报「日程不存在。」。记录 id 是 UUID，只在本人的邮箱里按 id 定位，
 * 找到哪就去改哪；单邮箱视图下活动邮箱排第一，行为与错误文案保持不变。
 */
function owningMailboxCandidates(req) {
  const active = ownedRequestMailbox(req);
  // 范围口径与 /api/state 一致：单邮箱视图只有活动邮箱，混合视图（scope=all / tag=）才覆盖视图内邮箱。
  return [active, ...ownedRequestMailboxScope(req).filter((id) => id !== active)];
}

function findOwningMailbox(req, hasItem) {
  for (const mailboxId of owningMailboxCandidates(req)) {
    if (hasItem(readStore(mailboxId))) return mailboxId;
  }
  return null;
}

/** 事件作用域接口（材料 / 报告）先定位归属邮箱，找不到按原口径返回「日程不存在。」。 */
function eventMailboxOr404(req, res) {
  const mailboxId = findOwningMailbox(req, (store) => (store.events || []).some((event) => event.id === req.params.id));
  if (!mailboxId) {
    res.status(404).json({ error: '日程不存在。' });
    return null;
  }
  return mailboxId;
}

app.get('/api/recruitment', (req, res) => {
  const mailboxId = ownedRequestMailbox(req);
  const data = getRecruitmentState(mailboxId);
  data.traces = [...data.traces, ...readTraces(mailboxId).filter((trace) => ['resume', 'recruitment'].includes(trace.kind))]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  data.busy = Boolean(data.busy || retryingAttachments.size || (syncing && syncState.mailboxId === mailboxId));
  res.json(data);
});
app.get('/api/recruitment/candidates/:id', (req, res) => {
  const candidate = readRecruitment(ownedRequestMailbox(req)).candidates.find((item) => item.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: '候选人不存在。' });
  res.json(candidate);
});
app.post('/api/recruitment/chat', api(async (req, res) => {
  const settings = readSettings();
  res.json(await runRecruitmentChat(ownedRequestMailbox(req), String(req.body.message || '').trim(), settings));
}));
app.post('/api/recruitment/demo', api(async (req, res) => {
  if (syncing || isRecruitmentBusy()) return res.status(409).json({ error: '请等待当前处理完成。' });
  res.json(await importRecruitmentDemo(ownedRequestMailbox(req)));
}));
app.put('/api/recruitment/interviews/:id', api(async (req, res) => {
  res.json(await updateInterview(ownedRequestMailbox(req), req.params.id, req.body));
}));
app.post('/api/recruitment/interviews/:id/meeting', api(async (req, res) => {
  const settings = readSettings();
  res.json(await prepareInterviewMeeting(ownedRequestMailbox(req), req.params.id, settings));
}));
app.post('/api/recruitment/interviews/:id/send', api(async (req, res) => {
  const settings = readSettings();
  res.json(await sendInterview(ownedRequestMailbox(req), req.params.id, settings, { confirmDemoSend: req.body?.confirmDemoSend === true }));
}));
app.get('/api/recruitment/attachments/:id', api(async (req, res) => {
  const settings = readSettings();
  const mailboxId = String(req.query.mailbox || settings.activeMailboxId);
  if (!settings.mailboxes.some((mailbox) => mailbox.id === mailboxId)) return res.status(404).json({ error: '邮箱不存在。' });
  const attachment = getAttachment(mailboxId, req.params.id);
  if (!attachment) return res.status(404).json({ error: '附件不存在。' });
  const bytes = await readAttachmentBytes(mailboxId, attachment.id);
  if (!bytes) return res.status(404).json({ error: '附件文件不存在。' });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename || 'resume.pdf')}`);
  res.send(bytes);
}));
app.post('/api/recruitment/attachments/:id/retry', api(async (req, res) => {
  const settings = readSettings();
  const mailboxId = ownedRequestMailbox(req);
  if (syncing || isRecruitmentBusy() || retryingAttachments.size || invoiceExtractions.size) return res.status(409).json({ error: '请等待当前处理完成再重试。' });
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
      const recoveredEmail = { ...email, attachments: mergeRecruitmentAttachments(email, attachments),
        attachmentTexts: recruitmentAttachmentTexts(email, attachments) };
      await enrichEmailWithAttachmentText(recoveredEmail, { context, skipRecruitment: false });
      const extracted = await extractEvents(recoveredEmail, settings, before.events, context, before.tasks);
      const latest = readStore(mailboxId);
      record = importEmail(latest, recoveredEmail, extracted, 'qq');
      saveStore(latest, mailboxId);
    } else {
      record = { ...email, attachments: mergeRecruitmentAttachments(email, attachments) };
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

app.get('/api/rag/status', api(async (req, res) => {
  const settings = readSettings();
  const mailboxIds = ownedRequestMailboxScope(req);
  const mailboxId = mailboxIds[0];
  const chunks = (await Promise.all(mailboxIds.map((id) => listChunks(id)))).flat();
  const byAttachment = new Map();
  for (const chunk of chunks) {
    // 附件 id 是内容哈希，跨邮箱可能重名，按「邮箱 + 附件」计数。
    const key = `${chunk.mailboxId || mailboxId}:${chunk.attachmentId}`;
    byAttachment.set(key, (byAttachment.get(key) || 0) + 1);
  }
  res.json({
    mailboxId,
    mailboxIds,
    mailboxCount: mailboxIds.length,
    enabled: isRagEnabled(settings),
    embeddings: isRagEmbeddings(settings),
    keywordOnly: settings.ragEmbeddings === false,
    embeddingModel: settings.embeddingModel || '',
    chunkCount: chunks.length,
    attachmentCount: byAttachment.size,
    embeddedCount: chunks.filter((item) => Array.isArray(item.embedding) && item.embedding.length).length,
  });
}));

app.post('/api/rag/search', api(async (req, res) => {
  const settings = readSettings();
  if (!isRagEnabled(settings)) return res.status(400).json({ error: 'RAG 未开启。' });
  const mailboxIds = ownedRequestMailboxScope(req);
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: '请提供检索 query。' });
  const candidateIds = Array.isArray(req.body?.candidateIds)
    ? req.body.candidateIds.map(String).filter(Boolean)
    : undefined;
  res.json(await ragSearch({
    mailboxId: mailboxIds[0],
    mailboxIds,
    query,
    settings,
    candidateIds,
    limit: Math.min(20, Math.max(1, Number(req.body?.limit) || 6)),
  }));
}));

app.post('/api/rag/reindex', api(async (req, res) => {
  const settings = readSettings();
  if (!isRagEnabled(settings)) return res.status(400).json({ error: 'RAG 未开启。' });
  if (syncing || isRecruitmentBusy() || retryingAttachments.size) {
    return res.status(409).json({ error: '请等待当前处理完成后再重建索引。' });
  }
  const mailboxIds = ownedRequestMailboxScope(req);
  const perMailbox = [];
  let chunkCount = 0;
  for (const mailboxId of mailboxIds) {
    const attachments = readRecruitment(mailboxId).attachments || [];
    const emails = readStore(mailboxId).emails || [];
    const attachmentsResult = await reindexMailboxAttachments({ mailboxId, attachments, settings });
    const mail = await reindexMailboxEmails({ mailboxId, emails, settings });
    const chunks = await listChunks(mailboxId);
    chunkCount += chunks.length;
    perMailbox.push({ mailboxId, ...attachmentsResult, mail, chunkCount: chunks.length });
  }
  res.json({
    ...perMailbox[0],
    mailboxId: mailboxIds[0],
    mailboxIds,
    mailboxCount: mailboxIds.length,
    chunkCount,
    perMailbox,
  });
}));

/** 增量补齐未入库历史邮件；已有片段跳过，可在启动与登录后反复调用。 */
app.post('/api/rag/ensure', api(async (req, res) => {
  const settings = readSettings();
  if (!isRagEnabled(settings)) {
    return res.json({ skipped: true, reason: 'rag_disabled', processed: 0, missing: 0 });
  }
  const mailboxIds = ownedRequestMailboxScope(req);
  const perMailbox = [];
  let processed = 0;
  let missing = 0;
  let chunkCount = 0;
  for (const mailboxId of mailboxIds) {
    const emails = readStore(mailboxId).emails || [];
    const result = await ensureMailboxEmailsIndexed({ mailboxId, emails, settings });
    processed += result.processed || 0;
    missing += result.missing || 0;
    chunkCount += result.chunkCount || 0;
    perMailbox.push({ mailboxId, ...result });
  }
  res.json({
    skipped: false,
    mailboxId: mailboxIds[0],
    mailboxIds,
    mailboxCount: mailboxIds.length,
    processed,
    missing,
    chunkCount,
    perMailbox,
  });
}));

app.post('/api/rag/ask', api(async (req, res) => {
  const settings = readSettings();
  if (!isRagEnabled(settings)) return res.status(400).json({ error: 'RAG 未开启。' });
  const mailboxIds = ownedRequestMailboxScope(req);
  const mailboxId = mailboxIds[0];
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '请写出要查找的内容。' });
  res.json(await askMailboxKnowledge({ mailboxId, mailboxIds, message, settings, limit: req.body?.limit }));
}));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message });
});
if (productionRuntime || process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('*', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  // [desktop patch] 动态导入：安装版运行时不含 vite。
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: Number(process.env.DAYLIGHT_HMR_PORT || (Number(process.env.PORT || 3000) + 10000)) } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
// [desktop patch] 桌面端只监听回环地址，不接受外部网卡。
const host = process.env.DAYLIGHT_DESKTOP === '1' ? '127.0.0.1' : (process.env.HOST || (productionRuntime ? '0.0.0.0' : '127.0.0.1'));
async function bootstrapRagKnowledge() {
  try {
    const settings = readSettings();
    if (!isRagEnabled(settings)) return;
    const mailboxes = settings.mailboxes || [];
    let processed = 0;
    for (const mailbox of mailboxes) {
      const emails = readStore(mailbox.id).emails || [];
      const result = await ensureMailboxEmailsIndexed({ mailboxId: mailbox.id, emails, settings });
      processed += result.processed || 0;
    }
    if (processed > 0) console.log(`[rag] bootstrap indexed ${processed} historical emails`);
  } catch (error) {
    console.warn('[rag] bootstrap skipped:', error.message);
  }
}

const server = app.listen(port, host);
server.on('listening', () => {
  health.started();
  const actualPort = server.address().port;
  // [desktop patch] 原生壳层解析这一行拿到实际端口后再导航。
  if (process.env.DAYLIGHT_DESKTOP === '1') console.log(`DAYLIGHT_READY ${actualPort}`);
  else console.log(`Daylight is ready on port ${actualPort}`);
  setTimeout(() => { bootstrapRagKnowledge().catch(() => {}); }, 1500);
});
server.on('error', (error) => {
  // [desktop patch] 端口被占用时回退随机端口，避免用户机器上直接打不开。
  if (error.code === 'EADDRINUSE' && process.env.DAYLIGHT_DESKTOP === '1') server.listen(0, '127.0.0.1');
  else { console.error(error); process.exit(1); }
});
if (productionRuntime) installShutdown({ health, server });
