import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('work', { recursive: true });
const dataDir = fs.mkdtempSync(path.resolve('work/invoice-flow-test-'));
process.env.DAYLIGHT_DATA_DIR = dataDir;
const { parseExtraction, importEmail, processEmails, extractEvents } = await import('./agent.js');
const { reextractInvoiceEmail } = await import('./invoice-extraction.js');
const { enrichEmailWithAttachmentText } = await import('./attachment-text.js');

const source = () => ({ id: 'synthetic-invoice-mail', category: 'invoice', subject: 'Synthetic invoice',
  sender: 'billing@example.invalid', receivedAt: '2026-10-16T09:00:00+08:00', body: '发票已开具，下周一前报销。',
  mode: 'qq', attachments: [{ id: 'file-1', filename: 'synthetic-invoice.pdf', contentType: 'application/pdf', key: 'synthetic/key.pdf' }],
  attachmentTexts: [{ attachmentId: 'file-1', filename: 'synthetic-invoice.pdf', kind: 'pdf', text: 'Invoice 000100, total CNY 106.00, Synthetic Seller' }] });
const invoice = { attachmentId: 'file-1', invoiceNumber: '000100', sellerName: 'Synthetic Seller', totalAmount: '106.00', currency: 'CNY' };
const emptyStore = () => ({ events: [], tasks: [], emails: [] });
const settings = { activeMailboxId: 'default', apiKey: 'synthetic-model-key', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' };

test('发票解析先丢弃模型误给的无效日程和待办，日期与催报销要求不会污染清单', async () => {
  const extraction = parseExtraction(JSON.stringify({ category: 'invoice', intent: 'calendar',
    events: [{ title: '错误的开票日期日程', start: 'not-a-date' }], tasks: [{ title: '' }], invoices: [invoice] }));
  assert.deepEqual(extraction.events, []);
  assert.deepEqual(extraction.tasks, []);
  const store = emptyStore();
  const result = await processEmails(store, [source()], async () => extraction, 'qq', { enrichAttachments: false });
  assert.equal(result.invoices, 1);
  assert.equal(result.added, 0);
  assert.equal(result.tasksAdded, 0);
  assert.equal(store.events.length + store.tasks.length, 0);
  assert.equal(store.emails[0].category, 'invoice');
  assert.equal(store.emails[0].intent, 'invoice');
  assert.equal(store.emails[0].invoiceStatus, 'extracted');
  assert.equal(store.emails[0].extraction.invoices[0].invoiceNumber, '000100');
  assert.equal(store.emails[0].draftReply, undefined);
  const duplicate = await processEmails(store, [source()], () => assert.fail('不应重复调用模型'), 'qq');
  assert.equal(duplicate.duplicate, 1);
  assert.equal(duplicate.invoices, 0);
});

test('直接导入和独立 invoice 意图同样禁止取消已有日程或修改已有待办', () => {
  const event = { id: 'manual-event', title: '现有安排', status: 'active', source: 'manual' };
  const task = { id: 'manual-task', title: '现有工作', status: 'done', sources: [], source: 'email' };
  const store = { events: [event], tasks: [task], emails: [] };
  const snapshot = JSON.stringify({ event, task });
  const record = importEmail(store, source(), { category: 'general', intent: 'invoice',
    events: [{ action: 'cancel', targetEventId: event.id }], tasks: [{ existingTaskId: task.id, title: task.title }], invoices: [invoice] }, 'qq');
  assert.equal(JSON.stringify({ event, task }), snapshot);
  assert.deepEqual(record.eventIds, []);
  assert.deepEqual(record.taskIds, []);
  assert.equal(record.category, 'invoice');
});

test('模型已有票据结果但误标普通沟通时仍进入发票助手，来源失配保留错误而不写日历', () => {
  const store = emptyStore();
  const record = importEmail(store, source(), { category: 'general', intent: 'calendar',
    events: [{ title: '不得入历' }], tasks: [], invoices: [{ ...invoice, attachmentId: 'unknown' }] }, 'qq');
  assert.equal(record.category, 'invoice');
  assert.equal(record.invoiceStatus, 'failed');
  assert.deepEqual(record.extraction.invoices, []);
  assert.match(record.invoiceErrors[0], /关联/);
  assert.equal(store.events.length, 0);
});

test('无附件发票通知只分类，不从正文生成票据或待办', () => {
  const store = emptyStore();
  const record = importEmail(store, { ...source(), attachments: [], attachmentTexts: [] },
    { category: 'invoice', events: [], tasks: [{ title: '报销' }], invoices: [] }, 'qq');
  assert.equal(record.invoiceStatus, 'empty');
  assert.deepEqual(record.extraction.invoices, []);
  assert.equal(store.events.length + store.tasks.length, 0);
});

test('重提取读取保存的原附件、修复旧附件标识并更新字段，保留原邮件及用户数据', async () => {
  const email = { ...source(), attachments: source().attachments.map(({ id, ...file }) => file),
    eventIds: ['historic-event'], taskIds: ['historic-task'], userDraft: 'synthetic saved draft',
    extraction: { summary: '原摘要', actions: [], invoices: [] } };
  let calls = 0;
  const result = await reextractInvoiceEmail(email, settings, {
    mailboxId: 'secondary',
    readAttachment: async (file, scope) => { assert.equal(scope.mailboxId, 'secondary'); return { buffer: Buffer.from('synthetic pdf bytes') }; },
    enrich: (mail, options) => enrichEmailWithAttachmentText(mail, { ...options, extractPdf: async () => ({ text: 'Invoice 000100 total 106.00 CNY', pageCount: 1 }) }),
    extract: async (mail, _settings, events, _context, tasks) => {
      calls++;
      assert.deepEqual(events, []); assert.deepEqual(tasks, []);
      return { invoices: [{ ...invoice, attachmentId: mail.attachmentTexts[0].attachmentId }], summary: '新摘要' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.email.invoiceStatus, 'extracted');
  assert.equal(result.email.extraction.invoices.length, 1);
  assert.equal(result.email.attachments[0].textStatus, 'success');
  assert.equal(result.email.userDraft, email.userDraft);
  assert.deepEqual(result.email.eventIds, email.eventIds);
  assert.deepEqual(result.email.taskIds, email.taskIds);
  assert.equal(email.attachments[0].id, undefined, '不提前改动原保存对象');
});

test('重提取的模型或文件失败保留先前票据，后续重试可恢复', async () => {
  const email = { ...source(), extraction: { invoices: [{ ...invoice, id: 'previous-invoice' }] } };
  const options = { readAttachment: async () => ({ buffer: Buffer.from('pdf') }),
    enrich: (mail, opts) => enrichEmailWithAttachmentText(mail, { ...opts, extractPdf: async () => ({ text: 'Invoice 000100 total 106.00 CNY' }) }),
    extract: async () => { throw new Error('合成模型暂时失败'); } };
  const failed = await reextractInvoiceEmail(email, settings, options);
  assert.equal(failed.error, '合成模型暂时失败');
  assert.equal(failed.email.invoiceStatus, 'partial');
  assert.equal(failed.email.extraction.invoices[0].id, 'previous-invoice');
  const missing = await reextractInvoiceEmail(email, settings, { ...options, readAttachment: async () => null });
  assert.equal(missing.email.invoiceStatus, 'partial');
  assert.equal(missing.email.extraction.invoices[0].id, 'previous-invoice');
  assert.ok(missing.email.invoiceErrors.some((message) => message.includes('不可用')));
  const recovered = await reextractInvoiceEmail(failed.email, settings, { ...options, extract: async () => ({ invoices: [invoice] }) });
  assert.equal(recovered.email.invoiceStatus, 'extracted');
  assert.deepEqual(recovered.email.invoiceErrors, []);
});

test('同一 PDF 部分票据失败时逐张保留旧结果，错误金额不覆盖此前可用字段', async () => {
  const store = emptyStore();
  const email = importEmail(store, source(), { category: 'invoice', events: [], tasks: [], invoices: [invoice,
    { ...invoice, invoiceNumber: '000200', totalAmount: '200.00' }] }, 'qq');
  const result = await reextractInvoiceEmail(email, settings, {
    readAttachment: async () => ({ buffer: Buffer.from('pdf') }),
    enrich: (mail, opts) => enrichEmailWithAttachmentText(mail, { ...opts, extractPdf: async () => ({ text: 'Invoice 000100 and invoice 000200' }) }),
    extract: async () => ({ invoices: [{ ...invoice, totalAmount: 'unreadable' }, 'bad second invoice'] }),
  });
  assert.equal(result.email.invoiceStatus, 'partial');
  assert.equal(result.email.extraction.invoices.length, 2);
  assert.equal(result.email.extraction.invoices.find((item) => item.invoiceNumber === '000100').totalAmount, '106.00');
  assert.equal(result.email.extraction.invoices.find((item) => item.invoiceNumber === '000200').totalAmount, '200.00');
  assert.ok(result.email.invoiceErrors.some((error) => error.includes('此前')));
});

test('旧自定义提示词仍附加当前发票规则并传递可追溯附件 ID，同次模型返回票据', async (t) => {
  const custom = '合成自定义提示词，保持已有风格。';
  fs.writeFileSync(path.join(dataDir, 'prompts.json'), JSON.stringify({ extractionSystem: custom }));
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ category: 'invoice', intent: 'invoice',
      events: [], tasks: [], invoices: [invoice] }) } }] }));
  });
  const extracted = await extractEvents(source(), settings);
  assert.ok(request.messages[0].content.includes(custom));
  assert.match(request.messages[0].content, /发票报销提取规则/);
  assert.match(request.messages[0].content, /强制 events:\[\]、tasks:\[\]/);
  const input = JSON.parse(request.messages[1].content);
  assert.equal(input.attachments[0].id, input.attachmentTexts[0].attachmentId);
  assert.equal(extracted.invoices[0].invoiceNumber, '000100');
});
