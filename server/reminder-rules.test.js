import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReminderItems, describeRule, evaluateReminders, formatBeijingDate, formatOffset,
  formatRemaining, matchRule, normalizePrefs, normalizeRule, notificationContent, notificationId,
} from '../shared/reminder-rules.js';

// 提醒规则的核心是「什么时候该弹哪一条通知」。这些用例把排期口径钉住：
// 提前量、允许提醒时间段顺延、过期续催、以及同一件事被待办/工作台/邮件重复描述时的去重。

const NOW = Date.parse('2026-10-17T10:00:00+08:00');

const state = {
  events: [
    { id: 'event-1', title: '产品设计评审', start: '2026-10-19T14:00:00+08:00', end: '2026-10-19T15:30:00+08:00', category: 'work' },
    { id: 'event-2', title: '已取消的会', start: '2026-10-18T09:00:00+08:00', status: 'cancelled' },
  ],
  tasks: [
    { id: 'task-1', title: '作业3 提交', dueAt: '2026-10-20T18:00:00+08:00', status: 'pending',
      deadlineText: '10月20日 18:00', sources: [{ emailId: 'mail-1' }] },
    { id: 'task-2', title: '报名材料', dueAt: '2026-10-18T18:00:00+08:00', status: 'pending' },
    { id: 'task-3', title: '已经交掉的作业', dueAt: '2026-10-19T18:00:00+08:00', status: 'done' },
  ],
  emails: [
    { id: 'mail-1', subject: '作业通知', extraction: { summary: '作业3 于 10月20日 18:00 截止', tasks: [{ title: '作业3 提交', dueAt: '2026-10-20T18:00:00+08:00' }] } },
    { id: 'mail-2', subject: '暑期营报名', extraction: { summary: '报名截止 10月19日 09:00', category: 'notice', tasks: [{ title: '暑期营报名截止', dueAt: '2026-10-19T09:00:00+08:00', deadlineText: '10月19日 09:00' }] } },
  ],
};

const scenarios = {
  workbenches: [{ id: 'wb-1', name: '推免申请' }],
  items: [{ id: 'item-1', workbenchId: 'wb-1', title: '暑期夏令营报名' }],
  actions: [
    { id: 'action-1', workbenchId: 'wb-1', itemId: 'item-1', title: '材料提交', kind: 'task', state: 'pending', dueAt: '2026-10-21T18:00:00+08:00' },
    { id: 'action-2', workbenchId: 'wb-1', itemId: 'item-1', title: '已发出的邮件', kind: 'task', state: 'sent', dueAt: '2026-10-22T18:00:00+08:00' },
    { id: 'action-3', workbenchId: 'wb-1', itemId: 'item-1', title: '没有截止时间的行动', kind: 'task', state: 'pending', dueAt: null },
  ],
};

test('归一化规则：补齐默认值、裁剪越界输入，不抛错', () => {
  const rule = normalizeRule({
    id: 'x', name: '很长的规则名'.repeat(10), targets: ['task', 'unknown', 'task'],
    keywords: [' 作业 ', '作业', ''], offsets: [{ value: 3, unit: 'day' }, { value: 0, unit: 'day' }, { value: 200, unit: 'day' }, 90],
    window: { start: '22:00', end: '08:00' }, overdue: { enabled: true, everyDays: 9 },
  });
  assert.equal(rule.id.startsWith('rm_'), true, '非法 id 应该重新生成');
  assert.equal(rule.targets.join(','), 'task', '未知类目被丢弃、重复项合并');
  assert.deepEqual(rule.keywords, ['作业']);
  assert.deepEqual(rule.offsets, [4320, 90], '提前量去重、排序（大到小）：3 天保留，0 与 200 天（超 90 天上限）丢弃');
  assert.equal(rule.window, null, 'end<=start 的时间段直接回退');
  assert.deepEqual(rule.overdue, { enabled: true, everyDays: 7 });
  assert.ok(rule.name.length <= 40);

  const bare = normalizeRule({ name: '报名' });
  assert.deepEqual(bare.targets, ['event', 'task', 'action', 'mail'], '未指定类目表示四类都要');
  assert.deepEqual(bare.offsets, [1440], '未指定提前量默认提前 1 天');
  assert.equal(bare.enabled, true);
});

test('摊平工作区数据：只保留未结束且有明确截止的条目', () => {
  const items = buildReminderItems({ state, scenarios });
  const keys = items.map((item) => `${item.kind}:${item.title}`);
  assert.deepEqual(keys, ['event:产品设计评审', 'task:作业3 提交', 'task:报名材料', 'action:材料提交', 'mail:暑期营报名截止']);
  assert.ok(!keys.some((key) => key.includes('已取消')), '取消的日程不提醒');
  assert.ok(!keys.some((key) => key.includes('已经交掉')), '完成的待办不提醒');
  assert.ok(!keys.some((key) => key.includes('已发出的邮件')), '已发出的行动不提醒');
  assert.ok(!keys.some((key) => key.includes('没有截止时间')), '没有截止时间无法倒数，不提醒');
  assert.ok(!keys.some((key) => key.includes('作业通知')), '邮件里的截止已经变成待办，由待办负责，不重复');
  const action = items.find((item) => item.kind === 'action');
  assert.equal(action.detail, '暑期夏令营报名 推免申请', '工作台行动带上事项与工作台名称，便于关键词匹配');
});

test('匹配规则：关键词、排除词与全部命中', () => {
  const items = buildReminderItems({ state, scenarios });
  // 类目过滤由排期阶段按 rule.targets 完成（见 evaluateReminders），这里一并带上，
  // 才能验证「只提醒待办截止，不提醒日程」这类语义。
  const matched = (rule, list = items) => list
    .filter((item) => rule.targets.includes(item.kind) && matchRule(rule, item))
    .map((item) => item.title);

  assert.deepEqual(matched(normalizeRule({ targets: ['task', 'mail'], keywords: ['作业'] })), ['作业3 提交']);

  assert.deepEqual(matched(normalizeRule({ targets: ['task'] })), ['作业3 提交', '报名材料'], '没有关键词表示该类目全都要');

  assert.deepEqual(matched(normalizeRule({ targets: ['task', 'mail'], keywords: [], excludeKeywords: ['报名'] })), ['作业3 提交']);

  assert.deepEqual(matched(normalizeRule({ targets: ['action'], keywords: ['材料', '推免'], matchAll: true })), ['材料提交']);
  assert.deepEqual(matched(normalizeRule({ targets: ['action'], keywords: ['材料', '不存在的词'], matchAll: true })), []);
});

test('排期：多条提前量、按截止时间倒数、内容可读', () => {
  const items = buildReminderItems({ state, scenarios });
  const rule = normalizeRule({ name: '作业', targets: ['task', 'mail'], keywords: ['作业'], offsets: [{ value: 3, unit: 'day' }, { value: 1, unit: 'day' }, { value: 4, unit: 'hour' }] });
  const occurrences = evaluateReminders({ rules: [rule], items, now: NOW });
  assert.deepEqual(occurrences.map((occurrence) => formatBeijingDate(occurrence.fireAt, { time: true })),
    ['10月17日 18:00', '10月19日 18:00', '10月20日 14:00'],
    '截止 10-20 18:00：提前 3 天=10-17 18:00（还没到 10:00 之后 30 秒的下限，仍然排）、提前 1 天、提前 4 小时');

  const last = notificationContent(occurrences.at(-1));
  assert.equal(last.title, '作业3 提交');
  assert.equal(last.body, '还有 4 小时 · 截止 10月20日 18:00 · 作业');
});

test('排期：落在允许时间段之外顺延到当天允许段开始，晚于截止则丢弃', () => {
  const items = buildReminderItems({ state, scenarios });
  const window = { start: '08:00', end: '22:00' };
  const rule = normalizeRule({ name: '报名', targets: ['mail'], keywords: ['报名'], offsets: [{ value: 4, unit: 'hour' }] });
  const [clamped] = evaluateReminders({ rules: [rule], items, now: NOW, window });
  assert.equal(formatBeijingDate(clamped.fireAt), '10月19日 08:00', '05:00 顺延到 08:00');

  const lateDeadline = buildReminderItems({
    state: { emails: [{ id: 'mail-late', subject: '早会通知', extraction: { tasks: [{ title: '早会', dueAt: '2026-10-19T07:00:00+08:00' }] } }] },
  });
  const dropped = evaluateReminders({ rules: [rule], items: lateDeadline, now: NOW, window });
  assert.deepEqual(dropped, [], '顺延后已经晚于截止，宁可不提醒，也不在事后打扰');
});

test('排期：同一件事被待办与邮件重复描述时只留一条', () => {
  const duplicated = buildReminderItems({
    state: {
      tasks: [],
      emails: [
        { id: 'mail-a', subject: '作业通知', extraction: { tasks: [{ title: '作业3 提交', dueAt: '2026-10-20T18:00:00+08:00' }] } },
        { id: 'mail-b', subject: '同一件事的另一封', extraction: { tasks: [{ title: '作业3 提交', dueAt: '2026-10-20T18:00:00+08:00' }] } },
      ],
    },
  });
  const rule = normalizeRule({ name: '作业', targets: ['mail'], keywords: ['作业'], offsets: [{ value: 1, unit: 'day' }] });
  const occurrences = evaluateReminders({ rules: [rule], items: duplicated, now: NOW });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].itemId, 'mail-a#作业3 提交', '保留先出现的那条，同一件事不会弹两次');
});

test('排期：过期续催按天数重复，最长 30 天，且不越过上限条数', () => {
  const items = buildReminderItems({ state, scenarios });
  const rule = normalizeRule({ name: '作业催办', targets: ['task'], keywords: ['作业'], offsets: [{ value: 1, unit: 'day' }], overdue: { enabled: true, everyDays: 2 } });
  const occurrences = evaluateReminders({ rules: [rule], items, now: NOW });
  const overdue = occurrences.filter((occurrence) => occurrence.overdue);
  assert.ok(overdue.length > 0, '过期后仍应继续提醒');
  assert.equal(overdue[0].offsetMinutes > 1440, true);
  assert.ok(overdue.every((occurrence) => occurrence.fireAt <= Date.parse('2026-10-20T18:00:00+08:00') + 30 * 86_400_000));
  assert.match(notificationContent(overdue[0]).body, /^已过期 /);

  const capped = evaluateReminders({ rules: [normalizeRule({ targets: ['event', 'task', 'action', 'mail'], offsets: [{ value: 1, unit: 'day' }, { value: 2, unit: 'hour' }] })], items, now: NOW, max: 3 });
  assert.equal(capped.length, 3, '只保留最近的若干条（iOS 待发送通知有上限）');
  assert.deepEqual(capped.map((occurrence) => occurrence.fireAt).sort((a, b) => a - b), capped.map((occurrence) => occurrence.fireAt));
});

test('通知 id 稳定、正文可读、规则描述可复核', () => {
  assert.equal(notificationId('rule:task:t1:1440'), notificationId('rule:task:t1:1440'));
  assert.notEqual(notificationId('rule:task:t1:1440'), notificationId('rule:task:t1:60'));
  assert.equal(Number.isInteger(notificationId('x')) && notificationId('x') > 0, true);

  assert.equal(formatOffset(4320), '3 天');
  assert.equal(formatOffset(4320 + 240), '3 天 4 小时');
  assert.equal(formatOffset(30), '30 分钟');
  assert.equal(formatRemaining(4 * 3_600_000), '还有 4 小时');
  assert.equal(formatRemaining(-2 * 3_600_000), '已过期 2 小时');

  assert.equal(describeRule({ name: '作业', targets: ['task', 'mail'], keywords: ['作业'], offsets: [4320, 1440, 240] }),
    '待办截止、邮件里的截止，含「作业」，提前 3 天、1 天、4 小时 提醒');
});

test('整份偏好归一化：规则上限、开关与时间段回退', () => {
  const prefs = normalizePrefs({
    enabled: false,
    window: { start: '8:00', end: '22:00' },
    maxPending: 999,
    rules: Array.from({ length: 40 }, (_, index) => ({ name: `规则${index}` })),
    log: [{ fireAt: '2026-10-18T08:00:00+08:00', at: NOW, title: '作业3', ruleId: 'r1', itemKind: 'task', itemId: 't1' }, { broken: true }],
  });
  assert.equal(prefs.enabled, false);
  assert.deepEqual(prefs.window, { start: '08:00', end: '22:00' });
  assert.equal(prefs.maxPending, 64);
  assert.equal(prefs.rules.length, 30);
  assert.equal(prefs.log.length, 1);
  assert.equal(prefs.log[0].title, '作业3');
});
