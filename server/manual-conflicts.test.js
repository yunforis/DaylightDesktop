import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findManualConflicts } from '../src/lib/domain.js';

const base = [
  { id: 'a', title: '晨会', start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00' },
  { id: 'b', title: '全天', start: '2026-10-15T00:00:00+08:00', end: '2026-10-16T00:00:00+08:00', allDay: true },
  { id: 'c', title: '已取消', start: '2026-10-15T09:30:00+08:00', end: '2026-10-15T10:30:00+08:00', status: 'cancelled' },
];

test('手动新建检测时段重叠，忽略全天与已取消，并可排除自身', () => {
  const hits = findManualConflicts(
    { start: '2026-10-15T09:30:00+08:00', end: '2026-10-15T10:30:00+08:00' },
    base,
  );
  assert.deepEqual(hits.map((item) => item.id), ['a']);

  const self = findManualConflicts(
    { start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00' },
    base,
    'a',
  );
  assert.deepEqual(self, []);

  const allDay = findManualConflicts(
    { start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00', allDay: true },
    base,
  );
  assert.deepEqual(allDay, []);
});
