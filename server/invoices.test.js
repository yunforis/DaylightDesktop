import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoices } from './invoices.js';

function emailFixture() {
  return {
    id: 'qq:invoices-fixture:100:1',
    subject: '合成发票附件',
    body: '这段正文不作为发票字段的来源。',
    attachments: [
      { id: 'mail-opaque-attachment-a', filename: '合成发票.pdf', contentType: 'application/pdf' },
      { id: 'mail-opaque-attachment-b', filename: '合成发票.png', contentType: 'image/png' },
    ],
    attachmentTexts: [
      { attachmentId: 'mail-opaque-attachment-a', filename: '合成发票.pdf', kind: 'pdf',
        text: '电子发票 发票号码 00001234 销售方 合成服务公司 价税合计 113.00', characters: 42 },
      { attachmentId: 'mail-opaque-attachment-b', filename: '合成发票.png', kind: 'image_ocr',
        text: '电子发票 发票号码 00005678 销售方 合成交通公司 价税合计 50.00', characters: 42 },
    ],
  };
}

function invoice(overrides = {}) {
  return { attachmentId: 'mail-opaque-attachment-a', invoiceNumber: '00001234',
    sellerName: '合成服务公司', totalAmount: '113.00', ...overrides };
}

test('发票号码、税号和金额字符串保留前导零及小数精度，明细不进行金额推算', () => {
  const result = normalizeInvoices([invoice({
    invoiceCode: '00112233', buyerTaxId: '000012345678901234', sellerTaxId: '001234567890123456',
    amount: '100.000000000000000001', taxAmount: '13.000000000000000000',
    totalAmount: '113.000000000000000001', currency: 'CNY',
    items: [{ name: '合成服务费', quantity: '0.130000', unitPrice: '769.230769230769230',
      amount: '100.000000000000000001', taxRate: '13%', taxAmount: '13.000000000000000000' }],
  })], emailFixture());
  assert.deepEqual(result.errors, []);
  const saved = result.invoices[0];
  assert.equal(saved.invoiceNumber, '00001234');
  assert.equal(saved.invoiceCode, '00112233');
  assert.equal(saved.buyerTaxId, '000012345678901234');
  assert.equal(saved.sellerTaxId, '001234567890123456');
  assert.equal(saved.totalAmount, '113.000000000000000001');
  assert.equal(saved.items[0].quantity, '0.130000');
  assert.equal(saved.items[0].unitPrice, '769.230769230769230');
  assert.equal(saved.items[0].specification, null);
  assert.equal(saved.attachmentName, '合成发票.pdf');
});

test('缺失字段保留 null，只有总额时不反推不含税金额和税额，不补邮箱正文内容', () => {
  const email = emailFixture();
  email.body = '正文另提开票日期 2026-10-16、购买方合成集团、税额 13.00。';
  const { invoices, errors } = normalizeInvoices([invoice()], email);
  assert.deepEqual(errors, []);
  const saved = invoices[0];
  for (const field of ['invoiceType', 'invoiceCode', 'invoiceDate', 'buyerName', 'buyerTaxId',
    'sellerTaxId', 'amount', 'taxAmount', 'currency', 'notes']) assert.equal(saved[field], null, field);
  assert.deepEqual(saved.items, []);
});

test('多份附件和同一附件多张发票逐张保留，重复同一发票不会多建一条', () => {
  const inputs = [invoice(), invoice({ invoiceNumber: '00001235', totalAmount: '226.00' }),
    invoice({ attachmentId: 'mail-opaque-attachment-b', invoiceNumber: '00005678', totalAmount: '50.00' }),
    invoice()];
  const { invoices, errors } = normalizeInvoices(inputs, emailFixture());
  assert.deepEqual(errors, []);
  assert.equal(invoices.length, 3);
  assert.equal(new Set(invoices.map((item) => item.id)).size, 3);
  assert.deepEqual(invoices.map((item) => item.attachmentName), ['合成发票.pdf', '合成发票.pdf', '合成发票.png']);
});

test('显式错误附件 id 不按文件名或单一来源猜测回退', () => {
  const email = emailFixture();
  email.attachments = email.attachments.slice(0, 1);
  email.attachmentTexts = email.attachmentTexts.slice(0, 1);
  const { invoices, errors } = normalizeInvoices([invoice({ attachmentId: 'invented-id', filename: '合成发票.pdf' })], email);
  assert.deepEqual(invoices, []);
  assert.match(errors[0], /无法唯一关联/);
});

test('预置的唯一同名文字摘录可关联附件，缺 id 且仅有一个文字来源时也可关联', () => {
  const email = emailFixture();
  email.attachments = [{ filename: '预置合成发票.pdf', contentType: 'application/pdf' }];
  email.attachmentTexts = [{ filename: '预置合成发票.pdf', kind: 'pdf', text: '发票号码 00001234 价税合计 113.00' }];
  for (const input of [invoice({ attachmentId: undefined, filename: '预置合成发票.pdf' }),
    invoice({ attachmentId: undefined })]) {
    const { invoices, errors } = normalizeInvoices([input], email);
    assert.deepEqual(errors, []);
    assert.equal(invoices[0].attachmentId, 'attachment-1');
    assert.equal(invoices[0].attachmentName, '预置合成发票.pdf');
  }
});

test('同名附件用明确 id 分开定位，只给重复文件名时不猜附件', () => {
  const email = emailFixture();
  email.attachments[1].filename = email.attachments[0].filename;
  email.attachmentTexts[1].filename = email.attachmentTexts[0].filename;
  const explicit = normalizeInvoices([invoice(), invoice({ attachmentId: 'mail-opaque-attachment-b', invoiceNumber: '00005678' })], email);
  assert.deepEqual(explicit.errors, []);
  assert.equal(explicit.invoices.length, 2);
  const missing = normalizeInvoices([invoice({ attachmentId: undefined, filename: '合成发票.pdf' })], email);
  assert.deepEqual(missing.invoices, []);
  assert.match(missing.errors[0], /无法唯一关联/);
  // A filename remains ambiguous even if only one of the identically named files was extracted.
  email.attachmentTexts.pop();
  assert.equal(normalizeInvoices([invoice({ attachmentId: undefined, filename: '合成发票.pdf' })], email).invoices.length, 0);
});

test('没有可读 PDF/图片文字的附件或虚构摘录来源不能生成发票', () => {
  const variations = [
    { attachmentTexts: [] },
    { attachmentTexts: [{ attachmentId: 'mail-opaque-attachment-a', kind: 'pdf', text: '   ' }] },
    { attachmentTexts: [{ attachmentId: 'mail-opaque-attachment-a', kind: 'plain', text: '普通文本' }] },
    { attachmentTexts: [{ attachmentId: 'invented-id', filename: '合成发票.pdf', kind: 'pdf', text: '发票号码 00001234' }] },
    { attachments: [] },
  ];
  for (const variation of variations) {
    const result = normalizeInvoices([invoice()], { ...emailFixture(), ...variation });
    assert.deepEqual(result.invoices, []);
    assert.match(result.errors[0], /无法唯一关联/);
  }
});

test('有限 JSON 数字兼容转字符串且零不丢，字符串金额不重新格式化', () => {
  const result = normalizeInvoices([invoice({ amount: 0, taxAmount: 0, totalAmount: 12.5,
    items: [{ name: '合成项目', quantity: 0, unitPrice: '0.000000', amount: 0, taxAmount: 0 }] })], emailFixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.invoices[0].amount, '0');
  assert.equal(result.invoices[0].taxAmount, '0');
  assert.equal(result.invoices[0].totalAmount, '12.5');
  assert.equal(result.invoices[0].items[0].quantity, '0');
  assert.equal(result.invoices[0].items[0].unitPrice, '0.000000');
});

test('错误字段类型留空并给出错误，不丢弃同一张发票中其他可用字段', () => {
  const result = normalizeInvoices([invoice({ invoiceNumber: 1234, amount: { value: 100 },
    taxAmount: '未知', totalAmount: Infinity, buyerName: false,
    items: [null, { name: '合成服务费', quantity: '很多', amount: '100.00' }] })], emailFixture());
  assert.equal(result.invoices.length, 1);
  const saved = result.invoices[0];
  for (const field of ['invoiceNumber', 'amount', 'taxAmount', 'totalAmount', 'buyerName']) assert.equal(saved[field], null);
  assert.equal(saved.sellerName, '合成服务公司');
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].quantity, null);
  assert.equal(saved.items[0].amount, '100.00');
  assert.ok(result.errors.length >= 7);
  assert.ok(result.errors.some((message) => message.includes('invoiceNumber')));
  assert.ok(result.errors.some((message) => message.includes('taxAmount')));
});

test('普通邮件无发票时返回空数组，格式错误和没有实际字段的空票据有明确提示', () => {
  for (const input of [undefined, null, []]) {
    assert.deepEqual(normalizeInvoices(input, emailFixture()), { invoices: [], errors: [] });
  }
  const malformed = normalizeInvoices({}, emailFixture());
  assert.deepEqual(malformed.invoices, []);
  assert.match(malformed.errors[0], /invoices 必须是数组/);
  const result = normalizeInvoices([null, '发票', [],
    { attachmentId: 'mail-opaque-attachment-a', invoiceType: '电子发票', currency: 'CNY', notes: '合成备注', items: [{}] }], emailFixture());
  assert.deepEqual(result.invoices, []);
  assert.equal(result.errors.length, 4);
  assert.match(result.errors[3], /没有可用的发票字段/);
});

test('稳定 id 定位同一邮件和附件的号码，重复提取或调整其他附件顺序不改变 id', () => {
  const email = emailFixture();
  const first = invoice();
  const second = invoice({ attachmentId: 'mail-opaque-attachment-b', invoiceNumber: '00005678' });
  const initial = normalizeInvoices([first, second], email).invoices;
  const repeated = normalizeInvoices([second, { ...first, totalAmount: '113.01' }], email).invoices;
  assert.equal(initial[0].id, repeated[1].id);
  assert.equal(initial[1].id, repeated[0].id);
  const otherEmail = normalizeInvoices([first], { ...email, id: 'qq:invoices-fixture:100:2' }).invoices[0];
  assert.notEqual(initial[0].id, otherEmail.id);
  const otherAttachment = normalizeInvoices([{ ...first, attachmentId: 'mail-opaque-attachment-b' }], email).invoices[0];
  assert.notEqual(initial[0].id, otherAttachment.id);
});

test('缺发票号的部分票据仍可保存，各附件内多张无码票据使用稳定顺序 id', () => {
  const email = emailFixture();
  const inputs = [invoice({ invoiceNumber: null }), invoice({ invoiceNumber: null, totalAmount: '226.00' })];
  const initial = normalizeInvoices(inputs, email);
  assert.deepEqual(initial.errors, []);
  assert.equal(initial.invoices.length, 2);
  assert.notEqual(initial.invoices[0].id, initial.invoices[1].id);
  const withOtherAttachment = normalizeInvoices([
    invoice({ attachmentId: 'mail-opaque-attachment-b', invoiceNumber: null }), ...inputs,
  ], email).invoices;
  assert.deepEqual(withOtherAttachment.slice(1).map((item) => item.id), initial.invoices.map((item) => item.id));
  assert.deepEqual(normalizeInvoices(inputs, email).invoices, initial.invoices);
});
