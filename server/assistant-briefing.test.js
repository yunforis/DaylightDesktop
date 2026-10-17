import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailBriefing, emailDateRange, emailEvidence, emailMatchesRange } from './assistant-briefing.js';

const now = Date.parse('2026-10-16T10:00:00+08:00');
const message = (id, receivedAt, fields = {}) => ({ id, receivedAt, subject: `合成邮件 ${id}`,
  sender: 'sender@example.invalid', body: '合成来源正文', mode: 'qq', ...fields });

test('简报过去 N 天使用精确滚动区间，起点包含，当前时刻之后排除', () => {
  const range = emailDateRange({ days: 2 }, now, { defaultDays: 7 });
  assert.equal(range.fromInclusive, '2026-10-14T10:00:00.000+08:00');
  assert.equal(range.untilExclusive, '2026-10-16T10:00:00.001+08:00');
  assert.equal(emailMatchesRange(message('before', '2026-10-14T09:59:59.999+08:00'), range), false);
  assert.equal(emailMatchesRange(message('start', '2026-10-14T10:00:00+08:00'), range), true);
  assert.equal(emailMatchesRange(message('now', '2026-10-16T02:00:00Z'), range), true);
  assert.equal(emailMatchesRange(message('future', '2026-10-16T10:00:00.001+08:00'), range), false);
  assert.equal(emailDateRange({}, now, { defaultDays: 7 }).days, 7);
});

test('日期范围含北京时间末日，跨 UTC 日期正确，非法输入不会静默扩大范围', () => {
  const range = emailDateRange({ from: '2026-10-15', to: '2026-10-15', days: 200 }, now, { defaultDays: 7 });
  assert.equal(range.mode, 'beijing_dates');
  assert.equal(range.days, undefined);
  assert.equal(emailMatchesRange(message('midnight', '2026-10-14T16:00:00Z'), range), true);
  assert.equal(emailMatchesRange(message('last', '2026-10-15T15:59:59.999Z'), range), true);
  assert.equal(emailMatchesRange(message('next', '2026-10-15T16:00:00Z'), range), false);
  for (const args of [{ days: 0 }, { days: 1.2 }, { days: 366 }, { days: 'abc' },
    { from: '' }, { from: '2026-02-30' }, { to: 'October 15' }, { from: '2026-10-16', to: '2026-10-15' }]) {
    assert.throws(() => emailDateRange(args, now, { defaultDays: 7 }));
  }
});

test('简报统计范围内全部已保存邮件，明细截断、未同步与示例边界均可核对', () => {
  const emails = [
    message('meeting', '2026-10-15T01:00:00Z', { category: 'meeting', priority: 'high', intent: 'calendar', status: 'conflict',
      extraction: { summary: '合成会议改到次周', category: 'meeting' }, eventIds: ['cancelled-event'] }),
    message('task', '2026-10-15T02:00:00Z', { category: 'task', intent: 'task', taskIds: ['open-task', 'done-task'] }),
    message('demo', '2026-10-15T03:00:00Z', { mode: 'demo', category: 'notice' }),
    message('reply', '2026-10-15T04:00:00Z', { category: 'inquiry', intent: 'reply' }),
    message('outside', '2026-10-12T04:00:00Z'),
    message('unknown-date', 'broken-date'),
  ];
  const store = { emails, lastSync: '2026-10-16T01:00:00Z', tasks: [
    { id: 'open-task', title: '合成报告', status: 'pending', dueAt: '2026-10-15T18:00:00+08:00', sources: [{ emailId: 'task' }] },
    { id: 'done-task', title: '已提交材料', status: 'done', dueAt: '2026-10-14T18:00:00+08:00' },
    { id: 'unrelated-task', title: '不应混入', sources: [{ emailId: 'outside' }] },
  ], events: [
    { id: 'cancelled-event', title: '已取消安排', start: '2026-10-20T10:00:00+08:00', end: '2026-10-20T11:00:00+08:00', status: 'cancelled' },
    { id: 'unrelated-event', title: '不应混入', emailId: 'outside' },
  ] };
  const result = buildEmailBriefing(store, { from: '2026-10-15', to: '2026-10-15', limit: 2 },
    { now, mailboxId: 'fixture-mailbox', settings: { fetchLimit: 15 } });
  assert.equal(result.overview.total, 4);
  assert.equal(result.overview.included, 2);
  assert.equal(result.overview.omitted, 2);
  assert.equal(result.overview.demoCount, 1);
  assert.deepEqual(result.emails.map(({ id }) => id), ['reply', 'demo']);
  assert.deepEqual(Object.fromEntries(result.overview.categories.map(({ id, count }) => [id, count])),
    { meeting: 1, task: 1, notice: 1, inquiry: 1 });
  assert.equal(result.scope.totalSaved, 6);
  assert.equal(result.scope.undatedSaved, 1);
  assert.equal(result.scope.queriedLiveMailbox, false);
  assert.equal(result.scope.inboxCompleteness, 'unknown');
  assert.equal(result.scope.unsyncedCount, null);
  assert.equal(result.scope.configuredRecentLimit, 15);
  assert.equal(result.scope.earliestSavedReceivedAt, '2026-10-12T12:00:00.000+08:00');
  assert.deepEqual(result.tasks.items.map(({ id, status, overdue }) => ({ id, status, overdue })), [
    { id: 'open-task', status: 'pending', overdue: true }, { id: 'done-task', status: 'done', overdue: false },
  ]);
  assert.deepEqual(result.tasks.items[0].sources, [{ emailId: 'task', emailSubject: '合成邮件 task' }]);
  assert.equal(result.events.items.length, 1);
  assert.equal(result.events.items[0].status, 'cancelled');
  assert.deepEqual(result.events.items[0].sources, [{ emailId: 'meeting', emailSubject: '合成邮件 meeting' }]);
  assert.equal(result.needsReview.total, 1);
  assert.equal(result.replyCandidates.sentStatusChecked, false);
  assert.equal(result.truncated, true);
  assert.match(result.notes.join('\n'), /未同步数量/);
  assert.match(result.notes.join('\n'), /示例/);
  assert.match(result.notes.join('\n'), /有 2 封未附明细/);
  assert.match(result.contentTrust, /不可信/);
});

test('没有同步记录或本地邮件时明确覆盖未知，不能等同真实邮箱无邮件', () => {
  const result = buildEmailBriefing({ emails: [], tasks: [], events: [], lastSync: null }, {}, { now });
  assert.equal(result.overview.total, 0);
  assert.equal(result.scope.lastSync, null);
  assert.equal(result.scope.inboxCompleteness, 'unknown');
  assert.match(result.notes.join('\n'), /没有同步时间记录/);
  assert.match(result.notes.join('\n'), /不表示真实邮箱中没有来信/);
});

test('简报上下文有界，分类数量固定，优先采用内容摘要且不泄漏完整原文', () => {
  const emails = Array.from({ length: 45 }, (_, index) => message(`long-${index}`, '2026-10-15T12:00:00+08:00', {
    subject: '合成主题'.repeat(300), body: '不可信原文'.repeat(2000), category: `未知分类-${index}`,
    extraction: { summary: '已保存的语义摘要'.repeat(300) },
  }));
  const store = { emails,
    tasks: Array.from({ length: 24 }, (_, index) => ({ id: `task-${index}`, title: '长待办'.repeat(500), sources: [{ emailId: 'long-0' }] })),
    events: Array.from({ length: 23 }, (_, index) => ({ id: `event-${index}`, title: '长日程'.repeat(500), emailId: 'long-0' })),
  };
  const result = buildEmailBriefing(store, { limit: 100 }, { now });
  assert.equal(result.emails.length, 30);
  assert.equal(result.overview.total, 45);
  assert.deepEqual(result.overview.categories, [{ id: 'unclassified', count: 45, label: '未分类' }]);
  assert.equal(result.tasks.items.length, 20);
  assert.equal(result.tasks.omitted, 4);
  assert.equal(result.events.omitted, 3);
  assert.ok(result.emails.every((email) => email.summaryTruncated && email.summarySource === 'extraction' && email.body === undefined));
  assert.ok(JSON.stringify(result).length < 46_000);
  const excerpt = emailEvidence(emails[0], { includeBody: true, bodyLimit: 40 });
  assert.equal(excerpt.body.length, 40);
  assert.equal(excerpt.bodyTruncated, true);
});
