import test from 'node:test';
import assert from 'node:assert/strict';
import { eventToIcs, storeToIcs } from './external-calendar.js';

test('ICS 导出包含有效日程标题与时间', () => {
  const event = {
    id: 'evt-1',
    title: '产品评审',
    start: '2026-10-16T15:00:00+08:00',
    end: '2026-10-16T16:00:00+08:00',
    location: '会议室 A',
    description: '带上原型',
    status: 'active',
  };
  const ics = eventToIcs(event);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:产品评审/);
  assert.match(ics, /LOCATION:会议室 A/);
  assert.match(ics, /UID:evt-1@daylight/);
});

test('整库 ICS 跳过已取消日程', () => {
  const ics = storeToIcs({
    events: [
      { id: 'a', title: '有效', start: '2026-10-16T10:00:00+08:00', end: '2026-10-16T11:00:00+08:00', status: 'active' },
      { id: 'b', title: '已取消', start: '2026-10-16T12:00:00+08:00', end: '2026-10-16T13:00:00+08:00', status: 'cancelled' },
    ],
  });
  assert.match(ics, /SUMMARY:有效/);
  assert.doesNotMatch(ics, /SUMMARY:已取消/);
});
