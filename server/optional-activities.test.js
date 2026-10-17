import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic mail, prompts, and model responses stay separate from the user's data.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, 'work', 'optional-activities-test-'));
process.env.DAYLIGHT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
const { extractEvents, parseExtraction, processEmails } = await import('./agent.js');
const { DEFAULT_EXTRACTION_PROMPT } = await import('./prompts.js');

const baseEvent = { title: '合成开放分享', start: '2026-10-20T14:00:00+08:00',
  allDay: false, category: 'work', location: '演示活动室', description: '可自愿报名参加' };
const baseEmail = { id: 'qq:optional-fixture:100:1', subject: '合成开放分享报名通知',
  sender: 'Synthetic Host <synthetic-host@example.invalid>', receivedAt: '2026-10-15T10:00:00+08:00',
  body: '合成开放分享将于 2026 年 10 月 20 日 14:00 举办，欢迎报名，自愿参加。' };
const settings = { baseUrl: 'https://synthetic.invalid/v1', apiKey: 'invented-optional-activity-key', model: 'synthetic-model' };
const emptyStore = () => ({ events: [], tasks: [], emails: [], lastSync: null });
const extraction = (events) => ({ summary: '合成开放活动，感兴趣可报名参加。',
  category: 'notice', intent: 'calendar', priority: 'normal', tasks: [], events });

function fakeModel(t, answer) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const content = typeof answer === 'function' ? answer(request) : answer;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return requests;
}

function assertActivityRules(system) {
  for (const phrase of ['报名参加', '自愿参加', '欢迎报名', '感兴趣']) {
    assert.ok(system.includes(phrase), `缺少可选活动规则：${phrase}`);
  }
  assert.match(system, /默认[^\n。]{0,40}(?:2\s*小时|两小时)/);
  assert.match(system, /报名截止/);
  assert.match(system, /活动时间/);
  assert.match(system, /calendar/);
}

test('默认提取规则包含报名、自愿活动和两小时时长，并区分报名截止与活动时间', async (t) => {
  const requests = fakeModel(t, extraction([{ action: 'create', ...baseEvent, end: '2026-10-20T16:00:00+08:00' }]));
  assertActivityRules(DEFAULT_EXTRACTION_PROMPT);
  await extractEvents(baseEmail, settings);
  assertActivityRules(requests[0].messages[0].content);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(JSON.parse(requests[0].messages[1].content).body, baseEmail.body);
});

test('本机已保存自定义提取 prompt 时仍追加最新可选活动规则，并保留自定义内容', async (t) => {
  const custom = '合成自定义规则：标题统一用中文。仅处理必须参加的活动，新邀请缺少结束时间默认一小时。';
  fs.writeFileSync(path.join(dataDir, 'prompts.json'), JSON.stringify({ extractionSystem: custom }));
  t.after(() => fs.writeFileSync(path.join(dataDir, 'prompts.json'), JSON.stringify({ extractionSystem: DEFAULT_EXTRACTION_PROMPT })));
  const requests = fakeModel(t, extraction([]));
  await extractEvents(baseEmail, settings);
  const system = requests[0].messages[0].content;
  assert.ok(system.includes(custom));
  assertActivityRules(system);
  assert.ok(system.indexOf('报名参加') > system.indexOf(custom) + custom.length - 1,
    '最新活动规则应位于已保存的旧规则之后');
});

test('新建非全天日程缺少 end 时默认两小时，跨午夜仍使用北京时间', () => {
  for (const end of [undefined, null, '']) {
    const parsed = parseExtraction(JSON.stringify(extraction([
      { action: 'create', ...baseEvent, start: '2026-10-20T23:30:00+08:00', end },
    ])));
    const actual = parsed.events[0];
    assert.equal(Date.parse(actual.end) - Date.parse(actual.start), 2 * 60 * 60 * 1000);
    assert.match(actual.end, /^2026-10-21T01:30:00(?:\.000)?\+08:00$/);
    assert.equal(actual.allDay, false);
  }
});

test('报名参加、自愿参加和欢迎报名活动可入历，缺失结束时间保存为两小时且重复邮件去重', async (t) => {
  const phrases = ['报名参加', '自愿参加', '欢迎报名'];
  const emails = phrases.map((phrase, index) => ({ ...baseEmail, id: `qq:optional-fixture:200:${index + 1}`,
    subject: `合成活动 ${index + 1} ${phrase}`, body: `合成活动 ${index + 1} 于 2026 年 10 月 ${20 + index} 日 14:00 举办，${phrase}。` }));
  const requests = fakeModel(t, (request) => {
    const mail = JSON.parse(request.messages[1].content);
    const index = emails.findIndex((item) => item.subject === mail.subject);
    return extraction([{ action: 'create', ...baseEvent, title: `合成活动 ${index + 1}`,
      start: `2026-10-${20 + index}T14:00:00+08:00` }]);
  });
  const store = emptyStore();
  const run = () => processEmails(store, emails,
    (mail, events, context, tasks) => extractEvents(mail, settings, events, context, tasks), 'qq');
  const result = await run();
  assert.deepEqual(result.errors, []);
  assert.equal(result.added, 3);
  assert.equal(result.skipped, 0);
  assert.equal(store.events.length, 3);
  for (const event of store.events) {
    assert.equal(Date.parse(event.end) - Date.parse(event.start), 2 * 60 * 60 * 1000);
    assert.equal(event.source, 'email');
    const mail = store.emails.find((item) => item.id === event.emailId);
    assert.equal(mail.intent, 'calendar');
    assert.equal(mail.extraction.actions[0].end, event.end);
  }
  const repeat = await run();
  assert.equal(repeat.duplicate, 3);
  assert.equal(store.events.length, 3);
  assert.equal(requests.length, 3);
});

test('导入入口也为未规范化的新日程补齐两小时，不依赖模型先填 end', async () => {
  const store = emptyStore();
  const result = await processEmails(store, [baseEmail], async () => extraction([{ ...baseEvent }]), 'qq');
  assert.deepEqual(result.errors, []);
  assert.equal(result.added, 1);
  assert.equal(Date.parse(store.events[0].end) - Date.parse(baseEvent.start), 2 * 60 * 60 * 1000);
});

test('明确结束时间和完整全天日程原样保留，无效的明确结束时间继续报错', async () => {
  const explicit = { ...baseEvent, end: '2026-10-20T14:45:00+08:00' };
  const allDay = { ...baseEvent, title: '合成两天活动', allDay: true,
    start: '2026-10-21T00:00:00+08:00', end: '2026-10-23T00:00:00+08:00' };
  const parsed = parseExtraction(JSON.stringify(extraction([explicit, allDay])));
  const store = emptyStore();
  const result = await processEmails(store, [baseEmail], async () => parsed, 'qq');
  assert.deepEqual(result.errors, []);
  assert.equal(result.added, 2);
  assert.equal(store.events[0].end, explicit.end);
  assert.equal(store.events[1].start, allDay.start);
  assert.equal(store.events[1].end, allDay.end);
  assert.equal(store.events[1].allDay, true);
  for (const end of ['invalid-time', '2026-10-20T13:00:00+08:00']) {
    assert.throws(() => parseExtraction(JSON.stringify(extraction([{ ...baseEvent, end }]))), /有效的起止时间/);
  }
});

test('改期仅提供新开始时间时沿用原时长，地点调整保留原起止时间', async () => {
  const original = { ...baseEvent, id: 'synthetic-long-activity', source: 'manual',
    end: '2026-10-20T17:30:00+08:00', status: 'active' };
  const store = { ...emptyStore(), events: [{ ...original }] };
  const reschedule = parseExtraction(JSON.stringify(extraction([{ action: 'reschedule', targetEventId: original.id,
    reason: '合成活动改到次日', start: '2026-10-21T10:00:00+08:00' }])));
  const result = await processEmails(store, [baseEmail], async () => reschedule, 'qq');
  assert.deepEqual(result.errors, []);
  assert.equal(result.rescheduled, 1);
  const replacement = store.events.find((item) => item.previousEventId === original.id);
  assert.ok(replacement);
  assert.equal(Date.parse(replacement.end) - Date.parse(replacement.start), 3.5 * 60 * 60 * 1000);
  assert.equal(store.events[0].status, 'cancelled');
  assert.equal(store.events[0].replacementEventId, replacement.id);

  const changeLocation = parseExtraction(JSON.stringify(extraction([{ action: 'reschedule', targetEventId: replacement.id,
    reason: '合成场地变更', location: '演示活动室 C' }])));
  const moved = await processEmails(store, [{ ...baseEmail, id: 'qq:optional-fixture:100:2' }], async () => changeLocation, 'qq');
  assert.deepEqual(moved.errors, []);
  assert.equal(moved.rescheduled, 1);
  const latest = store.events.find((item) => item.previousEventId === replacement.id);
  assert.equal(latest.start, replacement.start);
  assert.equal(latest.end, replacement.end);
  assert.equal(latest.location, '演示活动室 C');
});
