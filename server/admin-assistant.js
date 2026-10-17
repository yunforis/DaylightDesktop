/**
 * 管理端小 D：意图声明 + 管理 API / 系统运维工具调用。
 * 破坏性操作须 confirm=true。
 */
import { completionUrl, formatModelFetchError } from './agent.js';
import {
  adminCreateUser, adminDeleteUser, adminForceLogoutUser, adminGetUser,
  adminListUsers, adminUpdateUser, requireAdminFromHeader,
} from './auth.js';
import { mailboxTagLabel, publicSettings, readSettings, readStore } from './store.js';
import { modelFetch } from './model-fetch.js';
import { sanitizeSnapshot, usageMetrics, readTraces } from './traces.js';
import {
  infraHealth, publicInfraConfig, readInfraConfig, reloadInfra,
} from './infra/index.js';
import { mergeInfraSecrets } from './infra/config.js';
import { listJobs, testQueueConnection } from './infra/queue.js';
import { testOssConnection } from './infra/oss.js';
import { listUsers } from './infra/postgres.js';
import {
  readMailTemplates, saveMailTemplates, resetMailTemplates, TEMPLATE_META,
  renderMailTemplate,
} from './mail-templates.js';
import {
  readOnboardingGuideAsync, saveOnboardingGuide, resetOnboardingGuide,
} from './onboarding-guide.js';
import { sendTemplatedMail, systemMailReady } from './mailer.js';
import { idleStatus } from './idle-sync.js';

function tool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

const TOOLS = [
  tool('declare_intent', '必须首先调用：声明用户意图、风险等级与执行计划，供界面展示意图识别。', {
    type: 'object',
    required: ['intent', 'category', 'risk', 'plan'],
    properties: {
      intent: { type: 'string', description: '一句话意图摘要（中文）' },
      category: {
        type: 'string',
        enum: ['query', 'monitor', 'user', 'mailbox', 'infra', 'mail', 'settings', 'guide', 'other'],
      },
      risk: { type: 'string', enum: ['read', 'write', 'dangerous'] },
      plan: { type: 'array', items: { type: 'string' }, description: '拟执行步骤列表' },
    },
  }),
  tool('list_capabilities', '列出管理端小 D 可用工具与对应管理 API，便于介绍系统能力。', {
    type: 'object',
    properties: {},
  }),
  tool('get_current_time', '获取服务端当前北京时间。', { type: 'object', properties: {} }),
  tool('get_overview', '系统总览：用户数、邮箱数、日程/邮件/待办/证据链计数、infra 状态。', {
    type: 'object',
    properties: {},
  }),
  tool('get_monitor', '运维监控：同步状态、IDLE、队列任务、最近处理日志。', {
    type: 'object',
    properties: { traceLimit: { type: 'integer' } },
  }),
  tool('search_system', '跨用户、邮箱、近期证据链关键词检索。', {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
  }),
  tool('list_users', '列出全部用户（id/邮箱/角色/场景）。', {
    type: 'object',
    properties: { query: { type: 'string', description: '可选，按邮箱或用户名过滤' } },
  }),
  tool('get_user', '查看用户详情及关联邮箱。', {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'string' } },
  }),
  tool('create_user', '创建用户。写操作。', {
    type: 'object',
    required: ['email', 'username', 'password'],
    properties: {
      email: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
      role: { type: 'string', enum: ['user', 'admin'] },
    },
  }),
  tool('update_user', '更新用户角色/资料。写操作。', {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string' },
      role: { type: 'string', enum: ['user', 'admin'] },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  }),
  tool('force_logout_user', '强制用户下线（撤销会话）。危险操作，须 confirm=true。', {
    type: 'object',
    required: ['userId', 'confirm'],
    properties: {
      userId: { type: 'string' },
      confirm: { type: 'boolean' },
    },
  }),
  tool('delete_user', '删除用户。危险操作，须 confirm=true。', {
    type: 'object',
    required: ['userId', 'confirm'],
    properties: {
      userId: { type: 'string' },
      confirm: { type: 'boolean' },
    },
  }),
  tool('list_mailboxes', '列出全部邮箱及归属、统计。', {
    type: 'object',
    properties: { query: { type: 'string' } },
  }),
  tool('get_infra', '读取基础设施公开配置与健康状态。', { type: 'object', properties: {} }),
  tool('test_oss', '测试对象存储连通性。', { type: 'object', properties: {} }),
  tool('test_mq', '测试消息队列连通性。', { type: 'object', properties: {} }),
  tool('reload_infra', '热加载当前 infra 配置。写操作。', { type: 'object', properties: {} }),
  tool('update_auth_gate', '更新认证门禁（requireAuth / allowLocalDemoLogin / adminEmails）。写操作；开启强制登录须谨慎。', {
    type: 'object',
    required: ['confirm'],
    properties: {
      requireAuth: { type: 'boolean' },
      allowLocalDemoLogin: { type: 'boolean' },
      adminEmails: { type: 'array', items: { type: 'string' } },
      confirm: { type: 'boolean' },
    },
  }),
  tool('get_mail_templates', '读取系统邮件模板列表与元数据。', { type: 'object', properties: {} }),
  tool('preview_mail_template', '预览指定邮件模板。', {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  }),
  tool('send_test_mail', '向指定地址发送模板测试邮件。写操作。', {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      to: { type: 'string', description: '收件人，默认管理员邮箱' },
    },
  }),
  tool('reset_mail_templates', '恢复默认邮件模板。危险操作，须 confirm=true。', {
    type: 'object',
    required: ['confirm'],
    properties: { confirm: { type: 'boolean' } },
  }),
  tool('get_onboarding_guide', '读取新手引导步骤。', { type: 'object', properties: {} }),
  tool('reset_onboarding_guide', '恢复默认新手引导。危险操作，须 confirm=true。', {
    type: 'object',
    required: ['confirm'],
    properties: { confirm: { type: 'boolean' } },
  }),
  tool('get_workspace_settings', '读取共享工作区模型/邮箱公开设置。', { type: 'object', properties: {} }),
  tool('list_jobs', '列出队列任务。', {
    type: 'object',
    properties: { limit: { type: 'integer' } },
  }),
];

function mailboxStats(settings = readSettings()) {
  return (settings.mailboxes || []).map((mailbox) => {
    const store = readStore(mailbox.id);
    const traces = readTraces(mailbox.id);
    return {
      id: mailbox.id,
      email: mailbox.email,
      tag: mailbox.tag,
      tagLabel: mailboxTagLabel(mailbox),
      provider: mailbox.provider,
      ownerUserId: mailbox.ownerUserId || mailbox.userId || null,
      events: (store.events || []).length,
      emails: (store.emails || []).length,
      tasks: (store.tasks || []).length,
      traces: (traces || []).length,
    };
  });
}

function currentTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(now);
  return { date, time, datetime: `${date} ${time}`, weekday, timezone: 'Asia/Shanghai' };
}

function requireConfirm(args, label) {
  if (args?.confirm !== true) {
    throw new Error(`${label}为危险操作，请再次确认并将 confirm 设为 true。`);
  }
}

async function runTool(name, args, { admin, syncState }) {
  if (name === 'declare_intent') {
    return {
      ok: true,
      intent: String(args.intent || '').trim(),
      category: args.category || 'other',
      risk: args.risk || 'read',
      plan: Array.isArray(args.plan) ? args.plan.map(String) : [],
    };
  }
  if (name === 'list_capabilities') {
    return {
      tools: TOOLS.map((item) => ({
        name: item.function.name,
        description: item.function.description,
      })),
      apis: [
        'GET /api/admin/overview', 'GET /api/admin/monitor', 'GET|POST|PUT|DELETE /api/admin/users*',
        'GET /api/admin/mailboxes', 'GET|PUT /api/admin/infra', 'POST /api/admin/infra/test-*',
        'GET|PUT /api/admin/settings', 'GET|PUT|POST /api/admin/mail-templates*',
        'GET|PUT|POST /api/admin/onboarding-guide*', 'POST /api/admin/assistant/chat',
      ],
    };
  }
  if (name === 'get_current_time') return currentTime();

  if (name === 'get_overview') {
    const settings = readSettings();
    const mailboxes = mailboxStats(settings);
    const health = await infraHealth();
    return {
      users: (await adminListUsers()).length,
      mailboxes: mailboxes.length,
      events: mailboxes.reduce((s, i) => s + i.events, 0),
      emails: mailboxes.reduce((s, i) => s + i.emails, 0),
      tasks: mailboxes.reduce((s, i) => s + i.tasks, 0),
      traces: mailboxes.reduce((s, i) => s + i.traces, 0),
      systemMailReady: systemMailReady(),
      infra: health.config,
      status: health.status,
      sync: syncState || null,
      idle: idleStatus(),
      jobs: listJobs(20),
    };
  }

  if (name === 'get_monitor') {
    const settings = readSettings();
    const health = await infraHealth();
    const limit = Math.min(80, Math.max(5, Number(args.traceLimit) || 40));
    const recentTraces = [];
    for (const mailbox of settings.mailboxes || []) {
      for (const trace of readTraces(mailbox.id).slice(-30)) {
        recentTraces.push({
          mailboxId: mailbox.id,
          mailboxEmail: mailbox.email,
          trace_id: trace.trace_id,
          subject: trace.subject || trace.input?.subject || '',
          status: trace.status || '',
          mode: trace.mode || '',
          created_at: trace.created_at || trace.started_at || null,
          error: trace.error || '',
        });
      }
    }
    recentTraces.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return {
      sync: syncState || null,
      idle: idleStatus(),
      jobs: listJobs(40),
      status: health.status,
      mailboxStats: mailboxStats(settings),
      recentTraces: recentTraces.slice(0, limit),
    };
  }

  if (name === 'search_system') {
    const q = String(args.query || '').trim().toLowerCase();
    if (!q) return { users: [], mailboxes: [], traces: [] };
    const limit = Math.min(40, Math.max(1, Number(args.limit) || 20));
    const users = (await adminListUsers()).filter((u) => (
      `${u.email || ''} ${u.username || ''} ${u.role || ''} ${u.workspaceMode || ''}`.toLowerCase().includes(q)
    )).slice(0, limit);
    const mailboxes = mailboxStats(readSettings()).filter((m) => (
      `${m.email || ''} ${m.tagLabel || ''} ${m.provider || ''} ${m.ownerUserId || ''}`.toLowerCase().includes(q)
    )).slice(0, limit);
    const traces = [];
    for (const mailbox of readSettings().mailboxes || []) {
      for (const trace of readTraces(mailbox.id).slice(-40)) {
        const hay = `${trace.subject || ''} ${trace.status || ''} ${trace.error || ''} ${trace.trace_id || ''}`.toLowerCase();
        if (hay.includes(q)) {
          traces.push({
            mailboxId: mailbox.id,
            mailboxEmail: mailbox.email,
            trace_id: trace.trace_id,
            subject: trace.subject || '',
            status: trace.status || '',
          });
        }
      }
    }
    return { query: q, users, mailboxes, traces: traces.slice(0, limit) };
  }

  if (name === 'list_users') {
    let users = await adminListUsers();
    const q = String(args.query || '').trim().toLowerCase();
    if (q) {
      users = users.filter((u) => `${u.email || ''} ${u.username || ''}`.toLowerCase().includes(q));
    }
    return {
      users: users.map((u) => ({
        id: u.id, email: u.email, username: u.username, role: u.role, workspaceMode: u.workspaceMode,
      })),
      count: users.length,
    };
  }

  if (name === 'get_user') {
    const detail = await adminGetUser(args.userId);
    const settings = readSettings();
    const mailboxes = (settings.mailboxes || [])
      .filter((m) => (m.ownerUserId || m.userId) === detail.user.id
        || String(m.email || '').toLowerCase() === String(detail.user.email || '').toLowerCase())
      .map((m) => ({ id: m.id, email: m.email, tag: m.tag, provider: m.provider }));
    return { ...detail, mailboxes };
  }

  if (name === 'create_user') {
    const user = await adminCreateUser(args);
    return { ok: true, user: { id: user.id, email: user.email, username: user.username, role: user.role } };
  }

  if (name === 'update_user') {
    const { userId, ...patch } = args;
    const user = await adminUpdateUser(userId, patch);
    return { ok: true, user: { id: user.id, email: user.email, username: user.username, role: user.role, workspaceMode: user.workspaceMode } };
  }

  if (name === 'force_logout_user') {
    requireConfirm(args, '强制下线');
    return adminForceLogoutUser(args.userId, admin.id);
  }

  if (name === 'delete_user') {
    requireConfirm(args, '删除用户');
    return adminDeleteUser(args.userId, admin.id);
  }

  if (name === 'list_mailboxes') {
    const settings = readSettings();
    const users = await listUsers().catch(() => []);
    const byId = new Map(users.map((u) => [u.id, u]));
    let list = mailboxStats(settings).map((item) => {
      const raw = (settings.mailboxes || []).find((m) => m.id === item.id) || {};
      const owner = (raw.ownerUserId && byId.get(raw.ownerUserId)) || null;
      return {
        ...item,
        ownerUsername: owner?.username || null,
        ownerEmail: owner?.email || null,
      };
    });
    const q = String(args.query || '').trim().toLowerCase();
    if (q) list = list.filter((m) => `${m.email} ${m.ownerUsername || ''} ${m.ownerEmail || ''}`.toLowerCase().includes(q));
    return { mailboxes: list, activeMailboxId: settings.activeMailboxId };
  }

  if (name === 'get_infra') {
    const health = await infraHealth();
    return { config: publicInfraConfig(), status: health.status, health };
  }

  if (name === 'test_oss') {
    const current = readInfraConfig({ force: true });
    return testOssConnection(current.oss);
  }

  if (name === 'test_mq') {
    const current = readInfraConfig({ force: true });
    return testQueueConnection(current.mq);
  }

  if (name === 'reload_infra') {
    return reloadInfra(readInfraConfig({ force: true }));
  }

  if (name === 'update_auth_gate') {
    requireConfirm(args, '修改认证门禁');
    const current = readInfraConfig({ force: true });
    const nextAuth = {
      ...current.auth,
      ...(args.requireAuth !== undefined ? { requireAuth: Boolean(args.requireAuth) } : {}),
      ...(args.allowLocalDemoLogin !== undefined ? { allowLocalDemoLogin: Boolean(args.allowLocalDemoLogin) } : {}),
      ...(Array.isArray(args.adminEmails) ? {
        adminEmails: args.adminEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean),
      } : {}),
    };
    const next = mergeInfraSecrets({ ...current, auth: nextAuth }, current);
    return reloadInfra(next);
  }

  if (name === 'get_mail_templates') {
    return { templates: readMailTemplates(), meta: TEMPLATE_META, systemMailReady: systemMailReady() };
  }

  if (name === 'preview_mail_template') {
    return {
      preview: renderMailTemplate(args.id, {
        code: '123456',
        email: admin.email || 'demo@example.com',
        username: admin.username || '管理员',
        minutes: 10,
        resetUrl: 'http://127.0.0.1:3000/reset-password?token=demo',
        title: '示例通知标题',
        body: '这是一封预览通知正文。',
        version: '0.1.0',
      }),
    };
  }

  if (name === 'send_test_mail') {
    const target = String(args.to || admin.email || '').trim();
    if (!target) throw new Error('请提供收件人 to');
    return sendTemplatedMail(args.id, {
      to: target,
      vars: {
        code: '123456',
        email: target,
        username: admin.username || '管理员',
        minutes: 10,
        resetUrl: 'http://127.0.0.1:3000/reset-password?token=demo',
        title: 'Daylight 测试通知',
        body: '这是一封由管理端小 D 发出的模板测试邮件。',
        version: '0.1.0',
      },
    });
  }

  if (name === 'reset_mail_templates') {
    requireConfirm(args, '重置邮件模板');
    return { templates: resetMailTemplates() };
  }

  if (name === 'get_onboarding_guide') return readOnboardingGuideAsync();

  if (name === 'reset_onboarding_guide') {
    requireConfirm(args, '重置新手引导');
    return resetOnboardingGuide();
  }

  if (name === 'get_workspace_settings') {
    return { settings: publicSettings(readSettings()) };
  }

  if (name === 'list_jobs') {
    return { jobs: listJobs(Math.min(80, Math.max(1, Number(args.limit) || 40))), idle: idleStatus() };
  }

  throw new Error(`未知工具：${name}`);
}

async function chatCompletion(settings, messages, { tools, timeoutMs = 60_000 } = {}) {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw Object.assign(new Error('请先在工作区设置中配置模型 Base URL、API Key 和模型名称（管理端小 D 复用该配置）'), { status: 400 });
  }
  const endpoint = completionUrl(settings.baseUrl);
  const body = {
    model: settings.model,
    messages,
    temperature: 0.2,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (new URL(endpoint).hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model)) {
    body.thinking = { type: 'disabled' };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await modelFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw Object.assign(new Error('模型返回非 JSON'), { status: 502 });
    }
    if (!response.ok) {
      const upstream = payload.error?.message || payload.message || `模型调用失败 ${response.status}`;
      throw Object.assign(new Error(formatModelFetchError({ message: upstream }, settings)), { status: 502 });
    }
    return payload;
  } catch (error) {
    if (signal.aborted) {
      throw Object.assign(new Error(`模型请求超过 ${timeoutMs / 1000} 秒`), { status: 504 });
    }
    if (error.status === 502) throw error;
    throw Object.assign(new Error(sanitizeSnapshot(formatModelFetchError(error, settings), [settings.apiKey])), {
      status: error.status || 502,
    });
  }
}

const SYSTEM_PROMPT = `你是 Daylight 全局管理员助手「管理端小 D」。
你面向已鉴权的系统管理员，可调用管理工具查询与变更：用户、邮箱、同步/队列监控、基础设施（OSS/MQ/认证门禁）、系统邮件模板、新手引导、共享工作区设置。
规则：
1. 每轮对话的第一次工具调用必须是 declare_intent，清楚说明意图、类别、风险（read/write/dangerous）与计划步骤。
2. 只根据工具真实返回作答，不编造用户数、队列状态或配置。
3. 危险操作（删除用户、强制下线、重置模板/引导、改认证门禁）必须先说明风险，再在工具参数中确认 confirm=true；用户未明确要求时不要执行。
4. 不要泄露 API Key、授权码、JWT、App Secret；工具结果中若含密钥只概述「已配置」。
5. 时间用北京时间。回答简洁中文；写操作后简要确认结果。
6. 可用 list_capabilities 介绍系统管理能力与对应接口。`;

function emit(onEvent, event) {
  if (typeof onEvent === 'function') onEvent(event);
}

function mergeUsage(total, usage, settings) {
  const metrics = usageMetrics(usage, settings);
  if (metrics.llm_tokens_in != null) total.prompt_tokens += metrics.llm_tokens_in;
  if (metrics.llm_tokens_out != null) total.completion_tokens += metrics.llm_tokens_out;
  if (metrics.llm_tokens_cached_in != null) total.cached_tokens += metrics.llm_tokens_cached_in;
  if (metrics.cost_cny != null) {
    total.cost_cny += metrics.cost_cny;
  } else if (usage) {
    total.cost_known = false;
  }
  total.rounds += 1;
  return metrics;
}

function costSummary(total, settings) {
  const known = total.cost_known !== false && Number.isFinite(total.cost_cny);
  return {
    usage: {
      prompt_tokens: total.prompt_tokens || null,
      completion_tokens: total.completion_tokens || null,
      cached_tokens: total.cached_tokens || null,
    },
    cost_cny: known ? total.cost_cny : null,
    cost_status: known ? 'known' : 'price_missing',
    pricing: usageMetrics({
      prompt_tokens: total.prompt_tokens,
      completion_tokens: total.completion_tokens,
      prompt_tokens_details: { cached_tokens: total.cached_tokens },
    }, settings).pricing,
  };
}

/**
 * @param {{ messages: Array, authorization?: string, syncState?: object }} input
 */
export async function runAdminAssistantChat(
  { messages = [], authorization, syncState } = {},
  { timeoutMs = 90_000, onEvent } = {},
) {
  const admin = await requireAdminFromHeader(authorization);
  const settings = readSettings();
  const history = [
    { role: 'system', content: '' },
    ...messages
      .filter((item) => item && ['user', 'assistant'].includes(item.role) && item.content != null)
      .map((item) => ({ role: item.role, content: String(item.content) }))
      .slice(-16),
  ];

  const toolTrace = [];
  let intent = null;
  const usageTotal = {
    prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0,
    cost_cny: 0, cost_known: true, rounds: 0,
  };
  let rounds = 0;
  emit(onEvent, { type: 'status', message: '正在识别意图…' });

  while (rounds < 8) {
    rounds += 1;
    const now = currentTime();
    history[0].content = `${SYSTEM_PROMPT}\n服务端当前北京时间：${now.datetime}（${now.weekday}）。当前管理员：${admin.username || admin.email}。`;
    emit(onEvent, { type: 'round', round: rounds, message: `第 ${rounds} 轮模型调用` });

    let completion;
    try {
      completion = await chatCompletion(settings, history, { tools: TOOLS, timeoutMs });
      if (!completion.choices?.[0]?.message) throw Object.assign(new Error('模型未返回内容'), { status: 502 });
    } catch (error) {
      if (!toolTrace.length) throw error;
      const cost = costSummary(usageTotal, settings);
      const payload = {
        reply: `处理中断：${error.message}`,
        toolTrace,
        intent,
        interrupted: true,
        ...cost,
      };
      emit(onEvent, { type: 'done', ...payload });
      return payload;
    }

    mergeUsage(usageTotal, completion.usage, settings);
    emit(onEvent, {
      type: 'usage',
      round: rounds,
      usage: completion.usage || null,
      cost: costSummary(usageTotal, settings),
    });

    const choice = completion.choices[0].message;
    const toolCalls = choice.tool_calls || [];
    if (!toolCalls.length) {
      const cost = costSummary(usageTotal, settings);
      const payload = {
        reply: choice.content || '好的。',
        toolTrace,
        intent,
        ...cost,
      };
      emit(onEvent, { type: 'done', ...payload });
      return payload;
    }

    history.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      let result;
      const started = Date.now();
      try {
        try { args = JSON.parse(call.function?.arguments || '{}'); }
        catch { throw new Error('工具参数不是有效 JSON'); }
      } catch (error) {
        args = {};
        result = { ok: false, error: error.message };
      }
      emit(onEvent, {
        type: 'tool_start',
        name,
        args,
        running: true,
        label: name === 'declare_intent' ? '意图识别' : undefined,
      });
      if (!result) {
        try {
          result = await runTool(name, args, { admin, syncState });
          if (name === 'declare_intent' && result?.intent) {
            intent = result;
            emit(onEvent, { type: 'intent', intent: result });
          }
        } catch (error) {
          result = { ok: false, error: error.message };
        }
      }
      const entry = {
        name,
        args,
        result,
        latency_ms: Date.now() - started,
        kind: name === 'declare_intent' ? 'intent' : 'tool',
      };
      toolTrace.push(entry);
      emit(onEvent, { type: 'tool_end', ...entry, running: false });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  const cost = costSummary(usageTotal, settings);
  const payload = {
    reply: '已达到工具调用轮数上限，请根据已执行步骤继续提问。',
    toolTrace,
    intent,
    interrupted: true,
    ...cost,
  };
  emit(onEvent, { type: 'done', ...payload });
  return payload;
}

/** 管理端全局搜索索引（高覆盖）。 */
export async function buildAdminSearchIndex({ syncState } = {}) {
  const settings = readSettings();
  const users = await adminListUsers().catch(() => []);
  const mailboxes = mailboxStats(settings);
  const health = await infraHealth().catch(() => ({ status: {}, config: {} }));
  const pages = [
    { id: 'nav-overview', label: '总览', path: '/admin', group: '导航', keywords: 'overview dashboard 首页' },
    { id: 'nav-jobs', label: '同步与队列', path: '/admin/monitor/jobs', group: '导航', keywords: 'sync queue rabbitmq job IDLE' },
    { id: 'nav-traces', label: '处理日志', path: '/admin/monitor/traces', group: '导航', keywords: 'trace 证据链 日志' },
    { id: 'nav-users', label: '用户管理', path: '/admin/users', group: '导航', keywords: '账号 role HR personal' },
    { id: 'nav-auth', label: '认证门禁', path: '/admin/auth', group: '导航', keywords: '登录 jwt requireAuth adminEmails' },
    { id: 'nav-mailboxes', label: '邮箱管理', path: '/admin/mailboxes', group: '导航', keywords: 'imap smtp 邮箱' },
    { id: 'nav-workspace', label: '模型与工作区', path: '/admin/workspace', group: '导航', keywords: 'model api key deepseek' },
    { id: 'nav-onboarding', label: '新手引导', path: '/admin/onboarding', group: '导航', keywords: 'onboarding 引导' },
    { id: 'nav-storage', label: '本地存储', path: '/admin/storage', group: '导航', keywords: 'data 磁盘' },
    { id: 'nav-oss', label: '对象存储', path: '/admin/storage/oss', group: '导航', keywords: 'oss s3 七牛 又拍 阿里云 US3' },
    { id: 'nav-mail', label: '系统发信', path: '/admin/mail', group: '导航', keywords: 'smtp 模板 验证码 邮件' },
  ];
  const configItems = [
    {
      id: 'cfg-auth',
      label: `认证 · 强制登录 ${health.config?.auth?.requireAuth ? '开' : '关'}`,
      path: '/admin/auth',
      group: '系统配置',
      keywords: `requireAuth ${health.config?.auth?.adminEmails?.join(' ') || ''} jwt`,
      hint: (health.config?.auth?.adminEmails || []).join(', ') || '管理员邮箱列表',
    },
    {
      id: 'cfg-oss',
      label: `对象存储 · ${health.config?.oss?.provider || '未配置'}`,
      path: '/admin/storage/oss',
      group: '系统配置',
      keywords: `oss ${health.config?.oss?.provider || ''} bucket`,
      hint: health.status?.oss || '',
    },
    {
      id: 'cfg-mq',
      label: `消息队列 · ${health.config?.mq?.enabled ? '启用' : '关闭'}`,
      path: '/admin/monitor/jobs',
      group: '系统配置',
      keywords: 'rabbitmq mq queue',
      hint: health.status?.mq || '',
    },
    {
      id: 'cfg-mail',
      label: `系统发信 · ${systemMailReady() ? '就绪' : '未就绪'}`,
      path: '/admin/mail',
      group: '系统配置',
      keywords: 'smtp mailer 发信',
    },
    {
      id: 'cfg-model',
      label: `共享模型 · ${settings.model || '未配置'}`,
      path: '/admin/workspace',
      group: '系统配置',
      keywords: `模型 model api key openai deepseek ${settings.model || ''} ${settings.baseUrl || ''} 飞书 RAG embedding`,
      hint: settings.baseUrl || '模型与 API Key',
    },
    {
      id: 'nav-workspace-model',
      label: '模型与工作区设置',
      path: '/admin/workspace',
      group: '导航',
      keywords: '模型 model api key 工作区 base url 单价',
      hint: '共享模型配置',
    },
  ];
  const userItems = users.map((u) => ({
    id: `user-${u.id}`,
    label: u.username || u.email || u.id,
    hint: [u.email, u.role, u.workspaceMode].filter(Boolean).join(' · '),
    path: `/admin/users/${u.id}`,
    group: '用户',
    keywords: `${u.email || ''} ${u.role || ''} ${u.workspaceMode || ''} admin hr personal`,
  }));
  const mailboxItems = mailboxes.map((m) => ({
    id: `mb-${m.id}`,
    label: m.email || m.id,
    hint: `${m.tagLabel || m.tag || ''} · 日程 ${m.events} · 邮件 ${m.emails}`,
    path: '/admin/mailboxes',
    group: '邮箱',
    keywords: `${m.provider || ''} ${m.ownerUserId || ''} imap`,
  }));
  const templateMetaById = Object.fromEntries((TEMPLATE_META || []).map((item) => [item.id, item]));
  const templates = Object.keys(readMailTemplates() || {}).map((id) => ({
    id: `tpl-${id}`,
    label: `邮件模板 · ${templateMetaById[id]?.label || id}`,
    path: '/admin/mail',
    group: '邮件模板',
    keywords: `${id} ${templateMetaById[id]?.label || ''} smtp 验证码`,
    hint: id,
  }));
  const jobs = listJobs(30).map((job) => ({
    id: `job-${job.id || job.name}-${job.createdAt || ''}`,
    label: job.name || job.type || '队列任务',
    hint: [job.status, job.queue].filter(Boolean).join(' · '),
    path: '/admin/monitor/jobs',
    group: '队列任务',
    keywords: `${job.name || ''} ${job.status || ''} rabbitmq`,
  }));
  const traces = [];
  for (const mailbox of settings.mailboxes || []) {
    for (const trace of readTraces(mailbox.id).slice(-25)) {
      traces.push({
        id: `trace-${trace.trace_id}`,
        label: trace.subject || '处理记录',
        hint: `${mailbox.email || mailbox.id} · ${trace.status || ''}`,
        path: '/admin/monitor/traces',
        group: '处理日志',
        keywords: `${trace.trace_id} ${trace.mode || ''} ${trace.error || ''}`,
      });
    }
  }
  const actions = [
    { id: 'act-little-d', label: '打开管理端小 D', path: null, group: '操作', keywords: '助手 admin little-d', action: 'open-little-d' },
    { id: 'act-app', label: '前往用户工作区', path: '/app', group: '操作', keywords: '用户端 workspace' },
  ];
  if (syncState?.status) {
    actions.push({
      id: 'act-sync',
      label: `当前同步 · ${syncState.status}`,
      path: '/admin/monitor/jobs',
      group: '操作',
      keywords: `sync ${syncState.trigger || ''} ${syncState.mailboxId || ''}`,
      hint: syncState.mailboxId || '',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    items: [...actions, ...pages, ...configItems, ...userItems, ...mailboxItems, ...templates, ...jobs, ...traces],
  };
}
