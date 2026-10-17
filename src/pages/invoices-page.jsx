import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, ArrowUpRight, CheckCheck, Copy, FileSearch, Inbox, LoaderCircle,
  Mail, ReceiptText, Search, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { AttachmentList } from '@/components/attachment-viewer';
import { InvoiceExtractButton } from '@/components/invoice-email-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/context/workspace';
import {
  INVOICE_FIELDS, INVOICE_ITEM_FIELDS, formatInvoiceAmount, hasInvoiceValue, invoiceCopyText,
  invoiceRows, invoiceStatus, invoiceTotals,
} from '@/lib/invoices';
import { request } from '@/lib/api';
import { fullDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';

async function copyInvoiceText(value, label) {
  try {
    await navigator.clipboard.writeText(String(value));
    toast.success(`${label}已复制`);
  } catch {
    toast.error('复制失败，请选中文字手动复制');
  }
}

function CopyButton({ value, label, className }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className={cn('shrink-0 text-muted-foreground', className)}
      disabled={!hasInvoiceValue(value)}
      title={`复制${label}`}
      aria-label={`复制${label}`}
      onClick={() => copyInvoiceText(value, label)}
    >
      <Copy className="size-3" />
    </Button>
  );
}

function InvoiceField({ invoice, field, monetary = false }) {
  const [key, label] = field;
  const value = invoice[key];
  return (
    <div className="min-w-0 rounded-lg bg-muted/35 px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-start justify-between gap-2 text-sm">
        <span className={cn('min-w-0 select-text break-all', monetary && 'font-medium tabular-nums', !hasInvoiceValue(value) && 'text-muted-foreground')}>
          {hasInvoiceValue(value) ? (monetary ? formatInvoiceAmount(value) : value) : '未识别'}
        </span>
        <CopyButton value={value} label={label} />
      </dd>
    </div>
  );
}

function InvoiceDetail({ row }) {
  const { openEmail } = useWorkspace();
  const { invoice, email, mailboxId } = row;
  const status = invoiceStatus(email);
  const sourceAttachment = invoice && (email.attachments || []).find((attachment) => attachment.id === invoice.attachmentId);
  const fields = (keys) => INVOICE_FIELDS.filter(([key]) => keys.includes(key));
  return (
    <Card className="min-w-0 gap-5 overflow-hidden">
      <CardHeader className="gap-3 pb-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <Badge variant="outline">发票报销</Badge>
          {email.mailboxTag && <Badge variant="outline">{email.mailboxTag}</Badge>}
          {email.mode?.startsWith('demo') && <Badge variant="outline">示例 · 预置结果</Badge>}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="text-xl leading-snug break-words">{invoice?.invoiceType || (invoice ? '发票信息' : '发票邮件')}</CardTitle>
            <CardDescription className="break-all">{invoice?.attachmentName || email.subject}</CardDescription>
          </div>
          {invoice && (
            <Button size="sm" onClick={() => copyInvoiceText(invoiceCopyText(invoice, email), '整张发票信息')}>
              <Copy className="size-3.5" />复制整张信息
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => openEmail(email.id, mailboxId)}>
            <Mail className="size-3.5" />查看原邮件<ArrowUpRight className="size-3.5" />
          </Button>
          <InvoiceExtractButton email={email} />
        </div>
      </CardHeader>

      <CardContent className="min-w-0 space-y-5">
        {(email.invoiceStatus === 'partial' || email.invoiceStatus === 'failed' || email.invoiceErrors?.length > 0) && (
          <div className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/25" role="status">
            <p className="flex items-start gap-2 text-sm font-medium"><AlertTriangle className="mt-0.5 size-4 shrink-0" />部分信息需要重新提取或核对原件</p>
            {email.invoiceErrors?.map((error, index) => <p key={index} className="text-xs leading-relaxed break-words text-muted-foreground">{error}</p>)}
          </div>
        )}

        {invoice ? (
          <>
            <div className="rounded-xl border border-primary/15 bg-primary/5 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">价税合计</span>
                <CopyButton value={invoice.totalAmount} label="价税合计" />
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="select-text text-3xl font-semibold tracking-tight tabular-nums break-all">{formatInvoiceAmount(invoice.totalAmount)}</span>
                <span className="text-sm text-muted-foreground">{invoice.currency || '币种未识别'}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">由附件提取，请对照原件核对后用于报销。未识别的字段显示为「未识别」。</p>
            </div>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">发票信息</h3>
              <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
                {fields(['invoiceNumber', 'invoiceCode', 'invoiceDate', 'currency']).map((field) => <InvoiceField key={field[0]} invoice={invoice} field={field} />)}
                <InvoiceField invoice={invoice} field={INVOICE_FIELDS[0]} />
              </dl>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">购销双方</h3>
              <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
                {fields(['buyerName', 'buyerTaxId', 'sellerName', 'sellerTaxId']).map((field) => <InvoiceField key={field[0]} invoice={invoice} field={field} />)}
              </dl>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">金额与税额 <span className="ml-1 text-xs font-normal text-muted-foreground">{invoice.currency || '币种未识别'}</span></h3>
              <dl className="grid min-w-0 gap-2 sm:grid-cols-3">
                {fields(['amount', 'taxAmount', 'totalAmount']).map((field) => <InvoiceField key={field[0]} invoice={invoice} field={field} monetary />)}
              </dl>
            </section>

            <section className="min-w-0 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">项目明细</h3>
                <span className="text-xs text-muted-foreground">{invoice.items?.length || 0} 项</span>
              </div>
              {invoice.items?.length ? (
                <div className="min-w-0 rounded-lg border">
                  <Table>
                    <TableHeader><TableRow>{INVOICE_ITEM_FIELDS.map(([key, label]) => <TableHead key={key} className="text-xs">{label}</TableHead>)}</TableRow></TableHeader>
                    <TableBody>
                      {invoice.items.map((item, index) => (
                        <TableRow key={index}>
                          {INVOICE_ITEM_FIELDS.map(([key, label]) => (
                            <TableCell key={key} className="text-xs">
                              <div className="flex items-start gap-1">
                                <span className={cn('max-w-52 select-text whitespace-normal break-words', !hasInvoiceValue(item[key]) && 'text-muted-foreground')}>
                                  {hasInvoiceValue(item[key]) ? item[key] : '未识别'}
                                </span>
                                <CopyButton value={item[key]} label={`第 ${index + 1} 项${label}`} />
                              </div>
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">未识别到项目明细，可查看原附件。</p>}
            </section>

            {hasInvoiceValue(invoice.notes) && (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">备注</h3><CopyButton value={invoice.notes} label="备注" /></div>
                <p className="select-text rounded-lg bg-muted/35 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">{invoice.notes}</p>
              </section>
            )}
          </>
        ) : (
          <div className="space-y-3 rounded-xl border border-dashed bg-muted/20 p-5">
            <FileSearch className="size-7 text-muted-foreground" />
            <h3 className="text-sm font-medium">{email.invoiceStatus === 'empty' ? '附件中未识别到发票' : email.invoiceStatus === 'failed' ? '发票提取未完成' : '这封邮件尚未提取发票信息'}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {email.attachments?.length ? '可查看原邮件和附件，或点击上方按钮从已保存的 PDF / 图片提取发票字段。' : '这封邮件没有已保存的附件，可查看原邮件确认发票内容。'}
            </p>
          </div>
        )}

        <Separator />
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{invoice ? '原始发票附件' : '邮件附件'}</h3>
          {invoice && !sourceAttachment ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">未找到与这张票据匹配的已保存附件。可打开原邮件核对，或查看该邮件的其他附件。</p>
              <AttachmentList attachments={email.attachments || []} />
            </div>
          ) : email.attachments?.length ? (
            <AttachmentList attachments={sourceAttachment ? [sourceAttachment] : email.attachments} />
          ) : <p className="text-sm text-muted-foreground">无已保存附件</p>}
        </section>
        <section className="space-y-1.5 rounded-lg bg-muted/30 p-3">
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Inbox className="size-3.5" />来源邮件</p>
          <button type="button" className="block w-full text-left text-sm font-medium break-words hover:text-primary" onClick={() => openEmail(email.id, mailboxId)}>{email.subject || '无主题'}</button>
          <p className="text-xs break-all text-muted-foreground">{email.sender}</p>
          <p className="text-xs text-muted-foreground">{fullDateTime(email.receivedAt)}{email.mailboxEmail ? ` · ${email.mailboxEmail}` : ''}</p>
        </section>
      </CardContent>
    </Card>
  );
}

export default function InvoicesPage({ embedded = false, mailboxIds: boundMailboxIds = [] } = {}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { emails, state, isSyncing, isMixedView, sync } = useWorkspace();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [boundEmails, setBoundEmails] = useState(null);
  const [boundError, setBoundError] = useState('');
  const boundKey = boundMailboxIds.join(',');
  const activeMailboxId = state.settings.activeMailboxId || '';
  useEffect(() => {
    if (!boundKey) {
      setBoundEmails(null);
      setBoundError('');
      return undefined;
    }
    let cancelled = false;
    Promise.all(boundMailboxIds.map((id) => request(`/state?mailbox=${encodeURIComponent(id)}`)))
      .then((results) => {
        if (cancelled) return;
        setBoundError('');
        setBoundEmails(results.flatMap((item) => item.emails || []));
      })
      .catch((error) => {
        if (!cancelled) setBoundError(error.message || '无法读取绑定邮箱');
      });
    return () => { cancelled = true; };
  }, [boundKey, state]);
  const sourceEmails = boundKey ? (boundEmails || []) : emails;
  const rows = useMemo(() => invoiceRows(sourceEmails, boundMailboxIds[0] || activeMailboxId), [sourceEmails, boundKey, activeMailboxId]);
  const invoices = useMemo(() => rows.flatMap((row) => row.invoice ? [row.invoice] : []), [rows]);
  const summary = useMemo(() => invoiceTotals(invoices), [invoices]);
  const sourceCount = new Set(rows.filter((row) => row.invoice).map((row) => `${row.mailboxId}:${row.email.id}`)).size;
  const attentionCount = new Set(rows.filter((row) => !row.invoice || ['partial', 'failed'].includes(row.email.invoiceStatus))
    .map((row) => `${row.mailboxId}:${row.email.id}`)).size;
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'extracted' && !row.invoice) return false;
      if (filter === 'attention' && row.invoice && !['partial', 'failed'].includes(row.email.invoiceStatus)) return false;
      if (!needle) return true;
      const text = [row.email.subject, row.email.sender, row.email.mailboxEmail, row.invoice?.attachmentName,
        ...INVOICE_FIELDS.map(([key]) => row.invoice?.[key]), row.invoice?.notes,
        ...(row.invoice?.items || []).flatMap((item) => INVOICE_ITEM_FIELDS.map(([key]) => item[key]))].join(' ');
      return text.toLowerCase().includes(needle);
    });
  }, [rows, query, filter]);

  const invoiceId = params.get('invoice');
  const sourceId = params.get('source');
  const mailboxId = params.get('mailbox');
  const linkedRow = rows.find((row) => row.invoice?.id === invoiceId && (!mailboxId || row.mailboxId === mailboxId))
    || (sourceId ? rows.find((row) => row.email.id === sourceId && (!mailboxId || row.mailboxId === mailboxId)) : null);
  const selected = visibleRows.find((row) => row.key === linkedRow?.key) || visibleRows[0];

  function selectRow(row) {
    const next = new URLSearchParams(params);
    next.delete('email');
    if (row.invoice) next.set('invoice', row.invoice.id);
    else next.delete('invoice');
    next.set('source', row.email.id);
    if (row.mailboxId) next.set('mailbox', row.mailboxId);
    setParams(next, { replace: true });
  }

  async function syncMail() {
    const result = await sync('qq');
    if (result?.needSettings) navigate('/app/settings');
  }

  return (
    <div className="@container mx-auto w-full max-w-5xl min-w-0 space-y-5">
      {!embedded && (
      <>
      <Link to="/app/workbenches" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />我的工作台</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><ReceiptText className="size-6 text-primary" />发票助手</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">从邮件 PDF 和图片附件提取发票，复制所需字段，快速准备报销。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><Link to="/app/mail"><Inbox className="size-3.5" />邮件助手</Link></Button>
          <Button size="sm" disabled={isSyncing || isMixedView} onClick={() => syncMail().catch(() => {})} title={isMixedView ? '切换到单个邮箱后同步' : '同步当前邮箱'}>
            {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}同步邮箱
          </Button>
        </div>
      </div>
      </>
      )}
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{boundKey && !boundMailboxIds.includes(activeMailboxId) ? '这里显示工作台绑定邮箱里的发票。同步只处理顶栏当前邮箱。' : '这里显示工作台绑定邮箱里的发票。'}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild><Link to="/app/mail"><Inbox className="size-3.5" />邮件助手</Link></Button>
            <Button size="sm" disabled={isSyncing || isMixedView || (Boolean(boundKey) && !boundMailboxIds.includes(activeMailboxId))} onClick={() => syncMail().catch(() => {})} title={isMixedView ? '切换到单个邮箱后同步' : boundKey && !boundMailboxIds.includes(activeMailboxId) ? '请先在顶栏切换到该工作台绑定的邮箱' : '同步当前邮箱'}>
              {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}同步邮箱
            </Button>
          </div>
        </div>
      )}
      {boundError && <p className="text-sm text-destructive">{boundError}</p>}
      {boundKey && !boundEmails && !boundError && <p className="text-sm text-muted-foreground">正在读取绑定邮箱…</p>}

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4"><CardDescription className="flex items-center gap-2"><ReceiptText className="size-3.5" />已提取发票</CardDescription></CardHeader>
          <CardContent className="px-4"><p className="text-2xl font-semibold tabular-nums">{invoices.length}<span className="ml-1.5 text-sm font-normal text-muted-foreground">张</span></p><p className="mt-1 text-xs text-muted-foreground">来自 {sourceCount} 封发票邮件</p></CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-4"><CardDescription className="flex items-center gap-2"><Wallet className="size-3.5" />价税合计 · 按币种</CardDescription></CardHeader>
          <CardContent className="space-y-1 px-4">
            {summary.totals.length ? summary.totals.map((total) => <p key={total.currency} className="text-lg font-semibold tabular-nums break-all">{formatInvoiceAmount(total.amount)}<span className="ml-2 text-xs font-normal text-muted-foreground">{total.currency}</span></p>) : <p className="text-2xl text-muted-foreground">—</p>}
            <p className="text-xs text-muted-foreground">{summary.missingCount ? `${summary.missingCount} 张金额或币种未识别，未计入合计` : '按已识别价税合计汇总'}</p>
          </CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-4"><CardDescription className="flex items-center gap-2"><FileSearch className="size-3.5" />待查看邮件</CardDescription></CardHeader>
          <CardContent className="px-4"><p className="text-2xl font-semibold tabular-nums">{attentionCount}<span className="ml-1.5 text-sm font-normal text-muted-foreground">封</span></p><p className="mt-1 text-xs text-muted-foreground">待提取、未识别或部分失败</p></CardContent>
        </Card>
      </div>

      {(invoiceId || sourceId) && !linkedRow && (
        <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">链接中的发票不在当前邮箱视图中。请切换到来源邮箱，或查看当前票据。</p>
      )}

      {!rows.length ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10"><ReceiptText className="size-7 text-primary" /></div>
            <h2 className="text-lg font-medium">让发票信息触手可及</h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">同步含发票 PDF 或图片附件的邮件，识别后会在这里集中展示。历史发票邮件可从邮件详情手动提取。</p>
            <Button size="sm" variant="outline" asChild><Link to="/app/mail"><Mail className="size-3.5" />查看邮件</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <Card className="min-w-0 gap-4 @5xl:sticky @5xl:top-0">
            <CardHeader className="gap-3 px-4">
              <div className="flex items-center justify-between gap-2"><CardTitle className="text-base">票据与来源</CardTitle><Badge variant="secondary">{visibleRows.length}</Badge></div>
              <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索票号、购销方、邮件…" aria-label="搜索发票" className="pl-9" /></div>
              <Select value={filter} onValueChange={setFilter}><SelectTrigger className="w-full" aria-label="筛选发票"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部发票邮件</SelectItem><SelectItem value="extracted">有提取结果</SelectItem><SelectItem value="attention">待查看邮件</SelectItem></SelectContent></Select>
            </CardHeader>
            <CardContent className="px-2">
              {visibleRows.length ? (
                <div className="max-h-80 space-y-1 overflow-y-auto px-1 @5xl:max-h-[calc(100svh-420px)] @5xl:min-h-40">
                  {visibleRows.map((row) => {
                    const status = invoiceStatus(row.email);
                    return (
                      <button
                        key={row.key}
                        type="button"
                        aria-pressed={selected?.key === row.key}
                        onClick={() => selectRow(row)}
                        className={cn('w-full space-y-2 rounded-lg border px-3 py-3 text-left transition-colors', selected?.key === row.key ? 'border-primary/35 bg-primary/8' : 'border-transparent hover:bg-muted/50')}
                      >
                        <div className="flex items-start justify-between gap-2"><span className="line-clamp-2 min-w-0 text-sm font-medium break-all">{row.invoice?.sellerName || row.invoice?.invoiceType || row.email.subject || '发票邮件'}</span><ReceiptText className={cn('mt-0.5 size-4 shrink-0', selected?.key === row.key ? 'text-primary' : 'text-muted-foreground')} /></div>
                        {row.invoice ? <p className="text-base font-semibold tabular-nums break-all">{formatInvoiceAmount(row.invoice.totalAmount)} <span className="text-xs font-normal text-muted-foreground">{row.invoice.currency || '币种未识别'}</span></p> : <p className="text-xs text-muted-foreground">查看原件并尝试提取</p>}
                        <p className="truncate text-xs text-muted-foreground">{row.invoice?.invoiceNumber ? `票号 ${row.invoice.invoiceNumber}` : row.invoice?.attachmentName || row.email.sender}</p>
                        <div className="flex flex-wrap gap-1"><Badge variant={status.variant}>{status.label}</Badge>{row.invoice?.invoiceDate && <span className="py-0.5 text-xs text-muted-foreground">{row.invoice.invoiceDate}</span>}{row.email.mailboxTag && <Badge variant="outline">{row.email.mailboxTag}</Badge>}</div>
                      </button>
                    );
                  })}
                </div>
              ) : <div className="space-y-2 py-8 text-center text-sm text-muted-foreground"><CheckCheck className="mx-auto size-5" /><p>{filter === 'attention' && !query ? '当前没有待查看的发票邮件' : '没有匹配的票据'}</p></div>}
            </CardContent>
          </Card>
          {selected ? <InvoiceDetail key={selected.key} row={selected} /> : <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">调整搜索词或筛选条件后查看票据。</div>}
        </div>
      )}
    </div>
  );
}
