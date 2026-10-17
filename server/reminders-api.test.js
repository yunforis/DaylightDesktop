/**
 * 提醒规则解析接口（POST /api/reminders/parse）。
 *
 * 这条链路很窄但必须钉住三件事：
 * 1. 模型产出的字段一律过一遍 shared/reminder-rules.js 的归一化——越界值截断而不是 500；
 * 2. 没配模型 / 模型没读懂时给出可操作的中文错误，而不是静默返回空规则；
 * 3. 接口无状态：不建日程、不建待办、不写业务数据（规则存在手机端）。
 *
 * 这里只 stub 模型 HTTP 调用（globalThis.fetch）；接口本身用真实 express 路由，
 * 因为「路由有没有挂上、鉴权与参数校验在不在」正是要验证的一部分。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-reminders-'));
process.env.DAYLIGHT_DATA_DIR = directory;
process.env.DAYLIGHT_RUNTIME = 'local';
process.env.DAYLIGHT_AUTO_PROXY = '0';

const settingsPath = path.join(directory, 'settings.json');
const MODEL_SETTINGS = { baseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-key', model: 'synthetic-model' };
const writeSettings = (value) => fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2));
writeSettings(MODEL_SETTINGS);

const { parseReminderText, reminderRouter } = await import('./reminders-api.js');
const originalFetch = globalThis.fetch;
const NOW = Date.parse('2026-10-17T10:00:00+08:00');

let calls = [];
function stubModel(content) {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 30 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('一句话 → 规则草稿：越界字段被归一化，不是报错', async () => {
  stubModel(JSON.stringify({
    rules: [
      { name: '作业提醒', targets: ['task', 'unknown-target'], keywords: ['作业', '作业'],
        offsets: [{ value: 3, unit: 'day' }, { value: 1, unit: 'day' }, { value: 4, unit: 'hour' }],
        window: { start: '09:00', end: '21:00' } },
      { name: '乱值', targets: [], offsets: [{ value: 0, unit: 'day' }, { value: 999, unit: 'day' }],
        window: { start: '23:00', end: '07:00' }, overdue: { enabled: true, everyDays: 99 } },
    ],
    reply: '作业提前 3 天、1 天、4 小时提醒你。',
  }));
  const parsed = await parseReminderText({ text: '作业提前 3 天、1 天、4 小时提醒我', now: NOW });

  assert.equal(parsed.rules.length, 2);
  const [first, second] = parsed.rules;
  assert.deepEqual(first.offsets, [4320, 1440, 240], '提前量换算成分钟并从大到小');
  assert.deepEqual(first.keywords, ['作业'], '关键词去重');
  assert.deepEqual(first.targets, ['task'], '模型编造的类目被丢掉，而不是带着跑');
  assert.deepEqual(first.window, { start: '09:00', end: '21:00' });
  assert.ok(/^rm_[A-Za-z0-9]{6,}$/.test(first.id), '缺少合法 id 时补一个，手机端才有稳定去重键');
  assert.equal(first.enabled, true, '模型没写 enabled 时默认开启');

  assert.deepEqual(second.targets, ['event', 'task', 'action', 'mail'], '没给类目时四类兜底');
  assert.deepEqual(second.offsets, [1440], '提前量全部不合法时回退成「提前 1 天」');
  assert.equal(second.window, null, '跨天时间段无法顺延，直接回退成默认（null 表示用默认）');
  assert.equal(second.overdue.everyDays, 7, '过期续催频率截到 1-7 天');

  const body = calls[0].body;
  assert.equal(body.response_format.type, 'json_object', '必须要求 JSON 模式');
  assert.equal(body.model, 'synthetic-model');
  assert.match(body.messages[1].content, /今天是北京时间 10月17日 10:00/);
  assert.match(body.messages[1].content, /用户目前还没有提醒规则/);
  assert.match(body.messages[1].content, /作业提前 3 天、1 天、4 小时提醒我/);
});

test('已有规则名带给模型，避免重复建议', async () => {
  stubModel('{"rules":[{"name":"面试","targets":["event"],"offsets":[{"value":1,"unit":"hour"}]}],"reply":"已配置。"}');
  const parsed = await parseReminderText({ text: '面试前 1 小时提醒', existing: ['作业提醒', '报名'], now: NOW });
  assert.match(calls[0].body.messages[1].content, /作业提醒、报名/);
  assert.equal(parsed.reply, '已配置。');
});

test('reply 缺失时也有话可说，前端不用自己拼', async () => {
  stubModel('{"rules":[{"name":"日报","targets":["task"],"offsets":[{"value":2,"unit":"hour"}]}]}');
  const parsed = await parseReminderText({ text: '日报提前 2 小时', now: NOW });
  assert.equal(parsed.reply, '');
});

test('没配模型时给出可操作的中文错误，而不是静默失败', async () => {
  writeSettings({ baseUrl: '', apiKey: '', model: '' });
  try {
    await assert.rejects(parseReminderText({ text: '作业提前 1 天', now: NOW }),
      (error) => error.status === 409 && /模型/.test(error.message));
  } finally {
    writeSettings(MODEL_SETTINGS);
  }
});

test('模型没读懂时明确说没读懂，换种说法可以重试', async () => {
  stubModel('{"rules":[],"reply":""}');
  await assert.rejects(parseReminderText({ text: '随便说点什么', now: NOW }),
    (error) => error.status === 502 && /换一种说法/.test(error.message));
});

test('模型不返回 JSON 对象时报错可重试，不会写坏任何业务数据', async () => {
  stubModel('{"rules":"作业提前一天"}');
  const before = fs.readdirSync(directory).sort();
  await assert.rejects(parseReminderText({ text: '作业提前一天', now: NOW }));
  assert.deepEqual(fs.readdirSync(directory).sort(), before, '解析失败不该落任何文件');
});

test('请求上下文没有追踪记录器时也能调用模型（不会 TypeError）', async () => {
  stubModel('{"rules":[{"name":"作业","targets":["task"],"offsets":[{"value":1,"unit":"day"}]}],"reply":"好的。"}');
  const { runWithRequestContext } = await import('./request-context.js');
  // HTTP 中间件给的上下文只有身份，没有 startSpan；模型调用必须容忍这种情况。
  const parsed = await runWithRequestContext({ userId: 'u1', user: { id: 'u1' } }, () =>
    parseReminderText({ text: '作业提前一天', now: NOW }));
  assert.equal(parsed.rules.length, 1);
  assert.equal(calls.length, 1);
});

test('接口面：401 / 400 / 200，参数校验带中文原因', async () => {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization === 'Bearer synthetic') req.user = { id: 'u1' };
    next();
  });
  app.use('/api/reminders', reminderRouter);
  // 与 server/index.js 末尾的错误处理保持一致：错误以 {error} 的 JSON 返回，前端才能显示中文原因。
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/reminders/parse`;
  const post = (body, headers = { Authorization: 'Bearer synthetic' }) => originalFetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    stubModel('{"rules":[{"name":"作业","targets":["task"],"keywords":["作业"],"offsets":[{"value":1,"unit":"day"}]}],"reply":"作业提前 1 天提醒。"}');

    const anonymous = await post({ text: '作业提前一天' }, {});
    assert.equal(anonymous.status, 401);

    const empty = await post({ text: '   ' });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /请先描述/);

    const tooLong = await post({ text: '啊'.repeat(501) });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /500 字以内/);

    const ok = await post({ text: '作业提前一天提醒我', existing: ['报名'] });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.rules.length, 1);
    assert.deepEqual(payload.rules[0].offsets, [1440]);
    assert.equal(payload.reply, '作业提前 1 天提醒。');
    assert.equal(payload.summary.length, 1);
    assert.match(payload.summary[0], /^作业：/);
    assert.match(payload.summary[0], /提前 1 天/);
    assert.ok(!('text' in payload) || payload.text === undefined, '不回显用户原话之外的私有内容');
    assert.equal(calls.length, 1, '只调用一次模型');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
