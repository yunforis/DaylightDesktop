import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(root, 'work', 'capability-loop-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;

const { importEmail, resolveEmailMatch, parseExtraction, processEmails } = await import('./agent.js');
const { emailLabels, assertTaskCompletable, EMAIL_CATEGORIES, EMAIL_INTENTS } = await import('./tasks.js');
const {
  queueExternalSync, setExternalSyncRequireConfirm, confirmPendingExternalSync,
  dismissPendingExternalSync, publicCalendarSync, listPendingExternalSync,
} = await import('./external-calendar.js');
const { saveCalendarSync } = await import('./store.js');

const event = {
  id: 'evt-capability-1',
  title: '产品复盘',
  start: '2026-10-20T14:00:00+08:00',
  end: '2026-10-20T15:00:00+08:00',
  allDay: false,
  category: 'work',
  location: 'A',
  source: 'manual',
};
const email = {
  id: 'qq:capability:1',
  subject: '场地调整通知',
  sender: 'host@example.invalid',
  receivedAt: '2026-10-15T09:00:00+08:00',
  body: '复盘改到会议室 B，请确认。',
};

test('分类含 general/irrelevant，并校验独立 intent', () => {
  assert.ok(EMAIL_CATEGORIES.includes('general'));
  assert.ok(EMAIL_CATEGORIES.includes('irrelevant'));
  assert.ok(EMAIL_INTENTS.includes('calendar'));
  const labels = emailLabels({ category: 'general', priority: 'low', intent: 'fyi' });
  assert.equal(labels.intent, 'fyi');
  assert.throws(() => emailLabels({ intent: 'hack' }), /不支持的邮件意图/);
});

test('irrelevant / noise 不写入日程或待办', () => {
  const store = { events: [], emails: [], tasks: [], lastSync: null };
  const record = importEmail(store, email, {
    summary: '无关推广',
    category: 'irrelevant',
    intent: 'noise',
    priority: 'low',
    events: [{ action: 'create', title: '不应创建', start: event.start, end: event.end, allDay: false, category: 'work' }],
    tasks: [{ title: '不应创建的待办' }],
  }, 'qq');
  assert.equal(record.status, 'skipped');
  assert.equal(store.events.length, 0);
  assert.equal(store.tasks.length, 0);
});

test('省略 target 进入 needs_match，人工点选后完成 cancel', () => {
  const store = { events: [{ ...event }], emails: [], tasks: [], lastSync: null };
  const record = importEmail(store, email, {
    summary: '取消通知但目标不明',
    category: 'meeting',
    intent: 'calendar',
    priority: 'normal',
    events: [{ action: 'cancel', reason: '活动取消' }],
  }, 'qq');
  assert.equal(record.status, 'needs_match');
  assert.equal(record.pendingActions.length, 1);
  assert.equal(store.events[0].status, undefined);

  resolveEmailMatch(store, email.id, {
    pendingActionId: record.pendingActions[0].id,
    targetEventId: event.id,
    resolution: 'apply',
  });
  assert.equal(store.events[0].status, 'cancelled');
  const updated = store.emails.find((item) => item.id === email.id);
  assert.equal(updated.pendingActions.length, 0);
  assert.equal(updated.status, 'imported');
});

test('keep 动作确认日历已是最新且不改写日程', () => {
  const store = { events: [{ ...event }], emails: [], tasks: [], lastSync: null };
  const record = importEmail(store, { ...email, id: 'qq:capability:keep' }, {
    summary: '已是最新安排',
    category: 'meeting',
    intent: 'calendar',
    events: [{ action: 'keep', targetEventId: event.id, reason: '时间地点未变' }],
  }, 'qq');
  assert.equal(record.status, 'imported');
  assert.deepEqual(record.keptEventIds, [event.id]);
  assert.equal(store.events[0].status, undefined);
  assert.equal(store.events[0].location, 'A');
});

test('待办 reply_sent 核验在未发信时拒绝完成', () => {
  const task = {
    id: 'task-1',
    title: '回复确认',
    requiresVerification: true,
    verification: { mode: 'reply_sent', status: 'pending' },
    sources: [{ emailId: email.id }],
  };
  assert.throws(
    () => assertTaskCompletable(task, { emails: [{ id: email.id }], traces: [] }),
    /已发送回复/,
  );
  const ok = assertTaskCompletable(task, {
    emails: [{ id: email.id, reply_delivery: { status: 'sent' } }],
    traces: [],
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.verifiedAt);
});

test('外部日历 requireConfirm 时入队，确认后出队', () => {
  saveCalendarSync({
    oauthApps: {},
    connections: [{ id: 'conn-1', provider: 'google', enabled: true, accessToken: 'x', refreshToken: 'y' }],
    requireConfirm: false,
    pendingExternalSync: [],
  });
  setExternalSyncRequireConfirm(true);
  const store = { events: [{ ...event }], emails: [], tasks: [] };
  const queued = queueExternalSync(store, event, 'create');
  assert.equal(queued.requireConfirm, true);
  assert.equal(listPendingExternalSync().length, 1);
  assert.equal(publicCalendarSync().requireConfirm, true);
  const dismissed = dismissPendingExternalSync({ all: true });
  assert.equal(dismissed.pending, 0);
  queueExternalSync(store, event, 'update');
  const confirmed = confirmPendingExternalSync(store, { all: true });
  assert.equal(confirmed.confirmed, 1);
});

test('parseExtraction 接受 intent 与 keep', () => {
  const parsed = parseExtraction(JSON.stringify({
    summary: '闲聊',
    category: 'general',
    intent: 'fyi',
    priority: 'low',
    events: [],
    tasks: [],
  }));
  assert.equal(parsed.category, 'general');
  assert.equal(parsed.intent, 'fyi');
});

test('processEmails 对 needs_match 记成功处理并可再次人工 resolve', async () => {
  const store = { events: [{ ...event }], emails: [], tasks: [], lastSync: null };
  const result = await processEmails(store, [email], async () => ({
    summary: '改期但未给目标',
    category: 'meeting',
    intent: 'calendar',
    priority: 'normal',
    events: [{ action: 'reschedule', reason: '改期', location: 'B', start: event.start, end: event.end }],
    tasks: [],
  }), 'qq', { enrichAttachments: false });
  assert.deepEqual(result.errors, []);
  assert.equal(store.emails[0].status, 'needs_match');
  const pending = store.emails[0].pendingActions[0];
  resolveEmailMatch(store, email.id, {
    pendingActionId: pending.id,
    targetEventId: event.id,
    resolution: 'apply',
  });
  assert.equal(store.events.find((item) => item.id === event.id).status, 'cancelled');
  assert.ok(store.events.some((item) => item.previousEventId === event.id && item.location === 'B'));
});
