import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, LoaderCircle, ReceiptText, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/context/workspace';
import { formatInvoiceAmount, invoiceHref, invoiceStatus } from '@/lib/invoices';

export function InvoiceExtractButton({ email, size = 'sm' }) {
  const navigate = useNavigate();
  const { state, invoiceExtracting, extractInvoices, closeEmail } = useWorkspace();
  const mailboxId = email.mailboxId || state.settings.activeMailboxId || '';
  const busy = invoiceExtracting === `${mailboxId}:${email.id}`;
  const hasAttachments = Boolean(email.attachments?.length);
  const configured = state.settings.modelReady;
  return (
    <Button
      size={size}
      variant="outline"
      disabled={Boolean(invoiceExtracting) || !hasAttachments}
      title={hasAttachments ? '读取已保存的附件并调用已配置的模型' : '这封邮件没有已保存的附件'}
      onClick={() => {
        if (!configured) { closeEmail(); navigate('/app/settings'); }
        else extractInvoices(email).catch(() => {});
      }}
    >
      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      {busy ? '正在提取…' : !configured ? '配置模型后提取' : email.invoiceStatus || email.extraction?.invoices?.length ? '重新提取' : '提取发票'}
    </Button>
  );
}

export function EmailInvoiceSummary({ email }) {
  const navigate = useNavigate();
  const { state, closeEmail } = useWorkspace();
  const invoices = email.extraction?.invoices || [];
  const status = invoiceStatus(email);
  function openInvoice(invoice) {
    closeEmail();
    navigate(invoiceHref(email, invoice, state.settings.activeMailboxId));
  }
  return (
    <section className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium"><ReceiptText className="size-4" />发票报销</h3>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        发票信息保存到发票助手，可复制报销字段；提取结果请对照原件核对。
      </p>
      {invoices.length ? (
        <div className="space-y-2">
          {invoices.map((invoice) => (
            <button
              key={invoice.id}
              type="button"
              className="flex w-full items-start justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left hover:bg-muted/50"
              onClick={() => openInvoice(invoice)}
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium break-words">{invoice.sellerName || invoice.invoiceType || '发票'}</div>
                <div className="text-xs text-muted-foreground break-all">发票号码：{invoice.invoiceNumber || '未识别'}</div>
                <div className="text-sm font-medium tabular-nums">{formatInvoiceAmount(invoice.totalAmount)} {invoice.currency || ''}</div>
              </div>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {email.invoiceStatus === 'empty' ? '未在附件中识别到发票。' : email.invoiceStatus === 'failed' ? '本次提取未完成，可查看原件后重试。' : '这封邮件还没有结构化发票结果，可从已保存附件提取。'}
        </p>
      )}
      {email.invoiceErrors?.length > 0 && (
        <div className="space-y-1 text-xs text-destructive" role="status">
          {email.invoiceErrors.map((error, index) => <p key={index}>{error}</p>)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => openInvoice(invoices[0])}><ReceiptText className="size-3.5" />查看发票助手</Button>
        <InvoiceExtractButton email={email} />
      </div>
    </section>
  );
}
