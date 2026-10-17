import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractEvents, processEmails } from './agent.js';
import { findConflicts } from './conflicts.js';
import { createTraceRecorder, summarizeTraces } from './traces.js';

// Invented data only. Each test freezes Beijing time; the model fixture uses loopback.
const now = Date.parse('2026-10-13T09:00:00+08:00');
const event = { title: '演示讨论', start: '2026-10-20T14:00:00+08:00',
  end: '2026-10-20T15:00:00+08:00', allDay: false, category: 'work',
  location: '演示会议室', description: '讨论演示方案' };
const allDayEvent = { ...event, title: '两天演示活动', start: '2026-10-20T00:00:00+08:00',
  end: '2026-10-22T00:00:00+08:00', allDay: true };
const email = { id: 'qq:conflict-fixture:100:1', subject: '演示讨论邀请',
  sender: '演示联系人 <conflict-host@example.invalid>', receivedAt: '2026-10-13T08:00:00+08:00',
  body: '邀请参加 10 月 20 日 14:00–15:00 演示讨论。' };
const emptyStore = () => ({ events: [], emails: [], lastSync: null });
const existing = (id, fields = {}) => ({ ...event, id, source: 'manual', ...fields });
const freezeTime = (t) => t.mock.timers.enable({ apis: ['Date'], now });
const mail = (id, fields = {}) => ({ ...email, id, ...fields });

function assertFeasible(conflict, calendar) {
  const { event: requested, suggestedSlots } = conflict;
  assert.equal(suggestedSlots.length, 3);
  for (let index = 0; index < suggestedSlots.length; index += 1) {
    const slot = suggestedSlots[index];
    assert.equal(slot.allDay, requested.allDay);
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), Date.parse(requested.end) - Date.parse(requested.start));
    assert.ok(Date.parse(slot.start) >= Math.max(now, Date.parse(requested.start)));
    assert.deepEqual(findConflicts(slot, calendar), [], '候选应避开最终有效日历');
    assert.deepEqual(findConflicts(slot, suggestedSlots.slice(0, index)), [], '三个候选应彼此不重叠');
    assert.match(slot.start, /\+08:00$/);
    assert.match(slot.end, /\+08:00$/);
  }
}

test('新邀请和相邻日程不冲突，已取消日程不会阻挡创建', async (t) => {
  freezeTime(t);
  const before = existing('before', { title: '前一场会议', start: '2026-10-20T13:00:00+08:00', end: event.start });
  const after = existing('after', { title: '后一场会议', start: event.end, end: '2026-10-20T16:00:00+08:00' });
  const cancelled = existing('cancelled', { status: 'cancelled' });
  const store = { ...emptyStore(), events: [before, after, cancelled] };
  const result = await processEmails(store, [email], async () => [event], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(store.emails[0].status, 'imported');
  assert.deepEqual(store.emails[0].conflicts, []);
  const created = store.events.find((item) => item.emailId === email.id);
  assert.equal(created.start, event.start);
  assert.equal(created.end, event.end);
  assert.equal(created.source, 'email');
  assert.equal(store.emails[0].extraction.actions[0].eventId, created.id);
  assert.equal(store.emails[0].extraction.actions[0].outcome, undefined);
});

test('冲突邀请也创建并标记，草稿写明冲突对象和三个可行时段', async (t) => {
  freezeTime(t);
  const busy = existing('busy', { title: '客户交流', start: '2026-10-20T13:30:00+08:00', end: '2026-10-20T14:30:00+08:00' });
  const later = existing('later', { title: '项目验收', start: '2026-10-20T16:00:00+08:00', end: '2026-10-20T17:00:00+08:00' });
  const store = { ...emptyStore(), events: [busy, later] };
  const calendarBefore = structuredClone(store.events);
  const result = await processEmails(store, [email], async () => [event], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(store.events.slice(0, 2), calendarBefore);
  assert.equal(store.events.length, 3);
  const record = store.emails[0];
  assert.equal(record.status, 'conflict');
  const created = store.events[2];
  assert.deepEqual(record.createdEventIds, [created.id]);
  assert.deepEqual(record.eventIds, [created.id]);
  assert.equal(created.status, 'active');
  assert.equal(created.hasConflict, true);
  assert.deepEqual(created.conflictEventIds, [busy.id]);
  assert.match(record.summary, /日程冲突/);
  const conflict = record.conflicts[0];
  assert.equal(conflict.actionIndex, 0);
  assert.equal(conflict.action, 'create');
  assert.equal(conflict.eventId, created.id);
  assert.deepEqual(conflict.event, event);
  assert.deepEqual(conflict.existingEvents.map((item) => item.id), [busy.id]);
  assert.equal(conflict.existingEvents[0].title, busy.title);
  assert.equal(conflict.existingEvents[0].start, busy.start);
  assert.equal(conflict.existingEvents[0].end, busy.end);
  assert.equal(record.extraction.actions[0].outcome, 'conflict');
  assert.equal(record.extraction.actions[0].eventId, created.id);
  assertFeasible(conflict, store.events);
  assert.match(record.draftReply, /冲突/);
  assert.match(record.draftReply, /已加入日历并标记冲突/);
  assert.ok(!record.draftReply.includes('暂未'));
  assert.ok(record.draftReply.includes(event.title));
  assert.ok(record.draftReply.includes(busy.title));
  for (const time of ['14:00', '15:00', '13:30', '14:30']) assert.ok(record.draftReply.includes(time));
  for (const slot of conflict.suggestedSlots) {
    assert.ok(record.draftReply.includes(slot.start.slice(11, 16)));
    assert.ok(record.draftReply.includes(slot.end.slice(11, 16)));
  }
  assert.match(record.draftReply, /3 个时段/);
  assert.match(record.draftReply, /确认/);
  assert.equal(record.draftSource, 'local_template');
});

test('一批邮件按先后占用日历，冲突邮件去重且回调正常保存结果', async (t) => {
  freezeTime(t);
  const first = mail('qq:conflict-fixture:100:2');
  const second = mail('qq:conflict-fixture:100:3', { subject: '后来的邀请', receivedAt: '2026-10-13T08:10:00+08:00' });
  const laterEvent = { ...event, title: '后来的讨论', start: '2026-10-20T14:30:00+08:00', end: '2026-10-20T15:30:00+08:00' };
  const store = emptyStore();
  const calls = [];
  const saved = [];
  const extractor = async (message, candidates) => {
    calls.push({ id: message.id, candidates: candidates.map((item) => item.title) });
    return [message.id === first.id ? event : laterEvent];
  };
  const result = await processEmails(store, [second, first], extractor, 'qq', {
    onProcessed: (record) => saved.push({ id: record.id, status: record.status, draft: record.draftReply }),
  });
  assert.equal(result.added, 2);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [{ id: first.id, candidates: [] }, { id: second.id, candidates: [event.title] }]);
  assert.deepEqual(saved.map(({ id, status }) => ({ id, status })), [{ id: first.id, status: 'imported' }, { id: second.id, status: 'conflict' }]);
  assert.ok(saved.every((record) => record.draft));
  assert.equal(store.events.length, 2);
  const record = store.emails.find((item) => item.id === second.id);
  assert.equal(record.conflicts[0].existingEvents[0].id, store.events[0].id);
  const before = structuredClone(store);
  const repeated = await processEmails(store, [second, first, second], extractor, 'qq');
  assert.equal(repeated.duplicate, 3);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.conflicts, 0);
  assert.deepEqual(repeated.errors, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(store, before);
});

test('同封多个操作全部保存并标记相互冲突，待办保存且候选避开最终安排', async (t) => {
  freezeTime(t);
  const busy = existing('busy', { title: '已有讨论' });
  const accepted = { ...event, title: '随后讨论', start: '2026-10-20T15:00:00+08:00', end: '2026-10-20T16:00:00+08:00' };
  const overlapsAccepted = { ...event, title: '重叠讨论', start: '2026-10-20T15:30:00+08:00', end: '2026-10-20T16:30:00+08:00' };
  const last = { ...event, title: '最后讨论', start: '2026-10-20T16:00:00+08:00', end: '2026-10-20T17:00:00+08:00' };
  const store = { ...emptyStore(), events: [busy] };
  const result = await processEmails(store, [email], async () => ({ category: 'meeting', priority: 'normal',
    events: [event, accepted, overlapsAccepted, last], tasks: [{ title: '准备演示资料', dueAt: null }] }), 'qq');
  assert.equal(result.added, 4);
  assert.equal(result.conflicts, 4);
  assert.equal(result.tasksAdded, 1);
  assert.deepEqual(result.errors, []);
  const record = store.emails[0];
  assert.equal(record.status, 'conflict');
  assert.deepEqual(record.conflicts.map((item) => item.actionIndex), [0, 1, 2, 3]);
  assert.deepEqual(record.extraction.actions.map((item) => item.outcome), ['conflict', 'conflict', 'conflict', 'conflict']);
  assert.ok(record.extraction.actions.every((item) => item.eventId));
  assert.equal(store.events.length, 5);
  assert.ok(store.events.slice(1).every((item) => item.status === 'active' && item.hasConflict));
  assert.deepEqual(record.conflicts[2].existingEvents.map((item) => item.id),
    [record.extraction.actions[1].eventId, record.extraction.actions[3].eventId]);
  assert.equal(store.tasks[0].title, '准备演示资料');
  for (const conflict of record.conflicts) assertFeasible(conflict, store.events);
  assert.ok(record.draftReply.includes('随后讨论'));
  assert.ok(record.draftReply.includes('准备演示资料'));
});

test('调整后的时间冲突也取消原安排并创建替代日程，检测排除自身', async (t) => {
  freezeTime(t);
  const original = existing('original', { source: 'email', emailId: 'qq:original' });
  const busy = existing('busy', { title: '其他安排', start: event.end, end: '2026-10-20T16:00:00+08:00' });
  const store = { ...emptyStore(), events: [original, busy] };
  const busyBefore = structuredClone(busy);
  const result = await processEmails(store, [email], async () => [{ action: 'reschedule', targetEventId: original.id,
    reason: '主持人要求调整', start: '2026-10-20T14:30:00+08:00', end: '2026-10-20T15:30:00+08:00' }], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.cancelled, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(store.events.length, 3);
  assert.equal(original.status, 'cancelled');
  assert.equal(original.cancellationType, 'reschedule');
  assert.deepEqual(busy, busyBefore);
  const replacement = store.events.find((item) => item.id === original.replacementEventId);
  assert.equal(replacement.previousEventId, original.id);
  assert.equal(replacement.status, 'active');
  assert.equal(replacement.hasConflict, true);
  assert.deepEqual(replacement.conflictEventIds, [busy.id]);
  const record = store.emails[0];
  const conflict = record.conflicts[0];
  assert.equal(conflict.action, 'reschedule');
  assert.equal(conflict.targetEventId, original.id);
  assert.equal(conflict.eventId, replacement.id);
  assert.deepEqual(conflict.existingEvents.map((item) => item.id), [busy.id]);
  assert.equal(record.extraction.actions[0].targetEventId, original.id);
  assert.equal(record.extraction.actions[0].eventId, replacement.id);
  assert.equal(record.extraction.actions[0].location, original.location);
  assert.deepEqual(record.createdEventIds, [replacement.id]);
  assert.deepEqual(record.rescheduledEventIds, [original.id]);
  assert.match(record.draftReply, /调整已按通知更新日历并标记冲突，原安排已取消/);
  assertFeasible(conflict, store.events);
});

test('仅更换地点不会与自己冲突，正常创建调整后的关联日程', async (t) => {
  freezeTime(t);
  const original = existing('original', { source: 'email' });
  const store = { ...emptyStore(), events: [original] };
  const result = await processEmails(store, [email], async () => [{ action: 'reschedule', targetEventId: original.id, location: '另一演示会议室' }], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(original.status, 'cancelled');
  const replacement = store.events.find((item) => item.id === original.replacementEventId);
  assert.equal(replacement.previousEventId, original.id);
  assert.equal(replacement.start, event.start);
  assert.equal(replacement.end, event.end);
  assert.equal(replacement.location, '另一演示会议室');
  assert.equal(store.emails[0].status, 'imported');
});

test('同封邮件交换两个日程的时间，检测使用最终安排且不与已取消原项冲突', async (t) => {
  freezeTime(t);
  const first = existing('original-first', { title: '第一场讨论' });
  const second = existing('original-second', { title: '第二场讨论', start: '2026-10-20T16:00:00+08:00', end: '2026-10-20T17:00:00+08:00' });
  const store = { ...emptyStore(), events: [first, second] };
  const result = await processEmails(store, [email], async () => [
    { action: 'reschedule', targetEventId: first.id, start: second.start, end: second.end },
    { action: 'reschedule', targetEventId: second.id, start: first.start, end: first.end },
  ], 'qq');
  assert.equal(result.added, 2);
  assert.equal(result.rescheduled, 2);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.ok([first, second].every((item) => item.status === 'cancelled'));
  const replacements = store.events.filter((item) => item.status === 'active');
  assert.equal(replacements.length, 2);
  assert.deepEqual(replacements.map((item) => item.start), [second.start, first.start]);
  assert.ok(replacements.every((item) => !item.hasConflict));
  assert.ok(replacements.every((item) => findConflicts(item, replacements.filter((other) => other.id !== item.id)).length === 0));
});

test('冲突日程仍是有效匹配目标，后续调整和取消正常关联且不继承旧冲突标识', async (t) => {
  freezeTime(t);
  const first = mail('qq:conflict-fixture:100:10');
  const adjustment = mail('qq:conflict-fixture:100:11', { receivedAt: '2026-10-13T08:10:00+08:00' });
  const cancellation = mail('qq:conflict-fixture:100:12', { receivedAt: '2026-10-13T08:20:00+08:00' });
  const busy = existing('busy', { title: '已有安排' });
  const store = { ...emptyStore(), events: [busy] };
  const result = await processEmails(store, [cancellation, adjustment, first], async (message, candidates) => {
    if (message.id === first.id) return [event];
    const target = candidates.find((item) => item.emailId === (message.id === adjustment.id ? first.id : adjustment.id));
    assert.ok(target, '后续邮件能够匹配当前有效的冲突安排或替代安排');
    if (message.id === adjustment.id) {
      assert.equal(target.hasConflict, true);
      return [{ action: 'reschedule', targetEventId: target.id, start: event.end, end: '2026-10-20T16:00:00+08:00' }];
    }
    return [{ action: 'cancel', targetEventId: target.id },
      { ...event, title: '占用取消后时段的新邀请', start: target.start, end: target.end }];
  }, 'qq');
  assert.equal(result.added, 3);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  const conflicted = store.events.find((item) => item.emailId === first.id);
  const replacement = store.events.find((item) => item.emailId === adjustment.id);
  const fresh = store.events.find((item) => item.emailId === cancellation.id);
  assert.equal(conflicted.status, 'cancelled');
  assert.equal(conflicted.replacementEventId, replacement.id);
  assert.equal(replacement.previousEventId, conflicted.id);
  assert.equal(replacement.hasConflict, undefined);
  assert.equal(replacement.status, 'cancelled');
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.hasConflict, undefined);
  assert.deepEqual(findConflicts(fresh, [busy, conflicted, replacement]), []);
});

test('同封邮件的取消先释放时段，即使创建操作排列在取消之前', async (t) => {
  freezeTime(t);
  const original = existing('original');
  const store = { ...emptyStore(), events: [original] };
  const result = await processEmails(store, [email], async () => [{ ...event, title: '替代讨论' },
    { action: 'cancel', targetEventId: original.id, reason: '改为另一场讨论' }], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(original.status, 'cancelled');
  assert.deepEqual(store.events.filter((item) => item.status !== 'cancelled').map((item) => item.title), ['替代讨论']);
  assert.deepEqual(store.emails[0].extraction.actions.map((item) => item.action), ['create', 'cancel']);
});

test('同封邮件的新邀请可使用调整释放的时段，新时段重叠的双方均保存并标记', async (t) => {
  freezeTime(t);
  const original = existing('original');
  const store = { ...emptyStore(), events: [original] };
  const movedStart = '2026-10-20T16:00:00+08:00';
  const movedEnd = '2026-10-20T17:00:00+08:00';
  const result = await processEmails(store, [email], async () => [{ ...event, title: '使用原时段的讨论' },
    { ...event, title: '与新时段重叠的讨论', start: '2026-10-20T16:30:00+08:00', end: '2026-10-20T17:30:00+08:00' },
    { action: 'reschedule', targetEventId: original.id, start: movedStart, end: movedEnd }], 'qq');
  assert.equal(result.added, 3);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.conflicts, 2);
  assert.deepEqual(result.errors, []);
  const record = store.emails[0];
  assert.deepEqual(record.conflicts.map((item) => item.actionIndex), [1, 2]);
  assert.equal(record.conflicts[0].existingEvents[0].id, original.replacementEventId);
  assert.equal(record.conflicts[0].existingEvents[0].start, movedStart);
  assert.equal(record.conflicts[1].existingEvents[0].id, record.extraction.actions[1].eventId);
  assert.ok(store.events.some((item) => item.title === '使用原时段的讨论'));
  assert.equal(record.extraction.actions[0].outcome, undefined);
  for (const conflict of record.conflicts) assertFeasible(conflict, store.events);
});

test('冲突调整也释放原时段，同封邮件的新邀请正常占用原时段', async (t) => {
  freezeTime(t);
  const original = existing('original');
  const busy = existing('busy', { title: '新时段的占用', start: '2026-10-20T16:00:00+08:00', end: '2026-10-20T17:00:00+08:00' });
  const store = { ...emptyStore(), events: [original, busy] };
  const result = await processEmails(store, [email], async () => [{ ...event, title: '拟占原时段的新邀请' },
    { action: 'reschedule', targetEventId: original.id, start: busy.start, end: busy.end }], 'qq');
  assert.equal(result.added, 2);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(original.status, 'cancelled');
  assert.equal(store.events.length, 4);
  const record = store.emails[0];
  const conflicts = record.conflicts;
  assert.deepEqual(conflicts.map((item) => item.actionIndex), [1]);
  assert.equal(conflicts[0].existingEvents[0].id, busy.id);
  const created = store.events.find((item) => item.id === record.extraction.actions[0].eventId);
  assert.equal(created.start, original.start);
  assert.equal(created.end, original.end);
  assert.equal(created.hasConflict, undefined);
  for (const conflict of conflicts) assertFeasible(conflict, store.events);
});

test('跨日全天邀请正常导入，保留原日期且不受同日定时和全天安排阻挡', async (t) => {
  freezeTime(t);
  const busy = existing('busy', { title: '第二天下午安排', start: '2026-10-21T14:00:00+08:00', end: '2026-10-21T15:00:00+08:00' });
  const multiDay = existing('multi-day', { title: '已有跨日全天安排', start: '2026-10-19T00:00:00+08:00', end: '2026-10-23T00:00:00+08:00', allDay: true });
  const store = { ...emptyStore(), events: [busy, multiDay] };
  const before = structuredClone(store.events);
  const result = await processEmails(store, [email], async () => [allDayEvent], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(store.events.slice(0, 2), before);
  const record = store.emails[0];
  assert.equal(record.status, 'imported');
  assert.deepEqual(record.conflicts, []);
  const created = store.events.find((item) => item.id === record.createdEventIds[0]);
  assert.equal(created.allDay, true);
  assert.equal(created.start, allDayEvent.start);
  assert.equal(created.end, allDayEvent.end);
  assert.equal(record.extraction.actions[0].outcome, undefined);
  assert.equal(record.extraction.actions[0].eventId, created.id);
  assert.match(record.draftReply, /已记录/);
  assert.match(record.draftReply, /全天/);
  assert.match(record.draftReply, /2026\/10\/20 至 2026\/10\/21/);
  assert.ok(!record.draftReply.includes('冲突'));
});

test('已有跨日全天安排不阻挡同日定时邀请，也不修改原全天记录', async (t) => {
  freezeTime(t);
  const allDay = existing('all-day', { ...allDayEvent });
  const store = { ...emptyStore(), events: [allDay] };
  const before = structuredClone(allDay);
  const result = await processEmails(store, [email], async () => [event], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(allDay, before);
  assert.equal(store.emails[0].status, 'imported');
  assert.deepEqual(store.emails[0].conflicts, []);
  const created = store.events.find((item) => item.id === store.emails[0].createdEventIds[0]);
  assert.equal(created.allDay, false);
  assert.equal(created.start, event.start);
  assert.equal(created.end, event.end);
  assert.match(store.emails[0].draftReply, /已记录/);
});

test('同封邮件的全天和定时安排均正常导入，不受操作先后顺序影响', async (t) => {
  freezeTime(t);
  for (const events of [[allDayEvent, event], [event, allDayEvent]]) {
    const store = emptyStore();
    const result = await processEmails(store, [email], async () => events, 'qq');
    assert.equal(result.added, 2);
    assert.equal(result.conflicts, 0);
    assert.deepEqual(result.errors, []);
    const record = store.emails[0];
    assert.equal(record.status, 'imported');
    assert.deepEqual(record.conflicts, []);
    assert.deepEqual(record.extraction.actions.map((item) => item.outcome), [undefined, undefined]);
    assert.deepEqual(store.events.map(({ title, start, end, allDay }) => ({ title, start, end, allDay })),
      events.map(({ title, start, end, allDay }) => ({ title, start, end, allDay })));
  }
});

test('同批邮件中全天安排先收到或后收到均正常导入，不阻挡定时安排', async (t) => {
  freezeTime(t);
  for (const requested of [[allDayEvent, event], [event, allDayEvent]]) {
    const first = mail('qq:all-day-fixture:100:1');
    const second = mail('qq:all-day-fixture:100:2', { receivedAt: '2026-10-13T08:10:00+08:00' });
    const calls = [];
    const store = emptyStore();
    const result = await processEmails(store, [second, first], async (message) => {
      calls.push(message.id);
      return [requested[message.id === first.id ? 0 : 1]];
    }, 'qq');
    assert.deepEqual(calls, [first.id, second.id]);
    assert.equal(result.added, 2);
    assert.equal(result.conflicts, 0);
    assert.deepEqual(result.errors, []);
    assert.ok(store.emails.every((record) => record.status === 'imported' && !record.conflicts.length));
    assert.deepEqual(store.events.map((item) => item.allDay), requested.map((item) => item.allDay));
  }
});

test('定时冲突的三个候选忽略全天安排，同时避开其他定时占用', async (t) => {
  freezeTime(t);
  const allDay = existing('all-day', { ...allDayEvent });
  const busy = existing('busy', { title: '冲突的定时讨论' });
  const later = existing('later', { title: '后续定时会议', start: '2026-10-20T16:00:00+08:00', end: '2026-10-20T17:00:00+08:00' });
  const store = { ...emptyStore(), events: [allDay, busy, later] };
  const result = await processEmails(store, [email], async () => [event], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  const conflict = store.emails[0].conflicts[0];
  assert.deepEqual(conflict.existingEvents.map((item) => item.id), [busy.id]);
  assert.deepEqual(conflict.suggestedSlots.map((item) => item.start), [
    '2026-10-20T15:00:00+08:00', '2026-10-20T17:00:00+08:00', '2026-10-21T09:00:00+08:00',
  ]);
  assertFeasible(conflict, store.events);
  assert.ok(conflict.suggestedSlots.every((slot) => Date.parse(slot.start) >= Date.parse(allDay.start) && Date.parse(slot.end) <= Date.parse(allDay.end)));
  assert.ok(!store.emails[0].draftReply.includes(allDay.title));
});

test('定时活动改为全天时正常调整，即使新日期内有其他安排也保留关联', async (t) => {
  freezeTime(t);
  const original = existing('original', { source: 'email', start: '2026-10-20T09:00:00+08:00', end: '2026-10-20T10:00:00+08:00' });
  const busy = existing('busy', { title: '当天定时会议' });
  const store = { ...emptyStore(), events: [original, busy] };
  const result = await processEmails(store, [email], async () => [{ action: 'reschedule', targetEventId: original.id,
    start: allDayEvent.start, end: allDayEvent.end, allDay: true }], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(original.status, 'cancelled');
  const replacement = store.events.find((item) => item.id === original.replacementEventId);
  assert.equal(replacement.previousEventId, original.id);
  assert.equal(replacement.allDay, true);
  assert.equal(replacement.start, allDayEvent.start);
  assert.equal(replacement.end, allDayEvent.end);
  const record = store.emails[0];
  assert.equal(record.status, 'imported');
  assert.deepEqual(record.conflicts, []);
  assert.equal(record.extraction.actions[0].eventId, replacement.id);
  assert.equal(record.extraction.actions[0].targetEventId, original.id);
  assert.match(record.draftReply, /已按新安排更新日历/);
  assert.match(record.draftReply, /全天/);
});

test('全天活动改为定时时保留新安排的冲突标识，并取消原全天安排', async (t) => {
  freezeTime(t);
  const original = existing('original', { ...allDayEvent, source: 'email' });
  const busy = existing('busy', { title: '冲突的定时会议' });
  const store = { ...emptyStore(), events: [original, busy] };
  const result = await processEmails(store, [email], async () => [{ action: 'reschedule', targetEventId: original.id,
    start: event.start, end: event.end, allDay: false }], 'qq');
  assert.equal(result.added, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(store.events.length, 3);
  assert.equal(original.status, 'cancelled');
  const replacement = store.events.find((item) => item.id === original.replacementEventId);
  assert.equal(replacement.previousEventId, original.id);
  assert.equal(replacement.status, 'active');
  assert.equal(replacement.allDay, false);
  assert.equal(replacement.hasConflict, true);
  assert.deepEqual(replacement.conflictEventIds, [busy.id]);
  const record = store.emails[0];
  assert.equal(record.status, 'conflict');
  assert.equal(record.conflicts[0].event.allDay, false);
  assert.deepEqual(record.conflicts[0].existingEvents.map((item) => item.id), [busy.id]);
  assert.equal(record.extraction.actions[0].outcome, 'conflict');
  assert.equal(record.extraction.actions[0].eventId, replacement.id);
  assertFeasible(record.conflicts[0], store.events);
  assert.match(record.draftReply, /原安排已取消/);
});

test('冲突对象、原提取和候选保存为快照，后续编辑或删除日程不改变草稿', async (t) => {
  freezeTime(t);
  const busy = existing('busy', { title: '处理时已有安排' });
  const requested = { ...event };
  const store = { ...emptyStore(), events: [busy] };
  await processEmails(store, [email], async () => [requested], 'qq');
  const record = store.emails[0];
  const before = structuredClone({ conflicts: record.conflicts, extraction: record.extraction, draftReply: record.draftReply });
  Object.assign(busy, { title: '后续修改标题', start: '2026-11-01T10:00:00+08:00', end: '2026-11-01T11:00:00+08:00', location: '新地点' });
  requested.title = '修改模型输入对象';
  requested.start = '2026-12-01T10:00:00+08:00';
  store.events = [];
  const persisted = JSON.parse(JSON.stringify(record));
  assert.deepEqual({ conflicts: persisted.conflicts, extraction: persisted.extraction, draftReply: persisted.draftReply }, before);
  assert.ok(persisted.draftReply.includes('处理时已有安排'));
  assert.ok(!persisted.draftReply.includes('后续修改标题'));
});

test('示例只检查示例日程，真实邮件检查真实和手动日程', async (t) => {
  freezeTime(t);
  for (const { mode, source, conflicts } of [
    { mode: 'qq', source: 'demo', conflicts: 0 },
    { mode: 'demo', source: 'manual', conflicts: 0 },
    { mode: 'demo', source: 'email', conflicts: 0 },
    { mode: 'demo', source: 'demo', conflicts: 1 },
    { mode: 'qq', source: 'manual', conflicts: 1 },
    { mode: 'qq', source: 'email', conflicts: 1 },
  ]) {
    const busy = existing('busy', { source });
    const store = { ...emptyStore(), events: [busy] };
    const result = await processEmails(store, [email], async () => [event], mode);
    assert.equal(result.conflicts, conflicts, `${mode} 检查 ${source}`);
    assert.equal(result.added, 1);
    assert.deepEqual(result.errors, []);
    if (conflicts) assert.equal(store.emails[0].conflicts[0].existingEvents[0].id, busy.id);
  }
});

test('模型提取后使用刷新后的日历检测冲突，保留等待期间加入的手动安排', async (t) => {
  freezeTime(t);
  const store = emptyStore();
  const busy = existing('while-model-running', { title: '模型等待期间加入的安排' });
  let candidateCount;
  const result = await processEmails(store, [email], async (_message, candidates) => {
    candidateCount = candidates.length;
    return [event];
  }, 'qq', { beforeImport: async (calendar) => { calendar.events = [busy]; } });
  assert.equal(candidateCount, 0);
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(store.events.length, 2);
  assert.deepEqual(store.events[0], busy);
  assert.equal(store.events[1].hasConflict, true);
  assert.deepEqual(store.events[1].conflictEventIds, [busy.id]);
  assert.equal(store.emails[0].conflicts[0].existingEvents[0].id, busy.id);
});

test('多个长标题冲突的可确认草稿保持完整，不丢失末项的三个候选', async (t) => {
  freezeTime(t);
  const participants = '产品负责人、交互设计师、前端开发、后端开发、数据分析师、测试负责人、客户成功团队及交付项目经理';
  const busy = existing('busy', { title: `2026 年第四季度产品交付阶段联合评审：包括需求范围核对、设计方案验收、数据平台集成计划、演示环境准备和客户上线安排；参会人员为${participants}`,
    end: '2026-10-20T17:00:00+08:00', description: '依次检查交付里程碑、尚未解决的设计问题、集成接口和演示方案，并在会后汇总责任人、验收材料与下一轮沟通安排。' });
  const first = { ...event, title: `跨部门演示方案第一轮确认：检查首页信息结构、邮件提取流程、日程展示与交互细节，收集产品和客户团队反馈并确认下次交付范围；参会人员为${participants}` };
  const second = { ...event, title: `跨部门演示方案第二轮确认：检查取消和调整通知、冲突提示、回复草稿和推荐时间，讨论现场演示脚本与各环节负责人；参会人员为${participants}`,
    start: '2026-10-20T15:00:00+08:00', end: '2026-10-20T16:30:00+08:00' };
  const store = { ...emptyStore(), events: [busy] };
  const recorder = createTraceRecorder({ traces: [] });
  const result = await processEmails(store, [email], async () => [first, second], 'qq', { recorder });
  assert.equal(result.conflicts, 2);
  assert.deepEqual(result.errors, []);
  const record = store.emails[0];
  const draft = recorder.traces[0].draft_reply;
  assert.ok(record.draftReply.length > 700, '此草稿应覆盖超过普通证据快照长度的场景');
  assert.equal(draft, record.draftReply, '用户可确认的草稿应完整保存');
  assert.ok(draft.includes(second.title));
  assert.ok(draft.endsWith('谢谢。'));
  assert.equal((draft.match(/^3\. /gm) || []).length, 2, '两项冲突的第三个候选均应完整保留');
  for (const conflict of record.conflicts) assertFeasible(conflict, store.events);
});

test('本地 HTTP 模型只调用一次，冲突日志成功结束并保留待确认草稿及用量', async (t) => {
  freezeTime(t);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '邀请参加演示讨论。', category: 'meeting', priority: 'normal', events: [event], tasks: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'invented-conflict-test-key',
    model: 'local-conflict-model', tokenPriceIn: 2, tokenPriceOut: 8 };
  const busy = existing('busy', { title: '已确认的演示评审' });
  const store = { ...emptyStore(), events: [busy] };
  const recorder = createTraceRecorder({ settings, traces: [] });
  const extractor = (message, candidates, context, tasks) => extractEvents(message, settings, candidates, context, tasks);
  const result = await processEmails(store, [email], extractor, 'qq', { recorder });
  assert.equal(result.conflicts, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(requests.length, 1, '冲突草稿与候选在本地生成，不增加模型请求');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.response_format.type, 'json_object');
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content).existingEvents.map((item) => item.id), [busy.id]);
  const trace = recorder.traces[0];
  assert.equal(trace.status, 'conflict');
  assert.equal(trace.attempts[0].status, 'conflict');
  assert.match(trace.decision, /冲突/);
  assert.match(trace.decision, /确认/);
  assert.equal(store.emails[0].trace_id, trace.trace_id);
  assert.equal(trace.draft_reply, store.emails[0].draftReply);
  assert.ok(trace.spans.every((span) => span.status === 'success'));
  const check = trace.spans.flatMap((span) => span.tool_calls).find((tool) => tool.name === 'calendar.check_conflicts');
  assert.equal(check.result_summary.conflict_count, 1);
  const draft = trace.spans.find((span) => span.stage === 'draft_reply');
  assert.equal(draft.output_snapshot.sent, false);
  assert.equal(draft.output_snapshot.source, 'local_template');
  assert.equal(trace.llm_tokens_in, 100);
  assert.equal(trace.llm_tokens_out, 20);
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.completed_count, 1);
  assert.equal(summary.failed_count, 0);
  const before = structuredClone(recorder.traces);
  const duplicate = await processEmails(store, [email], extractor, 'qq', { recorder });
  assert.equal(duplicate.duplicate, 1);
  assert.equal(duplicate.conflicts, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(recorder.traces, before);
});
