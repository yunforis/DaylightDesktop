/**
 * 用户可自定义的日历分类（日程归类），与邮件主题分类（meeting/task/…）分开。
 */
import { randomUUID } from 'node:crypto';

export const DEFAULT_CALENDAR_CATEGORIES = [
  {
    id: 'work',
    label: '工作安排',
    color: '#3d7a5c',
    enabled: true,
    keywords: ['会议', '评审', '项目', '工作', '面试', '答辩'],
  },
  {
    id: 'personal',
    label: '生活日常',
    color: '#a66b3d',
    enabled: true,
    keywords: ['朋友', '家人', '聚餐', '旅行', '运动', '休闲'],
  },
];

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normalizeCalendarCategories(input) {
  const list = Array.isArray(input) ? input : [];
  const normalized = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let id = String(raw.id || '').trim().slice(0, 32);
    if (!id) id = randomUUID().slice(0, 8);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = String(raw.label || id).trim().slice(0, 24) || id;
    const color = COLOR_RE.test(String(raw.color || '')) ? String(raw.color) : '#64748b';
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
      : String(raw.keywords || '')
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20);
    normalized.push({
      id,
      label,
      color,
      enabled: raw.enabled !== false,
      keywords,
    });
  }
  if (!normalized.length) return DEFAULT_CALENDAR_CATEGORIES.map((item) => ({ ...item }));
  if (!normalized.some((item) => item.enabled)) normalized[0].enabled = true;
  return normalized;
}

export function enabledCalendarCategories(categories = DEFAULT_CALENDAR_CATEGORIES) {
  const list = normalizeCalendarCategories(categories).filter((item) => item.enabled);
  return list.length ? list : normalizeCalendarCategories(DEFAULT_CALENDAR_CATEGORIES);
}

export function resolveEventCategory(value, categories = DEFAULT_CALENDAR_CATEGORIES) {
  const list = enabledCalendarCategories(categories);
  const raw = String(value || '').trim();
  if (!raw) return list[0]?.id || 'work';
  const byId = list.find((item) => item.id === raw || item.id === raw.toLowerCase());
  if (byId) return byId.id;
  const byLabel = list.find((item) => item.label === raw);
  if (byLabel) return byLabel.id;
  // 兼容旧数据 / 模型仍返回 personal
  if (raw === 'personal') {
    const personal = list.find((item) => item.id === 'personal') || list.find((item) => /生活|个人/.test(item.label));
    if (personal) return personal.id;
  }
  if (raw === 'work') {
    const work = list.find((item) => item.id === 'work') || list.find((item) => /工作/.test(item.label));
    if (work) return work.id;
  }
  return list[0]?.id || 'work';
}

export function categoryPromptBlock(categories = DEFAULT_CALENDAR_CATEGORIES) {
  const list = enabledCalendarCategories(categories);
  const lines = list.map((item) => {
    const hints = item.keywords?.length ? `；提示词：${item.keywords.join('、')}` : '';
    return `- ${item.id}：${item.label}${hints}`;
  });
  return [
    '日程 category（日历分类）必须从下列 id 中选一个，不要用邮件主题分类（meeting/task 等）：',
    ...lines,
    '若无法判断，默认选第一个。',
  ].join('\n');
}
