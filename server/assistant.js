/**
 * 小 D：工作区内自然语言助手，通过工具调用读写当前邮箱的日程 / 待办 / 邮件。
 */
import { randomUUID } from 'node:crypto';
import { completionUrl } from './agent.js';
import { enabledCalendarCategories, resolveEventCategory } from './calendar-categories.js';
import { readSettings, readStore, saveStore } from './store.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_events',
      description: '按关键词或时间范围查找日程',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '标题/地点/备注关键词' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD（含）' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
          limit: { type: 'integer', description: '最多返回条数，默认 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: '新建日程',
      parameters: {
        type: 'object',
        required: ['title', 'start', 'end'],
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO8601，建议带 +08:00' },
          end: { type: 'string', description: 'ISO8601，建议带 +08:00' },
          allDay: { type: 'boolean' },
          category: { type: 'string', description: '日历分类 id，来自用户自定义分类' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_event',
      description: '更新已有日程',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          allDay: { type: 'boolean' },
          category: { type: 'string', description: '日历分类 id' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_event',
      description: '删除日程',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: '列出待办，可按状态筛选',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'done', 'all'] },
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: '更新待办完成状态',
      parameters: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'done'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_emails',
      description: '搜索已处理邮件',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_email',
      description: '按邮件 id 查看原文与元数据',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event_related_emails',
      description: '查看某日程关联的来源/变更邮件',
      parameters: {
        type: 'object',
        required: ['eventId'],
        properties: { eventId: { type: 'string' } },
      },
    },
  },
];

function inRange(iso, from, to) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (from && t < Date.parse(`${from}T00:00:00+08:00`)) return false;
  if (to && t > Date.parse(`${to}T23:59:59+08:00`)) return false;
  return true;
}

function summarizeEvent(event) {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: Boolean(event.allDay),
    category: event.category || 'work',
    location: event.location || '',
    status: event.status || 'active',
    emailId: event.emailId || null,
    changeEmailId: event.changeEmailId || event.cancelledByEmailId || null,
  };
}

function runTool(name, args = {}) {
  const settings = readSettings();
  const categories = enabledCalendarCategories(settings.calendarCategories);
  const store = readStore();
  if (!Array.isArray(store.events)) store.events = [];
  if (!Array.isArray(store.tasks)) store.tasks = [];
  if (!Array.isArray(store.emails)) store.emails = [];
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));

  if (name === 'search_events') {
    const q = String(args.query || '').trim().toLowerCase();
    const list = (store.events || [])
      .filter((event) => (event.status || 'active') !== 'cancelled')
      .filter((event) => {
        if (args.from || args.to) return inRange(event.start, args.from, args.to);
        return true;
      })
      .filter((event) => {
        if (!q) return true;
        return [event.title, event.location, event.description, event.emailSubject]
          .filter(Boolean)
          .some((text) => String(text).toLowerCase().includes(q));
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
      .slice(0, limit)
      .map(summarizeEvent);
    return { events: list, count: list.length };
  }

  if (name === 'create_event') {
    if (!args.title || !args.start || !args.end) throw new Error('创建日程需要 title/start/end');
    if (Date.parse(args.end) <= Date.parse(args.start)) throw new Error('结束时间必须晚于开始时间');
    const event = {
      id: randomUUID(),
      title: String(args.title).trim(),
      start: args.start,
      end: args.end,
      allDay: Boolean(args.allDay),
      category: resolveEventCategory(args.category, categories),
      location: args.location || '',
      description: args.description || '',
      source: 'assistant',
      createdAt: new Date().toISOString(),
    };
    store.events.push(event);
    saveStore(store);
    return { ok: true, event: summarizeEvent(event) };
  }

  if (name === 'update_event') {
    const index = (store.events || []).findIndex((item) => item.id === args.id);
    if (index < 0) throw new Error('日程不存在');
    const next = { ...store.events[index] };
    for (const key of ['title', 'start', 'end', 'allDay', 'category', 'location', 'description']) {
      if (args[key] !== undefined) next[key] = args[key];
    }
    if (next.category !== undefined) next.category = resolveEventCategory(next.category, categories);
    if (Date.parse(next.end) <= Date.parse(next.start)) throw new Error('结束时间必须晚于开始时间');
    store.events[index] = next;
    saveStore(store);
    return { ok: true, event: summarizeEvent(next) };
  }

  if (name === 'delete_event') {
    const before = store.events.length;
    store.events = (store.events || []).filter((item) => item.id !== args.id);
    if (store.events.length === before) throw new Error('日程不存在');
    saveStore(store);
    return { ok: true, deleted: args.id };
  }

  if (name === 'list_tasks') {
    const status = args.status || 'all';
    const q = String(args.query || '').trim().toLowerCase();
    const list = (store.tasks || [])
      .filter((task) => (status === 'all' ? true : task.status === status))
      .filter((task) => {
        if (!q) return true;
        return String(task.title || '').toLowerCase().includes(q);
      })
      .slice(0, limit)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dueAt: task.dueAt || null,
        priority: task.priority || 'normal',
        sources: (task.sources || []).map((s) => ({ emailId: s.emailId, emailSubject: s.emailSubject })),
      }));
    return { tasks: list, count: list.length };
  }

  if (name === 'update_task') {
    const task = (store.tasks || []).find((item) => item.id === args.id);
    if (!task) throw new Error('待办不存在');
    if (!['pending', 'done'].includes(args.status)) throw new Error('status 只能是 pending 或 done');
    task.status = args.status;
    task.completedAt = args.status === 'done' ? new Date().toISOString() : null;
    saveStore(store);
    return { ok: true, task: { id: task.id, title: task.title, status: task.status } };
  }

  if (name === 'search_emails') {
    const q = String(args.query || '').trim().toLowerCase();
    const list = (store.emails || [])
      .filter((email) => {
        if (!q) return true;
        return [email.subject, email.sender, email.body, email.summary]
          .filter(Boolean)
          .some((text) => String(text).toLowerCase().includes(q));
      })
      .slice(0, limit)
      .map((email) => ({
        id: email.id,
        subject: email.subject,
        sender: email.sender,
        receivedAt: email.receivedAt,
        summary: email.extraction?.summary || email.summary || '',
      }));
    return { emails: list, count: list.length };
  }

  if (name === 'get_email') {
    const email = (store.emails || []).find((item) => item.id === args.id);
    if (!email) throw new Error('邮件不存在');
    return {
      id: email.id,
      subject: email.subject,
      sender: email.sender,
      receivedAt: email.receivedAt,
      body: String(email.body || '').slice(0, 4000),
      summary: email.extraction?.summary || email.summary || '',
      attachments: (email.attachments || []).map((file) => ({
        filename: file.filename,
        size: file.size,
        url: file.url || file.proxyUrl,
      })),
    };
  }

  if (name === 'get_event_related_emails') {
    const event = (store.events || []).find((item) => item.id === args.eventId);
    if (!event) throw new Error('日程不存在');
    const ids = [...new Set([event.emailId, event.changeEmailId, event.cancelledByEmailId].filter(Boolean))];
    const emails = ids.map((id) => {
      const email = (store.emails || []).find((item) => item.id === id);
      if (!email) {
        return {
          id,
          missing: true,
          subject: id === event.emailId ? event.emailSubject : event.changeEmailSubject,
          sender: id === event.emailId ? event.emailSender : event.changeEmailSender,
        };
      }
      return {
        id: email.id,
        subject: email.subject,
        sender: email.sender,
        receivedAt: email.receivedAt,
        summary: email.extraction?.summary || email.summary || '',
      };
    });
    return { event: summarizeEvent(event), emails };
  }

  throw new Error(`未知工具：${name}`);
}

async function chatCompletion(settings, messages, { tools } = {}) {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw Object.assign(new Error('请先在设置中配置模型 Base URL、API Key 和模型名称'), { status: 400 });
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
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch {
    throw Object.assign(new Error(`模型返回非 JSON：${text.slice(0, 200)}`), { status: 502 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || `模型调用失败 ${response.status}`), { status: 502 });
  }
  return payload;
}

const SYSTEM_PROMPT = `你是 Daylight 工作区助手「小 D」。
你可以帮助用户用自然语言查询、创建、修改、删除日程，查看待办与邮件，并说明日程关联的来源邮件。
时间统一按北京时间（Asia/Shanghai / UTC+08:00）。创建或修改日程时 start/end 请使用带 +08:00 的 ISO8601。
不要编造不存在的日程或邮件；不确定时先调用工具查询。
回答简洁、用中文；执行写操作后简要确认结果。`;

export async function runAssistantChat({ messages = [] } = {}) {
  const settings = readSettings();
  const categoryHint = enabledCalendarCategories(settings.calendarCategories)
    .map((item) => `${item.id}（${item.label}）`)
    .join('、');
  const history = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n可用日历分类：${categoryHint || 'work、personal'}。创建/修改日程时 category 使用分类 id。`,
    },
    ...messages
      .filter((item) => item && item.role && item.content != null)
      .map((item) => ({ role: item.role, content: String(item.content) }))
      .slice(-16),
  ];

  const toolTrace = [];
  let rounds = 0;
  while (rounds < 6) {
    rounds += 1;
    const completion = await chatCompletion(settings, history, { tools: TOOLS });
    const choice = completion.choices?.[0]?.message;
    if (!choice) throw Object.assign(new Error('模型未返回内容'), { status: 502 });

    const toolCalls = choice.tool_calls || [];
    if (!toolCalls.length) {
      return {
        reply: choice.content || '好的。',
        toolTrace,
        usage: completion.usage || null,
      };
    }

    history.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      let result;
      try {
        result = runTool(name, args);
      } catch (error) {
        result = { ok: false, error: error.message };
      }
      toolTrace.push({ name, args, result });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply: '我已执行多步工具调用，但尚未形成最终答复。请把问题再说具体一点。',
    toolTrace,
  };
}
