import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

const firstSettings = { email: 'first@qq.com', authorizationCode: 'invented-first-mailbox-code',
  baseUrl: 'http://127.0.0.1/fixture-model', apiKey: 'invented-mailbox-model-key', model: 'fixture-model', fetchLimit: 2 };
const secondSettings = { email: 'second@163.com', authorizationCode: 'invented-second-mailbox-code', provider: '163', fetchLimit: 2, mailboxId: '' };
const legacyEvent = { id: 'legacy-manual', title: '旧邮箱的手动安排', start: '2026-11-20T10:00:00+08:00', end: '2026-11-20T11:00:00+08:00', source: 'manual' };

// Real API/storage/scheduler; all mail, SMTP and model transports are local fixtures.
async function serveFixture() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { default: dns } = await import('node:dns/promises');
  const { default: nodemailer } = await import('nodemailer');
  const { ImapFlow } = await import('imapflow');
  const reads = [];
  const outgoing = [];
  const modelInputs = [];
  let mailboxSize = 5;
  let operation = 'create';
  let blockModel = false;
  let releaseModel;
  let blockSend = false;
  let releaseSend;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(ImapFlow.prototype, 'connect', async function () {
    this.mailbox = { exists: mailboxSize, uidValidity: 10 };
    reads.push({ email: this.options.auth.user, host: this.options.host, port: this.options.port,
      secure: this.options.secure, doSTARTTLS: this.options.doSTARTTLS });
  });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'fetch', async function* (range, query, options) {
    if (!query.source) reads.at(-1).range = range;
    const uids = options?.uid ? range.split(',').map(Number) :
      Array.from({ length: this.mailbox.exists - Number(range.split(':')[0]) + 1 }, (_, index) => Number(range.split(':')[0]) + index);
    if (query.source) reads.at(-1).sourceUids = uids;
    for (const uid of uids) {
      yield { uid, internalDate: new Date(`2026-10-14T08:0${uid}:00+08:00`), ...(query.source ? { source: Buffer.from([
        'From: Fixture <sender@example.invalid>',
        `Subject: Synthetic mailbox ${uid}`,
        `Date: Wed, 14 Oct 2026 08:0${uid}:00 +0800`,
        `Message-ID: <same-mail-${uid}@example.invalid>`,
        'Content-Type: text/plain; charset=utf-8', '', `Synthetic mailbox operation ${operation}, UID ${uid}.`,
      ].join('\r\n')) } : {}) };
    }
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    modelInputs.push(input);
    if (blockModel) {
      blockModel = false;
      await new Promise((resolve) => { releaseModel = resolve; });
    }
    const uid = Number(input.subject.match(/\d+$/)[0]);
    const cancel = input.body.includes('operation cancel') && uid === 6;
    const events = cancel ? [{ action: 'cancel', targetEventId: input.existingEvents.find((event) => event.title === '合成安排 4')?.id, reason: '合成取消通知' }]
      : [{ title: `合成安排 ${uid}`, start: `2026-11-${String(uid).padStart(2, '0')}T14:00:00+08:00`,
        end: `2026-11-${String(uid).padStart(2, '0')}T15:00:00+08:00`, allDay: false, category: 'work' }];
    const content = { summary: '本地多邮箱验证使用的合成邮件。', category: 'meeting', priority: 'normal', events,
      tasks: cancel ? [] : [{ title: '提交合成报告', dueAt: '2026-11-30T18:00:00+08:00', description: '本地测试待办。' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  });
  mock.method(dns, 'lookup', async () => ({ address: '192.0.2.9', family: 4 }));
  mock.method(nodemailer, 'createTransport', (options) => ({ async sendMail(mail) {
    outgoing.push({ options, mail });
    if (blockSend) {
      blockSend = false;
      await new Promise((resolve) => { releaseSend = resolve; });
    }
    return { accepted: [mail.to], messageId: `<mailbox-reply-${outgoing.length}@example.invalid>` };
  } }));
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = listen.apply(this, args);
    server.once('listening', () => parentPort.postMessage({ port: server.address().port }));
    return server;
  });
  parentPort.on('message', (message) => {
    if (message.type === 'tick') mock.timers.tick(60_000);
    if (message.type === 'cancel') { operation = 'cancel'; mailboxSize = 6; }
    if (message.type === 'block-model') blockModel = true;
    if (message.type === 'release-model') releaseModel();
    if (message.type === 'block-send') blockSend = true;
    if (message.type === 'release-send') releaseSend();
    parentPort.postMessage({ reads, outgoing, modelInputs });
  });
  process.argv.push('--production');
  await import(workerData.indexUrl);
}

async function fixtureServer(t, { configured = true } = {}) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const directory = fs.mkdtempSync(path.join(root, 'work', 'mailboxes-test-'));
  const legacy = { events: [legacyEvent], emails: [], lastSync: null };
  fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ ...firstSettings,
    ...(configured ? {} : { email: '', authorizationCode: '', apiKey: '' }) }));
  const worker = new Worker(`(${serveFixture.toString()})()`, { eval: true,
    workerData: { indexUrl: new URL('./index.js', import.meta.url).href },
    env: { ...process.env, PORT: '0', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_DISABLE_AUTH: '1' } });
  t.after(() => worker.terminate());
  const [{ port }] = await once(worker, 'message');
  const request = async (route, method = 'GET', body, mailboxId) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const command = async (message) => {
    const response = once(worker, 'message');
    worker.postMessage(message);
    return (await response)[0];
  };
  const state = async () => (await request('/api/state')).body;
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const traces = (await request('/api/traces')).body;
      if (await check(traces)) return traces;
      await delay(10);
    }
    assert.fail('合成多邮箱服务未到达预期状态');
  };
  return { directory, legacy, request, command, state, waitFor,
    finished: () => waitFor(({ sync }) => sync.status === 'completed' && !sync.running),
    activate: (id) => request(`/api/mailboxes/${id}/activate`, 'POST'),
    save: (settings) => request('/api/settings', 'PUT', settings) };
}

test('旧单邮箱配置和无 tasks 的日历直接兼容，读取状态不改写原文件', async (t) => {
  const app = await fixtureServer(t);
  const files = ['settings', 'calendar'].map((name) => fs.readFileSync(path.join(app.directory, `${name}.json`), 'utf8'));
  const state = await app.state();
  assert.equal(state.mailboxId, 'default');
  assert.equal(state.settings.activeMailboxId, 'default');
  assert.equal(state.settings.mailboxes.length, 1);
  assert.equal(state.settings.provider, 'qq');
  assert.equal(state.settings.mailboxReady, true);
  assert.deepEqual(state.events, app.legacy.events);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.events[0].status, undefined);
  assert.deepEqual((await app.request('/api/traces')).body.traces, []);
  assert.deepEqual(['settings', 'calendar'].map((name) => fs.readFileSync(path.join(app.directory, `${name}.json`), 'utf8')), files);
  for (const secret of [firstSettings.authorizationCode, firstSettings.apiKey]) assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal((await app.request('/api/sync/mail', 'POST')).body.added, 2);
  const adjusted = await app.save({ mailboxId: 'default', email: firstSettings.email, provider: 'custom',
    imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', authorizationCode: '' });
  assert.equal(adjusted.body.activeMailboxId, 'default');
  assert.equal(adjusted.body.hasAuthorizationCode, true);
  assert.equal((await app.request('/api/sync/mail', 'POST')).body.duplicate, 2, '同邮箱切换服务商选项仍按原邮件 ID 去重');
  const repeated = await app.command({ type: 'counts' });
  assert.equal(repeated.modelInputs.length, 2);
  assert.deepEqual(repeated.reads[0].sourceUids, [4, 5]);
  assert.equal(repeated.reads[1].sourceUids, undefined, '已处理邮件只检查 UID，不获取原文');
});

test('同 UID/Message-ID 和同名待办在不同邮箱分别提取，切换按各自数量读取且保留手动、取消与草稿', async (t) => {
  const app = await fixtureServer(t);
  assert.equal((await app.request('/api/sync/mailbox', 'POST')).body.added, 2);
  const first = await app.state();
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].sources.length, 2);
  assert.ok(first.tasks[0].sources[0].emailUrl.includes('mailbox=default'));
  assert.equal((await app.request(`/api/tasks/${first.tasks[0].id}`, 'PUT', { status: 'done' })).status, 200);
  const firstTrace = (await app.request('/api/traces')).body.traces[0];
  await app.request(`/api/traces/${firstTrace.trace_id}/feedback`, 'PUT', { action: 'modified', draft: '旧邮箱独立草稿。' });
  const saved = await app.save(secondSettings);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.syncStarted, true);
  const secondId = saved.body.activeMailboxId;
  assert.notEqual(secondId, 'default');
  const sync = (await app.finished()).sync;
  assert.equal(sync.trigger, 'mailbox-switch');
  assert.equal(sync.mailboxId, secondId);
  assert.equal(sync.result.added, 2);
  const second = await app.state();
  assert.equal(second.events.length, 2, '新邮箱未复制旧手动或预置日程');
  assert.equal(second.tasks.length, 1);
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  assert.equal(second.tasks[0].status, 'pending', '旧邮箱完成状态不影响新邮箱');
  assert.equal(second.tasks[0].sources.length, 2);
  assert.equal(second.emails[0].messageId, first.emails[0].messageId);
  assert.ok(second.emails[0].id.endsWith(':10:5'));
  assert.ok(first.emails[0].id.endsWith(':10:5'));
  assert.equal((await app.request(`/api/traces/${firstTrace.trace_id}/feedback`, 'PUT', { action: 'rejected' })).status, 404);
  assert.equal((await app.request(`/api/events/${legacyEvent.id}`, 'PUT', { title: '不能修改另一个邮箱' })).status, 404);
  assert.equal((await app.request(`/api/tasks/${first.tasks[0].id}`, 'PUT', { status: 'pending' })).status, 404);
  await app.command({ type: 'cancel' });
  assert.equal((await app.request('/api/sync/mail', 'POST')).body.cancelled, 1);
  assert.equal((await app.state()).events.find((event) => event.title === '合成安排 4').status, 'cancelled');
  const secondRoot = path.join(app.directory, 'mailboxes', secondId);
  assert.ok(fs.existsSync(path.join(secondRoot, 'calendar.json')));
  assert.ok(fs.existsSync(path.join(secondRoot, 'traces.json')));
  const restored = await app.activate('default');
  assert.equal(restored.body.syncStarted, true);
  await app.finished();
  const original = await app.state();
  assert.ok(original.events.some((event) => event.id === legacyEvent.id));
  assert.equal(original.tasks[0].status, 'done');
  const draft = original.emails.find((email) => email.trace_id === firstTrace.trace_id);
  assert.equal(draft.userDraft, '旧邮箱独立草稿。');
  const readResult = await app.command({ type: 'counts' });
  assert.deepEqual(readResult.reads.map(({ email, host, range }) => ({ email, host, range })), [
    { email: firstSettings.email, host: 'imap.qq.com', range: '4:*' },
    { email: secondSettings.email, host: 'imap.163.com', range: '4:*' },
    { email: secondSettings.email, host: 'imap.163.com', range: '5:*' },
    { email: firstSettings.email, host: 'imap.qq.com', range: '5:*' },
  ]);
  const previous = (await app.request('/api/traces')).body.sync.id;
  await app.command({ type: 'tick' });
  await app.waitFor(({ sync }) => sync.id !== previous && !sync.running);
  assert.equal((await app.command({ type: 'counts' })).reads.at(-1).email, firstSettings.email, '定时器只同步当前邮箱');
});

test('编辑地址会创建独立邮箱且不继承授权码；同账号空码保存保留，服务器与数量可分别配置', async (t) => {
  const app = await fixtureServer(t);
  const before = await app.state();
  const cleared = await app.save({ mailboxId: 'default', email: '', authorizationCode: '' });
  assert.equal(cleared.status, 400, '拒绝清空已配置账号，避免再次填写时沿用另一个账号数据');
  assert.deepEqual(await app.state(), before);
  const changed = await app.save({ mailboxId: 'default', email: 'custom@example.invalid', authorizationCode: '', provider: 'custom',
    imapHost: 'imap.example.invalid', imapPort: 143, imapSecure: false, smtpHost: 'smtp.example.invalid', smtpPort: 587, smtpSecure: false, fetchLimit: 3 });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.body.activeMailboxId, 'default');
  assert.equal(changed.body.hasAuthorizationCode, false);
  assert.equal(changed.body.syncStarted, false);
  assert.deepEqual((await app.state()).events, []);
  assert.equal((await app.request('/api/traces')).body.mailboxId, changed.body.activeMailboxId);
  assert.equal((await app.command({ type: 'counts' })).reads.length, 0);
  const configured = await app.save({ mailboxId: changed.body.activeMailboxId, email: 'custom@example.invalid', authorizationCode: 'invented-custom-code' });
  assert.equal(configured.body.hasAuthorizationCode, true);
  assert.equal((await app.save({ mailboxId: changed.body.activeMailboxId, authorizationCode: '' })).body.hasAuthorizationCode, true);
  assert.equal((await app.request('/api/sync/mail', 'POST')).body.total, 3);
  const read = (await app.command({ type: 'counts' })).reads[0];
  assert.equal(read.range, '3:*');
  assert.equal(read.host, 'imap.example.invalid');
  assert.equal(read.port, 143);
  assert.equal(read.secure, false);
  assert.equal(read.doSTARTTLS, true);
  await app.activate('default');
  await app.finished();
  const original = await app.state();
  assert.equal(original.settings.fetchLimit, 2);
  assert.equal(original.settings.email, firstSettings.email);
  assert.equal(original.settings.hasAuthorizationCode, true);
  assert.ok(original.events.some((event) => event.id === legacyEvent.id));
});

test('同步和SMTP等待期间拒绝切换；过期页面请求不跨邮箱写入，真实发送使用对应邮箱和服务器', async (t) => {
  const app = await fixtureServer(t);
  await app.request('/api/sync/qq', 'POST');
  const firstTrace = (await app.request('/api/traces')).body.traces[0];
  const saved = await app.save({ ...secondSettings, provider: 'outlook', email: 'second@outlook.com' });
  const secondId = saved.body.activeMailboxId;
  await app.finished();
  const secondTrace = (await app.request('/api/traces')).body.traces[0];
  await app.command({ type: 'block-send' });
  const sending = app.request(`/api/traces/${secondTrace.trace_id}/send`, 'POST', undefined, secondId);
  await app.waitFor(async () => (await app.command({ type: 'counts' })).outgoing.length === 1);
  assert.equal((await app.activate('default')).status, 409);
  assert.equal((await app.save({ mailboxId: 'default', email: firstSettings.email })).status, 409);
  await app.command({ type: 'release-send' });
  assert.equal((await sending).status, 200);
  const outgoing = (await app.command({ type: 'counts' })).outgoing[0];
  assert.equal(outgoing.mail.from, 'second@outlook.com');
  assert.equal(outgoing.options.auth.pass, secondSettings.authorizationCode);
  assert.equal(outgoing.options.port, 587);
  assert.equal(outgoing.options.secure, false);
  assert.equal(outgoing.options.requireTLS, true);
  assert.equal(outgoing.options.tls.servername, 'smtp-mail.outlook.com');
  assert.equal((await app.request(`/api/traces/${firstTrace.trace_id}/send`, 'POST')).status, 404);
  for (const [route, method, body] of [
    ['/api/events', 'POST', legacyEvent], [`/api/events/${legacyEvent.id}`, 'DELETE'],
    ['/api/tasks/missing', 'PUT', { status: 'done' }], ['/api/demo', 'DELETE'], ['/api/sync/demo', 'POST'],
    [`/api/traces/${secondTrace.trace_id}/feedback`, 'PUT', { action: 'modified', draft: '过期页面' }],
    [`/api/traces/${secondTrace.trace_id}/send`, 'POST'],
  ]) assert.equal((await app.request(route, method, body, 'default')).status, 409, route);
  await app.command({ type: 'cancel' });
  await app.command({ type: 'block-model' });
  const syncing = app.request('/api/sync/mail', 'POST');
  await app.waitFor(async ({ sync }) => sync.running && (await app.command({ type: 'counts' })).modelInputs.length === 5);
  assert.equal((await app.activate('default')).status, 409);
  await app.command({ type: 'release-model' });
  assert.equal((await syncing).status, 200);
  assert.equal((await app.state()).events.find((event) => event.title === '合成安排 4').status, 'cancelled');
  await app.activate('default');
  await app.finished();
  assert.equal((await app.request(`/api/traces/${firstTrace.trace_id}/send`, 'POST')).status, 200);
  const last = (await app.command({ type: 'counts' })).outgoing.at(-1);
  assert.equal(last.mail.from, firstSettings.email);
  assert.equal(last.options.tls.servername, 'smtp.qq.com');
  assert.equal(last.options.auth.pass, firstSettings.authorizationCode);
});
