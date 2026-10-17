import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEmails, resolveEmailMatch } from './agent.js';
import { createTraceRecorder } from './traces.js';

// All messages, events and model results are invented and stay in memory.
const email = { id: 'qq:matching-retry-fixture:100:1', subject: '合成评审场地调整',
  sender: 'Synthetic Host <synthetic-host@example.invalid>', receivedAt: '2026-10-14T08:00:00+08:00',
  body: '合成评审改到演示会议室 C，场次待补充确认。' };
const event = { id: 'synthetic-review', title: '合成评审', start: '2026-10-20T14:00:00+08:00',
  end: '2026-10-20T15:00:00+08:00', allDay: false, category: 'work', location: '演示会议室 A',
  description: '合成日程', source: 'manual' };
const task = { id: 'synthetic-task', title: '准备演示材料', description: '合成要求', dueAt: null,
  deadlineText: '', priority: 'normal', status: 'pending', source: 'email', sources: [] };
const modelContext = JSON.stringify({ endpoint: 'https://example.invalid/v1', model: 'synthetic-model', version: 'mail-calendar-tasks-intent-attach-v5' });
const emptyStore = () => ({ events: [], tasks: [], emails: [], lastSync: null });
const ambiguous = () => ({ summary: '场地调整，但无法唯一匹配原安排。', category: 'meeting', intent: 'calendar', priority: 'normal', events: [
  { action: 'reschedule', location: '演示会议室 C', reason: '场地调整' },
], tasks: [] });
const process = (store, recorder, extractor, retryMode = 'auto', context = modelContext) =>
  processEmails(store, [email], extractor, 'qq', { recorder, retryMode, modelContext: context, enrichAttachments: false });

test('无法唯一匹配时写入 needs_match 与候选，不猜目标、不改写原日程', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event), { ...event, id: 'similar-review', location: '演示会议室 B' }] };
  const beforeLocations = store.events.map((item) => item.location);
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => {
    calls++;
    return ambiguous();
  };
  const first = await process(store, recorder, extractor);
  assert.deepEqual(first.errors, []);
  assert.equal(first.added, 0);
  assert.equal(first.rescheduled, 0);
  assert.equal(store.emails.length, 1);
  assert.equal(store.emails[0].status, 'needs_match');
  assert.equal(store.emails[0].pendingActions?.length, 1);
  assert.equal(store.emails[0].pendingActions[0].candidates.length, 2);
  assert.deepEqual(store.events.map((item) => item.location), beforeLocations);
  assert.equal(store.events.every((item) => item.status !== 'cancelled'), true);
  assert.equal(calls, 1);
  // 已处理邮件按 ID 去重，自动同步不再重复提取
  const again = await process(store, recorder, extractor);
  assert.equal(again.duplicate, 1);
  assert.equal(calls, 1);
});

test('人工点选候选后完成 reschedule，并按邮件 ID 去重', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event)] };
  const recorder = createTraceRecorder();
  await process(store, recorder, async () => ambiguous());
  const pending = store.emails[0].pendingActions[0];
  resolveEmailMatch(store, email.id, {
    pendingActionId: pending.id,
    targetEventId: event.id,
    resolution: 'apply',
  });
  assert.equal(store.events[0].status, 'cancelled');
  assert.equal(store.events[1].previousEventId, event.id);
  assert.equal(store.events[1].location, '演示会议室 C');
  assert.equal(store.emails[0].status, 'imported');
  assert.equal(store.emails[0].pendingActions.length, 0);
  const repeated = await process(store, recorder, async () => ambiguous());
  assert.equal(repeated.duplicate, 1);
});

test('目标 ID 不存在时进入待匹配；补充日程后可人工应用或再次同步明确 id', async () => {
  const store = emptyStore();
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => {
    calls++;
    return {
      summary: '合成评审取消。',
      category: 'meeting',
      intent: 'calendar',
      events: [{ action: 'cancel', targetEventId: event.id, reason: '项目暂停' }],
      tasks: [],
    };
  };
  const first = await process(store, recorder, extractor);
  assert.deepEqual(first.errors, []);
  assert.equal(store.emails[0].status, 'needs_match');
  assert.equal(calls, 1);
  // 邮件已落库，自动同步去重
  assert.equal((await process(store, recorder, extractor)).duplicate, 1);
  assert.equal(calls, 1);
  store.events.push(structuredClone(event));
  store.emails[0].pendingActions[0].candidates = [{
    id: event.id, title: event.title, start: event.start, end: event.end, location: event.location,
  }];
  resolveEmailMatch(store, email.id, {
    pendingActionId: store.emails[0].pendingActions[0].id,
    targetEventId: event.id,
    resolution: 'apply',
  });
  assert.equal(store.events[0].status, 'cancelled');
});

test('日历变化不会自动清掉已落库的 needs_match；忽略后可重新处理需清邮件记录', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event)], tasks: [structuredClone(task)] };
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => { calls++; return ambiguous(); };
  await process(store, recorder, extractor);
  assert.equal(calls, 1);
  store.events[0].location = '演示会议室 B';
  assert.equal((await process(store, recorder, extractor)).duplicate, 1);
  assert.equal(calls, 1);
  resolveEmailMatch(store, email.id, {
    pendingActionId: store.emails[0].pendingActions[0].id,
    resolution: 'dismiss',
  });
  assert.equal(store.emails[0].pendingActions.length, 0);
});

test('模型服务故障继续自动重试；不与 needs_match 混淆', async () => {
  const store = emptyStore();
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => {
    calls++;
    throw new Error('模型服务暂时不可用');
  };
  const first = await process(store, recorder, extractor);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0].message, /模型服务暂时不可用/);
  assert.equal(recorder.traces[0].status, 'failed');
  assert.equal(recorder.traces[0].match_retry, null);
  const second = await process(store, recorder, extractor);
  assert.equal(second.errors.length, 1);
  assert.equal(calls, 2);
});
