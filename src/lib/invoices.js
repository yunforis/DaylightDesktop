export const INVOICE_FIELDS = [
  ['invoiceType', '发票类型'], ['invoiceNumber', '发票号码'], ['invoiceCode', '发票代码'],
  ['invoiceDate', '开票日期'], ['currency', '币种'],
  ['buyerName', '购买方名称'], ['buyerTaxId', '购买方税号'],
  ['sellerName', '销售方名称'], ['sellerTaxId', '销售方税号'],
  ['amount', '不含税金额'], ['taxAmount', '税额'], ['totalAmount', '价税合计'],
];

export const INVOICE_ITEM_FIELDS = [
  ['name', '项目名称'], ['specification', '规格型号'], ['unit', '单位'],
  ['quantity', '数量'], ['unitPrice', '单价'], ['amount', '金额'],
  ['taxRate', '税率'], ['taxAmount', '税额'],
];

export function hasInvoiceValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function invoiceMailboxId(email, activeMailboxId = '') {
  return email.mailboxId || activeMailboxId;
}

export function invoiceHref(email, invoice, activeMailboxId = '') {
  const params = new URLSearchParams({ source: email.id });
  if (invoice?.id) params.set('invoice', invoice.id);
  const mailboxId = invoiceMailboxId(email, activeMailboxId);
  if (mailboxId) params.set('mailbox', mailboxId);
  return `/app/invoices?${params}`;
}

export function invoiceRows(emails, activeMailboxId = '') {
  return emails.filter((email) => (email.category || email.extraction?.category) === 'invoice'
    || email.extraction?.invoices?.length).flatMap((email) => {
    const invoices = email.extraction?.invoices || [];
    const mailboxId = invoiceMailboxId(email, activeMailboxId);
    return (invoices.length ? invoices : [null]).map((invoice) => ({
      key: `${mailboxId}:${invoice?.id || `email:${email.id}`}`,
      email, invoice, mailboxId,
    }));
  });
}

export function invoiceStatus(email) {
  if (email.invoiceStatus === 'partial') return { label: '部分提取', variant: 'outline' };
  if (email.invoiceStatus === 'failed') return { label: '提取失败', variant: 'destructive' };
  if (email.extraction?.invoices?.length) return { label: '已提取', variant: 'secondary' };
  if (email.invoiceStatus === 'empty') return { label: '未识别到发票', variant: 'outline' };
  return { label: '待提取', variant: 'outline' };
}

function decimalParts(value) {
  if (!hasInvoiceValue(value)) return null;
  const match = String(value).trim().match(/^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/);
  if (!match) return null;
  return { negative: match[1] === '-', whole: match[2] || '0', fraction: match[3] || match[4] || '' };
}

// 金额保持十进制字符串，汇总也不经过 JavaScript 浮点数。
export function sumInvoiceAmounts(values) {
  const parts = values.map(decimalParts).filter(Boolean);
  if (!parts.length) return null;
  const scale = Math.max(2, ...parts.map((part) => part.fraction.length));
  const total = parts.reduce((sum, part) => {
    const amount = BigInt(`${part.whole}${part.fraction.padEnd(scale, '0')}`);
    return sum + (part.negative ? -amount : amount);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  return `${total < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function invoiceTotals(invoices) {
  const currencies = new Map();
  let missingCount = 0;
  for (const invoice of invoices) {
    if (!hasInvoiceValue(invoice.currency) || !decimalParts(invoice.totalAmount)) {
      missingCount += 1;
      continue;
    }
    const values = currencies.get(invoice.currency) || [];
    values.push(invoice.totalAmount);
    currencies.set(invoice.currency, values);
  }
  return {
    totals: [...currencies].map(([currency, values]) => ({
      currency, amount: sumInvoiceAmounts(values), count: values.length,
    })),
    missingCount,
  };
}

export function formatInvoiceAmount(value) {
  const parts = decimalParts(value);
  if (!parts) return hasInvoiceValue(value) ? String(value) : '—';
  const whole = parts.whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${parts.negative ? '-' : ''}${whole}.${parts.fraction.padEnd(2, '0')}`;
}

export function invoiceCopyText(invoice, email) {
  return [
    '发票信息',
    ...INVOICE_FIELDS.map(([key, label]) => `${label}：${hasInvoiceValue(invoice[key]) ? invoice[key] : '未识别'}`),
    '',
    '项目明细',
    ...(invoice.items?.length ? [
      INVOICE_ITEM_FIELDS.map(([, label]) => label).join('\t'),
      ...invoice.items.map((item) => INVOICE_ITEM_FIELDS
        .map(([key]) => hasInvoiceValue(item[key]) ? item[key] : '未识别').join('\t')),
    ] : ['未识别到项目明细']),
    ...(hasInvoiceValue(invoice.notes) ? ['', `备注：${invoice.notes}`] : []),
    '',
    `原附件：${invoice.attachmentName || '未记录'}`,
    `来源邮件：${email.subject || email.id}`,
    `发件人：${email.sender || '未记录'}`,
  ].join('\n');
}
