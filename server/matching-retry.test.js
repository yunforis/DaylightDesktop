import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEmails } from './agent.js';
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
const modelContext = JSON.stringify({ endpoint: 'https://example.invalid/v1', model: 'synthetic-model', version: 'mail-calendar-tasks-v3' });
const emptyStore = () => ({ events: [], tasks: [], emails: [], lastSync: null });
const ambiguous = () => ({ summary: '场地调整，但无法唯一匹配原安排。', events: [
  { action: 'reschedule', location: '演示会议室 C', reason: '场地调整' },
] });
const process = (store, recorder, extractor, retryMode = 'auto', context = modelContext) =>
  processEmails(store, [email], extractor, 'qq', { recorder, retryMode, modelContext: context });

test('匹配失败不猜目标且不产生部分写入；相同上下文自动同步和邮箱切换不增加模型调用或日志尝试', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event), { ...event, id: 'similar-review', location: '演示会议室 B' }] };
  const before = structuredClone(store.events);
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => {
    calls++;
    return { summary: '合成新邀请和不明确的场地调整。', events: [
      { ...event, action: 'create', title: '合成新邀请' }, ...ambiguous().events,
    ] };
  };
  const first = await process(store, recorder, extractor);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0].message, /未匹配到唯一日程/);
  assert.equal(first.deferred, 0);
  assert.equal(first.added, 0);
  assert.equal(store.emails.length, 0);
  assert.deepEqual(store.events, before);
  const trace = recorder.traces[0];
  assert.equal(trace.status, 'failed');
  assert.match(trace.match_retry.context_key, /^[a-f0-9]{64}$/);
  assert.equal(trace.match_retry.message, first.errors[0].message);
  const attempts = trace.attempts.length;
  const spans = trace.spans.length;
  // Operational timestamps, annotations and history do not change the model's match candidates.
  store.lastSync = '2026-10-14T08:01:00+08:00';
  store.events.reverse();
  store.events[0].updatedAt = '2026-10-14T08:01:30+08:00';
  trace.user_action = 'modified';
  trace.known_cost_cny = 0.5;
  for (const retryMode of ['auto', 'mailbox-switch']) {
    const deferred = await process(store, recorder, extractor, retryMode);
    assert.equal(deferred.deferred, 1);
    assert.equal(deferred.errors.length, 1);
    assert.equal(deferred.errors[0].deferred, true);
    assert.match(deferred.errors[0].message, /本轮没有重复调用模型/);
    assert.equal(deferred.duplicate, 0);
    assert.equal(deferred.skipped, 0);
    assert.equal(store.emails.length, 0);
    assert.equal(trace.attempts.length, attempts);
    assert.equal(trace.spans.length, spans);
    assert.equal(trace.status, 'failed');
  }
  assert.equal(calls, 1);
});

test('手动同步默认可以重试；匹配恢复后清除暂缓标记并按已处理邮件 ID 去重', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event)] };
  const recorder = createTraceRecorder();
  let calls = 0;
  let matching = false;
  const extractor = async () => {
    calls++;
    return matching ? { summary: '已确认合成评审的场地调整。', events: [
      { action: 'reschedule', targetEventId: event.id, location: '演示会议室 C', reason: '已确认场次' },
    ] } : ambiguous();
  };
  await process(store, recorder, extractor);
  const retry = await processEmails(store, [email], extractor, 'qq', { recorder, modelContext });
  assert.equal(retry.errors.length, 1);
  assert.equal(retry.deferred, 0);
  assert.equal(calls, 2);
  assert.equal(recorder.traces[0].attempts.length, 2);
  matching = true;
  const success = await process(store, recorder, extractor, 'manual');
  assert.deepEqual(success.errors, []);
  assert.equal(success.rescheduled, 1);
  assert.equal(calls, 3);
  assert.equal(recorder.traces[0].match_retry, null);
  assert.equal(recorder.traces[0].attempts.length, 3);
  assert.equal(store.events[0].status, 'cancelled');
  assert.equal(store.events[1].previousEventId, event.id);
  assert.equal(store.events[1].location, '演示会议室 C');
  assert.equal(store.emails.length, 1);
  const repeated = await process(store, recorder, extractor);
  assert.equal(repeated.duplicate, 1);
  assert.equal(repeated.deferred, 0);
  assert.equal(calls, 3);
  assert.equal(recorder.traces[0].attempts.length, 3);
});

test('目标 ID 不存在也暂缓自动重试，补充有效日程后自动恢复并清除标记', async () => {
  const store = emptyStore();
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => {
    calls++;
    return { summary: '合成评审取消。', events: [{ action: 'cancel', targetEventId: event.id, reason: '项目暂停' }] };
  };
  const first = await process(store, recorder, extractor);
  assert.match(first.errors[0].message, /目标不存在、已取消或不唯一/);
  assert.ok(recorder.traces[0].match_retry);
  assert.equal((await process(store, recorder, extractor)).deferred, 1);
  assert.equal(calls, 1);
  store.events.push(structuredClone(event));
  const restored = await process(store, recorder, extractor);
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.cancelled, 1);
  assert.equal(calls, 2);
  assert.equal(recorder.traces[0].match_retry, null);
});

test('有效日历、已有任务和模型上下文变化会恢复自动重试，示例与已取消日程变化不触发', async () => {
  const store = { ...emptyStore(), events: [structuredClone(event)], tasks: [structuredClone(task)] };
  const recorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => { calls++; return ambiguous(); };
  await process(store, recorder, extractor);
  const firstKey = recorder.traces[0].match_retry.context_key;
  store.events.push({ ...event, id: 'demo-review', source: 'demo' }, { ...event, id: 'old-review', status: 'cancelled' });
  store.tasks.push({ ...task, id: 'demo-task', source: 'demo' });
  store.events.find((item) => item.id === 'old-review').description = '已取消安排的历史备注变化';
  assert.equal((await process(store, recorder, extractor)).deferred, 1);
  assert.equal(calls, 1);
  assert.equal(recorder.traces[0].match_retry.context_key, firstKey);
  store.events[0].location = '演示会议室 B';
  assert.equal((await process(store, recorder, extractor)).deferred, 0);
  assert.equal(calls, 2);
  store.tasks[0].description = '补充原活动背景';
  assert.equal((await process(store, recorder, extractor)).deferred, 0);
  assert.equal(calls, 3);
  store.tasks[0].status = 'done';
  assert.equal((await process(store, recorder, extractor)).deferred, 0);
  assert.equal(calls, 4);
  const changedModel = JSON.stringify({ endpoint: 'https://example.invalid/v1', model: 'synthetic-updated-model', version: 'mail-calendar-tasks-v3' });
  assert.equal((await process(store, recorder, extractor, 'auto', changedModel)).deferred, 0);
  assert.equal(calls, 5);
  assert.equal((await process(store, recorder, extractor, 'auto', changedModel)).deferred, 1);
  assert.equal(recorder.traces[0].attempts.length, 5);
  assert.equal(store.emails.length, 0);
});

test('模型服务故障继续自动重试；手动匹配重试改为服务故障时移除旧匹配标记', async () => {
  const store = emptyStore();
  const recorder = createTraceRecorder();
  let calls = 0;
  let behavior = 'match';
  const extractor = async () => {
    calls++;
    if (behavior === 'service') throw new Error('合成模型请求失败：503');
    if (behavior === 'success') return { summary: '合成普通通知。', events: [] };
    return ambiguous();
  };
  await process(store, recorder, extractor);
  assert.ok(recorder.traces[0].match_retry);
  behavior = 'service';
  const manual = await process(store, recorder, extractor, 'manual');
  assert.match(manual.errors[0].message, /503/);
  assert.equal(recorder.traces[0].match_retry, null);
  const automatic = await process(store, recorder, extractor);
  assert.equal(automatic.deferred, 0);
  assert.match(automatic.errors[0].message, /503/);
  assert.equal(calls, 3);
  behavior = 'success';
  const recovered = await process(store, recorder, extractor);
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.skipped, 1);
  assert.equal(calls, 4);
  assert.equal(recorder.traces[0].attempts.length, 4);
});

test('各邮箱独立 recorder 的匹配失败标记互不影响，即使传入相同合成邮件 ID', async () => {
  const firstStore = emptyStore();
  const secondStore = emptyStore();
  const firstRecorder = createTraceRecorder();
  const secondRecorder = createTraceRecorder();
  let calls = 0;
  const extractor = async () => { calls++; return ambiguous(); };
  await process(firstStore, firstRecorder, extractor);
  assert.equal((await process(firstStore, firstRecorder, extractor)).deferred, 1);
  const second = await process(secondStore, secondRecorder, extractor);
  assert.equal(second.errors.length, 1);
  assert.equal(second.deferred, 0);
  assert.equal(calls, 2);
  assert.notEqual(firstRecorder.traces[0].trace_id, secondRecorder.traces[0].trace_id);
  assert.equal(firstRecorder.traces[0].attempts.length, 1);
  assert.equal(secondRecorder.traces[0].attempts.length, 1);
});
