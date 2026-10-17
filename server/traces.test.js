import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractEvents, processEmails } from './agent.js';
import { createTraceRecorder, sanitizeSnapshot, summarizeTraces, usageMetrics, appendRecruitmentTraces } from './traces.js';

// These are invented fixtures; the model server below listens only on loopback.
const event = { title: '可观测演示评审', start: '2026-10-20T14:00:00+08:00',
  end: '2026-10-20T15:00:00+08:00', allDay: false, category: 'work',
  location: '演示会议室', description: '带上演示稿' };
const email = { id: 'qq:trace-fixture:100:42', subject: '可观测演示评审邀请',
  sender: 'Trace Host <trace-host@example.invalid>', receivedAt: '2026-10-12T10:00:00+08:00',
  body: '邀请参加 2026 年 10 月 20 日 14:00–15:00 演示评审，地点演示会议室。' };
const emptyStore = () => ({ events: [], emails: [], lastSync: null });
const pricing = { tokenPriceIn: 2, tokenPriceOut: 8, tokenPriceCachedIn: 0.5 };

test('证据链列表带上招聘执行记录，同一条不重复', () => {
  const merged = appendRecruitmentTraces(
    [{ trace_id: 'mail', attempts: [] }],
    [
      { trace_id: 'mail', attempts: [] },
      { trace_id: 'recruit', subject: '导入预置招聘示例', status: 'imported', mode: 'demo' },
    ],
    { id: 'mb', email: 'a@example.invalid' },
  );
  assert.equal(merged.filter((trace) => trace.trace_id === 'mail').length, 1);
  assert.equal(merged.find((trace) => trace.trace_id === 'recruit').source, 'recruitment');
  assert.equal(merged.find((trace) => trace.trace_id === 'recruit').mailboxId, 'mb');
  assert.deepEqual(merged.find((trace) => trace.trace_id === 'recruit').attempts, []);
});
const usage = { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 };
const output = (events = [event], summary = '邀请参加演示评审，需携带演示稿。') => ({ summary, events });
const completedResponse = (data = output(), tokenUsage = usage) => ({
  choices: [{ message: { content: typeof data === 'string' ? data : JSON.stringify(data) } }],
  ...(tokenUsage === null ? {} : { usage: tokenUsage }),
});

async function localModel(t, answer) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    const result = await answer(requests.length, requests.at(-1));
    res.writeHead(result?.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result?.body || result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    requests,
    settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'invented-trace-test-api-key', model: 'local-trace-model', ...pricing },
  };
}

function inMemoryRecorder(settings = {}) {
  const persisted = [];
  const recorder = createTraceRecorder({ settings, traces: [],
    persist: (traces) => persisted.push(structuredClone(traces)) });
  return { recorder, persisted };
}

async function processTracked(store, emails, settings, recorder, options = {}) {
  return processEmails(store, emails,
    (mail, candidates, context) => extractEvents(mail, settings, candidates, context), 'qq',
    { recorder, ...options });
}

test('日志输入递归脱敏邮箱、电话、配置密钥与链接参数，并截断长正文', () => {
  const key = 'invented-observability-key';
  const code = 'invented-imap-authorization';
  const input = {
    apiKey: key, authorizationCode: code,
    email: 'person@example.invalid',
    nested: { sender: '演示联系人 <person@example.invalid>', phone: '+86 13800138000',
      description: `${key} ${code} api_key=other-invented-secret Bearer another-invented-bearer`,
      location: 'https://example.invalid/meeting?token=private-link-value#private-fragment',
      credentialUrl: 'https://test-user:test-password@example.invalid/meeting?token=private-link-value' },
    body: `${'合成测试正文。'.repeat(200)}TRUNCATED_TAIL_SENTINEL`,
    headers: { authorization: `Bearer ${key}` },
    reasoning_content: 'PRIVATE_REASONING_SENTINEL',
  };
  const sanitized = sanitizeSnapshot(input, [key, code]);
  const serialized = JSON.stringify(sanitized);
  for (const secret of [key, code, 'person@example.invalid', '13800138000', 'other-invented-secret',
    'another-invented-bearer', 'test-user', 'test-password', 'private-link-value', 'private-fragment',
    'TRUNCATED_TAIL_SENTINEL', 'PRIVATE_REASONING_SENTINEL']) {
    assert.ok(!serialized.includes(secret), `日志快照不能保留 ${secret}`);
  }
  assert.match(sanitized.body, /截断/);
  assert.ok(sanitized.body.length < 800);
  assert.equal(sanitized.nested.location, 'https://example.invalid/meeting');
  assert.equal(input.apiKey, key, '记录快照不得改变原始模型输入');
  assert.ok(input.body.includes('TRUNCATED_TAIL_SENTINEL'));
});

test('使用服务商 Token 统计计算缓存费用，缺失 usage 或单价保持未知', () => {
  for (const cachedUsage of [
    { prompt_tokens_details: { cached_tokens: 600 } },
    { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
  ]) {
    const metrics = usageMetrics({ prompt_tokens: 1000, completion_tokens: 200, ...cachedUsage }, pricing);
    assert.equal(metrics.llm_tokens_in, 1000);
    assert.equal(metrics.llm_tokens_out, 200);
    assert.equal(metrics.llm_tokens_cached_in, 600);
    assert.equal(metrics.cost_status, 'known');
    assert.equal(metrics.cost_cny, 0.0027, '400 × 2 + 600 × 0.5 + 200 × 8，单位人民币 / 百万 Token');
  }
  for (const absentUsage of [undefined, {}, { prompt_tokens: 1000 }]) {
    const metrics = usageMetrics(absentUsage, pricing);
    assert.equal(metrics.cost_cny, null);
    assert.equal(metrics.cost_status, 'usage_missing');
  }
  for (const missingPricing of [{}, { tokenPriceIn: '', tokenPriceOut: 8 },
    { tokenPriceIn: 2, tokenPriceOut: null }, { tokenPriceIn: 2, tokenPriceOut: 8 }]) {
    const metrics = usageMetrics({ ...usage, prompt_tokens_details: { cached_tokens: 100 } }, missingPricing);
    assert.equal(metrics.cost_cny, null);
    assert.equal(metrics.cost_status, 'price_missing');
  }
  const explicitFree = usageMetrics(usage, { tokenPriceIn: 0, tokenPriceOut: 0 });
  assert.equal(explicitFree.cost_cny, 0);
  assert.equal(explicitFree.cost_status, 'known');
});

test('邮件正文先脱敏再截断，边界处的配置密钥不泄露部分字符', async (t) => {
  const model = await localModel(t, async () => completedResponse());
  const code = 'invented-boundary-credential-value';
  model.settings.authorizationCode = code;
  const { recorder } = inMemoryRecorder(model.settings);
  // Cross both the earlier 500-char mail preview and the shared 700-char snapshot limit.
  const body = `${'x'.repeat(490)}${code}${'y'.repeat(170)}${code} trailing text`;
  const result = await processTracked(emptyStore(), [{ ...email, body }], model.settings, recorder);
  assert.deepEqual(result.errors, []);
  const evidence = JSON.stringify(recorder.traces);
  assert.ok(!evidence.includes('invented-b'), '短输入快照也不能包含部分凭据');
  assert.ok(evidence.includes('已脱敏'));
  assert.equal(JSON.parse(model.requests[0].messages[1].content).body, body, '日志脱敏不改变实际业务输入');
});

test('本地模拟邮件在模型等待期间可见，完成后可按顺序回放到草稿并汇总费用', async (t) => {
  let announceRequest;
  let finishRequest;
  const requested = new Promise((resolve) => { announceRequest = resolve; });
  const allowedResponse = new Promise((resolve) => { finishRequest = resolve; });
  t.after(() => finishRequest());
  const model = await localModel(t, async () => {
    announceRequest();
    await allowedResponse;
    return { ...completedResponse(), choices: [{ message: {
      content: JSON.stringify(output()), reasoning_content: 'PROVIDER_PRIVATE_REASONING_SENTINEL',
    } }] };
  });
  const { recorder, persisted } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  const processing = processTracked(store, [email], model.settings, recorder);
  await requested;
  try {
    assert.equal(recorder.traces.length, 1);
    assert.equal(recorder.traces[0].status, 'running');
    assert.equal(recorder.traces[0].spans.find((span) => span.stage === 'extract').status, 'running');
    assert.equal(store.events.length, 0, '模型返回前不可写入猜测的日程');
    assert.ok(persisted.some((rows) => rows[0]?.spans.some((span) => span.stage === 'extract' && span.status === 'running')));
  } finally { finishRequest(); }
  const result = await processing;
  assert.deepEqual(result.errors, []);
  assert.equal(result.added, 1);
  assert.equal(store.events.length, 1);
  const trace = recorder.traces[0];
  assert.equal(trace.status, 'imported');
  assert.equal(trace.attempts.length, 1);
  assert.equal(store.emails[0].trace_id, trace.trace_id);
  assert.ok(trace.draft_reply, '成功处理必须有可回放的回复草稿');
  assert.equal(trace.llm_tokens_in, 1000);
  assert.equal(trace.llm_tokens_out, 250);
  assert.equal(trace.cost_cny, 0.004);
  assert.equal(trace.known_cost_cny, 0.004);
  assert.equal(trace.tokens_complete, true);
  const stages = trace.spans.map((span) => span.stage);
  assert.equal(trace.spans[0].tool_calls[0].name, 'mail.received', '合成邮件不可伪称实际 IMAP 收信');
  let previousIndex = -1;
  for (const stage of ['receive_email', 'parse', 'check_calendar', 'extract', 'create_task', 'draft_reply']) {
    const index = stages.indexOf(stage);
    assert.ok(index > previousIndex, `缺少或顺序错误的阶段：${stage}`);
    previousIndex = index;
  }
  for (const span of trace.spans) {
    assert.equal(span.parent_span, trace.trace_id);
    assert.equal(span.attempt, 1);
    assert.equal(span.status, 'success');
    assert.equal(span.latency_ms, Date.parse(span.ended_at) - Date.parse(span.started_at));
    assert.ok(span.offset_ms >= 0);
    assert.ok(span.thought);
    assert.ok(span.observation);
    assert.ok(span.tool_calls.length);
  }
  const llm = trace.spans.find((span) => span.stage === 'extract');
  assert.equal(llm.tool_calls[0].name, 'llm.chat_completions');
  assert.equal(llm.tool_calls[0].arguments.model, model.settings.model);
  assert.equal(llm.tool_calls[0].result_summary.http_status, 200);
  assert.equal(model.requests.length, 1, '草稿不额外调用模型');
  assert.ok(!JSON.stringify(recorder.traces).includes('PROVIDER_PRIVATE_REASONING_SENTINEL'));
  assert.ok(!JSON.stringify(recorder.traces).includes(model.settings.apiKey));
  assert.ok(!JSON.stringify(recorder.traces).includes('trace-host@example.invalid'));
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.count, 1);
  assert.equal(summary.completed_count, 1);
  assert.equal(summary.priced_count, 1);
  assert.equal(summary.avg_cost_cents, 0.4);
  assert.equal(summary.cost_cny, 0.004);
});

test('模型已计费而解析失败的邮件重试沿用同一 trace，保留历史及每次费用', async (t) => {
  const model = await localModel(t, async (attempt) => completedResponse(attempt === 1 ? '{bad-json' : output()));
  const { recorder } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  const failed = await processTracked(store, [email], model.settings, recorder);
  assert.equal(failed.errors.length, 1);
  assert.equal(store.emails.length, 0);
  assert.equal(store.events.length, 0);
  const trace = recorder.traces[0];
  const traceId = trace.trace_id;
  assert.equal(trace.status, 'failed');
  assert.equal(trace.cost_cny, 0.004, '解析失败也保留服务商已返回的 Token 和费用');
  const failedSpans = structuredClone(trace.spans);
  const retry = await processTracked(store, [email], model.settings, recorder);
  assert.deepEqual(retry.errors, []);
  assert.equal(retry.added, 1);
  assert.equal(recorder.traces.length, 1);
  assert.equal(trace.trace_id, traceId);
  assert.equal(trace.status, 'imported');
  assert.deepEqual(trace.spans.slice(0, failedSpans.length), failedSpans);
  assert.deepEqual(trace.attempts.map((attempt) => attempt.status), ['failed', 'imported']);
  assert.equal(trace.spans.filter((span) => span.stage === 'extract').length, 2);
  assert.equal(trace.llm_tokens_in, 2000);
  assert.equal(trace.llm_tokens_out, 500);
  assert.equal(trace.cost_cny, 0.008);
  assert.equal(model.requests.length, 2);
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.count, 1, '平均单封费用以邮件数量为分母');
  assert.equal(summary.attempt_count, 2);
  assert.equal(summary.avg_cost_cents, 0.8);
});

test('已处理及已跳过邮件重复同步不产生额外 trace、草稿或模型费用', async (t) => {
  const model = await localModel(t, async (call) => completedResponse(call === 1 ? output() : output([], '这是一封没有安排的演示资讯。')));
  const { recorder } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  const newsletter = { ...email, id: 'qq:trace-fixture:100:43', subject: '演示资讯' };
  const first = await processTracked(store, [email, newsletter], model.settings, recorder);
  assert.equal(first.added, 1);
  assert.equal(first.skipped, 1);
  const skipped = recorder.traces.find((trace) => trace.status === 'skipped');
  assert.ok(skipped.draft_reply);
  const before = structuredClone(recorder.traces);
  const repeated = await processTracked(store, [email, newsletter, newsletter], model.settings, recorder);
  assert.equal(repeated.duplicate, 3);
  assert.equal(repeated.added, 0);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(recorder.traces, before);
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.count, 2);
  assert.equal(summary.attempt_count, 2);
  assert.equal(summary.cost_cny, 0.008);
  assert.equal(summary.avg_cost_cents, 0.4);
});

test('缺失 usage 或未配置价格时显示未知费用，汇总保留已知小计而不生成虚假平均', async (t) => {
  const model = await localModel(t, async (call) => completedResponse(output(), call === 2 ? null : usage));
  const { recorder } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  const missingUsage = { ...email, id: 'qq:trace-fixture:100:44', subject: '服务商未提供 usage' };
  await processTracked(store, [email, missingUsage], model.settings, recorder);
  const usageUnknown = recorder.traces.find((trace) => trace.subject === missingUsage.subject);
  assert.equal(usageUnknown.cost_cny, null);
  assert.equal(usageUnknown.cost_status, 'usage_missing');
  assert.equal(usageUnknown.llm_tokens_in, null);
  assert.equal(usageUnknown.llm_tokens_out, null);
  assert.equal(usageUnknown.tokens_complete, false);
  const missingPrice = { ...email, id: 'qq:trace-fixture:100:45', subject: '未配置 Token 单价' };
  const noPricing = { ...model.settings, tokenPriceIn: null, tokenPriceOut: null, tokenPriceCachedIn: null };
  await processTracked(store, [missingPrice], noPricing, recorder);
  const priceUnknown = recorder.traces.find((trace) => trace.subject === missingPrice.subject);
  assert.equal(priceUnknown.cost_cny, null);
  assert.equal(priceUnknown.cost_status, 'price_missing');
  assert.equal(priceUnknown.llm_tokens_in, 1000);
  assert.equal(priceUnknown.llm_tokens_out, 250);
  assert.equal(priceUnknown.tokens_complete, true);
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.count, 3);
  assert.equal(summary.priced_count, 1);
  assert.equal(summary.unknown_cost_count, 2);
  assert.equal(summary.known_cost_cny, 0.004);
  assert.equal(summary.cost_cny, null);
  assert.equal(summary.avg_cost_cents, null);
  assert.equal(summary.known_avg_cost_cents, 0.4);
  assert.equal(summary.token_coverage_count, 2);
});

test('服务商失败未返回 usage 的历史重试保持费用未知，并保存脱敏错误证据', async (t) => {
  const key = 'invented-trace-test-api-key';
  const model = await localModel(t, async (call) => call === 1
    ? { status: 401, body: { error: { message: `Rejected ${key} for trace-host@example.invalid` } } }
    : completedResponse());
  const { recorder } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  const failed = await processTracked(store, [email], model.settings, recorder);
  assert.equal(failed.errors.length, 1);
  const failedSpan = recorder.traces[0].spans.find((span) => span.stage === 'extract');
  assert.equal(failedSpan.status, 'failed');
  assert.equal(failedSpan.tool_calls[0].result_summary.http_status, 401);
  assert.ok(!JSON.stringify(recorder.traces).includes(key));
  assert.ok(!JSON.stringify(recorder.traces).includes('trace-host@example.invalid'));
  const retry = await processTracked(store, [email], model.settings, recorder);
  assert.equal(retry.added, 1);
  const trace = recorder.traces[0];
  assert.equal(trace.attempts.length, 2);
  assert.equal(trace.cost_cny, null, '缺失 Token 的失败不能被后续成功重置为已知费用');
  assert.equal(trace.known_cost_cny, 0.004);
  assert.equal(trace.tokens_complete, false);
  assert.equal(trace.cost_status, 'usage_missing');
  const summary = summarizeTraces(recorder.traces).qq;
  assert.equal(summary.known_cost_cny, 0.004);
  assert.equal(summary.avg_cost_cents, null);
});

test('回放输出与草稿是处理时快照，日程和邮件后续编辑删除不改变日志', async (t) => {
  const model = await localModel(t, async () => completedResponse());
  const { recorder } = inMemoryRecorder(model.settings);
  const store = emptyStore();
  await processTracked(store, [email], model.settings, recorder);
  const trace = recorder.traces[0];
  const before = structuredClone(trace);
  Object.assign(store.events[0], { title: '手动编辑后的标题', start: '2026-11-01T09:00:00+08:00' });
  store.emails[0].extraction.actions[0].title = '邮件详情被修改';
  store.emails[0].body = '后续更改的邮件正文';
  store.events = [];
  store.emails = [];
  assert.deepEqual(trace, before);
  assert.ok(JSON.stringify(trace).includes(event.title));
  assert.ok(!JSON.stringify(trace).includes('手动编辑后的标题'));
  assert.deepEqual(JSON.parse(JSON.stringify(trace)).draft_reply, before.draft_reply);
});
