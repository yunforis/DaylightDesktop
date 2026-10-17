/**
 * 邮件过滤规则：在调用模型前跳过匹配邮件（垃圾/推广/免打扰等）。
 * 支持多条件 AND/OR、字段匹配、正则、域名、通配符。
 */
import { randomUUID } from 'node:crypto';

export const FILTER_FIELDS = [
  { id: 'from', label: '发件人' },
  { id: 'to', label: '收件人' },
  { id: 'subject', label: '主题' },
  { id: 'body', label: '正文' },
  { id: 'any', label: '任意文本（主题+发件人+正文）' },
];

export const FILTER_OPS = [
  { id: 'contains', label: '包含' },
  { id: 'not_contains', label: '不包含' },
  { id: 'equals', label: '等于' },
  { id: 'starts_with', label: '开头是' },
  { id: 'ends_with', label: '结尾是' },
  { id: 'wildcard', label: '通配符（* ?）' },
  { id: 'regex', label: '正则' },
  { id: 'domain', label: '发件人域名是（仅 from）' },
];

export const DEFAULT_MAIL_FILTERS = [
  {
    id: 'skip-promo-keywords',
    name: '跳过明显推广/广告',
    enabled: true,
    action: 'skip',
    match: 'any',
    conditions: [
      { field: 'subject', op: 'contains', value: '退订' },
      { field: 'subject', op: 'contains', value: '优惠券' },
      { field: 'subject', op: 'contains', value: '限时秒杀' },
      { field: 'subject', op: 'contains', value: '点击领取' },
      { field: 'from', op: 'contains', value: 'noreply@' },
      { field: 'from', op: 'contains', value: 'no-reply@' },
      { field: 'from', op: 'contains', value: 'marketing@' },
    ],
  },
  {
    id: 'skip-newsletter-domains',
    name: '跳过常见营销域名',
    enabled: false,
    action: 'skip',
    match: 'any',
    conditions: [
      { field: 'from', op: 'domain', value: 'mailchimp.com' },
      { field: 'from', op: 'domain', value: 'sendgrid.net' },
      { field: 'from', op: 'domain', value: 'amazonses.com' },
    ],
  },
];

const OPS = new Set(FILTER_OPS.map((item) => item.id));
const FIELDS = new Set(FILTER_FIELDS.map((item) => item.id));

function extractEmailAddress(value) {
  const text = String(value || '');
  const match = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return (match?.[0] || text).toLowerCase();
}

function extractDomain(value) {
  const address = extractEmailAddress(value);
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

function fieldText(email, field) {
  const from = String(email.from || email.sender || '');
  const to = String(email.to || '');
  const subject = String(email.subject || '');
  const body = String(email.body || '').slice(0, 8000);
  if (field === 'from') return from;
  if (field === 'to') return to;
  if (field === 'subject') return subject;
  if (field === 'body') return body;
  return `${subject}\n${from}\n${to}\n${body}`;
}

function wildcardToRegExp(pattern, caseSensitive) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseSensitive ? '' : 'i');
}

function safeRegExp(pattern, caseSensitive) {
  const source = String(pattern || '').slice(0, 200);
  if (!source) return null;
  try {
    return new RegExp(source, caseSensitive ? '' : 'i');
  } catch {
    return null;
  }
}

export function matchCondition(email, condition = {}) {
  const field = FIELDS.has(condition.field) ? condition.field : 'any';
  const op = OPS.has(condition.op) ? condition.op : 'contains';
  const needle = String(condition.value ?? '');
  if (!needle) return false;
  const caseSensitive = Boolean(condition.caseSensitive);
  const haystack = fieldText(email, field);
  const left = caseSensitive ? haystack : haystack.toLowerCase();
  const right = caseSensitive ? needle : needle.toLowerCase();

  if (op === 'domain') {
    const domain = extractDomain(fieldText(email, 'from'));
    const expect = right.replace(/^@/, '');
    return domain === expect || domain.endsWith(`.${expect}`);
  }
  if (op === 'contains') return left.includes(right);
  if (op === 'not_contains') return !left.includes(right);
  if (op === 'equals') return left === right;
  if (op === 'starts_with') return left.startsWith(right);
  if (op === 'ends_with') return left.endsWith(right);
  if (op === 'wildcard') {
    try {
      return wildcardToRegExp(needle, caseSensitive).test(haystack);
    } catch {
      return false;
    }
  }
  if (op === 'regex') {
    const re = safeRegExp(needle, caseSensitive);
    if (!re) return false;
    try {
      return re.test(haystack);
    } catch {
      return false;
    }
  }
  return false;
}

export function matchFilterRule(email, rule) {
  if (!rule || rule.enabled === false) return false;
  const conditions = Array.isArray(rule.conditions) ? rule.conditions.filter((item) => String(item?.value || '').trim()) : [];
  if (!conditions.length) return false;
  if (rule.match === 'all') return conditions.every((item) => matchCondition(email, item));
  return conditions.some((item) => matchCondition(email, item));
}

export function findMatchingFilter(email, filters = []) {
  for (const rule of normalizeMailFilters(filters)) {
    if (matchFilterRule(email, rule)) return rule;
  }
  return null;
}

export function normalizeMailFilters(input) {
  const list = Array.isArray(input) ? input : [];
  const normalized = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
      .map((item) => ({
        field: FIELDS.has(item?.field) ? item.field : 'subject',
        op: OPS.has(item?.op) ? item.op : 'contains',
        value: String(item?.value ?? '').slice(0, 500),
        caseSensitive: Boolean(item?.caseSensitive),
      }))
      .filter((item) => item.value.trim())
      .slice(0, 30);
    normalized.push({
      id: String(raw.id || randomUUID()).slice(0, 48),
      name: String(raw.name || '未命名规则').trim().slice(0, 48) || '未命名规则',
      enabled: raw.enabled !== false,
      action: 'skip',
      match: raw.match === 'all' ? 'all' : 'any',
      conditions,
    });
  }
  return normalized;
}

export function ensureMailFilters(input) {
  if (Array.isArray(input)) return normalizeMailFilters(input);
  return DEFAULT_MAIL_FILTERS.map((item) => ({
    ...item,
    conditions: item.conditions.map((condition) => ({ ...condition })),
  }));
}
