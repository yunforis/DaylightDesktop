import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';

// Actual Express/auth/assistant/tools/storage and SMTP code paths. Every transport response and
// identity is synthetic; global fetch, DNS, SMTP and IMAP are fenced inside a separate process.
// Natural process shutdown avoids native resources being unloaded by Worker.terminate on Windows.
async function serveFixture(fixtureData) {
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { default: dns } = await import('node:dns/promises');
  const { default: nodemailer } = await import('nodemailer');
  const { ImapFlow } = await import('imapflow');
  const models = [];
  const outgoing = [];
  const reserves = [];
  const lookups = [];
  let credentialCalls = 0;
  let imapCalls = 0;
  let httpServer;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(ImapFlow.prototype, 'connect', async () => { imapCalls++; throw new Error('Synthetic test forbids IMAP'); });
  mock.method(dns, 'lookup', async (hostname) => { lookups.push(hostname); return { address: '192.0.2.17', family: 4 }; });
  mock.method(nodemailer, 'createTransport', (options) => ({
    async sendMail(mail) {
      outgoing.push({ options, mail });
      return { accepted: Array.isArray(mail.to) ? [...mail.to] : [mail.to], rejected: [],
        messageId: mail.messageId || `<synthetic-${outgoing.length}@example.invalid>` };
    },
    close() {},
  }));
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const address = String(url);
    if (address === 'https://accounts.feishu.cn/oauth/v3/token') {
      credentialCalls++;
      return json({ access_token: 'synthetic-feishu-token', expires_in: 7200 });
    }
    if (address.startsWith('https://open.feishu.cn/open-apis/vc/v1/reserves/')) {
      const payload = JSON.parse(options.body);
      reserves.push({ url: address, method: options.method, payload });
      return json({ code: 0, data: { reserve: { id: `synthetic-reserve-${reserves.length}`,
        url: `https://vc.feishu.cn/j/synthetic-${reserves.length}`, meeting_no: `synthetic-${reserves.length}`, end_time: payload.end_time } } });
    }
    if (address !== 'http://127.0.0.1/assistant-fixture/v1/chat/completions') throw new Error(`Synthetic test forbids network URL: ${address}`);
    const body = JSON.parse(options.body);
    models.push({ messages: body.messages, tools: body.tools.map((tool) => tool.function.name) });
    const latest = body.messages.at(-1);
    let message;
    if (latest.role === 'tool') {
      const result = JSON.parse(latest.content);
      message = { role: 'assistant', content: result.scope
        ? `过去 ${result.range.days} 天，当前邮箱本地已保存 ${result.overview.total} 封邮件。本简报只读本地已保存邮件，未同步邮件可能遗漏，实际收件箱完整性未知。`
        : result.draft ? '已保存审核草稿，请检查收件人和正文后点击确认发送。' : '请核对工具返回的执行结果。' };
    } else {
      const user = [...body.messages].reverse().find((item) => item.role === 'user')?.content;
      const plan = fixtureData.plans[user];
      if (!plan) throw new Error(`Unexpected synthetic prompt: ${user}`);
      message = { role: 'assistant', content: null, tool_calls: [{ id: `synthetic-call-${models.length}`, type: 'function',
        function: { name: plan.name, arguments: JSON.stringify(plan.args) } }] };
    }
    return json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
  });
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = httpServer = listen.apply(this, args);
    server.once('listening', () => process.send({ ready: true, port: server.address().port }));
    return server;
  });
  process.on('message', async ({ command, id }) => {
    if (command === 'shutdown') {
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
    if (command === 'snapshot') process.send({ id, models, outgoing, reserves, lookups, credentialCalls, imapCalls });
  });
  process.argv.push('--production');
  await import(fixtureData.indexUrl);
}

async function fixture(t) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'work', 'assistant-api-test-'));
  const secret = 'synthetic-assistant-api-signing-secret';
  const users = ['alpha', 'beta'].map((name) => ({ id: `synthetic-user-${name}`, email: `${name}@example.invalid`,
    username: `synthetic-${name}`, role: 'user', session_version: 0, created_at: new Date().toISOString() }));
  const mailboxes = [
    { id: 'synthetic-alpha-work', ownerUserId: users[0].id, email: 'alpha-work@example.invalid' },
    { id: 'synthetic-alpha-other', ownerUserId: users[0].id, email: 'alpha-other@example.invalid' },
    { id: 'synthetic-beta-work', ownerUserId: users[1].id, email: 'beta-work@example.invalid' },
  ].map((mailbox) => ({ ...mailbox, provider: 'custom', authorizationCode: 'invented-mailbox-code',
    imapHost: '', syncStrategy: 'poll', smtpHost: 'smtp.example.invalid', smtpPort: 587, smtpSecure: false }));
  const now = Date.now();
  const start = new Date(now + 2 * 86400_000).toISOString();
  const end = new Date(Date.parse(start) + 3600_000).toISOString();
  const mailText = '帮我写邮件给 first@example.invalid 和 second@example.invalid，提醒他们按时提交合成报告。';
  const meetingText = `帮我在 ${start} 到 ${end} 安排项目讨论的飞书会议，邀请 guest@example.invalid 和 peer@example.invalid。`;
  const briefText = '整理过去 7 天的邮件，给我一份简报。';
  const secondText = '帮我写邮件给 alternate@example.invalid，提醒提交另一份合成报告。';
  const plans = {
    [mailText]: { name: 'draft_email', args: { to: ['first@example.invalid', 'second@example.invalid'], subject: '合成报告提交提醒', body: '您好，请按时提交合成报告，谢谢。' } },
    [meetingText]: { name: 'create_feishu_meeting', args: { title: '合成项目讨论', start, end,
      attendees: ['guest@example.invalid', 'peer@example.invalid'], description: '讨论合成项目的下一步。' } },
    [briefText]: { name: 'get_email_briefing', args: { days: 7 } },
    [secondText]: { name: 'draft_email', args: { to: ['alternate@example.invalid'], subject: '另一个邮箱的合成报告', body: '请提交另一份合成报告。' } },
  };
  fs.writeFileSync(path.join(directory, 'users.json'), JSON.stringify({ users, resets: [] }));
  fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, redis: { enabled: false },
    mq: { enabled: false }, oss: { enabled: false }, auth: { requireAuth: true, jwtSecret: secret, allowLocalDemoLogin: false } }));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ mailboxes, activeMailboxId: mailboxes[0].id,
    baseUrl: 'http://127.0.0.1/assistant-fixture/v1', apiKey: 'invented-model-key', model: 'synthetic-tools-model',
    feishu: { appId: 'synthetic-feishu-app', appSecret: 'invented-feishu-secret', ownerId: 'ou_synthetic_owner' },
    userPrefs: { [users[0].id]: { activeMailboxId: mailboxes[0].id }, [users[1].id]: { activeMailboxId: mailboxes[2].id } } }));
  for (const [index, mailbox] of mailboxes.entries()) {
    const local = path.join(directory, 'mailboxes', mailbox.id);
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'calendar.json'), JSON.stringify({ events: [], tasks: [], lastSync: null,
      emails: [{ id: `synthetic-email-${index}`, subject: `第 ${index} 邮箱合成通知`, sender: 'fixture@example.invalid',
        body: '请按计划准备合成报告。', extraction: { summary: `邮箱 ${index} 的合成报告通知。` }, category: 'task',
        mode: 'qq', receivedAt: new Date(now - 86400_000).toISOString(), status: 'imported' },
      { id: `synthetic-old-email-${index}`, subject: '范围外的合成通知', body: '过早的通知。',
        receivedAt: new Date(now - 10 * 86400_000).toISOString(), category: 'notice', mode: 'qq' }] }));
  }
  const tokens = users.map((user) => jwt.sign({ sub: user.id, sv: 0 }, secret, { expiresIn: '5m' }));
  let service;
  let port;
  let commandId = 0;
  const startServer = async () => {
    const environment = { ...process.env, PORT: '0', DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: directory,
      DAYLIGHT_REQUIRE_AUTH: '1', DAYLIGHT_AUTO_PROXY: '0' };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'DAYLIGHT_HTTPS_PROXY']) environment[key] = '';
    const fixtureData = { indexUrl: new URL('./index.js', import.meta.url).href, plans };
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `(${serveFixture.toString()})(${JSON.stringify(fixtureData)}).catch(error => {
        console.error(error); process.exitCode = 1; if (process.connected) process.disconnect();
      })`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment });
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
      if (exitResult) { reject(failure('Assistant API fixture already exited')); return; }
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onMessage = (value) => { cleanup(); resolve(value); };
      const onExit = (code, signal) => { cleanup(); reject(failure('Assistant API fixture exited before replying', { code, signal })); };
      const onError = (error) => { cleanup(); reject(failure('Assistant API fixture process failed', { error })); };
      const timer = setTimeout(() => { cleanup(); reject(failure('Assistant API fixture did not reply within 15 seconds')); }, 15000);
      child.once('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
    });
    const send = (value) => new Promise((resolve, reject) => child.send(value, (error) => error ? reject(error) : resolve()));
    const stop = () => stopping ||= (async () => {
      let timer;
      try {
        if (!exitResult) await send({ command: 'shutdown' });
        const result = await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('Assistant API fixture did not shut down within 5 seconds')), 5000);
        })]);
        if (result.error || result.code !== 0 || result.signal) throw failure('Assistant API fixture exited unsuccessfully', result);
      } catch (error) {
        if (!exitResult) { child.kill(); await exited; }
        throw error;
      } finally { clearTimeout(timer); }
    })();
    service = { nextMessage, send, stop };
    const { port: readyPort } = await nextMessage();
    assert.ok(Number.isInteger(readyPort) && readyPort > 0, failure('Assistant API fixture returned an invalid port'));
    port = readyPort;
  };
  t.after(() => service?.stop());
  await startServer();
  const request = async (route, { token = tokens[0], method = 'GET', body, mailboxId, sse = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}), ...(sse ? { Accept: 'text/event-stream' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('Content-Type'),
      ...(sse && response.headers.get('Content-Type')?.includes('text/event-stream')
        ? { events: text.split(/\r?\n\r?\n/).filter(Boolean).map((event) => JSON.parse(event.replace(/^data: /, ''))) }
        : { body: JSON.parse(text) }) };
  };
  const snapshot = async () => {
    const [received] = await Promise.all([service.nextMessage(), service.send({ command: 'snapshot', id: ++commandId })]);
    return received;
  };
  const chat = (message, requestId, options = {}) => request('/assistant/chat', { ...options, method: 'POST',
    body: { messages: [{ role: 'user', content: message }], requestId, ...(options.sse ? { stream: true } : {}) } });
  const restart = async () => { await service.stop(); await startServer(); };
  return { directory, mailboxes, tokens, request, snapshot, chat, restart, mailText, meetingText, briefText, secondText };
}

test('真实 Express HTTP：小 D 起草审核发送、飞书入历邀约、简报、SSE恢复与用户邮箱隔离（全部外部传输为合成模拟）', { timeout: 60_000 }, async (t) => {
  const app = await fixture(t);
  const [firstMailbox, otherMailbox, betaMailbox] = app.mailboxes;
  const unauthenticated = await app.request('/assistant/chat', { token: null, method: 'POST',
    body: { messages: [{ role: 'user', content: app.mailText }], requestId: 'synthetic-unauthenticated' } });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await app.request('/assistant/drafts', { token: null })).status, 401);
  assert.equal((await app.request('/assistant/drafts', { mailboxId: otherMailbox.id })).status, 409, '过期页面不能跨邮箱写入');
  assert.equal((await app.request('/assistant/drafts', { mailboxId: betaMailbox.id })).status, 409, '不能用其他用户邮箱头越权');
  assert.deepEqual((await app.request('/assistant/drafts', { token: app.tokens[1] })).body.drafts, []);

  assert.equal((await app.request('/assistant/drafts', { token: null, method: 'POST', body: {
    to: 'workbench@example.invalid', subject: '工作台回复', body: '尚未发送的回复。',
  }})).status, 401);
  assert.equal((await app.request('/assistant/drafts', { method: 'POST', body: {
    mailboxId: betaMailbox.id, to: 'workbench@example.invalid', subject: '工作台回复', body: '尚未发送的回复。',
  }})).status, 404, '不能把草稿写进其他用户邮箱');
  const workbenchDraft = await app.request('/assistant/drafts', { method: 'POST', body: {
    mailboxId: firstMailbox.id,
    to: 'workbench@example.invalid',
    subject: '工作台回复草稿',
    body: '这是工作台放入小 D 审核的回复，尚未发送。',
  }});
  assert.equal(workbenchDraft.status, 201, JSON.stringify(workbenchDraft.body));
  assert.equal(workbenchDraft.body.draft.status, 'pending');
  assert.equal(workbenchDraft.body.draft.from, firstMailbox.email);
  assert.equal((await app.snapshot()).outgoing.length, 0, '工作台放入审核不会发信');
  const discarded = await app.request(`/assistant/drafts/${workbenchDraft.body.draft.id}/discard`, {
    method: 'POST', body: { revision: workbenchDraft.body.draft.revision },
  });
  assert.equal(discarded.body.draft.status, 'discarded');
  assert.equal((await app.snapshot()).outgoing.length, 0, '放弃审核草稿也不会发信');
  assert.equal((await app.request('/assistant/drafts')).body.drafts.filter((item) => item.status !== 'discarded').length, 0);

  const composed = await app.chat(app.mailText, 'synthetic-email-request', { mailboxId: firstMailbox.id });
  assert.equal(composed.status, 200, JSON.stringify(composed.body));
  const emailTool = composed.body.toolTrace.find((tool) => tool.name === 'draft_email');
  assert.equal(emailTool.result.ok, true);
  const draft = emailTool.result.draft;
  assert.deepEqual(draft.to, ['first@example.invalid', 'second@example.invalid']);
  assert.equal(draft.from, firstMailbox.email);
  assert.equal(draft.status, 'pending');
  assert.equal((await app.snapshot()).outgoing.length, 0, '聊天起草不会发信');
  const saved = await app.request(`/assistant/drafts/${draft.id}`);
  assert.equal(saved.body.draft.id, draft.id);
  assert.equal((await app.request('/assistant/drafts')).body.drafts.filter((item) => item.status !== 'discarded').length, 1);
  const persistedDrafts = JSON.parse(fs.readFileSync(path.join(app.directory, 'mailboxes', firstMailbox.id, 'assistant-drafts.json'), 'utf8'));
  assert.ok(persistedDrafts.items.some((item) => item.id === draft.id && item.status === 'pending'));
  assert.equal((await app.request(`/assistant/drafts/${draft.id}`, { token: app.tokens[1] })).status, 404);
  assert.equal((await app.request(`/assistant/drafts/${draft.id}/send`, { token: app.tokens[1], method: 'POST', body: { confirmed: true, revision: 1 } })).status, 404);

  const edited = await app.request(`/assistant/drafts/${draft.id}`, { method: 'PATCH', body: { revision: 1, body: `${draft.body}\n请于周五前完成。` } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.draft.revision, 2);
  assert.match(edited.body.draft.body, /周五前/);
  assert.equal((await app.request(`/assistant/drafts/${draft.id}/send`, { method: 'POST', body: { revision: 2 } })).status, 400, '必须显式确认发送');
  assert.equal((await app.request(`/assistant/drafts/${draft.id}/send`, { method: 'POST', body: { confirmed: true, revision: 1 } })).status, 409, '旧审核版本不能发送');
  assert.equal((await app.snapshot()).outgoing.length, 0);
  const delivered = await app.request(`/assistant/drafts/${draft.id}/send`, { method: 'POST', body: { confirmed: true, revision: 2 } });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.draft.status, 'sent');
  assert.deepEqual(delivered.body.draft.delivery.accepted, draft.to);
  const sending = (await app.snapshot()).outgoing;
  assert.equal(sending.length, 1);
  assert.equal(sending[0].mail.from, firstMailbox.email);
  assert.deepEqual(sending[0].mail.to, draft.to);
  assert.equal(sending[0].mail.text, edited.body.draft.body);
  assert.equal(sending[0].options.host, '192.0.2.17');
  assert.equal(sending[0].options.tls.servername, 'smtp.example.invalid');
  assert.equal(sending[0].options.requireTLS, true);
  assert.equal(sending[0].options.auth.user, firstMailbox.email);
  assert.equal(Object.hasOwn(sending[0].mail, 'html'), false, '普通邮件草稿仍发送已审核的纯文本');
  assert.equal((await app.request(`/assistant/drafts/${draft.id}/send`, { method: 'POST', body: { confirmed: true, revision: 2 } })).status, 200);
  assert.equal((await app.snapshot()).outgoing.length, 1, '重复确认只调用一次SMTP代码');

  const streamed = await app.chat(app.meetingText, 'synthetic-meeting-stream', { mailboxId: firstMailbox.id, sse: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.contentType, /text\/event-stream/);
  assert.ok(streamed.events.some((event) => event.type === 'tool_start' && event.name === 'create_feishu_meeting'));
  assert.ok(streamed.events.some((event) => event.type === 'tool_end' && event.name === 'create_feishu_meeting'));
  const completed = streamed.events.filter((event) => event.type === 'done');
  assert.equal(completed.length, 1);
  const meetingTool = completed[0].toolTrace.find((tool) => tool.name === 'create_feishu_meeting');
  assert.equal(meetingTool.result.ok, true, JSON.stringify(meetingTool.result));
  const meeting = meetingTool.result;
  const calendar = await app.request('/state');
  const event = calendar.body.events.find((item) => item.id === meeting.event.id);
  assert.ok(event);
  assert.equal(event.source, 'assistant');
  assert.equal(event.meetingUrl, meeting.meeting.url);
  assert.ok(meeting.draft.body.includes(event.meetingUrl));
  assert.match(meeting.draft.body, /北京时间/);
  assert.match(meeting.notice, /有效期不限制入会开始时间/);
  assert.equal(meeting.draft.status, 'pending');
  const beforeReplay = await app.snapshot();
  assert.equal(beforeReplay.reserves.length, 1);
  assert.equal(beforeReplay.outgoing.length, 1, '飞书建会与生成邀约期间不发送邮件');
  assert.equal(beforeReplay.credentialCalls, 1);
  const replayed = await app.chat(app.meetingText, 'synthetic-meeting-stream', { mailboxId: firstMailbox.id });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.toolTrace[0].result.draft.id, meeting.draft.id);
  const afterReplay = await app.snapshot();
  assert.equal(afterReplay.models.length, beforeReplay.models.length, 'SSE完成后的JSON重放不重调模型');
  assert.equal(afterReplay.reserves.length, 1);
  assert.equal((await app.request('/state')).body.events.filter((item) => item.id === event.id).length, 1);
  assert.equal((await app.request('/assistant/drafts')).body.drafts.filter((item) => item.status !== 'discarded').length, 2);
  assert.equal((await app.chat(app.mailText, 'synthetic-meeting-stream')).status, 409, '同请求编号不同消息不能重用');
  assert.equal((await app.request(`/assistant/drafts/${meeting.draft.id}/send`, { method: 'POST', body: { revision: 1 } })).status, 400);
  assert.equal((await app.snapshot()).outgoing.length, 1);
  const invited = await app.request(`/assistant/drafts/${meeting.draft.id}/send`, { method: 'POST', body: { confirmed: true, revision: 1 } });
  assert.equal(invited.body.draft.status, 'sent');
  const withInvitation = await app.snapshot();
  assert.equal(withInvitation.outgoing.length, 2);
  assert.deepEqual(withInvitation.outgoing[1].mail.to, ['guest@example.invalid', 'peer@example.invalid']);
  assert.equal(withInvitation.outgoing[1].mail.text, meeting.draft.body);
  const invitationHtml = withInvitation.outgoing[1].mail.html;
  assert.equal(typeof invitationHtml, 'string');
  const invitationAnchors = [...invitationHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  assert.equal(invitationAnchors.length, 1);
  assert.ok(invitationAnchors[0][0].includes(`href="${meeting.meeting.url}"`));
  assert.match(invitationAnchors[0][0], /target="_blank"/);
  assert.match(invitationAnchors[0][0], /rel="noopener noreferrer"/);
  assert.equal(invitationAnchors[0][1], meeting.meeting.url);
  assert.equal((await app.request(`/assistant/drafts/${meeting.draft.id}/send`, { method: 'POST', body: { confirmed: true, revision: 1 } })).status, 200);
  assert.equal((await app.snapshot()).outgoing.length, 2);

  const brief = await app.chat(app.briefText, 'synthetic-briefing-request');
  assert.equal(brief.status, 200);
  const evidence = brief.body.toolTrace.find((tool) => tool.name === 'get_email_briefing').result;
  assert.equal(evidence.range.days, 7);
  assert.equal(evidence.scope.source, 'saved_current_mailbox');
  assert.equal(evidence.scope.mailboxId, firstMailbox.id);
  assert.equal(evidence.scope.queriedLiveMailbox, false);
  assert.equal(evidence.scope.inboxCompleteness, 'unknown');
  assert.equal(evidence.overview.total, 1);
  assert.equal(evidence.emails[0].id, 'synthetic-email-0');
  assert.match(brief.body.reply, /本地已保存/);
  assert.match(brief.body.reply, /未同步邮件可能遗漏/);

  const activated = await app.request(`/mailboxes/${otherMailbox.id}/activate`, { method: 'POST' });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.syncStarted, false);
  assert.equal((await app.request('/assistant/drafts', { mailboxId: firstMailbox.id })).status, 409);
  assert.deepEqual((await app.request('/assistant/drafts')).body.drafts, []);
  assert.equal((await app.request(`/assistant/drafts/${draft.id}`)).status, 404);
  const second = await app.chat(app.secondText, 'synthetic-other-mailbox', { mailboxId: otherMailbox.id });
  assert.equal(second.status, 200);
  const secondDraft = second.body.toolTrace[0].result.draft;
  assert.equal(secondDraft.from, otherMailbox.email);
  assert.equal(secondDraft.mailboxId, otherMailbox.id);
  assert.equal((await app.request(`/assistant/drafts/${secondDraft.id}`, { token: app.tokens[1] })).status, 404);
  assert.deepEqual((await app.request('/assistant/drafts', { token: app.tokens[1] })).body.drafts, []);
  assert.equal((await app.request(`/mailboxes/${betaMailbox.id}/activate`, { method: 'POST' })).status, 404);
  assert.equal((await app.request('/state', { token: app.tokens[1] })).body.mailboxId, betaMailbox.id);
  assert.deepEqual((await app.request('/state', { token: app.tokens[1] })).body.events, []);
  assert.equal((await app.snapshot()).imapCalls, 0, '定时器和邮箱切换均没有触发真实IMAP');
  assert.equal((await app.request(`/mailboxes/${firstMailbox.id}/activate`, { method: 'POST' })).status, 200);

  await app.restart();
  const restored = await app.chat(app.meetingText, 'synthetic-meeting-stream');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.toolTrace[0].result.draft.id, meeting.draft.id);
  assert.equal((await app.request(`/assistant/drafts/${meeting.draft.id}`)).body.draft.status, 'sent');
  const restartedState = await app.snapshot();
  assert.equal(restartedState.models.length, 0, '进程重启后也从持久化请求恢复');
  assert.equal(restartedState.reserves.length, 0);
  assert.equal(restartedState.outgoing.length, 0);
  assert.equal(restartedState.imapCalls, 0);
  assert.equal((await app.request('/state')).body.events.length, 1);
  assert.equal((await app.request('/assistant/drafts')).body.drafts.filter((item) => item.status !== 'discarded').length, 2);
});

test('会议邀约 API 不会把外部提交的非 HTTPS 或含认证信息的链接渲染为 HTML 超链接', { timeout: 60_000 }, async (t) => {
  const app = await fixture(t);
  const [mailbox] = app.mailboxes;
  const file = path.join(app.directory, 'mailboxes', mailbox.id, 'calendar.json');
  const calendar = JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = new Date(Date.now() + 86400000).toISOString();
  const end = new Date(Date.now() + 90000000).toISOString();
  calendar.events.push({ id: 'external-meeting-event', title: '合成会议链接边界', start, end });
  fs.writeFileSync(file, JSON.stringify(calendar));
  const invalidUrls = ['javascript:alert("synthetic")', 'data:text/html,<b>synthetic</b>',
    'http://vc.feishu.cn/j/synthetic', 'https://synthetic:credential@vc.feishu.cn/j/synthetic'];
  for (const url of invalidUrls) {
    const body = `请核对会议链接：${url}`;
    const created = await app.request('/assistant/drafts', { method: 'POST', body: {
      kind: 'meeting_invitation', eventId: 'external-meeting-event',
      to: ['guest@example.invalid'], subject: '合成会议链接边界', body,
      meeting: { url, expiresAt: end, scheduledStart: start, scheduledEnd: end },
    } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const draft = created.body.draft;
    const sent = await app.request(`/assistant/drafts/${draft.id}/send`, {
      method: 'POST', body: { confirmed: true, revision: draft.revision },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.draft.status, 'sent');
    const outgoing = (await app.snapshot()).outgoing.at(-1).mail;
    assert.equal(outgoing.text, body);
    assert.doesNotMatch(outgoing.html || '', /<a\b/i, url);
    assert.doesNotMatch(outgoing.html || '', /<b\b/i, '正文中的 HTML 标签不能成为实际标记');
  }
  const snapshot = await app.snapshot();
  assert.equal(snapshot.outgoing.length, invalidUrls.length);
  assert.equal(snapshot.reserves.length, 0, '外部提交草稿不会调用飞书');
  assert.equal(snapshot.models.length, 0, '审核发送不调用模型');
  assert.equal(snapshot.imapCalls, 0);
});

test('iOS/shared HTTP: invitation review, deduplication, Web state visibility, preferences and private ICS isolation', {timeout:60000}, async t=>{
 const app=await fixture(t),[mailbox,,foreign]=app.mailboxes;
 const file=path.join(app.directory,'mailboxes',mailbox.id,'calendar.json');
 const calendar=JSON.parse(fs.readFileSync(file,'utf8'));
 calendar.events.push({id:'mobile-invitation-event',title:'合成邀请',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+90000000).toISOString(),source:'qq'});
 calendar.emails[0].createdEventIds=['mobile-invitation-event'];
 fs.writeFileSync(file,JSON.stringify(calendar));
 assert.equal((await app.request('/invitations/synthetic-email-0',{method:'PUT',token:null,body:{decision:'accepted'}})).status,401);
 assert.equal((await app.request('/invitations/synthetic-email-0',{method:'PUT',token:app.tokens[1],body:{decision:'accepted'}})).status,404);
 await app.request('/invitation-preferences',{method:'PUT',body:{autoReply:true,acceptedTemplate:'确认参加 {title}',declinedTemplate:'本次无法参加 {title}'}});
 assert.equal((await app.request('/state',{token:app.tokens[1]})).body.settings.invitationPreferences.autoReply,false);
 const first=await app.request('/invitations/synthetic-email-0',{method:'PUT',body:{decision:'accepted'}});
 assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.draft.status,'pending');
 assert.equal((await app.snapshot()).outgoing.length,0,'swipe alone never invokes SMTP');
 const again=await app.request('/invitations/synthetic-email-0',{method:'PUT',body:{decision:'accepted'}});
 assert.equal(again.body.draft.id,first.body.draft.id);
 assert.equal((await app.request('/state')).body.events.find(event=>event.id==='mobile-invitation-event').attendanceStatus,'accepted');
 const draft=first.body.draft;
 await app.request(`/assistant/drafts/${draft.id}/send`,{method:'POST',body:{confirmed:true,revision:draft.revision}});
 await app.request(`/assistant/drafts/${draft.id}/send`,{method:'POST',body:{confirmed:true,revision:draft.revision}});
 assert.equal((await app.snapshot()).outgoing.length,1);
 assert.equal((await app.request('/invitations')).body['synthetic-email-0'].delivery.status,'sent');
 assert.equal((await app.request('/invitations/synthetic-email-0',{method:'PUT',body:{decision:'pending'}})).status,409);
 assert.equal((await app.request('/calendar.ics',{token:null})).status,401);
 const subscription=await app.request('/calendar-sync/subscription',{method:'POST',body:{}});
 assert.equal(subscription.status,200);
 const url=subscription.body.path.replace('/api','');
 assert.equal((await app.request(`${url}&mailboxId=${foreign.id}`,{token:null})).status,403);
});


test('manual task creation/editing share ownership, title validation and completion state with Web', {timeout:60000}, async t=>{
 const app=await fixture(t);
 assert.equal((await app.request('/tasks',{token:null,method:'POST',body:{title:'合成待办'}})).status,401);
 assert.equal((await app.request('/tasks',{method:'POST',body:{title:'',dueAt:'invalid'}})).status,400);
 const created=await app.request('/tasks',{method:'POST',body:{title:'准备合成材料',dueAt:'2027-01-02',priority:'normal'}});
 assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.source,'manual');assert.match(created.body.dueAt,/18:00:00\+08:00/);
 assert.equal((await app.request(`/tasks/${created.body.id}`,{token:app.tokens[1],method:'PUT',body:{title:'越权修改'}})).status,404);
 assert.equal((await app.request(`/tasks/${created.body.id}`,{method:'PUT',body:{status:'done',dueAt:'invalid'}})).status,400);
 assert.equal((await app.request('/state')).body.tasks.find(row=>row.id===created.body.id).status,'pending');
 const edited=await app.request(`/tasks/${created.body.id}`,{method:'PUT',body:{title:'核对合成材料',description:'补充备注',status:'done'}});
 assert.equal(edited.body.title,'核对合成材料');assert.equal(edited.body.status,'done');
 const state=await app.request('/state');assert.equal(state.body.tasks.find(row=>row.id===created.body.id).title,'核对合成材料');
 assert.equal((await app.snapshot()).outgoing.length,0);
});
