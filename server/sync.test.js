import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

// Run the real API and scheduler in an isolated worker. Only the IMAP transport,
// model response and interval clock are mocked; no QQ or remote model is contacted.
async function serveFixture() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { ImapFlow } = await import('imapflow');
  let reads = 0;
  let sourceReads = 0;
  let modelCalls = 0;
  let uid = 1;
  let failMailbox = false;
  let failModel = false;
  let failMatch = false;
  let blockRead = false;
  let releaseRead;
  let blockModel = false;
  let releaseModel;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(ImapFlow.prototype, 'connect', async function () {
    reads++;
    this.mailbox = { exists: 1, uidValidity: 10 };
    if (failMailbox) {
      failMailbox = false;
      throw new Error(`合成连接失败 ${workerData.authorizationCode}`);
    }
    if (blockRead) {
      blockRead = false;
      await new Promise((resolve) => { releaseRead = resolve; });
    }
  });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'fetch', async function* (range, options) {
    if (options.source) sourceReads++;
    yield { uid, internalDate: new Date('2026-10-13T08:00:00+08:00'),
      ...(options.source ? { source: Buffer.from([
        'From: Fixture <fixture@example.invalid>',
        'Subject: Automatic sync fixture',
        'Date: Tue, 13 Oct 2026 08:00:00 +0800',
        'Content-Type: text/plain; charset=utf-8',
        '', 'Demo review on 20 October, 14:00 to 15:00, Beijing time.',
      ].join('\r\n')) } : {}) };
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    modelCalls++;
    if (blockModel) {
      blockModel = false;
      await new Promise((resolve) => { releaseModel = resolve; });
    }
    const fail = failModel;
    failModel = false;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const target = input.existingEvents.find((event) => event.title === '自动同步演示评审');
    const payload = fail ? { error: { message: '合成模型暂时失败' } } : {
      choices: [{ message: { content: JSON.stringify({ summary: failMatch ? '合成评审场地调整。' : '合成评审邀请。', events: failMatch ? [{
        action: 'reschedule', ...(target ? { targetEventId: target.id } : {}), location: '合成会议室 C', reason: '合成场地调整',
      }] : [{
        title: '自动同步演示评审', start: `${uid === 1 ? '2026-10-20' : '2026-10-21'}T14:00:00+08:00`,
        end: `${uid === 1 ? '2026-10-20' : '2026-10-21'}T15:00:00+08:00`,
        allDay: false, category: 'work', location: '合成会议室', description: '',
      }] }) } }],
    };
    return { ok: !fail, status: fail ? 503 : 200, text: async () => JSON.stringify(payload) };
  });
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = listen.apply(this, args);
    server.once('listening', () => parentPort.postMessage({ port: server.address().port }));
    return server;
  });
  parentPort.on('message', (message) => {
    if (message.type === 'tick') mock.timers.tick(message.ms);
    if (message.type === 'block') blockRead = true;
    if (message.type === 'release') releaseRead();
    if (message.type === 'block-model') blockModel = true;
    if (message.type === 'release-model') releaseModel();
    if (message.type === 'fail-mailbox') failMailbox = true;
    if (message.type === 'fail-model') failModel = true;
    if (message.type === 'fail-match') failMatch = message.value ?? true;
    if (message.type === 'uid') uid = message.uid;
    parentPort.postMessage({ reads, sourceReads, modelCalls });
  });
  process.argv.push('--production');
  await import(workerData.indexUrl);
}

const settings = {
  email: 'automatic-sync@example.invalid', authorizationCode: 'invented-automatic-sync-code',
  baseUrl: 'http://127.0.0.1/fixture-model', apiKey: 'invented-automatic-sync-key',
  model: 'fixture-model', fetchLimit: 15,
};

async function fixtureServer(t) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const directory = fs.mkdtempSync(path.join(work, 'automatic-sync-test-'));
  fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify({ events: [], emails: [], tasks: [], lastSync: null }));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ ...settings, email: '', apiKey: '', authorizationCode: '' }));
  const worker = new Worker(`(${serveFixture.toString()})()`, {
    eval: true, workerData: { indexUrl: new URL('./index.js', import.meta.url).href, authorizationCode: settings.authorizationCode },
    env: { ...process.env, PORT: '0', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_DISABLE_AUTH: '1' },
  });
  t.after(() => worker.terminate());
  const [{ port }] = await once(worker, 'message');
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const command = async (message) => {
    const response = once(worker, 'message');
    worker.postMessage(message);
    return (await response)[0];
  };
  const syncState = async () => (await request('/api/traces')).body.sync;
  const waitForSync = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const sync = await syncState();
      if (check(sync)) return sync;
      await delay(10);
    }
    assert.fail('合成同步未在预期时间内到达目标状态');
  };
  return { request, command, syncState, waitForSync,
    configure: (values = {}) => request('/api/settings', 'PUT', { ...settings, ...values }),
    tick: (ms = 60_000) => command({ type: 'tick', ms }),
  };
}

test('自动同步每分钟检查配置，并沿用真实处理链和邮件 ID 去重', async (t) => {
  const app = await fixtureServer(t);
  assert.equal((await app.tick()).reads, 0);
  await app.configure({ apiKey: '' });
  assert.equal((await app.tick()).reads, 0);
  assert.equal((await app.syncState()).status, 'idle');
  await app.configure();
  assert.equal((await app.tick(59_999)).reads, 0);
  assert.equal((await app.tick(1)).reads, 1);
  const first = await app.waitForSync((sync) => sync.status === 'completed' && !sync.running);
  assert.equal(first.mode, 'qq');
  assert.equal(first.trigger, 'auto');
  assert.equal(first.result.added, 1);
  assert.equal((await app.command({ type: 'counts' })).sourceReads, 1);
  assert.equal((await app.request('/api/state')).body.events[0].source, 'email');
  await app.tick();
  const second = await app.waitForSync((sync) => sync.id !== first.id && !sync.running);
  assert.equal(second.result.duplicate, 1);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 1);
  assert.equal((await app.command({ type: 'counts' })).sourceReads, 1, '已处理邮件只检查 UID，不再次下载原文');
  assert.equal((await app.request('/api/state')).body.events.length, 1);
});

test('手动、自动和示例同步共用锁，忙碌时跳过定时检查', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'block' });
  const manual = app.request('/api/sync/qq', 'POST');
  await app.waitForSync((sync) => sync.running && sync.trigger === 'manual');
  assert.equal((await app.tick()).reads, 1);
  assert.equal((await app.request('/api/sync/demo', 'POST')).status, 409);
  assert.equal((await app.request('/api/sync/qq', 'POST')).status, 409);
  assert.equal((await app.request('/api/demo', 'DELETE')).status, 409);
  await app.command({ type: 'release' });
  assert.equal((await manual).body.added, 1);
  await app.command({ type: 'block' });
  await app.tick();
  const automatic = await app.waitForSync((sync) => sync.running && sync.trigger === 'auto');
  assert.equal((await app.tick()).reads, 2);
  assert.equal((await app.request('/api/sync/qq', 'POST')).status, 409);
  await app.command({ type: 'release' });
  await app.waitForSync((sync) => sync.id === automatic.id && !sync.running);
});

test('自动收信失败保留脱敏错误，下一分钟可以继续同步', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'fail-mailbox' });
  await app.tick();
  const failed = await app.waitForSync((sync) => sync.status === 'failed' && !sync.running);
  assert.match(failed.error, /合成连接失败/);
  assert.equal(failed.error.includes(settings.authorizationCode), false);
  await app.tick();
  const retry = await app.waitForSync((sync) => sync.id !== failed.id && !sync.running);
  assert.equal(retry.status, 'completed');
  assert.equal(retry.result.added, 1);
  assert.equal(retry.error, undefined);
});

test('自动模型提取失败的邮件在下一分钟重试成功并保留历史日志', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'fail-model' });
  await app.tick();
  const partial = await app.waitForSync((sync) => sync.status === 'partial' && !sync.running);
  assert.equal(partial.result.errors.length, 1);
  assert.equal((await app.request('/api/state')).body.emails.length, 0);
  await app.tick();
  const retry = await app.waitForSync((sync) => sync.id !== partial.id && !sync.running);
  assert.equal(retry.status, 'completed');
  assert.equal(retry.result.added, 1);
  const state = (await app.request('/api/state')).body;
  assert.equal(state.emails.length, 1);
  assert.equal(state.events.length, 1);
  const traces = (await app.request('/api/traces')).body.traces;
  assert.equal(traces.length, 1);
  assert.equal(traces[0].attempts.length, 2);
  await app.command({ type: 'uid', uid: 2 });
  await app.tick();
  const incoming = await app.waitForSync((sync) => sync.id !== retry.id && !sync.running);
  assert.equal(incoming.result.added, 1);
  assert.equal((await app.request('/api/state')).body.events.length, 2);
});

const busyEvent = { title: '已有合成安排', start: '2026-10-20T14:30:00+08:00', end: '2026-10-20T15:30:00+08:00',
  allDay: false, category: 'work', location: '合成会议室 B', description: '' };

test('自动同步发现冲突后保存三段回复草稿和反馈，后续周期按邮件 ID 跳过', async (t) => {
  const app = await fixtureServer(t);
  const existing = (await app.request('/api/events', 'POST', busyEvent)).body;
  await app.configure();
  await app.tick();
  const first = await app.waitForSync((sync) => sync.status === 'completed' && !sync.running);
  assert.equal(first.result.conflicts, 1);
  assert.equal(first.result.added, 1);
  assert.deepEqual(first.result.errors, []);
  const state = (await app.request('/api/state')).body;
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.find((event) => event.id === existing.id), existing);
  const conflictEvent = state.events.find((event) => event.id !== existing.id);
  assert.equal(conflictEvent.hasConflict, true);
  assert.deepEqual(conflictEvent.conflictEventIds, [existing.id]);
  assert.deepEqual(state.emails[0].createdEventIds, [conflictEvent.id]);
  assert.equal(state.emails[0].status, 'conflict');
  assert.equal(state.emails[0].conflicts[0].suggestedSlots.length, 3);
  assert.match(state.emails[0].draftReply, /已有合成安排/);
  const trace = (await app.request('/api/traces')).body.traces[0];
  assert.equal(trace.status, 'conflict');
  assert.equal((await app.request(`/api/traces/${trace.trace_id}/feedback`, 'PUT', { action: 'accepted' })).status, 200);
  assert.deepEqual((await app.request('/api/state')).body.events, state.events, '冲突已入历；采纳只保存草稿反馈，不创建推荐时段');
  const edited = `${trace.draft_reply}\n${'补充候选时段说明。'.repeat(80)}\n${settings.apiKey}\n请确认以上三个时段，保留完整结尾。`;
  const modified = (await app.request(`/api/traces/${trace.trace_id}/feedback`, 'PUT', { action: 'modified', draft: edited })).body;
  assert.ok(modified.user_draft.length > 700);
  assert.ok(modified.user_draft.endsWith('请确认以上三个时段，保留完整结尾。'));
  assert.ok(!modified.user_draft.includes(settings.apiKey));
  assert.equal(modified.draft_reply, trace.draft_reply, '修改不覆盖原稿');
  await app.tick();
  const repeated = await app.waitForSync((sync) => sync.id !== first.id && !sync.running);
  assert.equal(repeated.result.duplicate, 1);
  assert.equal(repeated.result.conflicts, 0);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 1);
  const saved = (await app.request('/api/traces')).body.traces[0];
  assert.equal(saved.user_action, 'modified');
  assert.equal(saved.user_draft, modified.user_draft);
  assert.equal(saved.attempts.length, 1);
});

test('模型等待期间手动新增的安排也参与冲突检测，手动数据保持原样', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'block-model' });
  const syncing = app.request('/api/sync/qq', 'POST');
  await app.waitForSync((sync) => sync.running && sync.stage === '按邮件时间处理');
  const existing = (await app.request('/api/events', 'POST', busyEvent)).body;
  await app.command({ type: 'release-model' });
  const result = (await syncing).body;
  assert.equal(result.conflicts, 1);
  assert.equal(result.added, 1);
  const state = (await app.request('/api/state')).body;
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.find((event) => event.id === existing.id), existing);
  assert.equal(state.events.find((event) => event.id !== existing.id).hasConflict, true);
  assert.equal(state.emails[0].conflicts[0].existingEvents[0].id, existing.id);
});

test('匹配失败的下一分钟自动同步暂缓模型重试，手动同步仍可重试并在修正后成功', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'fail-match' });
  await app.tick();
  const first = await app.waitForSync((sync) => sync.status === 'partial' && !sync.running);
  assert.equal(first.result.errors.length, 1);
  assert.equal(first.result.deferred, 0);
  assert.match(first.result.errors[0].message, /未匹配到唯一日程/);
  const initialState = (await app.request('/api/state')).body;
  assert.equal(initialState.events.length, 0);
  assert.equal(initialState.emails.length, 0);
  const initialTrace = (await app.request('/api/traces')).body.traces[0];
  assert.equal(initialTrace.attempts.length, 1);
  assert.ok(initialTrace.match_retry);
  await app.tick();
  const deferred = await app.waitForSync((sync) => sync.id !== first.id && !sync.running);
  assert.equal(deferred.status, 'partial');
  assert.equal(deferred.trigger, 'auto');
  assert.equal(deferred.deferred, 1);
  assert.equal(deferred.processed, 0);
  assert.equal(deferred.result.deferred, 1);
  assert.equal(deferred.result.errors[0].deferred, true);
  assert.equal(deferred.result.duplicate, 0);
  const automaticCounts = await app.command({ type: 'counts' });
  assert.equal(automaticCounts.reads, 2);
  assert.equal(automaticCounts.sourceReads, 2, '失败邮件仍读取原文，成功邮件才跳过源数据');
  assert.equal(automaticCounts.modelCalls, 1);
  const deferredTrace = (await app.request('/api/traces')).body.traces[0];
  assert.equal(deferredTrace.trace_id, initialTrace.trace_id);
  assert.equal(deferredTrace.attempts.length, 1, '暂缓周期不创建空日志尝试');
  assert.equal(deferredTrace.spans.length, initialTrace.spans.length);
  assert.equal(deferredTrace.status, 'failed');
  const manualFailure = await app.request('/api/sync/mailbox', 'POST');
  assert.equal(manualFailure.status, 200);
  assert.equal(manualFailure.body.deferred, 0);
  assert.equal(manualFailure.body.errors.length, 1);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 2);
  assert.equal((await app.request('/api/traces')).body.traces[0].attempts.length, 2);
  await app.command({ type: 'fail-match', value: false });
  const recovered = await app.request('/api/sync/mailbox', 'POST');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.added, 1);
  assert.deepEqual(recovered.body.errors, []);
  const completedTrace = (await app.request('/api/traces')).body.traces[0];
  assert.equal(completedTrace.match_retry, null);
  assert.equal(completedTrace.attempts.length, 3);
  assert.equal(completedTrace.status, 'imported');
  const state = (await app.request('/api/state')).body;
  assert.equal(state.events.length, 1);
  assert.equal(state.emails.length, 1);
  await app.tick();
  const repeated = await app.waitForSync((sync) => sync.id !== deferred.id && sync.trigger === 'auto' && !sync.running);
  assert.equal(repeated.status, 'completed');
  assert.equal(repeated.result.duplicate, 1);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 3);
  assert.equal((await app.command({ type: 'counts' })).sourceReads, 4);
});

test('手动补充原日程改变上下文后，自动同步恢复匹配并保存真实处理链的调整结果', async (t) => {
  const app = await fixtureServer(t);
  await app.configure();
  await app.command({ type: 'fail-match' });
  await app.tick();
  const failed = await app.waitForSync((sync) => sync.status === 'partial' && !sync.running);
  await app.tick();
  const deferred = await app.waitForSync((sync) => sync.id !== failed.id && !sync.running);
  assert.equal(deferred.result.deferred, 1);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 1);
  const original = (await app.request('/api/events', 'POST', { ...busyEvent,
    title: '自动同步演示评审', start: '2026-10-20T14:00:00+08:00', end: '2026-10-20T15:00:00+08:00' })).body;
  await app.tick();
  const recovered = await app.waitForSync((sync) => sync.id !== deferred.id && !sync.running);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.deferred, 0);
  assert.equal(recovered.result.rescheduled, 1);
  assert.deepEqual(recovered.result.errors, []);
  assert.equal((await app.command({ type: 'counts' })).modelCalls, 2);
  const state = (await app.request('/api/state')).body;
  const oldEvent = state.events.find((event) => event.id === original.id);
  const replacement = state.events.find((event) => event.id === oldEvent.replacementEventId);
  assert.equal(oldEvent.status, 'cancelled');
  assert.equal(oldEvent.cancellationType, 'reschedule');
  assert.equal(replacement.previousEventId, original.id);
  assert.equal(replacement.location, '合成会议室 C');
  assert.equal(replacement.start, original.start);
  assert.equal(state.emails.length, 1);
  const trace = (await app.request('/api/traces')).body.traces[0];
  assert.equal(trace.attempts.length, 2);
  assert.equal(trace.match_retry, null);
});
