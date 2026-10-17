import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceRecorder, summarizeTraces } from './traces.js';

// Synthetic accounting evidence only: these tests neither read mailbox data nor call a model.
const modelCall = (fields = {}) => ({
  stage: 'extract', status: 'success', llm_request: true,
  llm_tokens_in: 1000, llm_tokens_out: 250, llm_tokens_cached_in: 0,
  cost_cny: 0.004, cost_status: 'known', ...fields,
});
const emailTrace = (fields = {}) => ({
  trace_id: 'synthetic-mail-cost', email_ref: 'synthetic-reference', mode: 'qq',
  status: 'imported', attempts: [{ status: 'imported', latency_ms: 100 }],
  latency_ms: 100, llm_tokens_in: 1000, llm_tokens_out: 250,
  tokens_complete: true, cost_cny: 0.004, known_cost_cny: 0.004,
  cost_status: 'known', spans: [modelCall()], ...fields,
});

test('邮件成本按调用证据汇总，历史缺失不遮住已计价样本及费用小计', () => {
  const traces = [
    emailTrace({ trace_id: 'priced', cost_cny: 99, known_cost_cny: 99 }),
    emailTrace({ trace_id: 'missing-usage', status: 'failed',
      spans: [modelCall({ llm_tokens_in: null, llm_tokens_out: null,
        cost_cny: null, cost_status: 'usage_missing' })] }),
    emailTrace({ trace_id: 'missing-price', spans: [modelCall({
      cost_cny: null, cost_status: 'price_missing' })] }),
    emailTrace({ trace_id: 'running', status: 'running', spans: [modelCall({
      status: 'running', llm_tokens_in: null, llm_tokens_out: null,
      cost_cny: null, cost_status: 'usage_missing' })] }),
  ];
  const before = structuredClone(traces);
  const real = summarizeTraces(traces).qq;
  assert.equal(real.count, 4);
  assert.equal(real.priced_count, 1);
  assert.equal(real.unknown_cost_count, 3);
  assert.equal(real.known_cost_cny, 0.004, '小计由真实调用快照计算，不能沿用过期聚合值');
  assert.equal(real.known_avg_cost_cents, 0.4);
  assert.equal(real.avg_cost_cents, null, '已计价样本平均不能冒充全部邮件平均');
  assert.equal(real.cost_cny, null);
  assert.equal(real.unknown_usage_count, 1);
  assert.equal(real.unknown_price_count, 1);
  assert.equal(real.running_cost_count, 1);
  assert.equal(real.unclassified_cost_count, 0);
  assert.equal(real.llm_call_count, 4);
  assert.equal(real.priced_call_count, 1);
  assert.equal(real.unknown_usage_call_count, 1);
  assert.equal(real.unknown_price_call_count, 1);
  assert.equal(real.running_call_count, 1);
  assert.equal(real.unclassified_call_count, 0);
  assert.deepEqual(traces, before, '读取统计不能追溯改写原始执行记录');
});

test('同一邮件重试保留全部已知调用费用，并分别报告缺用量和缺单价', () => {
  const trace = emailTrace({ status: 'imported', attempts: [
    { status: 'failed', latency_ms: 100 }, { status: 'failed', latency_ms: 100 },
    { status: 'imported', latency_ms: 100 },
  ], spans: [
    modelCall({ status: 'failed', cost_cny: null, cost_status: 'usage_missing',
      llm_tokens_in: null, llm_tokens_out: null }),
    modelCall({ status: 'failed', cost_cny: null, cost_status: 'price_missing' }),
    modelCall({ status: 'failed', cost_cny: 0.003 }),
    modelCall({ cost_cny: 0.004 }),
  ] });
  const real = summarizeTraces([trace]).qq;
  assert.equal(real.priced_count, 0);
  assert.equal(real.known_cost_cny, 0.007);
  assert.equal(real.known_avg_cost_cents, null);
  assert.equal(real.avg_cost_cents, null);
  assert.equal(real.unknown_cost_count, 1);
  assert.equal(real.unknown_usage_count, 1, '同一封邮件多个未知原因只归入一个类别');
  assert.equal(real.unknown_price_count, 0);
  assert.equal(real.llm_call_count, 4);
  assert.equal(real.priced_call_count, 2);
  assert.equal(real.unknown_usage_call_count, 1);
  assert.equal(real.unknown_price_call_count, 1);
});

test('有调用但无完整用量的历史零费用不能被当作免费模型调用', () => {
  const real = summarizeTraces([emailTrace({ cost_cny: 0, known_cost_cny: 0,
    spans: [modelCall({ stage: 'rag_embed', status: 'failed', cost_cny: 0,
      cost_status: undefined, llm_tokens_in: null, llm_tokens_out: null })],
  })]).qq;
  assert.equal(real.priced_count, 0);
  assert.equal(real.known_cost_cny, 0);
  assert.equal(real.cost_cny, null);
  assert.equal(real.avg_cost_cents, null);
  assert.equal(real.unknown_usage_count, 1);
  assert.equal(real.unknown_usage_call_count, 1);
});

test('缺失或非有限费用不会形成已计价样本，也不会污染费用小计', () => {
  const malformed = [undefined, NaN, Infinity, -1];
  const traces = malformed.map((cost, index) => emailTrace({
    trace_id: `invalid-cost-${index}`, cost_cny: cost, known_cost_cny: cost,
    spans: [modelCall({ cost_cny: cost, cost_status: undefined })],
  }));
  traces.push(emailTrace({ trace_id: 'valid' }));
  const before = structuredClone(traces);
  const real = summarizeTraces(traces).qq;
  assert.equal(real.priced_count, 1);
  assert.equal(real.known_cost_cny, 0.004);
  assert.equal(real.known_avg_cost_cents, 0.4);
  assert.equal(real.unclassified_cost_count, 4);
  assert.equal(real.unclassified_call_count, 4);
  assert.equal(real.priced_call_count, 1);
  assert.deepEqual(traces, before);
});

test('规则过滤的真实邮件模型费用为零，与明确免费调用都可计入邮件平均', () => {
  const real = summarizeTraces([
    emailTrace({ trace_id: 'filtered', status: 'skipped', spans: [
      { stage: 'filter', status: 'success', cost_cny: 0 },
    ] }),
    emailTrace({ trace_id: 'free-model', spans: [modelCall({ cost_cny: 0 })] }),
    emailTrace({ trace_id: 'paid-model' }),
  ]).qq;
  assert.equal(real.count, 3);
  assert.equal(real.priced_count, 3);
  assert.equal(real.unknown_cost_count, 0);
  assert.equal(real.no_llm_count, 1);
  assert.equal(real.llm_call_count, 2);
  assert.equal(real.priced_call_count, 2);
  assert.equal(real.cost_cny, 0.004);
  assert.equal(real.avg_cost_cents, 0.4 / 3);
});

test('邮件成本筛选排除独立招聘操作，保留同步邮件中的招聘与简历处理', () => {
  const traces = [
    emailTrace({ trace_id: 'mail-recruitment', kind: 'recruitment' }),
    emailTrace({ trace_id: 'mail-resume', kind: 'resume' }),
    emailTrace({ trace_id: 'recruitment-chat', source: 'recruitment', kind: 'recruitment',
      spans: [modelCall({ cost_cny: 4 })] }),
    emailTrace({ trace_id: 'demo-mail', mode: 'demo', spans: [
      { stage: 'extract', status: 'success', llm_request: false, cost_cny: 0 },
    ] }),
    emailTrace({ trace_id: 'demo-recruitment', mode: 'demo', source: 'recruitment',
      spans: [{ stage: 'fixtures', status: 'success', cost_cny: 0 }] }),
  ];
  const mail = summarizeTraces(traces, { mailOnly: true });
  const all = summarizeTraces(traces);
  assert.equal(mail.total_count, 5, '总执行记录数量沿用接口兼容口径');
  assert.equal(mail.qq.count, 2);
  assert.equal(mail.qq.known_cost_cny, 0.008);
  assert.equal(mail.qq.avg_cost_cents, 0.4);
  assert.equal(mail.qq.llm_call_count, 2);
  assert.equal(mail.demo.count, 1);
  assert.equal(all.qq.count, 3, '招聘页仍能按原接口查看自身统计');
  assert.equal(all.demo.count, 2);
});

test('无阶段历史记录只在聚合费用和完整用量都有证据时计价', () => {
  const traces = [
    emailTrace({ trace_id: 'legacy-priced', spans: [] }),
    emailTrace({ trace_id: 'legacy-no-usage', spans: [], cost_cny: 0,
      known_cost_cny: 0, tokens_complete: false, llm_tokens_in: null, llm_tokens_out: null }),
    emailTrace({ trace_id: 'legacy-no-cost', spans: [], cost_cny: undefined,
      known_cost_cny: undefined, cost_status: 'price_missing' }),
  ];
  const real = summarizeTraces(traces).qq;
  assert.equal(real.priced_count, 1);
  assert.equal(real.unknown_cost_count, 2);
  assert.equal(real.known_cost_cny, 0.004);
  assert.equal(real.known_avg_cost_cents, 0.4);
  assert.equal(real.avg_cost_cents, null);
  assert.equal(real.no_llm_count, 0, '缺阶段记录不能证明当时没有调用模型');
});

test('非提取阶段的模型请求失败且没有返回用量时保留未知费用', () => {
  const recorder = createTraceRecorder();
  const context = recorder.beginEmail({ id: 'synthetic-embedding-failure', subject: '合成向量服务失败' }, 'qq');
  const span = context.startSpan('rag_embed', '合成向量请求', { llm_request: true });
  context.finishSpan(span, { status: 'failed', error: '合成连接断开，无服务商用量回执' });
  context.finish('failed');
  assert.equal(span.cost_cny, null);
  assert.equal(span.cost_status, 'usage_missing');
  assert.equal(context.trace.cost_cny, null);
  const real = summarizeTraces(recorder.traces).qq;
  assert.equal(real.unknown_usage_count, 1);
  assert.equal(real.priced_count, 0);
  assert.equal(real.avg_cost_cents, null);
});
