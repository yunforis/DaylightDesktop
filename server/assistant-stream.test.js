import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, beforeEach, test } from 'node:test';

// 在 Node 中替换浏览器别名入口；实际解析/回退逻辑直接加载生产源文件。
const encodeModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const imports = {
  '@/lib/auth-api': encodeModule('export const getAuthToken = () => globalThis.__assistantStreamFixture.token;'),
  '@/lib/api': encodeModule('export const getRequestMailboxId = () => globalThis.__assistantStreamFixture.mailboxId;'),
  '@/lib/api-error': new URL('../src/lib/api-error.js', import.meta.url).href,
};
let source = await readFile(new URL('../src/lib/assistant-stream.js', import.meta.url), 'utf8');
for (const [alias, target] of Object.entries(imports)) source = source.replace(`'${alias}'`, `'${target}'`);
const { streamAssistantChat } = await import(encodeModule(source));
const originalFetch = globalThis.fetch;
const fixture = { mailboxId: 'mailbox-a', token: 'synthetic-token-a' };
globalThis.__assistantStreamFixture = fixture;
const messages = [{ role: 'user', content: '为测试收件人准备一份待审核草稿' }];

beforeEach(() => { fixture.mailboxId = 'mailbox-a'; fixture.token = 'synthetic-token-a'; });
after(() => { globalThis.fetch = originalFetch; delete globalThis.__assistantStreamFixture; });

test('SSE 工具执行后断开，JSON 恢复沿用请求 ID、原邮箱与原认证', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (calls.length === 1) {
      fixture.mailboxId = 'mailbox-b';
      fixture.token = 'synthetic-token-b';
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"tool_end","name":"draft_email","result":{"ok":true}}\n\n')); },
        pull(controller) { controller.error(new Error('stream ended')); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ reply: '已生成待审核草稿', toolTrace: [{ name: 'draft_email', result: { ok: true } }] });
  };
  const events = [];
  const result = await streamAssistantChat(messages, { onEvent: (event) => events.push(event) });
  assert.equal(result.reply, '已生成待审核草稿');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[1].body.stream, false);
  assert.ok(calls[0].body.requestId);
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
  assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
  for (const call of calls) {
    assert.equal(call.options.headers['X-Mailbox-Id'], 'mailbox-a');
    assert.equal(call.options.headers.Authorization, 'Bearer synthetic-token-a');
  }
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
});

test('空 SSE 流恢复同一次请求，显式邮箱覆盖全局当前邮箱', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return calls.length === 1
      ? new Response('', { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ reply: '恢复完成' });
  };
  assert.equal((await streamAssistantChat(messages, { mailboxId: 'mailbox-fixed', requestId: 'fixed-request' })).reply, '恢复完成');
  for (const call of calls) {
    assert.equal(JSON.parse(call.body).requestId, 'fixed-request');
    assert.equal(call.headers['X-Mailbox-Id'], 'mailbox-fixed');
  }
});

test('首次请求网络失败后的恢复仍使用同一个请求 ID', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return Response.json({ reply: '已取回结果' });
  };
  await streamAssistantChat(messages);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId);
});

test('用户取消时中止且不触发 JSON 回退', async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options.signal, controller.signal);
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  };
  await assert.rejects(streamAssistantChat(messages, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('明确的权限错误只请求一次', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ error: '邮箱已切换，请刷新。' }, { status: 409 }); };
  await assert.rejects(streamAssistantChat(messages), /邮箱已切换/);
  assert.equal(calls, 1);
});

test('跨字节分片的中文 CRLF SSE 与没有结尾空行的 done 均能读取', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"status","message":"正在准备"}\r\n\r\ndata: {"type":"done","reply":"草稿已准备好"}');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  const result = await streamAssistantChat(messages, { onEvent: (event) => events.push(event) });
  assert.equal(result.reply, '草稿已准备好');
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ['status', 'done']);
});
