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

function mime({ uid = 1, subject = 'Synthetic application', body = 'Please review the attached resume.', attachment = pdf(), inReplyTo = '',
  from = 'candidate@example.invalid' } = {}) {
  const headers = [`From: Synthetic Candidate <${from}>`, `Subject: ${subject}`, `Message-ID: <incoming-${uid}@example.invalid>`,
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
  let inbox = workerData.inbox, answers = [], calls = [], reads = 0, rawReads = 0, outgoing = [], smtpErrors = [];
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(dns, 'lookup', async () => ({ address: '192.0.2.10', family: 4 }));
  mock.method(nodemailer, 'createTransport', () => ({ async sendMail(mail) {
    outgoing.push(mail);
    if (smtpErrors.length) {
      const failure = smtpErrors.shift();
      throw typeof failure === 'string' ? new Error(failure) : Object.assign(new Error(failure.message), failure);
    }
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
    if (command.type === 'smtpErrors') smtpErrors.push(...command.values);
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
    fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
      postgres: { enabled: false },
      redis: { enabled: false }, mq: { enabled: false }, oss: { enabled: false },
      auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'test', adminEmails: [] },
    }, null, 2));
  }
  const worker = new Worker(`(${serveFixture.toString()})()`, { eval: true,
    workerData: { indexUrl: new URL('./index.js', import.meta.url).href, inbox },
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key))),
      PORT: '0', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_REQUIRE_AUTH: '0' } });
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
  // Workbench-scoped recruitment may explicitly access an owned mailbox after the top bar switches.
  const scoped = await app.request(`/api/recruitment/candidates/${candidate.id}`, 'GET', undefined, { 'X-Mailbox-Id': 'default' });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.id, candidate.id);
  assert.equal((await app.request('/api/recruitment/chat', 'POST', { message: 'unowned mailbox operation' }, { 'X-Mailbox-Id': 'missing' })).status, 409);
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

test('招聘 API：示例邀约审核后走SMTP、失败可重试，清示例保留实发记录并能处理后续来信', async (t) => {
  const app = await fixture(t, []);
  const imported = await app.request('/api/recruitment/demo', 'POST');
  assert.equal(imported.status, 200);
  assert.equal(imported.body.added, 3);
  const candidate = imported.body.candidates[0];
  const initial = { start: '2030-04-02T14:00:00+08:00', end: '2030-04-02T15:00:00+08:00' };
  const moved = { start: '2030-04-03T15:00:00+08:00', end: '2030-04-03T16:00:00+08:00' };
  await app.answers([
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id, ...initial,
      subject: '【预置示例】合成面试邀约', body: '您好，请参加面试。\n（注意：当前为预置示例，仅用于演示，不会真实发送邮件）', meetingUrl: '12312312' } },
    { action: 'answer', content: '草稿已准备，请审核收件人和正文。' },
  ]);
  const chat = await app.request('/api/recruitment/chat', 'POST', { message: '生成合成候选人的面试草稿' });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const id = chat.body.interviewIds[0];
  assert.equal((await app.counts()).outgoing.length, 0);
  const unconfirmed = await app.request(`/api/recruitment/interviews/${id}/send`, 'POST');
  assert.equal(unconfirmed.status, 500);
  assert.match(unconfirmed.body.error, /预置|确认|审核/);
  assert.equal((await app.counts()).outgoing.length, 0);
  const reviewed = await app.request(`/api/recruitment/interviews/${id}`, 'PUT', {
    to: 'reviewed-recipient@daylight-test.com', confirmDemoSend: true,
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.subject, '合成面试邀约');
  assert.doesNotMatch(reviewed.body.body, /预置示例|不会真实发送/);
  assert.match(reviewed.body.body, /12312312/);
  assert.equal(reviewed.body.source, 'demo');
  assert.equal((await app.counts()).outgoing.length, 0, '保存清理后的审核稿不发信');
  await app.command({ type: 'smtpErrors', values: [{ message: 'Synthetic SMTP authentication rejected', command: 'AUTH', code: 'EAUTH' }] });
  const failure = await app.request(`/api/recruitment/interviews/${id}/send`, 'POST', { confirmDemoSend: true });
  assert.equal(failure.status, 500);
  assert.match(failure.body.error, /SMTP authentication rejected/);
  const failed = (await app.talent()).interviews.find((item) => item.id === id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.source, 'demo');
  assert.deepEqual((await app.state()).events, [originalEvent]);
  const sent = await app.request(`/api/recruitment/interviews/${id}/send`, 'POST', { confirmDemoSend: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.source, 'manual');
  assert.equal(sent.body.originalSource, 'demo');
  let counts = await app.counts();
  assert.equal(counts.outgoing.length, 2, '一次失败尝试后再次向SMTP提交');
  assert.equal(counts.outgoing[1].from, 'hr@example.invalid');
  assert.equal(counts.outgoing[1].to, reviewed.body.to);
  assert.equal(counts.outgoing[1].subject, reviewed.body.subject);
  assert.equal(counts.outgoing[1].text, reviewed.body.body);
  assert.equal((await app.request(`/api/recruitment/interviews/${id}/send`, 'POST')).status, 200);
  assert.equal((await app.counts()).outgoing.length, 2, '成功后重复点击不会再次提交SMTP');
  assert.equal((await app.request('/api/demo', 'DELETE')).status, 200);
  const remaining = await app.talent();
  assert.deepEqual(remaining.candidates.map((item) => item.id), [candidate.id]);
  assert.equal(remaining.candidates[0].source, 'demo', '人才资料继续显示预置来源');
  assert.ok(remaining.interviews.some((item) => item.id === id && item.status === 'sent'));
  const attachment = remaining.attachments.find((item) => item.candidateId === candidate.id);
  assert.ok(attachment, '实发邀约保留候选人简历附件');
  assert.equal((await app.request(attachment.url)).status, 200);
  const stateAfterClear = await app.state();
  assert.ok(stateAfterClear.emails.some((item) => candidate.versions.some((version) => version.emailId === item.id)), '实发邀约保留简历来源邮件');
  assert.equal(stateAfterClear.events.length, 2);
  assert.deepEqual(stateAfterClear.events.find((item) => item.id === originalEvent.id), originalEvent);
  assert.equal(stateAfterClear.events.find((item) => item.id === sent.body.eventId).source, 'recruitment');
  const beforeReply = stateAfterClear.events;
  await app.command({ type: 'inbox', values: [mime({ uid: 2, subject: 'Re: Interview', attachment: null,
    from: reviewed.body.to, inReplyTo: sent.body.messageId, body: 'Please move the interview to April 3, 15:00.' })] });
  await app.answers([{ kind: 'reschedule', summary: '合成候选人请求改期', ...moved, body: '您好，确认新的面试时间。' }]);
  const synced = await app.request('/api/sync/qq', 'POST');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.body.errors, []);
  assert.deepEqual((await app.state()).events, beforeReply);
  const draft = (await app.talent()).interviews.find((item) => item.previousInterviewId === id);
  assert.equal(draft.kind, 'reschedule');
  assert.equal(draft.source, 'manual');
  assert.equal(draft.to, reviewed.body.to);
  const rescheduled = await app.request(`/api/recruitment/interviews/${draft.id}/send`, 'POST');
  assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.body));
  assert.equal(rescheduled.body.status, 'sent');
  counts = await app.counts();
  assert.equal(counts.outgoing.length, 3);
  assert.equal(counts.outgoing[2].to, reviewed.body.to);
  assert.equal(counts.outgoing[2].inReplyTo, '<incoming-2@example.invalid>');
  const events = (await app.state()).events;
  assert.equal(events.find((item) => item.id === sent.body.eventId).status, 'cancelled');
  assert.equal(events.find((item) => item.id === rescheduled.body.eventId).previousEventId, sent.body.eventId);
  await app.stop();
  const restarted = await fixture(t, [], app.directory);
  assert.equal((await restarted.request(`/api/recruitment/interviews/${draft.id}/send`, 'POST')).status, 200);
  assert.equal((await restarted.counts()).outgoing.length, 0, '清示例及重启后仍保留发送成功状态');
});

test('招聘 API：模糊SMTP错误保留unknown，重复请求及重启均不再次发送', async (t) => {
  const app = await fixture(t);
  const candidate = await ingest(app);
  await app.answers([
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id,
      start: '2030-04-02T14:00:00+08:00', end: '2030-04-02T15:00:00+08:00',
      subject: '合成面试邀约', body: '您好，请参加面试。' } },
    { action: 'answer', content: '请审核草稿。' },
  ]);
  const chat = await app.request('/api/recruitment/chat', 'POST', { message: '生成面试草稿' });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const id = chat.body.interviewIds[0];
  await app.command({ type: 'smtpErrors', values: ['Synthetic SMTP connection lost without delivery receipt'] });
  const route = `/api/recruitment/interviews/${id}/send`;
  const failure = await app.request(route, 'POST');
  assert.equal(failure.status, 500);
  assert.match(failure.body.error, /connection lost/);
  assert.equal((await app.talent()).interviews.find(item => item.id === id).status, 'unknown');
  assert.equal((await app.counts()).outgoing.length, 1);
  assert.deepEqual((await app.state()).events, [originalEvent]);
  assert.equal((await app.request(route, 'POST')).status, 500);
  assert.equal((await app.talent()).interviews.find(item => item.id === id).status, 'unknown');
  assert.equal((await app.counts()).outgoing.length, 1, '模糊失败后再次点击不提交SMTP');
  await app.stop();
  const restarted = await fixture(t, [], app.directory);
  assert.equal((await restarted.request(route, 'POST')).status, 500);
  assert.equal((await restarted.talent()).interviews.find(item => item.id === id).status, 'unknown');
  assert.equal((await restarted.counts()).outgoing.length, 0, '重启仍从持久状态阻断发送');
  assert.deepEqual((await restarted.state()).events, [originalEvent]);
});

test('招聘 API：飞书凭据保存但不回传；普通附件重试不丢失原日程与待办关联', async (t) => {
  const app = await fixture(t, [mime({ subject: 'Project document', attachment: pdf('Synthetic project document for review. This document is not a personal resume.') })]);
  const secret = 'synthetic-feishu-secret';
  const configured = await app.request('/api/settings', 'PUT', { feishu: { appId: 'cli_synthetic', appSecret: secret, ownerId: 'ou_synthetic' } });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.feishu.hasAppSecret, true);
  assert.equal(configured.body.feishu.configured, true);
  assert.doesNotMatch(JSON.stringify(configured.body), /synthetic-feishu-secret/);
  assert.doesNotMatch(JSON.stringify((await app.state()).settings), /synthetic-feishu-secret/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.directory, 'settings.json'), 'utf8')).feishu.appSecret, secret);
  await app.answers([{ error: 'Synthetic extraction temporarily unavailable' }, { isResume: false },
    { category: 'notice', priority: 'normal', summary: '项目资料待核对',
      events: [{ title: 'Document review', start: '2030-05-01T10:00:00+08:00', end: '2030-05-01T11:00:00+08:00' }],
      tasks: [{ title: '核对项目资料', priority: 'normal' }] }]);
  const synced = await app.request('/api/sync/qq', 'POST');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.body.errors, []);
  const before = await app.state();
  assert.equal(before.emails[0].category, 'notice');
  assert.equal(before.emails[0].eventIds.length, 1);
  assert.equal(before.emails[0].taskIds.length, 1);
  const attachment = (await app.talent()).attachments[0];
  assert.equal(attachment.status, 'failed');
  await app.answers([{ isResume: false, summary: '这是一份项目资料。', profile: null }]);
  const retried = await app.request(`/api/recruitment/attachments/${attachment.id}/retry`, 'POST');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const after = await app.state();
  assert.equal(after.emails.length, 1);
  assert.equal(after.emails[0].category, 'notice');
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

test('招聘 API：工作台绑定的非活动邮箱可以读取，未拥有的邮箱仍拒绝', async (t) => {
  const app = await fixture(t, []);
  const bound = await app.request('/api/recruitment', 'GET', undefined, { 'X-Mailbox-Id': 'secondary' });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.mailboxId, 'secondary');
  const missing = await app.request('/api/recruitment', 'GET', undefined, { 'X-Mailbox-Id': 'missing-box' });
  assert.equal(missing.status, 409);
});
