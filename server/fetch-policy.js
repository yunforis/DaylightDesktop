/** Resolve mailbox fetch window (recent N vs date range) for IMAP reads. */

const DAY_MS = 24 * 60 * 60 * 1000;

export function shanghaiDayStart(date = new Date()) {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
  return new Date(`${text}T00:00:00+08:00`);
}

export function resolveFetchSince(mailbox = {}) {
  if ((mailbox.fetchMode || 'recent') !== 'range') return null;
  const preset = mailbox.fetchRange || 'week';
  const today = shanghaiDayStart();
  if (preset === 'today') return today;
  if (preset === 'yesterday') return new Date(today.getTime() - DAY_MS);
  if (preset === 'week') return new Date(today.getTime() - 7 * DAY_MS);
  if (preset === 'month') return new Date(today.getTime() - 30 * DAY_MS);
  if (preset === 'year') return new Date(today.getTime() - 365 * DAY_MS);
  if (preset === 'custom' && mailbox.fetchSince) {
    const parsed = new Date(mailbox.fetchSince);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(today.getTime() - 7 * DAY_MS);
}

export function resolveFetchUntil(mailbox = {}) {
  if ((mailbox.fetchMode || 'recent') !== 'range' || mailbox.fetchRange !== 'custom' || !mailbox.fetchUntil) return null;
  const parsed = new Date(mailbox.fetchUntil);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const FETCH_RANGE_OPTIONS = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天起' },
  { id: 'week', label: '近一周' },
  { id: 'month', label: '近一个月' },
  { id: 'year', label: '近一年' },
  { id: 'custom', label: '自定义日期' },
];

export const SYNC_STRATEGY_OPTIONS = [
  { id: 'idle', label: 'IMAP IDLE 推送（支持时优先）' },
  { id: 'poll', label: '定时轮询（默认）' },
];
