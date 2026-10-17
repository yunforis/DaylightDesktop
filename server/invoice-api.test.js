import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

const settings = {
  activeMailboxId: 'default', baseUrl: 'https://model.example.invalid/v1',
  apiKey: 'synthetic-invoice-model-key', model: 'fixture-model',
  mailboxes: [
    { id: 'default', provider: 'qq', email: 'invoices@example.invalid', authorizationCode: 'synthetic-mail-code', fetchLimit: 15 },
    { id: 'secondary', provider: 'qq', email: 'second@example.invalid', authorizationCode: '', fetchLimit: 15 },
  ],
};

function pdf() {
  const lines = [
    'SYNTHETIC ELECTRONIC INVOICE. Invoice Number 00001234.',
    'Seller Example Services Ltd. Buyer Example Team Ltd.',
    'Invoice Date 2026-10-16. Subtotal 100.000000000000000001.',
    'Tax 13.00. Total 113.000000000000000001 CNY.',
  ];
  const stream = `BT /F1 10 Tf 40 780 Td ${lines.map((line, index) => `${index ? '0 -16 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  return Buffer.from(`${data}xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

function mime() {
  return { uid: 1, source: Buffer.from([
    'From: Synthetic Invoices <billing@example.invalid>', 'To: invoices@example.invalid',
    'Subject: Synthetic invoice for reimbursement', 'Message-ID: <synthetic-invoice-1@example.invalid>',
    'Date: Fri, 16 Oct 2026 09:00:00 +0800', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="invoice-api-test"', '', '--invoice-api-test',
    'Content-Type: text/plain; charset=utf-8', '', 'Please review the attached synthetic invoice.',
    '--invoice-api-test', 'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="synthetic-invoice.pdf"', 'Content-Transfer-Encoding: base64', '',
    pdf().toString('base64'), '--invoice-api-test--', '',
  ].join('\r\n')).toString('base64') };
}

function modelInvoice(overrides = {}) {
  return {
    summary: '合成发票已提供，可复制票面信息核对报销。', category: 'invoice', intent: 'invoice', priority: 'normal',
    // Even an over-eager model must not turn invoice/reimbursement mail into calendar or task actions.
    events: [{ action: 'create', title: '不应创建的开票日期', start: '2026-10-16T09:00:00+08:00', end: '2026-10-16T10:00:00+08:00' }],
    tasks: [{ title: '不应创建的报销待办' }],
    invoices: [{ attachmentId: '@first-attachment', invoiceType: '电子发票', invoiceNumber: '00001234',
      invoiceDate: '2026-10-16', buyerName: 'Example Team Ltd.', sellerName: 'Example Services Ltd.',
      amount: '100.000000000000000001', taxAmount: '13.00', totalAmount: '113.000000000000000001', currency: 'CNY', ...overrides }],
  };
}

// Real Express, MIME/PDF parsing and local persistence run in the worker. Only remote transports are mocked.
async function serveFixture() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { ImapFlow } = await import('imapflow');
  let inbox = workerData.inbox, answers = [], calls = [], reads = 0, rawReads = 0;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(ImapFlow.prototype, 'connect', async function () {
    reads++;
    this.mailbox = { exists: inbox.length, uidValidity: 42 };
  });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'close', () => {});
  mock.method(ImapFlow.prototype, 'fetch', async function* (range, query) {
    const requested = String(range).split(',').map(Number);
    for (const message of inbox) {
      if (query.source && !requested.includes(message.uid)) continue;
      if (query.source) rawReads++;
      yield { uid: message.uid, internalDate: new Date(Date.UTC(2026, 9, 16, 1, 0, message.uid)),
        ...(query.source ? { source: Buffer.from(message.source, 'base64') } : {}) };
    }
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://model.example.invalid/')) throw new Error(`Unexpected external request: ${url}`);
    const request = JSON.parse(options.body);
    calls.push(request);
    if (!answers.length) throw new Error('No synthetic invoice response queued');
    let answer = answers.shift();
    if (answer.error) throw new Error(answer.error);
    if (answer.invoices) {
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      answer = { ...answer, invoices: answer.invoices.map((invoice) => ({ ...invoice,
        attachmentId: invoice.attachmentId === '@first-attachment'
          ? input.attachmentTexts?.[0]?.attachmentId || 'missing-attachment-id' : invoice.attachmentId,
      })) };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer), reasoning_content: 'PRIVATE_INVOICE_REASONING' } }],
      usage: { prompt_tokens: 100, completion_tokens: 80 } }));
  });
  parentPort.on('message', (command) => {
    if (command.type === 'answers') answers.push(...command.values);
    if (command.type === 'inbox') inbox = command.values;
    parentPort.postMessage({ reads, rawReads, calls, remainingAnswers: answers.length });
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

async function fixture(t, { inbox = [mime()], directory, prepare } = {}) {
  if (!directory) {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    fs.mkdirSync(path.join(root, 'work'), { recursive: true });
    directory = fs.mkdtempSync(path.join(root, 'work', 'invoice-api-test-'));
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings));
    fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify({ events: [], tasks: [], emails: [], lastSync: null }));
    fs.writeFileSync(path.join(directory, 'traces.json'), '[]');
    fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
      postgres: { enabled: false }, redis: { enabled: false }, mq: { enabled: false }, oss: { enabled: false },
      auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'synthetic', adminEmails: [] },
    }));
    prepare?.(directory);
  }
  const worker = new Worker(`(${serveFixture.toString()})()`, { eval: true,
    workerData: { indexUrl: new URL('./index.js', import.meta.url).href, inbox },
    env: { ...process.env, PORT: '0', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_REQUIRE_AUTH: '0' } });
  t.after(() => worker.terminate());
  const [{ port }] = await once(worker, 'message');
  const command = async (value) => {
    const result = once(worker, 'message');
    worker.postMessage(value);
    return (await result)[0];
  };
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  return { directory, request, stop: () => worker.terminate(),
    answers: (values) => command({ type: 'answers', values }), counts: () => command({ type: 'counts' }),
    state: async (scope = '') => (await request(`/api/state${scope ? `?scope=${scope}` : ''}`)).body };
}

function saveLegacyMail(directory, mailboxId = 'default') {
  const key = `users/workspace/mailboxes/${mailboxId}/fixture/synthetic-invoice.pdf`;
  const localFile = path.join(directory, 'attachments', key);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, pdf());
  const id = mailboxId === 'default' ? 'qq:invoices@example.invalid:42:1' : 'imap:second@example.invalid:42:1';
  const email = { id, subject: '已保存的合成发票邮件', body: '请核对附件。', sender: 'billing@example.invalid',
    receivedAt: '2026-10-16T09:00:00+08:00', mode: 'qq', category: 'invoice', priority: 'normal', status: 'skipped',
    eventIds: [], taskIds: [], attachments: [{ id: `legacy-${mailboxId}-attachment`, filename: 'synthetic-invoice.pdf',
      contentType: 'application/pdf', size: pdf().length, key, storage: 'local',
      url: `/api/attachments/${encodeURIComponent(key)}`, proxyUrl: `/api/attachments/${encodeURIComponent(key)}` }],
    extraction: { category: 'invoice', summary: '旧版发票邮件，尚无结构化字段。', actions: [], tasks: [] } };
  const calendarFile = mailboxId === 'default' ? path.join(directory, 'calendar.json')
    : path.join(directory, 'mailboxes', mailboxId, 'calendar.json');
  fs.mkdirSync(path.dirname(calendarFile), { recursive: true });
  fs.writeFileSync(calendarFile, JSON.stringify({ events: [], tasks: [], emails: [email], lastSync: null }));
  return email;
}

function extractionRoute(emailId) {
  return `/api/emails/${encodeURIComponent(emailId)}/extract-invoices`;
}

test('发票 API：真实 MIME/PDF 经非简历旁路提取发票、保留原附件链接并按邮件去重', async (t) => {
  const app = await fixture(t);
  await app.answers([{ isResume: false, summary: '这是合成发票，不是个人简历。', profile: null }, modelInvoice()]);
  const synced = await app.request('/api/sync/qq', 'POST');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.body.errors, [], JSON.stringify(synced.body));
  assert.equal(synced.body.invoices, 1);
  assert.equal(synced.body.added, 0);
  assert.equal(synced.body.tasksAdded, 0);
  const state = await app.state();
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.emails.length, 1);
  const email = state.emails[0];
  const attachment = email.attachments[0];
  assert.equal(email.category, 'invoice');
  assert.equal(email.intent, 'invoice');
  assert.equal(email.invoiceStatus, 'extracted');
  assert.deepEqual(email.invoiceErrors, []);
  assert.deepEqual(email.eventIds, []);
  assert.deepEqual(email.taskIds, []);
  assert.equal(attachment.status, 'not_resume');
  assert.equal(attachment.textStatus, 'success');
  assert.match(attachment.id, /^attachment-[a-f0-9]{24}$/);
  assert.match(attachment.key, /^users\/workspace\/mailboxes\/default\//);
  assert.equal(attachment.proxyUrl, `/api/attachments/${encodeURIComponent(attachment.key)}`);
  assert.equal(email.extraction.invoices[0].attachmentId, attachment.id);
  assert.equal(email.extraction.invoices[0].attachmentName, attachment.filename);
  assert.equal(email.extraction.invoices[0].invoiceNumber, '00001234');
  assert.equal(email.extraction.invoices[0].totalAmount, '113.000000000000000001');
  const counts = await app.counts();
  assert.equal(counts.calls.length, 2, '一次 PDF 简历识别和一次主提取');
  assert.equal(counts.rawReads, 1);
  const input = JSON.parse(counts.calls[1].messages[1].content);
  assert.equal(input.attachmentTexts[0].attachmentId, attachment.id);
  assert.equal(input.attachmentTexts[0].kind, 'pdf');
  assert.match(input.attachmentTexts[0].text, /SYNTHETIC ELECTRONIC INVOICE/);
  assert.equal(input.attachments[0].id, attachment.id);
  const download = await app.request(attachment.proxyUrl);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, pdf());
  const duplicate = await app.request('/api/sync/qq', 'POST');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, 1);
  const after = await app.counts();
  assert.equal(after.calls.length, counts.calls.length);
  assert.equal(after.rawReads, counts.rawReads);
  assert.deepEqual((await app.state()).emails[0].extraction.invoices, email.extraction.invoices);
  assert.doesNotMatch(JSON.stringify((await app.request('/api/traces')).body), /PRIVATE_INVOICE_REASONING|synthetic-invoice-model-key/);
});

test('发票 API：旧邮件显式提取、模型失败保留已有票据、重试成功并在重启后持久化', async (t) => {
  let legacy;
  const app = await fixture(t, { inbox: [], prepare(directory) { legacy = saveLegacyMail(directory); } });
  assert.equal((await app.state()).emails[0].extraction.invoices, undefined);
  await app.answers([modelInvoice()]);
  const extracted = await app.request(extractionRoute(legacy.id), 'POST', undefined, { 'X-Mailbox-Id': 'default' });
  assert.equal(extracted.status, 200, JSON.stringify(extracted.body));
  assert.equal(extracted.body.email.invoiceStatus, 'extracted');
  const savedInvoices = extracted.body.email.extraction.invoices;
  assert.equal(savedInvoices.length, 1);
  assert.equal(savedInvoices[0].attachmentId, legacy.attachments[0].id);
  await app.answers([{ error: 'Synthetic invoice model temporarily unavailable' }]);
  const failed = await app.request(extractionRoute(legacy.id), 'POST');
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.match(failed.body.error, /temporarily unavailable/);
  assert.deepEqual(failed.body.email.extraction.invoices, savedInvoices);
  assert.equal(failed.body.email.invoiceStatus, 'partial');
  assert.ok(failed.body.email.invoiceErrors.some((message) => message.includes('temporarily unavailable')));
  assert.deepEqual((await app.state()).emails[0].extraction.invoices, savedInvoices);
  await app.answers([modelInvoice({ totalAmount: '113.000000000000000002' })]);
  const retried = await app.request(extractionRoute(legacy.id), 'POST');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.email.extraction.invoices[0].id, savedInvoices[0].id);
  assert.equal(retried.body.email.extraction.invoices[0].totalAmount, '113.000000000000000002');
  assert.equal(retried.body.email.invoiceStatus, 'extracted');
  assert.deepEqual(retried.body.email.invoiceErrors, []);
  const beforeRestart = await app.state();
  assert.deepEqual(beforeRestart.events, []);
  assert.deepEqual(beforeRestart.tasks, []);
  assert.equal((await app.counts()).rawReads, 0, '显式重提取读取已保存附件，无需重读 IMAP');
  await app.stop();
  const restarted = await fixture(t, { directory: app.directory });
  const persistent = await restarted.state();
  assert.deepEqual(persistent.emails, beforeRestart.emails);
  assert.deepEqual((await restarted.request(persistent.emails[0].attachments[0].proxyUrl)).body, pdf());
  const duplicate = await restarted.request('/api/sync/qq', 'POST');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, 1);
  assert.equal((await restarted.counts()).calls.length, 0);
  assert.equal((await restarted.counts()).rawReads, 0);
});

test('发票 API：可定向重提取非当前邮箱且保持隔离，不存在邮箱或其他邮箱邮件被拒绝', async (t) => {
  let secondary;
  const app = await fixture(t, { inbox: [], prepare(directory) {
    saveLegacyMail(directory);
    secondary = saveLegacyMail(directory, 'secondary');
  } });
  const primaryPath = path.join(app.directory, 'calendar.json');
  const primaryBefore = fs.readFileSync(primaryPath, 'utf8');
  const primaryState = await app.state();
  await app.answers([modelInvoice({ invoiceNumber: '00005678' })]);
  const result = await app.request(extractionRoute(secondary.id), 'POST', undefined, { 'X-Mailbox-Id': 'secondary' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.email.extraction.invoices[0].attachmentId, secondary.attachments[0].id);
  assert.equal(result.body.email.extraction.invoices[0].invoiceNumber, '00005678');
  const activeAfter = await app.state();
  assert.equal(activeAfter.mailboxId, 'default');
  assert.equal(activeAfter.settings.activeMailboxId, 'default');
  assert.deepEqual(activeAfter.emails, primaryState.emails);
  assert.equal(fs.readFileSync(primaryPath, 'utf8'), primaryBefore);
  const bound = await app.request('/api/state?mailbox=secondary');
  assert.equal(bound.status, 200);
  assert.equal(bound.body.mailboxId, 'secondary');
  assert.equal(bound.body.viewScope, 'mailbox');
  assert.equal(bound.body.emails.length, 1);
  assert.equal(bound.body.settings.activeMailboxId, 'default');
  const missingMailbox = await app.request('/api/state?mailbox=missing');
  assert.equal(missingMailbox.status, 404);
  const all = await app.state('all');
  assert.equal(all.emails.length, 2);
  assert.equal(all.emails.find((email) => email.mailboxId === 'secondary').extraction.invoices[0].invoiceNumber, '00005678');
  assert.equal(all.emails.find((email) => email.mailboxId === 'default').extraction.invoices, undefined);
  const counts = await app.counts();
  assert.equal(counts.calls.length, 1);
  assert.equal(counts.reads, 0);
  const absent = await app.request(extractionRoute(secondary.id), 'POST', undefined, { 'X-Mailbox-Id': 'missing' });
  assert.equal(absent.status, 404);
  assert.match(absent.body.error, /邮箱不存在/);
  const otherMailbox = await app.request(extractionRoute(secondary.id), 'POST', undefined, { 'X-Mailbox-Id': 'default' });
  assert.equal(otherMailbox.status, 404);
  assert.match(otherMailbox.body.error, /原邮件不存在/);
  assert.equal((await app.counts()).calls.length, counts.calls.length);
  assert.equal(fs.existsSync(path.join(app.directory, 'mailboxes', 'missing')), false);
  assert.deepEqual((await app.state()).events, []);
  assert.deepEqual((await app.state()).tasks, []);
});

for (const recovery of ['attachment-retry', 'sync']) {
  test(`发票 API：PDF 简历识别与投递意图均失败后经 ${recovery === 'sync' ? '同步占位' : '附件重试'} 恢复发票原来源`, async (t) => {
    const app = await fixture(t);
    await app.answers([
      { error: 'Synthetic PDF classification temporarily unavailable' },
      { error: 'Synthetic mail intent temporarily unavailable' },
    ]);
    const initial = await app.request('/api/sync/qq', 'POST');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.errors.length, 1);
    const failedState = await app.state();
    assert.equal(failedState.emails.length, 1);
    const failed = failedState.emails[0];
    assert.equal(failed.recruitmentStatus, 'partial');
    assert.equal(failed.category, null);
    const attachment = failed.attachments[0];
    assert.equal(attachment.status, 'failed');
    assert.match(attachment.key, /^users\/workspace\/mailboxes\/default\//);
    const recruitment = (await app.request('/api/recruitment')).body;
    const stored = recruitment.attachments.find((item) => item.id === attachment.id);
    assert.ok(stored, '招聘附件和通用附件沿用同一 ID');
    assert.equal(stored.pageCount, 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(app.directory, 'recruitment.json'), 'utf8'));
    const savedAttachment = persisted.attachments.find((item) => item.id === attachment.id);
    assert.match(savedAttachment.pages.map((page) => page.text).join('\n'), /SYNTHETIC ELECTRONIC INVOICE/);
    assert.deepEqual(failed.attachmentTexts, [], '分类失败时不向主提取暴露未确认来源的缓存文字');
    const beforeCounts = await app.counts();
    assert.equal(beforeCounts.calls.length, 2);
    assert.equal(beforeCounts.rawReads, 1);
    await app.answers([{ isResume: false, summary: '合成发票，不是简历。', profile: null }, modelInvoice()]);
    const recovered = await app.request(recovery === 'sync' ? '/api/sync/qq'
      : `/api/recruitment/attachments/${attachment.id}/retry`, 'POST');
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    if (recovery === 'sync') {
      assert.deepEqual(recovered.body.errors, [], JSON.stringify(recovered.body));
      assert.equal(recovered.body.invoices, 1);
    }
    const state = await app.state();
    assert.equal(state.emails.length, 1, '恢复替换原邮件，不新增重复记录');
    const email = state.emails[0];
    assert.equal(email.id, failed.id);
    assert.equal(email.category, 'invoice');
    assert.equal(email.intent, 'invoice');
    assert.notEqual(email.recruitmentStatus, 'partial');
    assert.equal(email.invoiceStatus, 'extracted');
    assert.deepEqual(email.invoiceErrors, []);
    assert.equal(email.extraction.invoices.length, 1);
    assert.equal(email.extraction.invoices[0].attachmentId, attachment.id);
    assert.equal(email.extraction.invoices[0].invoiceNumber, '00001234');
    assert.equal(email.attachments[0].id, attachment.id);
    assert.equal(email.attachments[0].key, attachment.key);
    assert.equal(email.attachments[0].proxyUrl, attachment.proxyUrl);
    assert.equal(email.attachments[0].status, 'not_resume');
    assert.deepEqual((await app.request(email.attachments[0].proxyUrl)).body, pdf());
    assert.deepEqual(state.events, []);
    assert.deepEqual(state.tasks, []);
    const counts = await app.counts();
    assert.equal(counts.calls.length, 4);
    assert.equal(counts.rawReads, 1, '恢复利用本地保存的附件，不重新读取 IMAP 原文');
    const input = JSON.parse(counts.calls[3].messages[1].content);
    assert.equal(input.attachmentTexts[0].attachmentId, attachment.id);
    assert.equal(input.attachments[0].id, attachment.id);
    assert.match(input.attachmentTexts[0].text, /SYNTHETIC ELECTRONIC INVOICE/);
    const duplicate = await app.request('/api/sync/qq', 'POST');
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, 1);
    assert.equal((await app.counts()).calls.length, counts.calls.length);
    assert.equal((await app.counts()).rawReads, counts.rawReads);
  });
}
