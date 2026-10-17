const DAY_MS = 86_400_000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

export const EMAIL_CATEGORIES = ['meeting', 'task', 'notice', 'inquiry', 'invoice', 'promo', 'resume'];
export const EMAIL_PRIORITIES = ['high', 'normal', 'low'];

function beijingDay(value) {
  return new Date(Date.parse(value instanceof Date ? value.toISOString() : value) + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function moveDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function calendarDay(year, month, day) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('任务截止日期无效，请调整模型后重试。');
  }
  return value;
}

function clockIn(text) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  text = text.replace(/[零〇一二两三四五六七八九十]+(?=[点时])/g, (value) => {
    const [tens, units] = value.split('十');
    return String(value.includes('十') ? (digits[tens] || 1) * 10 + (digits[units] || 0) : digits[value]);
  });
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/) ||
    text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分?)?/);
  if (!match) return /中午/.test(text) ? [12, 0] : [18, 0];
  let hour = Number(match[2]);
  let minute = Number(match[3] || 0);
  if (/[点时]半/.test(text)) minute = 30;
  if (['下午', '傍晚', '晚上', '中午'].includes(match[1]) && hour < 12) hour += 12;
  if (match[1] === '凌晨' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) throw new Error('任务截止时间无效，请调整模型后重试。');
  return [hour, minute];
}

function atTime(day, hour = 18, minute = 0, second = 0) {
  return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+08:00`;
}

function normalizeDueAt(value) {
  if (!value) return null;
  if (typeof value !== 'string') throw new Error('任务截止时间无效，请调整模型后重试。');
  const input = value.trim();
  const datePrefix = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (datePrefix) calendarDay(Number(datePrefix[1]), Number(datePrefix[2]), Number(datePrefix[3]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split('-').map(Number);
    return atTime(calendarDay(year, month, day));
  }
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(input) ? `${input.replace(' ', 'T')}+08:00` : input;
  if (!Number.isFinite(Date.parse(zoned))) throw new Error('任务截止时间无效，请调整模型后重试。');
  return new Date(Date.parse(zoned) + BEIJING_OFFSET).toISOString().slice(0, 19) + '+08:00';
}

// Relative deadlines follow the email's Beijing date, even if that date is in the past.
export function inferDeadline(deadlineText = '', sentAt, dueAt = null) {
  const text = deadlineText.trim();
  if (!text) return normalizeDueAt(dueAt);
  const baseDay = beijingDay(sentAt);
  const year = Number(baseDay.slice(0, 4));
  let day;
  const explicit = text.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})(?:\s*[日号])?/);
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/) || text.match(/(?:^|\D)(\d{1,2})\/(\d{1,2})(?:\D|$)/);
  if (explicit) day = calendarDay(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]));
  else if (monthDay) day = calendarDay(year, Number(monthDay[1]), Number(monthDay[2]));
  else if (/大后天/.test(text)) day = moveDay(baseDay, 3);
  else if (/后天/.test(text)) day = moveDay(baseDay, 2);
  else if (/明天|明日/.test(text)) day = moveDay(baseDay, 1);
  else if (/今天|今日|当天/.test(text)) day = baseDay;
  else {
    const weekday = text.match(/(下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])/);
    const weekend = text.match(/(下|本|这)?周末/);
    if (weekday || weekend) {
      const current = new Date(`${baseDay}T00:00:00Z`).getUTCDay() || 7;
      const target = weekday ? ('一二三四五六日天'.indexOf(weekday[2]) + 1 || Number(weekday[2])) : 7;
      const targetDay = weekday?.[2] === '天' ? 7 : target;
      day = moveDay(baseDay, targetDay - current + ((weekday || weekend)[1] === '下' ? 7 : 0));
    }
  }
  if (!day) return normalizeDueAt(dueAt);
  const [hour, minute] = clockIn(text);
  return atTime(day, hour, minute);
}

export function taskPriority(dueAt, fallback = 'normal', now = new Date()) {
  if (!dueAt) return fallback === 'high' ? 'high' : 'normal';
  const today = beijingDay(now);
  const dueDay = beijingDay(dueAt);
  return dueDay === today || dueDay === moveDay(today, 1) ? 'high' : 'normal';
}

export function tasksForMode(tasks = [], mode) {
  return tasks.filter((task) => mode === 'demo' ? task.source === 'demo' : task.source !== 'demo');
}

export function normalizeTaskTitle(title) {
  return title.normalize('NFKC').trim().toLowerCase().replace(/^(?:请|麻烦|提醒[:：]?)+/u, '').replace(/[^\p{L}\p{N}]/gu, '');
}

export function normalizeTask(task) {
  if (!task || typeof task.title !== 'string' || !task.title.trim()) {
    throw new Error('模型返回的待办缺少任务标题，请调整模型后重试。');
  }
  if (task.deadlineText != null && typeof task.deadlineText !== 'string') {
    throw new Error('模型返回的待办截止描述格式不正确。');
  }
  const assignee = typeof task.assignee === 'string' ? task.assignee.trim() : '';
  return { title: task.title.trim(), description: typeof task.description === 'string' ? task.description.trim() : '',
    dueAt: task.dueAt || null, deadlineText: task.deadlineText?.trim() || '',
    ...(assignee ? { assignee } : {}),
    ...(task.existingTaskId ? { existingTaskId: task.existingTaskId } : {}) };
}

export function emailLabels(extraction) {
  if (extraction.category !== undefined && !EMAIL_CATEGORIES.includes(extraction.category)) {
    throw new Error('模型返回了不支持的邮件分类，请调整模型后重试。');
  }
  if (extraction.priority !== undefined && !EMAIL_PRIORITIES.includes(extraction.priority)) {
    throw new Error('模型返回了不支持的邮件优先级，请调整模型后重试。');
  }
  return { ...(extraction.category !== undefined ? { category: extraction.category } : {}),
    ...(extraction.priority !== undefined ? { priority: extraction.priority } : {}) };
}
