import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { sendQQReply } from './agent.js';

const settings = {
  email: 'reply-fixture@example.invalid', authorizationCode: 'invented-reply-fixture-code',
  baseUrl: 'http://127.0.0.1/fixture-model', apiKey: 'invented-reply-fixture-key',
  model: 'fixture-model', fetchLimit: 15,
};
const originalEmail = {
  id: `qq:${settings.email}:10:1`, trace_id: 'reply-fixture-trace', mode: 'qq', status: 'skipped',
  subject: '合成会议邀请', sender: '合成来信者 <sender@example.invalid>',
  senderAddress: 'sender@example.invalid', replyTo: '合成回复联系人 <reply-to@example.invalid>',
  messageId: '<original@example.invalid>', references: ['<older@example.invalid>'],
  receivedAt: '2026-10-13T08:00:00+08:00', body: '供本地测试的合成邮件。',
};
const originalTrace = {
  trace_id: originalEmail.trace_id, mode: 'qq', status: 'skipped', subject: originalEmail.subject,
  email_ref: createHash('sha256').update(originalEmail.id).digest('hex').slice(0, 24),
  started_at: originalEmail.receivedAt, ended_at: originalEmail.receivedAt, latency_ms: 0,
  draft_reply: '您好，已收到会议邀请，感谢说明。\n', draft_source: 'local_template', user_action: null,
  attempts: [], spans: [], llm_tokens_in: 0, llm_tokens_out: 0, cost_cny: 0, known_cost_cny: 0,
};

test('SMTP 回复使用系统 DNS 地址和 QQ TLS 域名、Reply-To 与原线程，中文长稿完整保留', async (t) => {
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const lookup = mock.method(dns, 'lookup', async () => ({ address: '192.0.2.5', family: 4 }));
  t.after(() => lookup.mock.restore());
  const draft = `您好：\n${'请查看三个候选时段及补充说明。'.repeat(100)}\n最终说明保持完整。\n`;
  let transportOptions;
  let outgoing;
  let message;
  const replacement = mock.method(nodemailer, 'createTransport', (options) => {
    transportOptions = options;
    return { sendMail: async (mail) => {
      outgoing = mail;
      const info = await stream.sendMail(mail);
      message = await simpleParser(info.message);
      return { ...info, accepted: [mail.to] };
    } };
  });
  t.after(() => replacement.mock.restore());
  const info = await sendQQReply(settings, {
    ...originalEmail, replyTo: `${originalEmail.replyTo}, 另一联系人 <second@example.invalid>`,
    references: ['<older@example.invalid>', originalEmail.messageId],
  }, draft);
  assert.equal(lookup.mock.callCount(), 1);
  assert.deepEqual(lookup.mock.calls[0].arguments, ['smtp.qq.com']);
  assert.equal(transportOptions.host, '192.0.2.5');
  assert.equal(transportOptions.port, 465);
  assert.equal(transportOptions.secure, true);
  assert.deepEqual(transportOptions.tls, { servername: 'smtp.qq.com' });
  assert.notEqual(transportOptions.tls.rejectUnauthorized, false, '保持默认 TLS 证书校验');
  assert.deepEqual(transportOptions.auth, { user: settings.email, pass: settings.authorizationCode });
  assert.equal(transportOptions.logger, false);
  assert.equal(transportOptions.debug, false);
  assert.equal(outgoing.to, 'reply-to@example.invalid', '只回复首个有效 Reply-To 地址');
  assert.equal(message.from.value[0].address, settings.email);
  assert.deepEqual(message.to.value.map((item) => item.address), ['reply-to@example.invalid']);
  assert.equal(message.subject, `Re: ${originalEmail.subject}`);
  assert.equal(message.inReplyTo, originalEmail.messageId);
  assert.deepEqual(message.references, ['<older@example.invalid>', originalEmail.messageId]);
  assert.equal(message.text, draft);
  assert.ok(message.text.length > 700);
  assert.equal(info.messageId, message.messageId);
});

test('没有有效 Reply-To 时回复新字段或旧 sender，已有 Re 主题不再添加前缀', async (t) => {
  const lookup = mock.method(dns, 'lookup', async () => ({ address: '192.0.2.5', family: 4 }));
  t.after(() => lookup.mock.restore());
  const outgoing = [];
  const replacement = mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (mail) => {
    outgoing.push(mail);
    return { accepted: [mail.to], messageId: '<fixture-reply@example.invalid>' };
  } }));
  t.after(() => replacement.mock.restore());
  await sendQQReply(settings, { ...originalEmail, subject: 'Re: 已有主题', replyTo: '无地址名称' }, '合成正文');
  await sendQQReply(settings, { subject: '旧邮件', sender: '"合成姓名, 测试" <legacy@example.invalid>' }, '合成正文');
  assert.equal(outgoing[0].to, originalEmail.senderAddress);
  assert.equal(outgoing[0].subject, 'Re: 已有主题');
  assert.equal(outgoing[1].to, 'legacy@example.invalid');
  assert.equal(outgoing[1].inReplyTo, undefined, '旧邮件缺少 Message-ID 时不编造线程头');
  await assert.rejects(sendQQReply(settings, { sender: '无法回复的名称' }, '合成正文'), /地址/);
  assert.equal(outgoing.length, 2);
  assert.equal(lookup.mock.callCount(), 2, '无收件人时不解析 SMTP 地址');
});

test('SMTP 没有接受目标收件人时不把回复视为成功', async (t) => {
  const lookup = mock.method(dns, 'lookup', async () => ({ address: '192.0.2.5', family: 4 }));
  t.after(() => lookup.mock.restore());
  const replacement = mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => ({ accepted: ['other@example.invalid'], rejected: ['reply-to@example.invalid'], messageId: '<rejected@example.invalid>' }),
  }));
  t.after(() => replacement.mock.restore());
  await assert.rejects(sendQQReply(settings, originalEmail, '合成正文'), /未接受/);
});

test('系统 DNS 解析失败时不创建 SMTP 连接，保留解析错误供发送入口处理', async (t) => {
  const failure = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.qq.com'), { code: 'ENOTFOUND' });
  const lookup = mock.method(dns, 'lookup', async () => { throw failure; });
  const transport = mock.method(nodemailer, 'createTransport', () => {
    assert.fail('DNS 解析失败后不应创建 SMTP 连接');
  });
  t.after(() => lookup.mock.restore());
  t.after(() => transport.mock.restore());
  await assert.rejects(sendQQReply(settings, originalEmail, '合成正文'), (error) => error === failure);
  assert.deepEqual(lookup.mock.calls[0].arguments, ['smtp.qq.com']);
  assert.equal(transport.mock.callCount(), 0);
});

// A separate process avoids native PDF module teardown in Windows Worker threads.
// Real Express API/JSON store, synthetic SMTP/IMAP/model and disabled interval clock.
async function serveFixture(fixtureData) {
  const { mock } = await import('node:test');
  const { default: dns } = await import('node:dns/promises');
  const { default: express } = await import('express');
  const { default: nodemailer } = await import('nodemailer');
  const { ImapFlow } = await import('imapflow');
  let outgoing = [];
  let reads = 0;
  let modelCalls = 0;
  let blockSend = false;
  let releaseSend;
  let failSend = false;
  let failDns = false;
  let blockModel = false;
  let releaseModel;
  let httpServer;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(dns, 'lookup', async () => {
    if (failDns) {
      failDns = false;
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND smtp.qq.com ${fixtureData.settings.email} ${fixtureData.settings.authorizationCode} ${fixtureData.settings.apiKey} sender@example.invalid`), { code: 'ENOTFOUND' });
    }
    return { address: '192.0.2.5', family: 4 };
  });
  mock.method(nodemailer, 'createTransport', (options) => ({
    async sendMail(mail) {
      outgoing.push({ options, mail });
      if (blockSend) {
        blockSend = false;
        await new Promise((resolve) => { releaseSend = resolve; });
      }
      if (failSend) {
        failSend = false;
        throw new Error(`合成 SMTP 连接失败 ${fixtureData.settings.email} ${fixtureData.settings.authorizationCode} ${fixtureData.settings.apiKey} sender@example.invalid`);
      }
      return { accepted: [mail.to], rejected: [], messageId: `<reply-fixture-${outgoing.length}@example.invalid>` };
    },
  }));
  mock.method(ImapFlow.prototype, 'connect', async function () {
    reads++;
    this.mailbox = { exists: 1, uidValidity: 10 };
  });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'fetch', async function* () {
    yield { uid: 2, internalDate: new Date('2026-10-13T09:00:00+08:00'),
      source: Buffer.from([
        'From: New Fixture <new-sender@example.invalid>',
        'Reply-To: Reply Fixture <new-reply@example.invalid>',
        'Subject: New synthetic notification',
        'Message-ID: <new-original@example.invalid>',
        'References: <older-thread@example.invalid> <previous-thread@example.invalid>',
        'Date: Tue, 13 Oct 2026 09:00:00 +0800',
        'Content-Type: text/plain; charset=utf-8',
        '', 'A synthetic notification used only by the local test.',
      ].join('\r\n')) };
  });
  mock.method(globalThis, 'fetch', async () => {
    modelCalls++;
    if (blockModel) {
      blockModel = false;
      await new Promise((resolve) => { releaseModel = resolve; });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ summary: '一封新的合成通知。', events: [], tasks: [], category: 'notice', priority: 'low' }),
    } }] }) };
  });
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = httpServer = listen.apply(this, args);
    server.once('listening', () => process.send({ port: server.address().port }));
    return server;
  });
  process.on('message', async (message) => {
    if (message.type === 'shutdown') {
      try {
        await new Promise((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
          httpServer.closeAllConnections();
        });
        mock.timers.reset();
        mock.restoreAll();
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        process.disconnect();
      }
      return;
    }
    if (message.type === 'block-send') blockSend = true;
    if (message.type === 'release-send') releaseSend();
    if (message.type === 'fail-send') failSend = true;
    if (message.type === 'fail-dns') failDns = true;
    if (message.type === 'block-model') blockModel = true;
    if (message.type === 'release-model') releaseModel();
    process.send({ outgoing, reads, modelCalls });
  });
  process.argv.push('--production');
  await import(fixtureData.indexUrl);
}

async function fixtureServer(t, { settingsOverrides = {}, emailOverrides = {}, traceOverrides = {}, directory } = {}) {
  const storedSettings = { ...settings, ...settingsOverrides };
  if (!directory) {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    directory = fs.mkdtempSync(path.join(work, 'reply-test-'));
    fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify({ events: [], tasks: [],
      emails: [{ ...originalEmail, ...emailOverrides }], lastSync: null }));
    fs.writeFileSync(path.join(directory, 'traces.json'), JSON.stringify([{ ...originalTrace, ...traceOverrides }]));
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(storedSettings));
    fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
      postgres: { enabled: false },
    mq: { enabled: false }, // Isolate transport from any RabbitMQ running on the host.
      auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'test', adminEmails: [] },
    }, null, 2));
  }
  const fixtureData = { indexUrl: new URL('./index.js', import.meta.url).href, settings: storedSettings };
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `(${serveFixture.toString()})(${JSON.stringify(fixtureData)}).catch(error => {
      console.error(error); process.exitCode = 1; if (process.connected) process.disconnect();
    })`], { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PORT: '0', DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_REQUIRE_AUTH: '0' } });
  let output = '', exitResult, stopping;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = (output + chunk).slice(-16384); });
  }
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { exitResult = { error }; resolve(exitResult); });
    child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  const failure = (message, result = exitResult) => new Error(
    `${message}; exitCode=${result?.code ?? 'pending'}, signal=${result?.signal ?? 'none'}\n${result?.error?.message || ''}\n${output}`);
  const nextMessage = () => new Promise((resolve, reject) => {
    if (exitResult) { reject(failure('Reply API fixture already exited')); return; }
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (value) => { cleanup(); resolve(value); };
    const onExit = (code, signal) => { cleanup(); reject(failure('Reply API fixture exited before replying', { code, signal })); };
    const onError = (error) => { cleanup(); reject(failure('Reply API fixture process failed', { error })); };
    const timer = setTimeout(() => { cleanup(); reject(failure('Reply API fixture did not reply within 15 seconds')); }, 15000);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
  const send = (value) => new Promise((resolve, reject) => child.send(value, (error) => error ? reject(error) : resolve()));
  const stop = () => stopping ||= (async () => {
    let timer;
    try {
      if (!exitResult) await send({ type: 'shutdown' });
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('Reply API fixture did not shut down within 5 seconds')), 5000);
      })]);
      if (result.error || result.code !== 0 || result.signal) throw failure('Reply API fixture exited unsuccessfully', result);
    } catch (error) {
      if (!exitResult) { child.kill(); await exited; }
      throw error;
    } finally { clearTimeout(timer); }
  })();
  t.after(stop);
  const { port } = await nextMessage();
  assert.ok(Number.isInteger(port) && port > 0, failure('Reply API fixture returned an invalid port'));
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const command = async (message) => {
    const [result] = await Promise.all([nextMessage(), send(message)]);
    return result;
  };
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await delay(10);
    }
    assert.fail('合成服务未在预期时间内到达目标状态');
  };
  return { directory, request, command, waitFor,
    send: () => request(`/api/traces/${originalTrace.trace_id}/send`, 'POST'),
    feedback: (action, draft) => request(`/api/traces/${originalTrace.trace_id}/feedback`, 'PUT', { action, draft }),
    trace: async () => (await request('/api/traces')).body.traces.find((item) => item.trace_id === originalTrace.trace_id),
    diskTrace: () => JSON.parse(fs.readFileSync(path.join(directory, 'traces.json'), 'utf8')).find((item) => item.trace_id === originalTrace.trace_id),
    stop,
  };
}

test('真实草稿发送完整已保存修改稿，只需邮箱配置，成功落盘并在重启后仍不重复发送', async (t) => {
  const app = await fixtureServer(t, { settingsOverrides: { apiKey: '', baseUrl: '', model: '' } });
  const edited = `您好：\n${'这是用户保存的完整回复说明。'.repeat(100)}\n联系 product-review@example.invalid，电话 13800138000。\n说明链接 https://example.invalid/meeting?invite=demo#agenda\n请保留这句最终说明。\n`;
  const modified = await app.feedback('modified', edited);
  assert.equal(modified.status, 200);
  assert.equal(modified.body.user_draft.includes('product-review@example.invalid'), false, '日志继续脱敏普通联系方式');
  assert.equal(modified.body.user_draft.includes('13800138000'), false);
  assert.equal(modified.body.user_draft.includes('invite=demo'), false);
  const savedEmail = (await app.request('/api/state')).body.emails[0];
  assert.equal(savedEmail.userDraft, edited, '作为业务内容保存的修改稿保持原文');
  const result = await app.request(`/api/traces/${originalTrace.trace_id}/send`, 'POST', { draft: '请求中的其他正文不覆盖保存稿', to: 'other@example.invalid' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user_action, 'accepted');
  assert.equal(result.body.reply_delivery.status, 'sent');
  assert.ok(Number.isFinite(Date.parse(result.body.reply_delivery.sent_at)));
  assert.equal(result.body.reply_delivery.message_id, '<reply-fixture-1@example.invalid>');
  assert.deepEqual(app.diskTrace(), result.body);
  const sent = await app.command({ type: 'counts' });
  assert.equal(sent.outgoing.length, 1);
  assert.equal(sent.outgoing[0].mail.text, edited);
  assert.equal(sent.outgoing[0].mail.to, 'reply-to@example.invalid');
  assert.equal(sent.modelCalls, 0);
  assert.equal(sent.reads, 0);
  assert.deepEqual((await app.send()).body, result.body);
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 1);
  assert.equal((await app.feedback('modified', '发送后修改')).status, 409);
  await app.stop();
  const restarted = await fixtureServer(t, { directory: app.directory });
  assert.deepEqual((await restarted.send()).body, result.body);
  assert.equal((await restarted.command({ type: 'counts' })).outgoing.length, 0);
});

test('同一草稿并发发送及发送中反馈返回 409，完成后只有一次 SMTP 调用', async (t) => {
  const app = await fixtureServer(t);
  await app.command({ type: 'block-send' });
  const sending = app.send();
  await app.waitFor(async () => (await app.command({ type: 'counts' })).outgoing.length === 1);
  assert.equal((await app.send()).status, 409);
  assert.equal((await app.feedback('rejected')).status, 409);
  await app.command({ type: 'release-send' });
  assert.equal((await sending).status, 200);
  assert.equal((await app.send()).status, 200);
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 1);
});

test('旧已采纳草稿仍能发送原始业务正文，旧修改稿优先于原稿且不调用模型', async (t) => {
  const raw = '联系 original-contact@example.invalid，电话 13800138000。\nhttps://example.invalid/review?invite=original#time\n';
  const original = await fixtureServer(t, {
    emailOverrides: { draftReply: raw },
    traceOverrides: { user_action: 'accepted', draft_reply: '联系 [邮箱已脱敏]，电话 [手机号已脱敏]。\nhttps://example.invalid/review\n' },
  });
  assert.equal((await original.send()).status, 200, '历史 accepted 反馈不是成功发信标记');
  const sentOriginal = await original.command({ type: 'counts' });
  assert.equal(sentOriginal.outgoing[0].mail.text, raw);
  assert.equal(sentOriginal.modelCalls, 0);
  assert.equal(sentOriginal.reads, 0);
  const legacyDraft = '上线前已保存的用户修改稿，继续沿用。\n';
  const modified = await fixtureServer(t, {
    emailOverrides: { draftReply: raw }, traceOverrides: { user_action: 'modified', user_draft: legacyDraft },
  });
  assert.equal((await modified.send()).status, 200);
  const sentModified = await modified.command({ type: 'counts' });
  assert.equal(sentModified.outgoing[0].mail.text, legacyDraft);
  assert.equal(sentModified.modelCalls, 0);
  assert.equal(sentModified.reads, 0);
});

test('发送失败保存脱敏状态和修改稿，再次采纳可以重试成功', async (t) => {
  const app = await fixtureServer(t);
  assert.equal((await app.feedback('modified', '合成用户修改稿。')).status, 200);
  await app.command({ type: 'fail-send' });
  const failure = await app.send();
  assert.equal(failure.status, 502);
  assert.match(failure.body.error, /合成 SMTP 连接失败/);
  const failed = await app.trace();
  assert.equal(failed.reply_delivery.status, 'failed');
  assert.ok(Number.isFinite(Date.parse(failed.reply_delivery.attempted_at)));
  assert.equal(failed.user_action, 'modified');
  assert.equal(failed.user_draft, '合成用户修改稿。');
  assert.deepEqual(app.diskTrace(), failed);
  for (const secret of [settings.email, settings.authorizationCode, settings.apiKey, 'sender@example.invalid']) {
    assert.equal(JSON.stringify(failure.body).includes(secret), false);
    assert.equal(JSON.stringify(failed.reply_delivery).includes(secret), false);
  }
  const retry = await app.send();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reply_delivery.status, 'sent');
  assert.equal(retry.body.reply_delivery.error, undefined);
  assert.equal(retry.body.user_action, 'accepted');
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 2);
});

test('DNS 失败保存脱敏错误并保留修改稿，重试重新解析后发送成功', async (t) => {
  const app = await fixtureServer(t);
  const draft = 'DNS 失败后保留的合成用户修改稿。';
  assert.equal((await app.feedback('modified', draft)).status, 200);
  await app.command({ type: 'fail-dns' });
  const failure = await app.send();
  assert.equal(failure.status, 502);
  assert.match(failure.body.error, /ENOTFOUND smtp\.qq\.com/);
  const failed = await app.trace();
  assert.equal(failed.reply_delivery.status, 'failed');
  assert.ok(Number.isFinite(Date.parse(failed.reply_delivery.attempted_at)));
  assert.equal(failed.user_action, 'modified');
  assert.equal(failed.user_draft, draft);
  assert.deepEqual(app.diskTrace(), failed);
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 0);
  for (const secret of [settings.email, settings.authorizationCode, settings.apiKey, 'sender@example.invalid']) {
    assert.equal(JSON.stringify(failure.body).includes(secret), false);
    assert.equal(JSON.stringify(failed.reply_delivery).includes(secret), false);
  }
  const retry = await app.send();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reply_delivery.status, 'sent');
  assert.equal(retry.body.reply_delivery.error, undefined);
  assert.equal(retry.body.user_action, 'accepted');
  const sent = await app.command({ type: 'counts' });
  assert.equal(sent.outgoing.length, 1);
  assert.equal(sent.outgoing[0].mail.text, draft);
  assert.equal(sent.outgoing[0].options.host, '192.0.2.5');
  assert.deepEqual(sent.outgoing[0].options.tls, { servername: 'smtp.qq.com' });
});

test('示例保留本地反馈，缺邮箱配置及已保存空稿不能发信', async (t) => {
  const demo = await fixtureServer(t, { emailOverrides: { mode: 'demo' }, traceOverrides: { mode: 'demo' } });
  assert.equal((await demo.feedback('accepted')).status, 200);
  assert.equal((await demo.send()).status, 400);
  assert.equal((await demo.command({ type: 'counts' })).outgoing.length, 0);
  const missing = await fixtureServer(t, { settingsOverrides: { authorizationCode: '' } });
  assert.equal((await missing.send()).status, 400);
  assert.equal((await missing.command({ type: 'counts' })).outgoing.length, 0);
  const empty = await fixtureServer(t);
  assert.equal((await empty.feedback('modified', '   ')).status, 200);
  assert.equal((await empty.send()).status, 400, '空修改稿不能回退发送原稿');
  assert.equal((await empty.command({ type: 'counts' })).outgoing.length, 0);
  assert.equal((await empty.request('/api/traces/missing-trace/send', 'POST')).status, 404);
});

test('新邮件保存回复地址与线程信息，同步继续写日志时保留已发送和失败可重试状态', async (t) => {
  const app = await fixtureServer(t);
  await app.command({ type: 'block-model' });
  const syncing = app.request('/api/sync/qq', 'POST');
  await app.waitFor(async () => (await app.command({ type: 'counts' })).modelCalls === 1);
  await app.command({ type: 'fail-send' });
  assert.equal((await app.send()).status, 502);
  const failure = (await app.trace()).reply_delivery;
  assert.equal(failure.status, 'failed');
  assert.equal((await app.send()).status, 200);
  const success = await app.trace();
  await app.command({ type: 'release-model' });
  assert.equal((await syncing).status, 200);
  assert.deepEqual(await app.trace(), success, '后续 recorder 写入不能覆盖发信结果');
  assert.deepEqual(app.diskTrace(), success);
  const state = (await app.request('/api/state')).body;
  const incoming = state.emails.find((item) => item.id.endsWith(':10:2'));
  assert.equal(incoming.senderAddress, 'new-sender@example.invalid');
  assert.match(incoming.replyTo, /new-reply@example\.invalid/);
  assert.equal(incoming.messageId, '<new-original@example.invalid>');
  assert.deepEqual(incoming.references, ['<older-thread@example.invalid>', '<previous-thread@example.invalid>']);
  assert.deepEqual(state.emails.find((item) => item.id === originalEmail.id), originalEmail);

  const failing = await fixtureServer(t);
  await failing.command({ type: 'block-model' });
  const pendingSync = failing.request('/api/sync/qq', 'POST');
  await failing.waitFor(async () => (await failing.command({ type: 'counts' })).modelCalls === 1);
  await failing.command({ type: 'fail-send' });
  assert.equal((await failing.send()).status, 502);
  const savedFailure = await failing.trace();
  await failing.command({ type: 'release-model' });
  assert.equal((await pendingSync).status, 200);
  assert.deepEqual(await failing.trace(), savedFailure, '同步完成也不能覆盖失败状态及脱敏错误');
  assert.equal((await failing.send()).status, 200);
});
