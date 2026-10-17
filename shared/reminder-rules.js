/**
 * 提醒规则（Reminder rules）：数据模型、匹配与排期。前后端共用。
 *
 * 为什么放在 shared/：
 * - 规则由手机端执行（iOS 本地通知：横幅/声音/锁屏），但「一句话设置」由后端模型把
 *   自然语言解析成同一套结构。两边必须共用同一份定义与校验，否则模型产出的字段会在
 *   客户端被静默丢掉。
 * - 这里保持纯函数、零依赖，服务端、客户端与两边的测试都直接 import。
 *
 * 时间口径：全部按北京时间（UTC+08:00）。截止时间来自后端已有的明确时刻：
 * 日程 start、待办 dueAt、工作台 action.dueAt、邮件里识别到的 dueAt；没有具体时刻的
 * 截止在后端已经归一到当天 18:00，这里不再重新解释文本。
 *
 * 「允许提醒的时间段」而不是「免打扰」：规则命中后如果算出来的时刻落在允许段之外，
 * 就顺延到当天的允许段开始；顺延后仍然晚于截止时间的那一条直接丢弃（不做过期骚扰），
 * 需要过期后继续催就显式打开 overdue。
 */

export const REMINDER_VERSION = 1;

/** 可被提醒的对象。顺序即展示顺序。 */
export const REMINDER_TARGETS = [
  { id: 'event', label: '日程开始', hint: '按日程开始时间倒数提醒' },
  { id: 'task', label: '待办截止', hint: '按待办截止时间倒数提醒' },
  { id: 'action', label: '工作台行动', hint: '报名、材料提交等工作台行动截止' },
  { id: 'mail', label: '邮件里的截止', hint: '邮件中识别到、尚未成为待办的截止时间' },
];

export const REMINDER_UNIT_MINUTES = { minute: 1, minutes: 1, hour: 60, hours: 60, day: 1440, days: 1440 };

/** 默认允许提醒的时间段：白天，避免深夜打扰。 */
export const DEFAULT_WINDOW = { start: '08:00', end: '22:00' };

/** iOS 待发送本地通知上限是 64 条，留出余量只排最近的这些。 */
export const DEFAULT_MAX_PENDING = 60;
export const MAX_PENDING_LIMIT = 64;

export const MAX_RULES = 30;
export const MAX_OFFSETS_PER_RULE = 8;
export const MAX_KEYWORDS = 12;
/** 提前量上限 90 天：再长也没有提醒价值。 */
export const MAX_OFFSET_MINUTES = 90 * 1440;
/** 过期提醒最多持续 30 天，避免一条忘了勾掉的待办无限打扰。 */
export const OVERDUE_MAX_DAYS = 30;
export const OVERDUE_MAX_TIMES = 10;

const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 北京时间的日历字段。 */
function beijingParts(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** 把北京时间的墙上时间换成真实时刻（UTC 毫秒）。 */
function beijingWallToMs(parts, hour, minute) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0) - BEIJING_OFFSET_MS;
}

function parseTime(text) {
  const match = TIME_PATTERN.exec(String(text || '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function toText(...values) {
  return values
    .map((value) => (value === null || value === undefined ? '' : String(value)))
    .filter(Boolean)
    .join(' ');
}

function trimText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function newRuleId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `rm_${uuid.replace(/-/g, '').slice(0, 16)}`;
  return `rm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 「3 天」「1 小时」「30 分钟」「1 天 2 小时」。 */
export function formatOffset(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (!total) return '0 分钟';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (mins) parts.push(`${mins} 分钟`);
  return parts.join(' ');
}

/** 「还有 4 小时」「已过期 2 天」。 */
export function formatRemaining(deltaMs) {
  const abs = Math.abs(Number(deltaMs) || 0);
  const label = formatOffset(Math.floor(abs / 60_000));
  if (abs < 60_000) return '不到 1 分钟';
  return Number(deltaMs) >= 0 ? `还有 ${label}` : `已过期 ${label}`;
}

/** 「10月20日」/「10月20日 23:59」（北京时间）。 */
export function formatBeijingDate(value, { time = true } = {}) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return '';
  const parts = beijingParts(ms);
  const date = `${parts.month}月${parts.day}日`;
  return time ? `${date} ${pad(parts.hour)}:${pad(parts.minute)}` : date;
}

/** 允许提醒的时间段。跨天（end<=start）不支持，直接回退，避免半懂不懂的顺延。 */
export function normalizeWindow(value, fallback = null) {
  if (!value || typeof value !== 'object') return fallback;
  const start = parseTime(value.start);
  const end = parseTime(value.end);
  if (!start || !end) return fallback;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (endMinutes <= startMinutes) return fallback;
  return { start: `${pad(start.hour)}:${pad(start.minute)}`, end: `${pad(end.hour)}:${pad(end.minute)}` };
}

function cleanKeywords(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[，,、;；/\s]+/);
  const out = [];
  for (const raw of list) {
    const text = String(raw ?? '').trim().slice(0, 24);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** 提前量统一存成「分钟数」数组，从大到小（展示顺序即 3 天 → 1 天 → 4 小时）。 */
export function normalizeOffsets(value) {
  const list = Array.isArray(value) ? value : [];
  const minutes = [];
  for (const entry of list) {
    let total = null;
    if (typeof entry === 'number' && Number.isFinite(entry)) total = Math.round(entry);
    else if (typeof entry === 'string' && Number.isFinite(Number(entry))) total = Math.round(Number(entry));
    else if (entry && typeof entry === 'object') {
      const unit = REMINDER_UNIT_MINUTES[String(entry.unit || 'minute').toLowerCase()];
      const amount = Number(entry.value ?? entry.amount ?? entry.minutes ?? entry.count);
      if (unit && Number.isFinite(amount)) total = Math.round(amount * unit);
    }
    if (total === null || total <= 0 || total > MAX_OFFSET_MINUTES) continue;
    if (!minutes.includes(total)) minutes.push(total);
  }
  minutes.sort((a, b) => b - a);
  return minutes.slice(0, MAX_OFFSETS_PER_RULE);
}

function normalizeOverdue(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: Boolean(source.enabled),
    everyDays: clampInt(source.everyDays ?? source.days, 1, 7, 1),
  };
}

/**
 * 归一化一条规则。模型输出、UI 表单、历史存储都走这里，
 * 缺字段补齐、越界截断、不合法的时间段回退，绝不抛错。
 */
export function normalizeRule(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const targets = [...new Set(
    (Array.isArray(source.targets) ? source.targets : [])
      .map((id) => String(id || '').trim())
      .filter((id) => REMINDER_TARGETS.some((target) => target.id === id)),
  )];
  const offsets = normalizeOffsets(source.offsets ?? source.minutesBefore);
  const rawId = String(source.id || '').trim();
  return {
    id: /^[A-Za-z0-9_-]{4,64}$/.test(rawId) ? rawId : newRuleId(),
    name: trimText(source.name || '提醒', 40) || '提醒',
    note: trimText(source.note, 200),
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    targets: targets.length ? targets : REMINDER_TARGETS.map((target) => target.id),
    keywords: cleanKeywords(source.keywords),
    excludeKeywords: cleanKeywords(source.excludeKeywords),
    matchAll: Boolean(source.matchAll),
    offsets: offsets.length ? offsets : [1440],
    window: normalizeWindow(source.window),
    overdue: normalizeOverdue(source.overdue),
    sound: source.sound === undefined ? true : Boolean(source.sound),
  };
}

function normalizeLog(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      at: toMs(entry.at),
      ruleId: String(entry.ruleId || ''),
      itemKind: String(entry.itemKind || ''),
      itemId: String(entry.itemId || ''),
      title: trimText(entry.title, 80),
      fireAt: toMs(entry.fireAt),
      overdue: Boolean(entry.overdue),
    }))
    .filter((entry) => Number.isFinite(entry.fireAt))
    .slice(0, 50);
}

/** 设备侧的整份偏好：开关、时间段、规则、最近提醒记录。 */
export function normalizePrefs(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rules = (Array.isArray(source.rules) ? source.rules : [])
    .slice(0, MAX_RULES)
    .map((rule) => normalizeRule(rule));
  return {
    version: REMINDER_VERSION,
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    window: normalizeWindow(source.window, DEFAULT_WINDOW) || DEFAULT_WINDOW,
    maxPending: clampInt(source.maxPending, 1, MAX_PENDING_LIMIT, DEFAULT_MAX_PENDING),
    rules,
    log: normalizeLog(source.log),
    updatedAt: toMs(source.updatedAt) || 0,
  };
}

/** 一句话描述规则，用于列表副标题与确认卡片。 */
export function describeRule(input) {
  const rule = normalizeRule(input);
  const parts = [];
  parts.push(rule.targets
    .map((id) => REMINDER_TARGETS.find((target) => target.id === id)?.label || id)
    .join('、'));
  if (rule.keywords.length) parts.push(`含「${rule.keywords.join('、')}」`);
  if (rule.excludeKeywords.length) parts.push(`不含「${rule.excludeKeywords.join('、')}」`);
  parts.push(`提前 ${rule.offsets.map((minutes) => formatOffset(minutes)).join('、')} 提醒`);
  if (rule.window) parts.push(`${rule.window.start}–${rule.window.end} 之外顺延`);
  if (rule.overdue.enabled) parts.push(`过期后每 ${rule.overdue.everyDays} 天再提醒`);
  return parts.join('，');
}

function pushItem(list, item) {
  if (!item || !Number.isFinite(item.deadlineAt)) return;
  list.push(item);
}

/**
 * 把工作区数据摊平成「可提醒条目」。
 * 只产出有明确截止时刻、且还没结束的条目；邮件里已经变成待办的截止由待办负责，不重复。
 */
export function buildReminderItems({ state = {}, scenarios = null } = {}) {
  const items = [];
  const events = Array.isArray(state.events) ? state.events : [];
  for (const event of events) {
    if (!event || event.status === 'cancelled') continue;
    const deadlineAt = toMs(event.start);
    pushItem(items, {
      kind: 'event',
      id: String(event.id || ''),
      title: trimText(event.title || '日程', 60),
      detail: trimText(event.location, 60),
      deadlineAt,
      deadlineLabel: '开始',
      category: String(event.category || ''),
      mailboxId: String(event.mailboxId || ''),
      text: toText(event.title, event.location, event.description, event.category).toLowerCase(),
    });
  }

  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const taskEmailIds = new Set();
  for (const task of tasks) {
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;
    for (const source of Array.isArray(task.sources) ? task.sources : []) {
      if (source?.emailId) taskEmailIds.add(String(source.emailId));
    }
    pushItem(items, {
      kind: 'task',
      id: String(task.id || ''),
      title: trimText(task.title || '待办', 60),
      detail: trimText(task.deadlineText, 60),
      deadlineAt: toMs(task.dueAt),
      deadlineLabel: '截止',
      category: String(task.priority || ''),
      mailboxId: String(task.mailboxId || ''),
      text: toText(task.title, task.description, task.deadlineText, task.assignee).toLowerCase(),
    });
  }

  const actions = Array.isArray(scenarios?.actions) ? scenarios.actions : [];
  const scenarioItems = Array.isArray(scenarios?.items) ? scenarios.items : [];
  const workbenches = Array.isArray(scenarios?.workbenches) ? scenarios.workbenches : [];
  const itemTitle = new Map(scenarioItems.map((item) => [String(item?.id || ''), String(item?.title || '')]));
  const workbenchTitle = new Map(workbenches.map((row) => [String(row?.id || ''), String(row?.name || '')]));
  for (const action of actions) {
    if (!action) continue;
    if (['cancelled', 'sent', 'done'].includes(String(action.state || ''))) continue;
    const itemId = String(action.itemId || '');
    const workbenchId = String(action.workbenchId || '');
    pushItem(items, {
      kind: 'action',
      id: String(action.id || ''),
      title: trimText(action.title || '工作台行动', 60),
      detail: trimText(toText(itemTitle.get(itemId), workbenchTitle.get(workbenchId)), 60),
      deadlineAt: toMs(action.dueAt),
      deadlineLabel: '截止',
      category: String(action.kind || ''),
      mailboxId: String(action.mailboxId || ''),
      text: toText(action.title, action.deadlineText, itemTitle.get(itemId), workbenchTitle.get(workbenchId)).toLowerCase(),
    });
  }

  const emails = Array.isArray(state.emails) ? state.emails : [];
  for (const email of emails) {
    if (!email || taskEmailIds.has(String(email.id || ''))) continue;
    const extraction = email.extraction || {};
    const found = Array.isArray(extraction.tasks) ? extraction.tasks : [];
    for (const entry of found) {
      const deadlineAt = toMs(entry?.dueAt);
      if (!Number.isFinite(deadlineAt)) continue;
      pushItem(items, {
        kind: 'mail',
        id: `${email.id}#${String(entry?.taskId || entry?.title || '')}`,
        title: trimText(entry?.title || email.subject || '邮件截止', 60),
        detail: trimText(email.subject, 60),
        deadlineAt,
        deadlineLabel: '截止',
        category: String(extraction.category || email.category || ''),
        mailboxId: String(email.mailboxId || ''),
        text: toText(entry?.title, entry?.deadlineText, email.subject, email.sender, extraction.summary).toLowerCase(),
      });
    }
  }

  return items;
}

/** 规则命中判断：先看排除词，再看关键词（无关键词=该类目全都要）。 */
export function matchRule(rule, item) {
  const text = String(item?.text || '').toLowerCase();
  if (rule.excludeKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) return false;
  if (!rule.keywords.length) return true;
  const hit = (keyword) => text.includes(keyword.toLowerCase());
  return rule.matchAll ? rule.keywords.every(hit) : rule.keywords.some(hit);
}

/** 允许提醒的时间段边界（同一天，不支持跨天）。 */
function windowBounds(window, ms) {
  const parts = beijingParts(ms);
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (!start || !end) return null;
  return {
    startMs: beijingWallToMs(parts, start.hour, start.minute),
    endMs: beijingWallToMs(parts, end.hour, end.minute),
  };
}

/** 落在允许段之外就顺延到当天的允许段开始；顺延后已晚于截止时间则丢弃。 */
export function clampToWindow(ms, window, deadlineAt) {
  if (!window) return ms;
  const bounds = windowBounds(window, ms);
  if (!bounds) return ms;
  if (ms >= bounds.startMs && ms < bounds.endMs) return ms;
  let next = bounds.startMs;
  if (next <= ms) next += DAY_MS;
  if (Number.isFinite(deadlineAt) && next >= deadlineAt) return NaN;
  return next;
}

/** 去重指纹：同一件事（同一次提醒时刻+同一截止）被待办/工作台/邮件重复描述时只留一条。 */
function sameDeadlineKey(occurrence) {
  return `${occurrence.fireAt}|${occurrence.deadlineAt}|${String(occurrence.itemTitle || '').replace(/\s+/g, '').slice(0, 24)}`;
}

const KIND_RANK = { task: 0, action: 1, mail: 2, event: 3 };

function makeOccurrence(rule, item, { fireAt, deadlineAt, offsetMinutes, overdue }) {
  const key = `${rule.id}:${item.kind}:${item.id}:${overdue ? `o${offsetMinutes}` : offsetMinutes}`;
  return {
    key,
    id: notificationId(key),
    ruleId: rule.id,
    ruleName: rule.name,
    itemKind: item.kind,
    itemId: item.id,
    itemTitle: item.title,
    deadlineAt,
    deadlineLabel: item.deadlineLabel || '截止',
    fireAt,
    offsetMinutes,
    overdue: Boolean(overdue),
    sound: rule.sound !== false,
  };
}

/**
 * 计算需要排的本地通知。
 * - 已过期时刻不排（除非规则显式打开 overdue）。
 * - 同一截止、同一标题的重复条目（待办 / 工作台 / 邮件三者常指向同一件事）只留一条。
 * - 只保留最近的 `max` 条：iOS 待发送通知有 64 条上限，App 回到前台时会重排。
 */
export function evaluateReminders({ rules = [], items = [], now = Date.now(), window = DEFAULT_WINDOW, max = DEFAULT_MAX_PENDING } = {}) {
  const nowMs = toMs(now);
  const floor = Math.max(nowMs, 0) + 30_000;
  const limit = clampInt(max, 1, MAX_PENDING_LIMIT, DEFAULT_MAX_PENDING);
  const collected = [];

  for (const rawRule of rules) {
    const rule = normalizeRule(rawRule);
    if (!rule.enabled) continue;
    const window_ = rule.window || window || null;
    for (const item of items) {
      if (!rule.targets.includes(item.kind)) continue;
      if (!matchRule(rule, item)) continue;
      const deadlineAt = item.deadlineAt;
      if (!Number.isFinite(deadlineAt)) continue;
      for (const offsetMinutes of rule.offsets) {
        const raw = deadlineAt - offsetMinutes * 60_000;
        if (raw < floor) continue;
        const fireAt = clampToWindow(raw, window_, deadlineAt);
        if (!Number.isFinite(fireAt) || fireAt < floor) continue;
        collected.push(makeOccurrence(rule, item, { fireAt, deadlineAt, offsetMinutes, overdue: false }));
      }
      if (rule.overdue.enabled) {
        const step = rule.overdue.everyDays * DAY_MS;
        const horizon = deadlineAt + OVERDUE_MAX_DAYS * DAY_MS;
        for (let time = deadlineAt + step, times = 0; time <= horizon && times < OVERDUE_MAX_TIMES; time += step, times += 1) {
          if (time < floor) continue;
          const fireAt = clampToWindow(time, window_, Infinity);
          if (!Number.isFinite(fireAt) || fireAt < floor || fireAt > horizon) continue;
          collected.push(makeOccurrence(rule, item, {
            fireAt,
            deadlineAt,
            offsetMinutes: Math.round((fireAt - deadlineAt) / 60_000),
            overdue: true,
          }));
        }
      }
    }
  }

  collected.sort((a, b) => a.fireAt - b.fireAt || a.itemTitle.localeCompare(b.itemTitle));

  // 同一截止、同一标题只留一条：待办 / 工作台行动 / 邮件识别出的截止常常指向同一件事，
  // 保留更「具体」的来源（待办 > 工作台 > 邮件）。
  const deduped = [];
  const byDeadline = new Map();
  const byInstant = new Set();
  for (const occurrence of collected) {
    const instant = `${occurrence.fireAt}|${occurrence.itemKind}|${occurrence.itemId}`;
    if (byInstant.has(instant)) continue;
    if (occurrence.itemKind !== 'event') {
      const deadlineKey = sameDeadlineKey(occurrence);
      const existing = byDeadline.get(deadlineKey);
      if (existing !== undefined) {
        if (KIND_RANK[occurrence.itemKind] < KIND_RANK[deduped[existing].itemKind]) deduped[existing] = occurrence;
        continue;
      }
      byDeadline.set(deadlineKey, deduped.length);
    }
    byInstant.add(instant);
    deduped.push(occurrence);
  }

  return deduped.slice(0, limit);
}

/** 稳定的 32 位通知 id（iOS 要求整数）。同一个 key 永远得到同一个 id。 */
export function notificationId(key) {
  const text = String(key || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (Math.abs(hash) % 2_147_483_647) || 1;
}

/** 通知的标题与正文。下发时算好，锁屏上直接可读。 */
export function notificationContent(occurrence) {
  const title = trimText(occurrence.itemTitle || 'Daylight 提醒', 60);
  const timing = occurrence.overdue
    ? `已过期 ${formatOffset(Math.max(0, occurrence.offsetMinutes))}`
    : `还有 ${formatOffset(occurrence.offsetMinutes)}`;
  const body = [
    timing,
    `${occurrence.deadlineLabel || '截止'} ${formatBeijingDate(occurrence.deadlineAt)}`,
    occurrence.ruleName,
  ].filter(Boolean).join(' · ');
  return { title, body };
}
