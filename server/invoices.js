import { createHash } from 'node:crypto';

export const INVOICE_EXTRACTION_RULES = `发票报销提取规则（与前文不一致时，以本节为准）：
本次 JSON 对象还必须包含 invoices 数组。邮件 category=invoice 的中文名称为“发票报销”，独立 intent 增加 invoice（发票报销）；以发票交付、发票信息或报销为主要目的时，category 和 intent 均返回 invoice，并强制 events:[]、tasks:[]。这类邮件不创建日程或待办，包括正文催报销、提供报销期限的邮件。
只从 attachmentTexts 中明确可辨认的 PDF 或图片发票文字提取 invoices，不从邮件主题、正文、发件人、附件文件名或现有日程猜测任何发票字段；这些上下文只用于邮件分类。正文提到发票、开票申请、普通广告、订单确认、付款提醒本身不代表已有发票；没有实际发票附件内容时返回 invoices:[]。只有发票类型或备注、没有任何实际票据信息时也返回 []。
一份附件可以含多张发票，逐张返回；每张必须填写 attachmentId，直接取对应 attachmentTexts 的 attachmentId，并与邮件 attachments 中的 id 对应，不能虚构或跨附件合并字段。
invoices 每项为 {"attachmentId":"对应来源附件的 id","invoiceType":null,"invoiceNumber":null,"invoiceCode":null,"invoiceDate":null,"buyerName":null,"buyerTaxId":null,"sellerName":null,"sellerTaxId":null,"amount":null,"taxAmount":null,"totalAmount":null,"currency":null,"items":[{"name":null,"specification":null,"unit":null,"quantity":null,"unitPrice":null,"amount":null,"taxRate":null,"taxAmount":null}],"notes":null}。
invoiceType 为附件上明确标注的发票类型；invoiceNumber 为发票号码，invoiceCode 为发票代码；invoiceDate 为附件上明确的开票日期，格式 YYYY-MM-DD。buyerName/buyerTaxId 是购买方名称/纳税人识别号，sellerName/sellerTaxId 是销售方名称/纳税人识别号。amount 为票面不含税金额合计，taxAmount 为税额合计，totalAmount 为价税合计，currency 只在票面明确币种或货币符号时填写。
发票号码、代码、税号及全部普通文本字段必须为字符串或 null，保留前导零。金额、数量和单价必须为十进制字符串或 null（例如 "100.00"、"0.130000"，不输出 JSON 数字），去掉货币符号和千分位分隔但保留原有小数位精度；不要计算、相加、推导或用别的字段补齐缺失金额。税率 taxRate 保留票面字符串（如 "13%"、"免税"），不自行换算。items 保留附件上明确的货物/服务明细；没有明细则为 []，没有的字段一律 null，不编造空明细。notes 仅保存票面明确的备注。OCR 不清楚或没有出现的字段为 null，不能用邮件正文或常识补全。`;

const TEXT_FIELDS = [
  'invoiceType', 'invoiceNumber', 'invoiceCode', 'invoiceDate',
  'buyerName', 'buyerTaxId', 'sellerName', 'sellerTaxId', 'currency', 'notes',
];
const AMOUNT_FIELDS = ['amount', 'taxAmount', 'totalAmount'];
const ITEM_TEXT_FIELDS = ['name', 'specification', 'unit', 'taxRate'];
const ITEM_NUMBER_FIELDS = ['quantity', 'unitPrice', 'amount', 'taxAmount'];
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const SUPPORTED_TEXT_KINDS = new Set(['pdf', 'image', 'image_ocr']);

function stringField(value, field, errors, label, decimal = false) {
  if (value === undefined || value === null || value === '') return null;
  // Older or less strict models may return JSON numbers; string input preserves precision.
  if (decimal && typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') {
    errors.push(`${label}：${field} 必须为字符串，已留空。`);
    return null;
  }
  const text = value.trim();
  if (!text) return null;
  if (decimal && !DECIMAL.test(text)) {
    errors.push(`${label}：${field} 不是有效的十进制字符串，已留空。`);
    return null;
  }
  return text;
}

function attachmentSources(email) {
  const attachments = (email.attachments || []).map((item, index) => ({
    ...item, id: item.id || `attachment-${index + 1}`,
  }));
  const sources = new Map();
  for (const text of email.attachmentTexts || []) {
    if (!SUPPORTED_TEXT_KINDS.has(text.kind) || typeof text.text !== 'string' || !text.text.trim()) continue;
    // A named, pre-extracted attachment is also supported; no file bytes are needed here.
    const matches = text.attachmentId
      ? attachments.filter((attachment) => attachment.id === text.attachmentId)
      : attachments.filter((attachment) => attachment.filename === text.filename);
    if (matches.length === 1) {
      const attachment = matches[0];
      sources.set(attachment.id, { ...attachment,
        uniqueFilename: attachments.filter((item) => item.filename === attachment.filename).length === 1 });
    }
  }
  return [...sources.values()];
}

function resolveAttachment(raw, sources) {
  if (raw.attachmentId !== undefined && raw.attachmentId !== null && raw.attachmentId !== '') {
    return sources.find((source) => source.id === raw.attachmentId) || null;
  }
  const filename = raw.attachmentName || raw.filename;
  if (filename) {
    const matches = sources.filter((source) => source.filename === filename);
    return matches.length === 1 && matches[0].uniqueFilename ? matches[0] : null;
  }
  return sources.length === 1 ? sources[0] : null;
}

function normalizeItems(rawItems, errors, label) {
  if (rawItems === undefined || rawItems === null) return [];
  if (!Array.isArray(rawItems)) {
    errors.push(`${label}：items 必须为数组，已留空。`);
    return [];
  }
  const items = [];
  for (const [index, raw] of rawItems.entries()) {
    const itemLabel = `${label}第 ${index + 1} 项明细`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${itemLabel}：明细必须为对象，已忽略。`);
      continue;
    }
    const item = {};
    for (const field of ITEM_TEXT_FIELDS) item[field] = stringField(raw[field], field, errors, itemLabel);
    for (const field of ITEM_NUMBER_FIELDS) item[field] = stringField(raw[field], field, errors, itemLabel, true);
    if (Object.values(item).some((value) => value !== null)) items.push(item);
  }
  return items;
}

function invoiceId(emailId, attachmentId, invoice, ordinal) {
  const identity = invoice.invoiceNumber
    ? ['number', invoice.invoiceCode, invoice.invoiceNumber]
    : ['position', ordinal];
  const hash = createHash('sha256').update(JSON.stringify([emailId, attachmentId, ...identity])).digest('hex').slice(0, 24);
  return `invoice-${hash}`;
}

/** Normalize model fields without calculating amounts or guessing attachment provenance. */
export function normalizeInvoices(rawInvoices, email) {
  const invoices = [];
  const errors = [];
  if (rawInvoices === undefined || rawInvoices === null) return { invoices, errors };
  if (!Array.isArray(rawInvoices)) {
    return { invoices, errors: ['模型返回格式不正确：invoices 必须是数组。'] };
  }
  const sources = attachmentSources(email);
  const sourceOrdinals = new Map();
  const seen = new Set();
  for (const [index, raw] of rawInvoices.entries()) {
    const label = `第 ${index + 1} 张发票`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label}：发票必须为对象，已忽略。`);
      continue;
    }
    const attachment = resolveAttachment(raw, sources);
    if (!attachment) {
      errors.push(`${label}：无法唯一关联已识别文字的 PDF/图片附件，已忽略。`);
      continue;
    }
    const invoice = { attachmentId: attachment.id, attachmentName: attachment.filename || null };
    for (const field of TEXT_FIELDS) invoice[field] = stringField(raw[field], field, errors, label);
    for (const field of AMOUNT_FIELDS) invoice[field] = stringField(raw[field], field, errors, label, true);
    invoice.items = normalizeItems(raw.items, errors, label);
    const usefulFields = [...TEXT_FIELDS.filter((field) => !['invoiceType', 'currency', 'notes'].includes(field)), ...AMOUNT_FIELDS];
    if (!usefulFields.some((field) => invoice[field] !== null) && !invoice.items.length) {
      errors.push(`${label}：没有可用的发票字段，已忽略。`);
      continue;
    }
    const ordinal = (sourceOrdinals.get(attachment.id) || 0) + 1;
    sourceOrdinals.set(attachment.id, ordinal);
    invoice.id = invoiceId(email.id, attachment.id, invoice, ordinal);
    if (seen.has(invoice.id)) continue;
    seen.add(invoice.id);
    invoices.push(invoice);
  }
  return { invoices, errors };
}
