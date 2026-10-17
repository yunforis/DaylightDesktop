import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, callJsonModel } from './model-json.js';
import { createTraceRecorder } from './traces.js';

test('兼容模型文本中的未转义换行，不改变正常转义或放宽无效结构', () => {
  assert.deepEqual(parseModelJson('{"action":"answer","content":"第一行\n第二行\t缩进"}'), { action: 'answer', content: '第一行\n第二行\t缩进' });
  const value = { content: '引号 " 与反斜线 \\ 以及换行\n', tools: ['valid'] };
  assert.deepEqual(parseModelJson(`\x60\x60\x60json\n${JSON.stringify(value)}\n\x60\x60\x60`), value);
  assert.throws(() => parseModelJson('{"action":"tool",broken}'));
});

test('多次模型调用累计用量且不保存资料正文、凭据或私有推理', async (t) => {
  const settings = { baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-private-key', model: 'fixture', tokenPriceIn: 1, tokenPriceOut: 2 };
  const recorder = createTraceRecorder({ settings });
  const context = recorder.beginEmail({ id: 'synthetic-chat', subject: '合成验证' }, 'qq');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"content":"PRIVATE_RESUME_TEXT"}', reasoning_content: 'PRIVATE_REASONING' } }], usage: { prompt_tokens: 100, completion_tokens: 30 } })));
  await callJsonModel(settings, [{ role: 'user', content: 'PRIVATE_RESUME_TEXT' }], { context });
  await callJsonModel(settings, [{ role: 'user', content: 'PRIVATE_RESUME_TEXT' }], { context });
  context.finish('imported');
  assert.equal(context.trace.llm_tokens_in, 200); assert.equal(context.trace.llm_tokens_out, 60);
  assert.equal(context.trace.cost_cny, 0.00032);
  assert.doesNotMatch(JSON.stringify(recorder.traces), /PRIVATE_RESUME_TEXT|PRIVATE_REASONING|synthetic-private-key/);
});

test('真实兼容服务的截断JSON至多修正一次，记录两次实际请求用量', async (t) => {
  const settings = { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-key', model: 'fixture' };
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: ++count === 1 ? '{"action":"answer","content":"unfinished' : '{"action":"answer","content":"完成"}' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })));
  const recorder = createTraceRecorder({ settings });
  const context = recorder.beginEmail({ id: 'repair' }, 'qq');
  const result = await callJsonModel(settings, [{ role: 'user', content: '合成查询' }], { context });
  assert.equal(count, 2); assert.equal(result.content, '完成');
  assert.equal(context.trace.spans[0].status, 'failed');
  assert.equal(context.trace.llm_tokens_in, 200);
});
