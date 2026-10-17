export const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
export const localDate = (key) => new Date(`${key}T12:00:00`);
export const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const shanghaiDate = (value) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(value));
export const clock = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
export const shiftDay = (key, days) => { const date = localDate(key); date.setDate(date.getDate() + days); return dateKey(date); };
export const onDay = (event, key) => shanghaiDate(event.start) <= key && shanghaiDate(Date.parse(event.end) - 1) >= key;
export const eventTime = (event) => event.allDay ? '全天' : `${clock(event.start)} – ${clock(event.end)}`;
export const shortDate = (value) => {
  const raw = String(value || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? localDate(raw) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
};
export const fullDateTime = (value) => `${shanghaiDate(value)} ${clock(value)}`;
export const eventRange = (event) => {
  const startDay = shanghaiDate(event.start);
  const endDay = shanghaiDate(Date.parse(event.end) - (event.allDay ? 1 : 0));
  if (event.allDay) return `${startDay}${startDay === endDay ? '' : ` – ${endDay}`} · 全天`;
  return `${fullDateTime(event.start)} – ${startDay === endDay ? clock(event.end) : fullDateTime(event.end)}`;
};
