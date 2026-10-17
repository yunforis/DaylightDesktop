const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;

const overlaps = (start, end, other) => start < other.end && end > other.start;
const dayStart = (time) => Math.floor((time + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
const beijingIso = (time) => new Date(time + BEIJING_OFFSET).toISOString().replace(/(?:\.000)?Z$/, '+08:00');

export function findConflicts(event, existingEvents) {
  if (event.allDay || event.attendanceStatus === 'declined') return [];
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return existingEvents.filter((other) => !other.allDay && other.status !== 'cancelled' && other.attendanceStatus !== 'declined' &&
    overlaps(start, end, { start: Date.parse(other.start), end: Date.parse(other.end) }));
}

export function suggestTimeSlots(event, existingEvents, now = Date.now()) {
  const originalStart = Date.parse(event.start);
  const duration = Date.parse(event.end) - originalStart;
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const earliest = Math.max(originalStart, Number(now));
  const busy = existingEvents.filter((other) => !other.allDay && other.status !== 'cancelled' && other.attendanceStatus !== 'declined')
    .map((other) => ({ start: Date.parse(other.start), end: Date.parse(other.end) }));
  const latestEnd = busy.reduce((latest, other) => other.end > latest ? other.end : latest, earliest);
  // Search each day in order. Enough days after the last occupied day remain for three full alternatives.
  const searchThrough = dayStart(latestEnd) + 3 * Math.ceil(duration / DAY) * DAY;
  const originalClock = originalStart - dayStart(originalStart);
  const slots = [];

  for (let day = dayStart(earliest); day <= searchThrough && slots.length < 3; day += DAY) {
    const firstStart = event.allDay ? day : duration > 9 * HOUR ? day + originalClock : day + 9 * HOUR;
    const lastStart = event.allDay || duration > 9 * HOUR ? firstStart : day + 18 * HOUR - duration;
    for (let start = firstStart; start <= lastStart && slots.length < 3; start += HOUR / 2) {
      const end = start + duration;
      if (start < earliest || busy.some((other) => overlaps(start, end, other))) continue;
      slots.push({ start: beijingIso(start), end: beijingIso(end), allDay: Boolean(event.allDay) });
      busy.push({ start, end });
    }
  }
  return slots;
}
