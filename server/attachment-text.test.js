import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workRoot = path.resolve('work');
fs.mkdirSync(workRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(workRoot, 'attachment-text-test-'));
const originalDataDirectory = process.env.DAYLIGHT_DATA_DIR;
process.env.DAYLIGHT_DATA_DIR = directory;
const { enrichEmailWithAttachmentText, ocrImageBuffer } = await import('./attachment-text.js');
const { extractPdf } = await import('./pdf.js');
const { readMailboxEmails } = await import('./agent.js');
after(() => {
  if (originalDataDirectory === undefined) delete process.env.DAYLIGHT_DATA_DIR;
  else process.env.DAYLIGHT_DATA_DIR = originalDataDirectory;
  if (!directory.startsWith(`${workRoot}${path.sep}`)) throw new Error('测试目录不在 work 内');
  fs.rmSync(directory, { recursive: true, force: true });
});

// All attachment bytes, metadata and transport responses are synthetic.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
function mail(raw, metadata = raw.map(({ id, filename, contentType, content, size }) => ({
  id, filename, contentType, size: size ?? content?.length ?? 0,
}))) {
  const email = { id: 'synthetic-invoice-mail', attachments: metadata };
  Object.defineProperty(email, '_textAttachments', { value: raw });
  return email;
}
function trace() {
  const spans = [];
  return { spans, startSpan(stage, label, fields) { const span = { stage, label, ...fields }; spans.push(span); return span; },
    updateSpan(span, fields) { Object.assign(span, fields); }, finishSpan(span, fields) { Object.assign(span, fields); } };
}

test('附件按稳定 ID 对应元数据，同名同大小的 PDF 分别保留且原始文本不写日志', async () => {
  const raw = [
    { id: 'opaque-pdf-a', filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('PRIVATE_SYNTHETIC_INVOICE_A') },
    { id: 'opaque-pdf-b', filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('PRIVATE_SYNTHETIC_INVOICE_B') },
    { id: 'opaque-image', filename: 'invoice.png', contentType: 'image/png', content: png },
  ];
  const email = mail(raw);
  email.attachments.reverse();
  Object.defineProperty(email, '_pdfAttachments', { value: [raw[0]] });
  const context = trace();
  const result = await enrichEmailWithAttachmentText(email, {
    context, extractPdf: async (buffer) => ({ text: buffer.toString(), pageCount: 2 }),
    ocr: async (buffer) => { assert.deepEqual(buffer, png); return 'PRIVATE_SYNTHETIC_IMAGE_INVOICE'; },
  });
  assert.deepEqual(result.attachmentTexts.map((item) => item.attachmentId), ['opaque-pdf-a', 'opaque-pdf-b', 'opaque-image']);
  assert.deepEqual(result.attachmentTexts.map((item) => item.kind), ['pdf', 'pdf', 'image_ocr']);
  assert.equal(result.attachmentTexts[0].pageCount, 2);
  assert.match(result.attachmentTexts[1].text, /INVOICE_B/);
  assert.equal(email.attachments.find((item) => item.id === 'opaque-pdf-b').textStatus, 'success');
  assert.equal(email.attachments.find((item) => item.id === 'opaque-image').textCharacters, 31);
  assert.deepEqual(email.attachmentTextErrors, []);
  assert.doesNotMatch(JSON.stringify(context.spans), /PRIVATE_SYNTHETIC/);
  assert.doesNotMatch(JSON.stringify(email), /_textAttachments|_pdfAttachments|"type":"Buffer"/);
});

test('旧 PDF 旁路与内联图片兼容，缺 ID 时逐一补 ID 而不合并同名附件', async () => {
  const pdfA = { filename: 'same.pdf', contentType: 'application/pdf', content: Buffer.from('Synthetic invoice A') };
  const pdfB = { filename: 'same.pdf', contentType: 'application/pdf', content: Buffer.from('Synthetic invoice B') };
  const email = { attachments: [
    { filename: 'same.pdf', contentType: 'application/pdf', size: pdfA.content.length },
    { filename: 'same.pdf', contentType: 'application/pdf', size: pdfB.content.length },
    { filename: 'receipt.jpg', mimeType: 'image/jpeg', _buffer: Uint8Array.from(png) },
  ] };
  Object.defineProperty(email, '_pdfAttachments', { value: [pdfA, pdfB] });
  const result = await enrichEmailWithAttachmentText(email, {
    extractPdf: async (buffer) => ({ text: buffer.toString(), pageCount: 1 }),
    ocr: async (buffer) => { assert.ok(Buffer.isBuffer(buffer)); return 'Synthetic receipt'; },
  });
  assert.deepEqual(result.attachmentTexts.map((item) => item.attachmentId), ['attachment-1', 'attachment-2', 'attachment-3']);
  assert.equal(result.attachmentTexts.length, 3);
  assert.equal(email.attachments.every((item) => item.textStatus === 'success'), true);
});

test('无原始字节时复用明确同 ID 的已读文字，保留截断提示且不掩盖旧失败', async () => {
  const email = { attachments: [
    { id: 'read-pdf', filename: 'read.pdf', contentType: 'application/pdf', textStatus: 'success' },
    { id: 'long-pdf', filename: 'long.pdf', contentType: 'application/pdf', textStatus: 'truncated' },
    { id: 'failed-image', filename: 'failed.png', contentType: 'image/png', textStatus: 'failed', textError: '旧 OCR 失败' },
    { id: 'wrong-source', filename: 'same.pdf', contentType: 'application/pdf' },
  ], attachmentTexts: [
    { attachmentId: 'read-pdf', filename: 'read.pdf', kind: 'pdf', text: 'Synthetic parsed invoice', pageCount: 2 },
    { attachmentId: 'long-pdf', filename: 'long.pdf', kind: 'pdf', text: 'x'.repeat(8_000), pageCount: 4 },
    { attachmentId: 'failed-image', filename: 'failed.png', kind: 'image_ocr', text: 'Old cached invoice' },
    { attachmentId: 'other-source', filename: 'same.pdf', kind: 'pdf', text: 'Different attachment invoice' },
  ] };
  const result = await enrichEmailWithAttachmentText(email, {
    extractPdf: () => assert.fail('已有文字时不需 PDF 字节'), ocr: () => assert.fail('不可用图片不应进入 OCR'),
  });
  assert.deepEqual(result.attachmentTexts.map((item) => item.attachmentId), ['read-pdf', 'long-pdf']);
  assert.equal(result.attachmentTexts[0].pageCount, 2);
  assert.equal(result.attachmentTexts[1].characters, 8_000);
  assert.equal(email.attachments[1].textStatus, 'truncated');
  assert.match(email.attachments[1].textError, /后续内容未进入分析/);
  assert.equal(email.attachments[2].textStatus, 'failed');
  assert.equal(email.attachments[3].textStatus, 'failed');
  assert.equal(result.errors.length, 3);
});

test('有原始字节时重新提取并覆盖旧摘录，失败不能用旧缓存冒充本次成功', async () => {
  const email = mail([
    { id: 'pdf', filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('current pdf') },
    { id: 'image', filename: 'invoice.png', contentType: 'image/png', content: png },
    { id: 'broken', filename: 'broken.pdf', contentType: 'application/pdf', content: Buffer.from('broken pdf') },
  ]);
  email.attachmentTexts = email.attachments.map((file) => ({
    attachmentId: file.id, filename: file.filename, kind: file.contentType === 'application/pdf' ? 'pdf' : 'image_ocr', text: 'Old invoice text',
  }));
  const result = await enrichEmailWithAttachmentText(email, {
    extractPdf: async (buffer) => {
      if (buffer.toString() === 'broken pdf') throw new Error('Current PDF is damaged');
      assert.equal(buffer.toString(), 'current pdf');
      return { text: 'Current PDF invoice' };
    }, ocr: async (buffer) => { assert.deepEqual(buffer, png); return 'Current image invoice'; },
  });
  assert.deepEqual(result.attachmentTexts.map((item) => item.text), ['Current PDF invoice', 'Current image invoice']);
  assert.equal(email.attachments[2].textStatus, 'failed');
  assert.match(result.errors[0], /Current PDF is damaged/);
});

test('空内容、PDF 错误、空 OCR 与 OCR 异常分别报告，重试成功后清除旧错误', async () => {
  const raw = [
    { id: 'empty', filename: 'empty.pdf', contentType: 'application/pdf' },
    { id: 'broken', filename: 'broken.pdf', contentType: 'application/pdf', content: Buffer.from('broken') },
    { id: 'blank-pdf', filename: 'blank.pdf', contentType: 'application/pdf', content: Buffer.from('blank') },
    { id: 'blank-image', filename: 'blank.png', contentType: 'image/png', content: Buffer.from('blank') },
    { id: 'offline-image', filename: 'offline.png', contentType: 'image/png', content: Buffer.from('offline') },
  ];
  const email = mail(raw);
  const failed = await enrichEmailWithAttachmentText(email, {
    extractPdf: async (buffer) => {
      if (buffer.toString() === 'broken') throw new Error('PDF 文件损坏或格式无效');
      return { text: '  --  ' };
    },
    ocr: async (buffer) => {
      if (buffer.toString() === 'offline') throw new Error('Synthetic OCR unavailable');
      return ' \n ';
    },
  });
  assert.equal(failed.attachmentTexts.length, 0);
  assert.equal(failed.errors.length, 5);
  assert.match(failed.errors.join('\n'), /原始内容不可用|格式无效|PDF未提取到可读文字|图片未提取到可读文字|OCR unavailable/);
  assert.equal(email.attachments.every((item) => item.textStatus === 'failed' && item.textError), true);
  raw[0].content = Buffer.from('recovered');
  const recovered = await enrichEmailWithAttachmentText(email, {
    extractPdf: async () => ({ text: 'Synthetic recovered invoice' }), ocr: async () => 'Synthetic recovered image',
  });
  assert.equal(recovered.attachmentTexts.length, 5);
  assert.deepEqual(email.attachmentTextErrors, []);
  assert.equal(email.attachments.every((item) => item.textStatus === 'success' && !item.textError), true);
});

test('仅支持的文件计入 6 个上限，超限及 8,000 字符截断均明确保留局限', async () => {
  const raw = [
    { id: 'document', filename: 'notes.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('synthetic') },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `pdf-${index}`, filename: `${index}.pdf`, contentType: 'application/pdf', content: Buffer.from(String(index)) })),
  ];
  const email = mail(raw);
  let calls = 0;
  const result = await enrichEmailWithAttachmentText(email, { extractPdf: async (buffer) => {
    calls += 1;
    return { text: buffer.toString() === '0' ? 'x'.repeat(8_001) : 'Synthetic short invoice' };
  } });
  assert.equal(calls, 6);
  assert.equal(result.attachmentTexts.length, 6);
  assert.equal(result.attachmentTexts[0].characters, 8_000);
  assert.equal(email.attachments[0].textStatus, 'unsupported');
  assert.equal(email.attachments[1].textStatus, 'truncated');
  assert.match(email.attachments[1].textError, /后续内容未进入分析/);
  assert.equal(email.attachments[7].textStatus, 'skipped_limit');
  assert.equal(result.errors.length, 2);
});

test('超过 25MB 的附件在解析前明确跳过', async () => {
  const email = mail([{ id: 'large-pdf', filename: 'large.pdf', contentType: 'application/pdf', content: Buffer.from('synthetic'), size: 25 * 1024 * 1024 + 1 }]);
  const result = await enrichEmailWithAttachmentText(email, { extractPdf: () => assert.fail('超限附件不得进入 PDF 解析') });
  assert.equal(result.attachmentTexts.length, 0);
  assert.equal(email.attachments[0].textStatus, 'skipped_size');
  assert.match(result.errors[0], /25MB/);
});

test('扫描 PDF 继续使用逐页渲染 OCR 能力并保留页数和附件 ID', async () => {
  const content = fs.readFileSync('docs/resume-test/09_顾言澈_运维_扫描版.pdf');
  const email = mail([{ id: 'scanned-pdf', filename: 'invoice-scan.pdf', contentType: 'application/pdf', content }]);
  const context = trace();
  let pages = 0;
  const result = await enrichEmailWithAttachmentText(email, { context, extractPdf: (buffer, options) => extractPdf(buffer, {
    ...options, ocr: async (rendered, { page }) => {
      pages += 1;
      assert.equal(page, 1);
      assert.deepEqual([...rendered.subarray(0, 4)], [137, 80, 78, 71]);
      return 'Synthetic scanned invoice total CNY 100.00';
    },
  }) });
  assert.equal(pages, 1);
  assert.equal(result.attachmentTexts[0].attachmentId, 'scanned-pdf');
  assert.equal(result.attachmentTexts[0].pageCount, 1);
  assert.match(result.attachmentTexts[0].text, /CNY 100.00/);
  assert.equal(context.spans.find((span) => span.stage === 'pdf_extract').label, '读取 PDF 附件');
  assert.doesNotMatch(JSON.stringify(context.spans), /Synthetic scanned invoice|简历|候选人/);
});

test('图片 OCR 成功、空白及识别失败都释放 worker，异常保留可重试', async () => {
  for (const outcome of ['success', 'blank', 'failure', 'parameters']) {
    let terminated = 0;
    const worker = {
      async setParameters() { if (outcome === 'parameters') throw new Error('Synthetic parameters failure'); },
      async recognize(buffer) {
        assert.deepEqual(buffer, png);
        if (outcome === 'failure') throw new Error('Synthetic recognize failure');
        return { data: { text: outcome === 'blank' ? ' -- ' : 'Synthetic invoice 100.00' } };
      },
      async terminate() { terminated += 1; },
    };
    const operation = ocrImageBuffer(png, { workerFactory: async () => worker, prepareLanguages: async () => {} });
    if (outcome === 'success') assert.equal(await operation, 'Synthetic invoice 100.00');
    else await assert.rejects(operation, /可读文字|Synthetic .* failure/);
    assert.equal(terminated, 1, `${outcome} 必须释放 worker`);
  }
});

test('图片 OCR 语言包下载失败明确报错且不启动 worker', async (t) => {
  const download = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic offline'); });
  await assert.rejects(ocrImageBuffer(png, { workerFactory: () => assert.fail('下载失败不应启动 worker') }), /语言包下载失败.*重试/);
  assert.equal(download.mock.callCount(), 1);
});

test('实际 MIME 图片字节进入提取路径，同名附件的 ID 稳定对应且邮件 JSON 不含 Buffer', async () => {
  const source = Buffer.from([
    'From: Sender <sender@example.invalid>', 'Subject: Synthetic invoice images', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="synthetic-invoice"', '',
    '--synthetic-invoice', 'Content-Type: text/plain; charset=utf-8', '', 'Attached synthetic invoices.',
    ...Array.from({ length: 2 }, () => ['--synthetic-invoice', 'Content-Type: image/png',
      'Content-Disposition: attachment; filename="same-invoice.png"', 'Content-Transfer-Encoding: base64', '', png.toString('base64')]).flat(),
    '--synthetic-invoice--', '',
  ].join('\r\n'));
  const client = { mailbox: { exists: 1, uidValidity: 7 }, async connect() {}, async getMailboxLock() { return { release() {} }; }, async logout() {},
    async *fetch(range, query) { yield { uid: 3, internalDate: new Date('2026-10-16T01:00:00Z'), ...(query.source ? { source } : {}) }; } };
  const settings = { email: 'mailbox@example.invalid', fetchLimit: 1 };
  const [email] = await readMailboxEmails(settings, { clientFactory: () => client });
  assert.equal(email._textAttachments.length, 2);
  assert.equal(Object.getOwnPropertyDescriptor(email, '_textAttachments').enumerable, false);
  assert.equal(email._pdfAttachments.length, 0);
  assert.equal(new Set(email.attachments.map((item) => item.id)).size, 2);
  assert.deepEqual(email._textAttachments.map((item) => item.id), email.attachments.map((item) => item.id));
  let reads = 0;
  const result = await enrichEmailWithAttachmentText(email, { ocr: async (bytes) => {
    reads += 1;
    assert.deepEqual(bytes, png);
    return `Synthetic invoice ${reads}`;
  } });
  assert.equal(reads, 2);
  assert.deepEqual(result.attachmentTexts.map((item) => item.attachmentId), email.attachments.map((item) => item.id));
  const [again] = await readMailboxEmails(settings, { clientFactory: () => client });
  assert.deepEqual(again.attachments.map((item) => item.id), email.attachments.map((item) => item.id));
  assert.doesNotMatch(JSON.stringify(email), /_textAttachments|"type":"Buffer"/);
});
