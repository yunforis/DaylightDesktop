import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/assistant-requests-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ activeMailboxId: 'default', mailboxes: [{ id: 'default', email: 'fixture@example.invalid' }] }));
const { runAssistantRequest } = await import('./assistant-requests.js');
const input = { requestId: 'request-fixture-123', messages: [{ role: 'user', content: '创建合成安排' }] };
beforeEach(() => fs.writeFileSync(path.join(directory, 'assistant-requests.json'), JSON.stringify({ items: [] })));

test('SSE断开时非流式回退等待原请求，进程内/持久缓存均不再调用工具', async () => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const handler = async (payload, { onEvent }) => {
    calls++;
    assert.equal(payload.requestId, input.requestId);
    onEvent({ type: 'tool_end', name: 'create_event', result: { ok: true } });
    started();
    await new Promise((resolve) => { release = resolve; });
    return { reply: '合成日程已保存', toolTrace: [{ name: 'create_event' }] };
  };
  const events = [];
  const first = runAssistantRequest(input, handler, { onEvent: (event) => events.push(event) });
  await ready;
  const fallback = runAssistantRequest(input, () => assert.fail('不能重跑'));
  release();
  assert.deepEqual(await first, await fallback);
  assert.equal(calls, 1);
  assert.deepEqual(await runAssistantRequest(input, () => assert.fail('缓存请求不能重跑')), await first);
  assert.deepEqual(events.map((event) => event.type), ['tool_end', 'done']);
  await assert.rejects(runAssistantRequest({ ...input, messages: [{ role: 'user', content: '另一操作' }] }, handler), /消息不同/);
});

test('服务重启遗留的进行中请求不能盲目重执行副作用', async () => {
  const { createHash } = await import('node:crypto');
  fs.writeFileSync(path.join(directory, 'assistant-requests.json'), JSON.stringify({ items: [{
    id: input.requestId, hash: createHash('sha256').update(JSON.stringify(input.messages)).digest('hex'), status: 'running',
  }] }));
  await assert.rejects(runAssistantRequest(input, () => assert.fail('结果未知不可重跑')), /执行结果尚待核对/);
});

test('请求失败保存脱敏错误，同编号回退不重新执行；不同编号可由用户重试', async () => {
  let calls = 0;
  const handler = async () => { calls++; throw Object.assign(new Error('合成模型失败'), { status: 502 }); };
  await assert.rejects(runAssistantRequest(input, handler), /合成模型失败/);
  await assert.rejects(runAssistantRequest(input, handler), /合成模型失败/);
  assert.equal(calls, 1);
  await assert.rejects(runAssistantRequest({ ...input, requestId: 'request-fixture-new' }, handler), /合成模型失败/);
  assert.equal(calls, 2);
});
