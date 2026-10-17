import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentBeijingTime } from './assistant.js';

test('小 D 当前时间工具返回北京时区可读字段', () => {
  const fixed = new Date('2026-10-15T09:05:30+08:00');
  const now = getCurrentBeijingTime(fixed);
  assert.equal(now.timezone, 'Asia/Shanghai');
  assert.equal(now.date, '2026-10-15');
  assert.match(now.time, /09:05:30/);
  assert.match(now.weekday, /星期/);
  assert.match(now.iso, /^2026-10-15T09:05:30\+08:00$/);
  assert.match(now.display, /2026-10-15/);
  assert.match(now.display, /09:05:30/);
});
