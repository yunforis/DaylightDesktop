import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

const profile = { personal: { name: '合成候选人', email: 'candidate@example.invalid', age: 23 },
  education: [{ school: '合成上海大学', city: '上海', degree: '本科', graduationStatus: '已毕业' }],
  projects: [{ name: '云计算平台', description: 'Developed Kubernetes cloud computing project.' }], skills: ['Kubernetes'] };
const settings = { activeMailboxId: 'default', baseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-api-key', model: 'fixture-model',
  mailboxes: [{ id: 'default', provider: 'qq', email: 'hr@example.invalid', authorizationCode: 'synthetic-mail-code', fetchLimit: 15 },
    { id: 'secondary', provider: 'qq', email: 'second@example.invalid', authorizationCode: '', fetchLimit: 15 }] };
const originalEvent = { id: 'manual-existing', title: 'Existing unrelated event', start: '2030-04-01T09:00:00+08:00',
  end: '2030-04-01T10:00:00+08:00', allDay: false, source: 'manual' };

function pdf(text = 'Synthetic candidate resume. Kubernetes cloud computing project. Shanghai university.') {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  return Buffer.from(`${data}xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

function mime({ uid = 1, subject = 'Synthetic application', body = 'Please review the attached resume.', attachment = pdf(), inReplyTo = '' } = {}) {
  const headers = ['From: Synthetic Candidate <candidate@example.invalid>', `Subject: ${subject}`, `Message-ID: <incoming-${uid}@example.invalid>`,
    'Date: Wed, 14 Oct 2026 09:00:00 +0800', ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []), 'MIME-Version: 1.0'];
  const lines = attachment ? [...headers, 'Content-Type: multipart/mixed; boundary="recruitment-test"', '', '--recruitment-test',
    'Content-Type: text/plain; charset=utf-8', '', body, '--recruitment-test', 'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="synthetic-resume.pdf"', 'Content-Transfer-Encoding: base64', '',
    attachment.toString('base64'), '--recruitment-test--', ''] : [...headers, 'Content-Type: text/plain; charset=utf-8', '', body];
  return { uid, source: Buffer.from(lines.join('\r\n')).toString('base64') };
}

// The real Express server, MIME parser, PDF parser and file stores run in this worker.
// All remote transports are intercepted; only the parent makes HTTP requests to localhost.
async function serveFixture() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { default: dns } = await import('node:dns/promises');
  const { default: nodemailer } = await import('nodemailer');
  const { ImapFlow } = await import('imapflow');
  let inbox = workerData.inbox, answers = [], calls = [], reads = 0, rawReads = 0, outgoing = [];
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(dns, 'lookup', async () => ({ address: '192.0.2.10', family: 4 }));
  mock.method(nodemailer, 'createTransport', () => ({ async sendMail(mail) {
    outgoing.push(mail);
    return { accepted: [mail.to], rejected: [], messageId: `<sent-${outgoing.length}@example.invalid>` };
  } }));
  mock.method(ImapFlow.prototype, 'connect', async function () { reads++; this.mailbox = { exists: inbox.length, uidValidity: 42 }; });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'close', () => {});
  mock.method(ImapFlow.prototype, 'fetch', async function* (range, query) {
    const requested = String(range).split(',').map(Number);
    for (const message of inbox) {
      if (query.source && !requested.includes(message.uid)) continue;
      if (query.source) rawReads++;
      yield { uid: message.uid, internalDate: new Date(1791939600000 + message.uid * 1000),
        ...(query.source ? { source: Buffer.from(message.source, 'base64') } : {}) };
    }
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://model.example.invalid/')) throw new Error(`Unexpected external request: ${url}`);
    const request = JSON.parse(options.body);
    calls.push(request);
    if (!answers.length) throw new Error('No synthetic model response queued');
    const answer = answers.shift();
    if (answer.error) throw new Error(answer.error);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer), reasoning_content: 'PRIVATE_MODEL_REASONING' } }],
      usage: { prompt_tokens: 100, completion_tokens: 80 } }));
  });
  parentPort.on('message', (command) => {
    if (command.type === 'answers') answers.push(...command.values);
    if (command.type === 'inbox') inbox = command.values;
    parentPort.postMessage({ reads, rawReads, calls, outgoing, remainingAnswers: answers.length });
  });
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = listen.apply(this, args);
    server.once('listening', () => parentPort.postMessage({ port: server.address().port }));
    return server;
  });
  process.argv.push('--production');
  await import(workerData.indexUrl);
}

async function fixture(t, inbox = [mime()], directory) {
  if (!directory) {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    fs.mkdirSync(path.join(root, 'work'), { recursive: true });
    directory = fs.mkdtempSync(path.join(root, 'work', 'recruitment-api-test-'));
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings));
    fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify({ events: [originalEvent], tasks: [], emails: [], lastSync: null }));
    fs.writeFileSync(path.join(directory, 'traces.json'), '[]');
  }
  const worker = new Worker(`(${serveFixture.toString()})()`, { eval: true,
    workerData: { indexUrl: new URL('./index.js', import.meta.url).href, inbox },
    env: { ...process.env, PORT: '0', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_DISABLE_AUTH: '1' } });
  t.after(() => worker.terminate());
  const [{ port }] = await once(worker, 'message');
  const command = async (value) => { const result = once(worker, 'message'); worker.postMessage(value); return (await result)[0]; };
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = response.headers.get('content-type')?.includes('application/pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json();
    return { status: response.status, body: content, headers: response.headers };
  };
  return { directory, request, command, stop: () => worker.terminate(), answers: (values) => command({ type: 'answers', values }),
    state: async () => (await request('/api/state')).body, talent: async () => (await request('/api/recruitment')).body,
    counts: () => command({ type: 'counts' }) };
}

async function ingest(app) {
  await app.answers([{ isResume: true, summary: '合成求职简历', profile }]);
  const result = await app.request('/api/sync/qq', 'POST');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, []);
  return (await app.talent()).candidates[0];
}

test('招聘 API：真实 MIME/PDF 提取入库、原附件下载、重复同步跳过与跨邮箱保持', async (t) => {
  const app = await fixture(t);
  const candidate = await ingest(app);
  const state = await app.state();
  assert.equal(candidate.profile.personal.name, profile.personal.name);
  assert.equal(state.emails[0].category, 'resume');
  assert.equal(state.emails[0].recruitmentStatus, 'completed');
  assert.deepEqual(state.events, [originalEvent]);
  assert.equal(state.tasks.length, 0);
  const attachment = (await app.talent()).attachments[0];
  const download = await app.request(attachment.url);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, pdf());
  assert.match(download.headers.get('content-disposition'), /inline/);
  const before = await app.counts();
  const duplicate = await app.request('/api/sync/qq', 'POST');
  assert.equal(duplicate.body.duplicate, 1);
  const after = await app.counts();
  assert.equal(after.calls.length, before.calls.length);
  assert.equal(after.rawReads, before.rawReads);
  assert.equal((await app.talent()).candidates[0].versions.length, 1);
  assert.doesNotMatch(JSON.stringify((await app.talent()).traces), /PRIVATE_MODEL_REASONING|synthetic-api-key/);
  assert.equal((await app.request('/api/mailboxes/secondary/activate', 'POST')).status, 200);
  assert.equal((await app.talent()).candidates.length, 0);
  assert.equal((await app.request(`/api/recruitment/candidates/${candidate.id}`)).status, 404);
  assert.equal((await app.request(`/api/recruitment/attachments/${attachment.id}`)).status, 404);
  assert.equal((await app.request(`/api/recruitment/attachments/${attachment.id}?mailbox=missing`)).status, 404);
  assert.equal((await app.request('/api/recruitment/chat', 'POST', { message: 'stale operation' }, { 'X-Mailbox-Id': 'default' })).status, 409);
  // Original attachment links carry their mailbox and remain usable after switching.
  assert.deepEqual((await app.request(attachment.url)).body, pdf());
  const stored = JSON.parse(fs.readFileSync(path.join(app.directory, 'calendar.json'), 'utf8'));
  assert.deepEqual(stored.events, [originalEvent]);
  assert.equal(stored.emails.length, 1);
});

test('招聘 API：模型工具生成草稿、审核发送一次、来信改期先审核再变更日历', async (t) => {
  const app = await fixture(t);
  const candidate = await ingest(app);
  const initial = { start: '2030-04-02T14:00:00+08:00', end: '2030-04-02T15:00:00+08:00' };
  const moved = { start: '2030-04-03T15:00:00+08:00', end: '2030-04-03T16:00:00+08:00' };
  await app.answers([
    { action: 'tool', tool: 'get_candidate', arguments: { candidateId: candidate.id } },
    { action: 'tool', tool: 'calendar_availability', arguments: initial },
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id, ...initial,
      subject: '合成面试邀约', body: '您好，请参加面试。', meetingUrl: 'https://meet.example.invalid/synthetic' } },
    { action: 'answer', content: '已准备草稿，请审核后发送。' },
  ]);
  const chat = await app.request('/api/recruitment/chat', 'POST', { message: '给合成候选人生成4月2日面试邀约' });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const id = chat.body.interviewIds[0];
  assert.equal((await app.counts()).outgoing.length, 0);
  assert.deepEqual((await app.state()).events, [originalEvent]);
  const reviewedBody = 'HR审核后的完整正文。\n会议链接：https://meet.example.invalid/synthetic';
  const reviewed = await app.request(`/api/recruitment/interviews/${id}`, 'PUT', { subject: 'HR审核主题', body: reviewedBody });
  assert.equal(reviewed.status, 200);
  const sent = await app.request(`/api/recruitment/interviews/${id}/send`, 'POST');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.calendarStatus, 'saved');
  let counts = await app.counts();
  assert.equal(counts.outgoing.length, 1);
  assert.equal(counts.outgoing[0].to, 'candidate@example.invalid');
  assert.equal(counts.outgoing[0].text, reviewedBody);
  assert.equal(counts.outgoing[0].subject, 'HR审核主题');
  assert.equal((await app.request(`/api/recruitment/interviews/${id}/send`, 'POST')).status, 200);
  assert.equal((await app.counts()).outgoing.length, 1);
  const beforeReply = (await app.state()).events;
  assert.equal(beforeReply.length, 2);
  const oldEvent = beforeReply.find((event) => event.id === sent.body.eventId);
  assert.equal(oldEvent.start, initial.start);
  await app.command({ type: 'inbox', values: [mime(), mime({ uid: 2, subject: 'Re: Interview', attachment: null,
    inReplyTo: sent.body.messageId, body: 'Please move the interview to April 3, 15:00.' })] });
  await app.answers([{ kind: 'reschedule', summary: '候选人申请改期', ...moved, body: '您好，确认新的面试时间。' }]);
  const reply = await app.request('/api/sync/qq', 'POST');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.errors, []);
  assert.deepEqual((await app.state()).events, beforeReply, '候选人请求不直接改变日历');
  const recruitment = await app.talent();
  const draft = recruitment.interviews.find((item) => item.previousInterviewId === id);
  assert.equal(draft.kind, 'reschedule');
  assert.equal(draft.status, 'draft');
  const replyMessage = recruitment.messages.find((message) => message.emailId?.endsWith(':42:2'));
  assert.ok(recruitment.traces.some((trace) => trace.trace_id === replyMessage.traceId), '面试回信模型日志在招聘页可见');
  assert.equal((await app.counts()).outgoing.length, 1);
  assert.equal((await app.request(`/api/recruitment/interviews/${draft.id}`, 'PUT', { body: `${draft.body}\nHR已审核。` })).status, 200);
  const rescheduled = await app.request(`/api/recruitment/interviews/${draft.id}/send`, 'POST');
  assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.body));
  const events = (await app.state()).events;
  assert.equal(events.find((event) => event.id === oldEvent.id).status, 'cancelled');
  assert.equal(events.find((event) => event.id === rescheduled.body.eventId).start, moved.start);
  assert.equal(events.find((event) => event.id === oldEvent.id).replacementEventId, rescheduled.body.eventId);
  counts = await app.counts();
  assert.equal(counts.outgoing.length, 2);
  assert.equal(counts.outgoing[1].inReplyTo, '<incoming-2@example.invalid>');
  await app.stop();
  const restarted = await fixture(t, [], app.directory);
  assert.equal((await restarted.request(`/api/recruitment/interviews/${draft.id}/send`, 'POST')).status, 200);
  assert.equal((await restarted.counts()).outgoing.length, 0, '重启也不会重复发送');
});

test('招聘 API：飞书凭据保存但不回传；普通附件重试不丢失原日程与待办关联', async (t) => {
  const app = await fixture(t, [mime({ subject: 'Invoice document', attachment: pdf('Invoice subtotal and reference. This document is not a personal resume.') })]);
  const secret = 'synthetic-feishu-secret';
  const configured = await app.request('/api/settings', 'PUT', { feishu: { appId: 'cli_synthetic', appSecret: secret, ownerId: 'ou_synthetic' } });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.feishu.hasAppSecret, true);
  assert.equal(configured.body.feishu.configured, true);
  assert.doesNotMatch(JSON.stringify(configured.body), /synthetic-feishu-secret/);
  assert.doesNotMatch(JSON.stringify((await app.state()).settings), /synthetic-feishu-secret/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.directory, 'settings.json'), 'utf8')).feishu.appSecret, secret);
  await app.answers([{ error: 'Synthetic extraction temporarily unavailable' }, { isResume: false },
    { category: 'invoice', priority: 'normal', summary: '发票待核对',
      events: [{ title: 'Invoice review', start: '2030-05-01T10:00:00+08:00', end: '2030-05-01T11:00:00+08:00' }],
      tasks: [{ title: '核对发票', priority: 'normal' }] }]);
  const synced = await app.request('/api/sync/qq', 'POST');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.body.errors, []);
  const before = await app.state();
  assert.equal(before.emails[0].category, 'invoice');
  assert.equal(before.emails[0].eventIds.length, 1);
  assert.equal(before.emails[0].taskIds.length, 1);
  const attachment = (await app.talent()).attachments[0];
  assert.equal(attachment.status, 'failed');
  await app.answers([{ isResume: false, summary: '这是一份发票。', profile: null }]);
  const retried = await app.request(`/api/recruitment/attachments/${attachment.id}/retry`, 'POST');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const after = await app.state();
  assert.equal(after.emails.length, 1);
  assert.equal(after.emails[0].category, 'invoice');
  assert.deepEqual(after.emails[0].eventIds, before.emails[0].eventIds);
  assert.deepEqual(after.emails[0].taskIds, before.emails[0].taskIds);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(after.emails[0].attachments[0].status, 'not_resume');
  const calls = (await app.counts()).calls.length;
  assert.equal((await app.request('/api/sync/qq', 'POST')).body.duplicate, 1);
  assert.equal((await app.counts()).calls.length, calls);
});

test('招聘 API：未确定分类的附件重试失败结束日志，再次恢复只保存一封邮件', async (t) => {
  const app = await fixture(t, [mime({ subject: 'Unclassified PDF', attachment: pdf('A synthetic document whose purpose needs later classification.') })]);
  await app.answers([{ error: 'Synthetic attachment model failure' }, { error: 'Synthetic intent model failure' }]);
  const first = await app.request('/api/sync/qq', 'POST');
  assert.equal(first.status, 200);
  assert.equal(first.body.errors.length, 1);
  assert.equal((await app.state()).emails[0].recruitmentStatus, 'partial');
  const attachment = (await app.talent()).attachments[0];
  await app.answers([{ isResume: false, profile: null }, { error: 'Synthetic calendar model failure' }]);
  const failure = await app.request(`/api/recruitment/attachments/${attachment.id}/retry`, 'POST');
  assert.equal(failure.status, 500);
  const failedTrace = (await app.talent()).traces.find((trace) => trace.attachmentIds?.includes(attachment.id));
  assert.equal(failedTrace.status, 'failed', '失败后不能留下永远运行中的招聘日志');
  await app.answers([{ category: 'notice', priority: 'normal', summary: '普通通知', events: [], tasks: [] }]);
  const retry = await app.request(`/api/recruitment/attachments/${attachment.id}/retry`, 'POST');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const state = await app.state();
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].category, 'notice');
  assert.notEqual(state.emails[0].recruitmentStatus, 'partial');
  assert.deepEqual(state.events, [originalEvent]);
  const calls = (await app.counts()).calls.length;
  assert.equal((await app.request('/api/sync/qq', 'POST')).body.duplicate, 1);
  assert.equal((await app.counts()).calls.length, calls);
});
