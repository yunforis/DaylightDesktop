import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewScopeMailboxIds } from './view-scope.js';

const mailboxes = [
  { id: 'mb-work', tag: 'work' },
  { id: 'mb-personal', tag: 'personal' },
  { id: 'mb-custom', tag: 'custom', tagCustom: '比赛' },
  { id: 'mb-untagged' },
];

test('视图范围：全部邮箱按配置顺序返回所有邮箱', () => {
  assert.deepEqual(
    viewScopeMailboxIds(mailboxes, { scope: 'all' }),
    ['mb-work', 'mb-personal', 'mb-custom', 'mb-untagged'],
  );
});

test('视图范围：按标签只返回该标签的邮箱，标签名与自定义标签都能匹配', () => {
  // 没有 tag 的邮箱按默认「工作」处理，与 /api/state 的 tag 过滤一致。
  assert.deepEqual(viewScopeMailboxIds(mailboxes, { tag: '工作' }), ['mb-work', 'mb-untagged']);
  assert.deepEqual(viewScopeMailboxIds(mailboxes, { tag: '个人' }), ['mb-personal']);
  assert.deepEqual(viewScopeMailboxIds(mailboxes, { tag: '比赛' }), ['mb-custom']);
  assert.deepEqual(viewScopeMailboxIds(mailboxes, { tag: '不存在的标签' }), []);
});

test('视图范围：当前邮箱视图不返回范围，由调用方回退到当前邮箱', () => {
  assert.deepEqual(viewScopeMailboxIds(mailboxes, {}), []);
  assert.deepEqual(viewScopeMailboxIds(mailboxes, { scope: 'active' }), []);
  assert.deepEqual(viewScopeMailboxIds(undefined, { scope: 'all' }), []);
});
