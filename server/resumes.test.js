import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

fs.mkdirSync('work', { recursive: true });
process.env.DAYLIGHT_DATA_DIR = fs.mkdtempSync(path.resolve('work/resumes-test-'));
const { processEmails, importEmail, readMailboxEmails } = await import('./agent.js');
const { processRecruitmentEmail } = await import('./resumes.js');
const { readRecruitment } = await import('./recruitment-store.js');
const { createTraceRecorder } = await import('./traces.js');
const settings = { baseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-resume-key', model: 'fixture-model' };
const emptyStore = () => ({ events: [], tasks: [], emails: [] });
const profile = { personal: { name: 'Synthetic Applicant', email: 'applicant@example.invalid', age: 23 },
  education: [{ school: 'Synthetic Shanghai University', city: '上海', degree: '本科', graduationStatus: '已毕业' }],
  projects: [{ name: 'Cloud scheduler', description: 'Developed Kubernetes cloud computing project.' }], skills: ['Kubernetes'] };
function pdf(text = 'Synthetic Applicant resume. Cloud computing project. Shanghai University.') {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
function mail(attachments, id = randomUUID()) {
  const email = { id, subject: 'Synthetic application', sender: 'Sender <sender@example.invalid>', body: 'PRIVATE_SYNTHETIC_RESUME_BODY', receivedAt: new Date().toISOString() };
  Object.defineProperty(email, '_pdfAttachments', { value: attachments.map(([filename, content]) => ({ filename, content, contentType: 'application/pdf' })) });
  return email;
}
function model(t, answer) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /^https:\/\/model\.example\.invalid/);
    const request = JSON.parse(options.body); calls++;
    const value = typeof answer === 'function' ? answer(request, calls) : answer;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value), reasoning_content: 'PRIVATE_REASONING' } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }));
  });
  return () => calls;
}
async function run(mailboxId, store, emails, recorder, fallback = async () => ({ category: 'notice', events: [], tasks: [] })) {
  return processEmails(store, emails, fallback, 'qq', { recorder, handleSpecialEmail: (email, context) => processRecruitmentEmail(mailboxId, email, settings, context) });
}

test('PDF 简历走真实解析和模型结构化，保存来源及版本，不入历/待办且重复同步不提取', async (t) => {
  const calls = model(t, { isResume: true, profile, summary: '合成求职简历' });
  const mailbox = randomUUID(), store = emptyStore(), recorder = createTraceRecorder({ settings });
  const email = mail([['resume.pdf', pdf()]]);
  const result = await run(mailbox, store, [email], recorder, () => assert.fail('不能进入普通日程提取'));
  assert.equal(result.errors.length, 0);
  assert.equal(store.emails[0].category, 'resume');
  assert.equal(store.emails[0].recruitmentStatus, 'completed');
  assert.equal(store.events.length + store.tasks.length, 0);
  assert.equal(readRecruitment(mailbox).candidates.length, 1);
  assert.equal(readRecruitment(mailbox).candidates[0].versions.length, 1);
  assert.ok(readRecruitment(mailbox).attachments[0].pages[0].text.includes('Synthetic Applicant'));
  const duplicate = await run(mailbox, store, [{ id: email.id, receivedAt: email.receivedAt }], recorder);
  assert.equal(duplicate.duplicate, 1); assert.equal(calls(), 1);
  const logs = JSON.stringify(recorder.traces);
  assert.doesNotMatch(logs, /PRIVATE_SYNTHETIC_RESUME_BODY|PRIVATE_REASONING|applicant@example.invalid/);
  assert.equal(recorder.traces[0].llm_tokens_in, 100);
});

test('多附件部分失败保留成功版本，最近邮件占位可从本地PDF重试且不重复版本', async (t) => {
  let retry = false;
  const calls = model(t, (request) => {
    const input = JSON.parse(request.messages.at(-1).content);
    if (input.filename === 'second.pdf' && !retry) return { isResume: true, profile: null };
    return { isResume: true, profile };
  });
  const mailbox = randomUUID(), store = emptyStore(), recorder = createTraceRecorder({ settings });
  const email = mail([['first.pdf', pdf()], ['second.pdf', pdf()]]);
  const result = await run(mailbox, store, [email], recorder);
  assert.equal(result.errors.length, 1); assert.equal(store.emails[0].recruitmentStatus, 'partial');
  assert.equal(readRecruitment(mailbox).candidates[0].versions.length, 1);
  retry = true;
  await run(mailbox, store, [{ id: email.id, receivedAt: email.receivedAt }], recorder);
  assert.equal(calls(), 3); assert.equal(store.emails.length, 1);
  assert.equal(store.emails[0].recruitmentStatus, 'completed');
  assert.equal(readRecruitment(mailbox).candidates[0].versions.length, 2);
  assert.equal(recorder.traces.length, 1); assert.equal(recorder.traces[0].attempts.length, 2);
});

test('普通 PDF 保留附件但不会入人才库，继续现有邮件流程', async (t) => {
  model(t, { isResume: false, profile: null, summary: '发票' });
  const mailbox = randomUUID(), store = emptyStore();
  await run(mailbox, store, [mail([['invoice.pdf', pdf('Invoice subtotal and payment reference. This is not a resume.')]])]);
  assert.equal(readRecruitment(mailbox).candidates.length, 0);
  assert.equal(store.emails[0].category, 'notice');
  assert.equal(store.emails[0].attachments[0].status, 'not_resume');
});

test('损坏的求职 PDF 保留失败状态，模型误给求职日程也不应用', async (t) => {
  model(t, { isResume: true });
  const store = emptyStore(), mailbox = randomUUID();
  await run(mailbox, store, [mail([['broken.pdf', Buffer.from('broken PDF')]])]);
  assert.equal(store.emails[0].recruitmentStatus, 'partial');
  assert.equal(readRecruitment(mailbox).attachments[0].status, 'failed');
  const record = importEmail(store, mail([]), { category: 'resume', summary: '求职', events: [{ title: '不该执行', start: 'invalid' }], tasks: [{ title: '也不执行' }] }, 'qq');
  assert.equal(store.events.length + store.tasks.length, 0);
  assert.equal(record.category, 'resume');
});

test('真实 MIME 读取保留非枚举 PDF 和 In-Reply-To，邮件 JSON 不含 Buffer', async () => {
  const content = pdf();
  const source = Buffer.from(['From: Applicant <applicant@example.invalid>', 'Subject: Application', 'In-Reply-To: <interview@example.invalid>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="synthetic"', '', '--synthetic', 'Content-Type: text/plain; charset=utf-8', '', 'Attached resume.',
    '--synthetic', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="resume.pdf"', 'Content-Transfer-Encoding: base64', '', content.toString('base64'), '--synthetic--', ''].join('\r\n'));
  const client = { mailbox: { exists: 1, uidValidity: 1 }, async connect() {}, async getMailboxLock() { return { release() {} }; }, async logout() {},
    async *fetch(range, query) { yield { uid: 1, internalDate: new Date(), ...(query.source ? { source } : {}) }; } };
  const [email] = await readMailboxEmails({ email: 'mailbox@example.invalid', fetchLimit: 1 }, { clientFactory: () => client });
  assert.equal(email._pdfAttachments.length, 1); assert.equal(email.inReplyTo, '<interview@example.invalid>');
  assert.deepEqual(email._pdfAttachments[0].content, content);
  assert.doesNotMatch(JSON.stringify(email), /Buffer|_pdfAttachments/);
});

test('不确定附件重试识别为普通PDF，只替换原邮件一次并结束重试状态', async (t) => {
  const mailbox = randomUUID(), store = emptyStore();
  let succeeds = false;
  const calls = model(t, () => succeeds ? { isResume: false, summary: '非简历PDF' } : { invalid: true });
  const email = mail([['invoice.pdf', pdf()]]);
  await run(mailbox, store, [email]);
  assert.equal(store.emails[0].recruitmentStatus, 'partial');
  succeeds = true;
  await run(mailbox, store, [{ id: email.id, receivedAt: email.receivedAt }]);
  assert.equal(store.emails.length, 1);
  assert.equal(store.emails[0].category, 'notice');
  assert.equal(store.emails[0].recruitmentStatus, 'not_resume');
  const before = calls();
  const result = await run(mailbox, store, [{ id: email.id, receivedAt: email.receivedAt }]);
  assert.equal(result.duplicate, 1); assert.equal(calls(), before);
});
