import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, suggestTimeSlots } from './conflicts.js';

const event = { title: '候选会议', start: '2026-10-13T14:00:00+08:00',
  end: '2026-10-13T15:00:00+08:00', allDay: false };
const now = Date.parse('2026-10-13T08:00:00+08:00');
const at = (start, end, fields = {}) => ({ start, end, ...fields });

function assertFeasible(slots, requested, existing, currentTime) {
  const duration = Date.parse(requested.end) - Date.parse(requested.start);
  assert.equal(slots.length, 3);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    assert.match(slot.start, /\+08:00$/);
    assert.match(slot.end, /\+08:00$/);
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), duration);
    assert.ok(Date.parse(slot.start) >= Math.max(Date.parse(requested.start), currentTime));
    assert.equal(slot.allDay, Boolean(requested.allDay));
    assert.deepEqual(findConflicts(slot, existing), []);
    assert.deepEqual(findConflicts(slot, slots.slice(0, index)), []);
  }
}

test('时间重叠检测使用半开区间，返回完整日程并兼容旧状态', () => {
  const old = at('2026-10-13T13:30:00+08:00', '2026-10-13T14:30:00+08:00', { id: 'old', title: '旧数据' });
  const nested = at(event.start, event.end, { id: 'same', status: 'active' });
  const enclosing = at('2026-10-13T12:00:00+08:00', '2026-10-13T17:00:00+08:00', { id: 'enclosing' });
  const cancelled = { ...nested, id: 'cancelled', status: 'cancelled' };
  const before = at('2026-10-13T13:00:00+08:00', event.start);
  const after = at(event.end, '2026-10-13T16:00:00+08:00');
  const found = findConflicts(event, [old, nested, enclosing, cancelled, before, after]);
  assert.deepEqual(found, [old, nested, enclosing]);
  assert.equal(found[0], old);
});

test('全天日程不参与冲突，普通日程仍按实际时间比较', () => {
  const allDay = at('2026-10-13T00:00:00+08:00', '2026-10-14T00:00:00+08:00', { allDay: true });
  const multiDay = at('2026-10-12T00:00:00+08:00', '2026-10-15T00:00:00+08:00', { allDay: true });
  assert.deepEqual(findConflicts(allDay, [event, multiDay]), []);
  assert.deepEqual(findConflicts(event, [allDay, multiDay]), []);
  assert.deepEqual(findConflicts(at('2026-10-14T00:00:00+08:00', '2026-10-14T01:00:00+08:00'), [allDay]), []);
  assert.deepEqual(findConflicts(at('2026-10-13T06:00:00Z', '2026-10-13T07:00:00Z'), [event]), [event]);
});

test('已标记冲突的有效安排继续占用时间，取消后才释放', () => {
  const occupied = at(event.start, '2026-10-13T16:00:00+08:00', {
    id: 'saved-conflicting-event', status: 'active', hasConflict: true, conflictEventIds: ['another-event'],
  });
  assert.deepEqual(findConflicts(event, [occupied]), [occupied]);
  const slots = suggestTimeSlots(event, [occupied], now);
  assert.equal(slots[0].start, occupied.end);
  assertFeasible(slots, event, [occupied], now);
  const cancelled = { ...occupied, status: 'cancelled' };
  assert.deepEqual(findConflicts(event, [cancelled]), []);
  assert.equal(suggestTimeSlots(event, [cancelled], now)[0].start, event.start);
});

test('普通会议优先原日期，避开多个有效占用与候选，已取消安排不阻挡', () => {
  const existing = [
    at('2026-10-13T13:00:00+08:00', '2026-10-13T15:00:00+08:00'),
    at('2026-10-13T16:00:00+08:00', '2026-10-13T17:00:00+08:00'),
    at('2026-10-13T15:00:00+08:00', '2026-10-13T16:00:00+08:00', { status: 'cancelled' }),
  ];
  const before = structuredClone(existing);
  const slots = suggestTimeSlots(event, existing, now);
  assert.deepEqual(slots.map((slot) => slot.start), ['2026-10-13T15:00:00+08:00',
    '2026-10-13T17:00:00+08:00', '2026-10-14T09:00:00+08:00']);
  assertFeasible(slots, event, existing, now);
  assert.deepEqual(existing, before);
});

test('原时间已过去时从当前时间后的半小时刻度寻找，不延长或缩短会议', () => {
  const requested = { ...event, start: '2026-10-10T10:05:00+08:00', end: '2026-10-10T11:20:00+08:00' };
  const currentTime = Date.parse('2026-10-13T16:10:00+08:00');
  const slots = suggestTimeSlots(requested, [], new Date(currentTime));
  assert.deepEqual(slots.map((slot) => slot.start), ['2026-10-13T16:30:00+08:00',
    '2026-10-14T09:00:00+08:00', '2026-10-14T10:30:00+08:00']);
  assertFeasible(slots, requested, [], currentTime);
  assert.ok(slots.every((slot) => slot.end.slice(11, 16) <= '18:00'));
});

test('连续忙满十四天后继续寻找三个空闲时段，午夜按北京时间计算', () => {
  const requested = { ...event, start: '2026-10-13T09:00:00+08:00', end: '2026-10-13T18:00:00+08:00' };
  const existing = [at('2026-10-13T00:00:00+08:00', '2026-10-27T00:00:00+08:00', { allDay: false })];
  const slots = suggestTimeSlots(requested, existing, now);
  assert.deepEqual(slots.map((slot) => slot.start), ['2026-10-27T09:00:00+08:00',
    '2026-10-28T09:00:00+08:00', '2026-10-29T09:00:00+08:00']);
  assertFeasible(slots, requested, existing, now);
});

test('全天日程不占用候选时段，普通会议仍阻挡重叠候选', () => {
  const existing = [
    at('2026-10-13T00:00:00+08:00', '2026-10-15T00:00:00+08:00', { allDay: true }),
    at('2026-10-13T14:00:00+08:00', '2026-10-13T15:00:00+08:00', { allDay: false }),
  ];
  const slots = suggestTimeSlots(event, existing, now);
  assert.deepEqual(slots.map((slot) => slot.start), ['2026-10-13T15:00:00+08:00',
    '2026-10-13T16:00:00+08:00', '2026-10-13T17:00:00+08:00']);
  assertFeasible(slots, event, existing, now);
});

test('跨天长活动逐日按原钟点寻找，并保持精确时长', () => {
  const requested = at('2026-10-13T23:15:00+08:00', '2026-10-15T11:45:00+08:00', { allDay: false });
  const existing = [at('2026-10-14T16:00:00+08:00', '2026-10-14T17:00:00+08:00')];
  const currentTime = Date.parse('2026-10-13T23:20:00+08:00');
  const slots = suggestTimeSlots(requested, existing, currentTime);
  assert.deepEqual(slots.map((slot) => slot.start), ['2026-10-14T23:15:00+08:00',
    '2026-10-16T23:15:00+08:00', '2026-10-18T23:15:00+08:00']);
  assertFeasible(slots, requested, existing, currentTime);
});
