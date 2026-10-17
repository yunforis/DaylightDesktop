import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/assistant-actions-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
const actions = await import('./assistant-actions.js');
const { runWithRequestContext } = await import('./request-context.js');
const { sendMailboxMessage } = await import('./agent.js');
const settings = { activeMailboxId: 'one', apiKey: 'invented-model-secret', mailboxes: [
  { id: 'one', email: 'sender@example.invalid', authorizationCode: 'invented-mail-secret', smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true },
  { id: 'two', email: 'other@example.invalid', authorizationCode: 'invented-other-secret', smtpHost: 'smtp.example.invalid', smtpPort: 465 },
] };
const input = () => ({ to: ['receiver@example.invalid'], subject: '提交合成报告', body: '您好，请按时提交报告，谢谢。' });
const create = (extra = {}) => actions.createAssistantDraft('one', { ...input(), ...extra }, settings);
const send = (draft, sendMail, extra = {}) => actions.sendAssistantDraft('one', draft.id, { revision: draft.revision, confirmed: true, ...extra }, settings, { sendMail });
const success = async (_settings, mail) => ({ messageId: mail.messageId, accepted: mail.to, rejected: [] });

beforeEach(() => {
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings));
  for (const mailbox of settings.mailboxes) {
    const folder = path.join(directory, 'mailboxes', mailbox.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'assistant-drafts.json'), JSON.stringify({ items: [] }));
    fs.writeFileSync(path.join(folder, 'calendar.json'), JSON.stringify({ events: [], tasks: [], emails: [] }));
  }
});

test('草稿持久化且不会发送；同一操作幂等，校验收件人与邮件头注入', async () => {
  const original = await create({ operationKey: 'draft-operation', to: ' Receiver@Example.invalid ; second@example.invalid,receiver@example.invalid' });
  assert.deepEqual(original.draft.to, ['receiver@example.invalid', 'second@example.invalid']);
  assert.equal(original.draft.status, 'pending');
  assert.equal(original.draft.revision, 1);
  assert.equal(original.draft.from, 'sender@example.invalid');
  assert.equal((await create({ operationKey: 'draft-operation', to: original.draft.to })).draft.id, original.draft.id);
  await assert.rejects(create({ operationKey: 'draft-operation', subject: '不同内容' }), /内容不一致/);
  assert.equal((await actions.listAssistantDrafts('one')).drafts.length, 1);
  assert.equal((await actions.listAssistantDrafts('two')).drafts.length, 0);
  for (const to of ['同事', 'a@example.invalid\r\nBcc:spy@example.invalid', ['ok@example.invalid', ''], ['Name <a@example.invalid>']]) {
    await assert.rejects(create({ to }), /邮箱/);
  }
  await assert.rejects(create({ subject: '主题\r\nBcc:spy@example.invalid' }), /单行/);
  await assert.rejects(create({ body: ' ' }), /正文/);
  const disk = fs.readFileSync(path.join(directory, 'mailboxes', 'one', 'assistant-drafts.json'), 'utf8');
  assert.doesNotMatch(disk, /invented-model-secret|invented-mail-secret/);
});

test('发送必须明确确认且审核版本匹配，修改后旧版本不能发出', async () => {
  const { draft } = await create();
  let calls = 0;
  const mail = async (...args) => { calls++; return success(...args); };
  await assert.rejects(send(draft, mail, { confirmed: false }), /确认发送真实邮件/);
  const edited = await actions.updateAssistantDraft('one', draft.id, { revision: 1, subject: '已审核合成报告' });
  assert.equal(edited.draft.revision, 2);
  await assert.rejects(send(draft, mail), /草稿已更新/);
  assert.equal(calls, 0);
  const sent = await send(edited.draft, mail);
  assert.equal(sent.draft.status, 'sent');
  assert.ok(sent.draft.sentAt);
  assert.equal(calls, 1);
  await send(draft, mail);
  assert.equal(calls, 1, '重复请求返回已发送回执');
  await assert.rejects(actions.updateAssistantDraft('one', draft.id, { revision: sent.draft.revision, body: '改写' }), /不能修改/);
});

test('并发点击先持久化 sending；第二次请求不能产生重复 SMTP', async () => {
  const { draft } = await create();
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const pending = send(draft, async (config, mail) => {
    calls++;
    started();
    await new Promise((resolve) => { release = resolve; });
    return success(config, mail);
  });
  await ready;
  const saved = await actions.getAssistantDraft('one', draft.id);
  assert.equal(saved.draft.status, 'sending');
  await assert.rejects(send(draft, success), /草稿已更新|不能修改/);
  release();
  assert.equal((await pending).draft.status, 'sent');
  assert.equal(calls, 1);
});

test('部分收件人接受时列出回执并禁止整封重发', async () => {
  const { draft } = await create({ to: ['first@example.invalid', 'second@example.invalid'] });
  const result = await send(draft, async () => ({ accepted: ['first@example.invalid'], rejected: ['second@example.invalid'], messageId: '<partial@example.invalid>' }));
  assert.equal(result.draft.status, 'unknown');
  assert.equal(result.draft.canRetry, false);
  assert.deepEqual(result.draft.delivery.accepted, ['first@example.invalid']);
  assert.match(result.draft.error, /部分收件人/);
  await assert.rejects(send(result.draft, () => assert.fail('不可重发')), /不能修改/);
});

test('认证失败可审核重试，DATA 超时保留未知且隐藏凭据', async () => {
  const { draft } = await create();
  const rejected = await send(draft, async () => { throw Object.assign(new Error('auth invented-mail-secret invented-model-secret'), { code: 'EAUTH', command: 'AUTH' }); });
  assert.equal(rejected.draft.status, 'failed');
  assert.equal(rejected.draft.canRetry, true);
  assert.doesNotMatch(rejected.draft.error, /invented-mail-secret|invented-model-secret/);
  const unknown = await send(rejected.draft, async () => { throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT', command: 'DATA' }); });
  assert.equal(unknown.draft.status, 'unknown');
  assert.equal(unknown.draft.canRetry, false);
  await assert.rejects(send(unknown.draft, () => assert.fail('不可重发')), /不能修改/);
});

test('SMTP 返回后存储失败依然保留发送屏障，恢复读取不会再次发信', async () => {
  const { draft } = await create();
  const file = path.join(directory, 'mailboxes', 'one', 'assistant-drafts.json');
  const result = await send(draft, async (config, mail) => {
    // Simulate a failed durable receipt commit after SMTP success.
    fs.writeFileSync(file, '{');
    return success(config, mail);
  });
  assert.equal(result.draft.status, 'unknown');
  assert.match(result.draft.error, /回执保存失败/);
  // Reconstruct the pre-SMTP marker as after recovering the previous atomic file.
  fs.writeFileSync(file, JSON.stringify({ items: [{ ...result.draft, status: 'sending' }] }));
  await assert.rejects(send(result.draft, () => assert.fail('不可重发')), /不能修改/);
});

test('发送前校验发件邮箱变化、SMTP缺失与草稿放弃', async () => {
  const { draft } = await create();
  const changed = { ...settings, mailboxes: settings.mailboxes.map((mailbox) => ({ ...mailbox, email: 'changed@example.invalid' })) };
  await assert.rejects(actions.sendAssistantDraft('one', draft.id, { revision: 1, confirmed: true }, changed, { sendMail: () => assert.fail('不可发送') }), /地址已变化/);
  const missing = { ...settings, mailboxes: settings.mailboxes.map((mailbox) => ({ ...mailbox, authorizationCode: '' })) };
  await assert.rejects(actions.sendAssistantDraft('one', draft.id, { revision: 1, confirmed: true }, missing), /SMTP/);
  const discarded = await actions.discardAssistantDraft('one', draft.id, { revision: 1 });
  assert.equal(discarded.draft.status, 'discarded');
  await assert.rejects(send(discarded.draft, () => assert.fail('不可发送')), /不能修改/);
});

test('跨邮箱与跨用户无法读取或发送他人的草稿', async () => {
  const { draft } = await create();
  await assert.rejects(actions.getAssistantDraft('two', draft.id), (error) => error.status === 404);
  await assert.rejects(actions.getAssistantDraft('../one', draft.id), (error) => error.status === 404);
  await runWithRequestContext({ userId: 'another-user' }, async () => {
    await assert.rejects(actions.getAssistantDraft('one', draft.id), (error) => error.status === 404);
    await assert.rejects(send(draft, () => assert.fail('不可发送')), (error) => error.status === 404);
  });
});

test('会议邀约链接、过期、已改动或已取消的日程在 SMTP 前拦截', async () => {
  const start = new Date(Date.now() + 86400000).toISOString();
  const end = new Date(Date.now() + 90000000).toISOString();
  const meeting = { url: 'https://vc.feishu.cn/j/fixture', expiresAt: end, scheduledStart: start, scheduledEnd: end };
  const { draft } = await create({ kind: 'meeting_invitation', body: `请参会 ${meeting.url}`, eventId: 'meeting-event', meeting });
  const file = path.join(directory, 'mailboxes', 'one', 'calendar.json');
  fs.writeFileSync(file, JSON.stringify({ events: [{ id: 'meeting-event', start, end, status: 'cancelled' }] }));
  await assert.rejects(send(draft, () => assert.fail('不可发送')), /取消或删除/);
  fs.writeFileSync(file, JSON.stringify({ events: [{ id: 'meeting-event', start: end, end }] }));
  await assert.rejects(send(draft, () => assert.fail('不可发送')), /时间已变化/);
  fs.writeFileSync(file, JSON.stringify({ events: [{ id: 'meeting-event', start, end }] }));
  const edited = await actions.updateAssistantDraft('one', draft.id, { revision: 1, body: '删除链接' });
  await assert.rejects(send(edited.draft, () => assert.fail('不可发送')), /缺少真实会议链接/);
});

test('会议邀约以审核后的中文正文发送纯文本与 HTML MIME，仅真实会议链接可点击且重复确认不重发', async (t) => {
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
  t.mock.method(dns, 'lookup', async () => ({ address: '192.0.2.30', family: 4 }));
  let calls = 0;
  let outgoing;
  let parsed;
  let raw;
  t.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail(mail) {
      calls++;
      outgoing = mail;
      const info = await stream.sendMail(mail);
      raw = info.message.toString('utf8');
      parsed = await simpleParser(info.message);
      return { ...info, accepted: mail.to, rejected: [] };
    },
    close() {},
  }));
  const start = new Date(Date.now() + 86400000).toISOString();
  const end = new Date(Date.now() + 90000000).toISOString();
  const meeting = { url: 'https://vc.feishu.cn/j/fixture?token=synthetic&source=daylight',
    expiresAt: end, scheduledStart: start, scheduledEnd: end };
  fs.writeFileSync(path.join(directory, 'mailboxes', 'one', 'calendar.json'),
    JSON.stringify({ events: [{ id: 'meeting-event', start, end }] }));
  const original = await create({ kind: 'meeting_invitation', subject: '原始会议草稿',
    body: `原始待修改正文 ${meeting.url}`, eventId: 'meeting-event', meeting });
  const reviewedBody = ['您好：', '', '已审核的项目会议，A & B。',
    '<b>这段不是粗体</b> <script>alert("合成内容")</script>',
    `飞书会议链接：${meeting.url}`, `再次附上：${meeting.url}`, '',
    '其他说明网址 https://example.invalid/reference 保持原文。', '期待您的参加。'].join('\r\n');
  const edited = await actions.updateAssistantDraft('one', original.draft.id, {
    revision: original.draft.revision, subject: '已审核的中文会议邀约', body: reviewedBody,
  });
  await assert.rejects(send(original.draft, sendMailboxMessage), /草稿已更新/);
  assert.equal(calls, 0);
  const sent = await send(edited.draft, sendMailboxMessage);
  assert.equal(sent.draft.status, 'sent');
  assert.equal(calls, 1);
  assert.equal(outgoing.text, reviewedBody, '纯文本正文与审核内容完全相同');
  assert.equal(parsed.text, reviewedBody.replace(/\r\n/g, '\n'));
  assert.equal(parsed.subject, '已审核的中文会议邀约');
  assert.match(raw, /Content-Type: multipart\/alternative;/i);
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/i);
  assert.match(raw, /Content-Type: text\/html; charset=utf-8/i);
  assert.equal(parsed.html, outgoing.html);
  const escapedUrl = 'https://vc.feishu.cn/j/fixture?token=synthetic&amp;source=daylight';
  const anchors = [...parsed.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  assert.equal(anchors.length, 2, '仅持久化会议链接的两次出现生成超链接');
  for (const [anchor, label] of anchors) {
    assert.ok(anchor.includes(`href="${escapedUrl}"`));
    assert.match(anchor, /target="_blank"/);
    assert.match(anchor, /rel="noopener noreferrer"/);
    assert.equal(label, escapedUrl);
  }
  assert.match(parsed.html, /已审核的项目会议，A &amp; B。/);
  assert.match(parsed.html, /&lt;b&gt;这段不是粗体&lt;\/b&gt;/);
  assert.match(parsed.html, /&lt;script&gt;alert\((?:&quot;|&#34;)合成内容(?:&quot;|&#34;)\)&lt;\/script&gt;/);
  assert.match(parsed.html, /其他说明网址 https:\/\/example\.invalid\/reference 保持原文。/);
  assert.doesNotMatch(parsed.html, /<script\b|<b\b|原始待修改正文/);
  await send(edited.draft, () => assert.fail('重复确认不可再次进入 SMTP'));
  assert.equal(calls, 1);
});

test('真实 SMTP 发送路径接受多收件人并保留部分拒绝回执，使用 TLS 并关闭传输', async (t) => {
  t.mock.method(dns, 'lookup', async () => ({ address: '192.0.2.30', family: 4 }));
  let closed = 0;
  let options;
  let message;
  t.mock.method(nodemailer, 'createTransport', (config) => {
    options = config;
    return { async sendMail(mail) { message = mail; return { accepted: [mail.to[0]], rejected: [mail.to[1]], messageId: '<fixture@example.invalid>' }; }, close() { closed++; } };
  });
  const recipients = ['one@example.invalid', 'two@example.invalid'];
  const info = await sendMailboxMessage({ ...settings, ...settings.mailboxes[0] }, { to: recipients, subject: '合成主题', text: '合成正文' });
  assert.deepEqual(message.to, recipients);
  assert.equal(message.from, 'sender@example.invalid');
  assert.deepEqual(info.rejected, [recipients[1]]);
  assert.equal(options.tls.servername, 'smtp.example.invalid');
  assert.equal(options.socketTimeout, 30_000);
  assert.equal(closed, 1);
});
