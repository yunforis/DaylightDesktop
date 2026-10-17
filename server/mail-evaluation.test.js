import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateDataset, publicActual, scoreCase, summarize, metricsContext } from '../scripts/lib/mail-evaluation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(fs.readFileSync(path.join(root, 'docs/submission/evaluation-cases.json'), 'utf8'));

function syntheticRecord(item) {
  const row = item.expected.actions[0];
  return { extraction: { actions: row ? [{ ...row, title: row.titleIncludes?.join('') }] : [], tasks: [] }, pendingActions: [] };
}

test('dataset validation is offline and rejects duplicate IDs and invalid golden times', () => {
  assert.equal(validateDataset(dataset).cases, 15);
  const duplicate = structuredClone(dataset); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => validateDataset(duplicate), /duplicate/);
  const bad = structuredClone(dataset); bad.cases[0].expected.actions[0].start = 'tomorrow';
  assert.throws(() => validateDataset(bad), /golden time/);
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/evaluate-mail.js', '--validate'], { cwd: root, encoding: 'utf8' }));
  assert.equal(result.model_calls, 0);
  assert.equal(result.mode, 'dataset-validation-only');
  assert.throws(() => execFileSync(process.execPath, ['scripts/evaluate-mail.js', '--live'], { cwd: root, stdio: 'pipe' }));
});

test('scorer rejects empty, wrong-time, extra-action and incomplete execution, including matching counts', () => {
  const item = dataset.cases[0];
  const record = syntheticRecord(item);
  const store = { events: [{ id: 'new', status: 'active' }], tasks: [] };
  const actual = publicActual(item, { events: [{}], tasks: [] }, record, store);
  assert.equal(scoreCase(item, actual).passed, true);
  const wrongTime = structuredClone(actual); wrongTime.actions[0].start = '2026-10-20T07:00:00.000Z';
  assert.equal(scoreCase(item, wrongTime).passed, false);
  const wrongKeyword = structuredClone(actual); wrongKeyword.actions[0].titleIncludes['面试'] = false;
  assert.equal(scoreCase(item, wrongKeyword).passed, false);
  const empty = structuredClone(actual); empty.actions = []; empty.rawEventCount = 0;
  assert.equal(scoreCase(item, empty).passed, false);
  const injected = structuredClone(actual); injected.rawEventCount = 2;
  assert.equal(scoreCase(item, injected).passed, false);
  assert.equal(scoreCase(item, actual, { code: 'TIMEOUT' }).passed, false);
  assert.equal(scoreCase(item, null).passed, false);
});

test('target identity matters and output projection excludes bodies, summaries and arbitrary provider text', () => {
  const item = dataset.cases.find((row) => row.id === 'cancel-interview');
  const record = syntheticRecord(item);
  const marker = 'PRIVATE-RESPONSE-CONTENT';
  Object.assign(record, { body: marker, summary: marker });
  Object.assign(record.extraction.actions[0], { reason: marker, description: marker });
  const store = { events: [{ id: 'qinghe-interview', status: 'cancelled' }], tasks: [] };
  const actual = publicActual(item, { events: [{}], summary: marker }, record, store);
  assert.equal(scoreCase(item, actual).passed, true);
  assert.ok(!JSON.stringify(actual).includes(marker));
  record.extraction.actions[0].targetEventId = marker;
  const changed = publicActual(item, { events: [{}] }, record, store);
  assert.equal(changed.actions[0].targetEventId, '[unrecognized]');
  assert.equal(scoreCase(item, changed).passed, false);
  assert.ok(!JSON.stringify(changed).includes(marker));
});

test('summary counts failures and unfinished cases, nearest-rank includes failed latency, unknown cost is not zero', () => {
  const rows = [
    { passed: true, duration_ms: 10, metrics: { llm_tokens_in: 10, llm_tokens_out: 2, cost_status: 'known', cost_cny: 0.01 } },
    { passed: false, duration_ms: 100, metrics: { cost_status: 'usage_missing', cost_cny: null } },
  ];
  const summary = summarize(rows, 3);
  assert.equal(summary.success_rate, 1 / 3);
  assert.equal(summary.failed_count, 1);
  assert.equal(summary.interrupted_or_unattempted_count, 1);
  assert.equal(summary.latency.sample_count, 2);
  assert.equal(summary.latency.p95_ms, 100);
  assert.equal(summary.costs.unknown_usage_count, 1);
  assert.equal(summary.costs.known_subtotal_cny, 0.01);
  assert.equal(summary.costs.total_cny, null);
  const unknown = summarize([rows[1]], 1);
  assert.equal(unknown.costs.known_subtotal_cny, null);
  assert.equal(unknown.costs.fully_priced_mean_cny, null);
  assert.equal(summarize([], 3).latency.p50_ms, null);
  assert.equal(summarize([{ ...rows[0], metrics: { ...rows[0].metrics, cost_cny: 0 } }], 1).costs.total_cny, 0);
});

test('trace adapter captures numeric production metrics without snapshots or credentials', () => {
  const { context, metrics } = metricsContext();
  const span = context.startSpan();
  context.updateSpan(span, { llm_tokens_in: 100, llm_tokens_out: 20, cost_cny: 0.1, cost_status: 'known',
    tool_calls: [{ arguments: { apiKey: 'secret', body: 'private' } }], output_snapshot: 'private' });
  assert.equal(metrics.llm_tokens_in, 100);
  assert.equal(metrics.cost_cny, 0.1);
  assert.ok(!JSON.stringify(metrics).includes('secret'));
  assert.ok(!JSON.stringify(metrics).includes('private'));
});

test('production extraction and in-memory application work with a mocked fetch, with isolated files and no network', async (t) => {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'work', 'mail-evaluation-test-'));
  const oldData = process.env.DAYLIGHT_DATA_DIR;
  process.env.DAYLIGHT_DATA_DIR = directory;
  const proxyKeys = ['DAYLIGHT_HTTPS_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'DAYLIGHT_AUTO_PROXY'];
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  process.env.DAYLIGHT_AUTO_PROXY = '0';
  t.after(() => {
    if (oldData === undefined) delete process.env.DAYLIGHT_DATA_DIR; else process.env.DAYLIGHT_DATA_DIR = oldData;
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const { extractEvents, parseExtraction, importEmail } = await import('./agent.js');
  const first = dataset.cases[0];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.response_format.type, 'json_object');
    assert.equal(JSON.parse(request.messages[1].content).body, first.email.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ events: [{
      title: '青禾学院保研面试', start: first.expected.actions[0].start, end: first.expected.actions[0].end, allDay: false,
    }], tasks: [] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
  });
  const metrics = metricsContext();
  const extraction = await extractEvents(first.email, { baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-key', model: 'synthetic-model',
    tokenPriceIn: 1, tokenPriceOut: 4, tokenPriceCachedIn: 0.02 }, [], metrics.context, []);
  assert.equal(calls, 1);
  assert.equal(metrics.metrics.llm_tokens_in, 100);
  assert.equal(metrics.metrics.cost_cny, 0.00018);
  const firstStore = { events: [], tasks: [], emails: [] };
  const firstRecord = importEmail(firstStore, { ...first.email, id: first.id }, extraction, 'qq');
  assert.equal(scoreCase(first, publicActual(first, extraction, firstRecord, firstStore)).passed, true);
  // Golden-generated responses only check scorer/application compatibility, never model quality.
  for (const item of dataset.cases) {
    const response = { events: item.expected.actions.map((row) => ({ ...row,
      ...(row.titleIncludes ? { title: row.titleIncludes.join('') } : {}) })),
    tasks: item.expected.tasks.map((row) => ({ title: row.titleIncludes.join(''), dueAt: row.dueAt,
      ...(row.taskId ? { existingTaskId: row.taskId } : {}) })) };
    const parsed = parseExtraction(JSON.stringify(response));
    const store = { events: structuredClone(item.context.events), tasks: structuredClone(item.context.tasks), emails: [] };
    const record = importEmail(store, { ...item.email, id: item.id }, parsed, 'qq');
    const score = scoreCase(item, publicActual(item, parsed, record, store));
    assert.equal(score.passed, true, `${item.id}: ${JSON.stringify(score.assertions.filter((row) => !row.pass))}`);
  }
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(path.join(directory, 'settings.json')));
  assert.ok(!fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('synthetic-key'));
});
