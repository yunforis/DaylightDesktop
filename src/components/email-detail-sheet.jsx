import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CalendarDays, ChevronRight, Clock3, Copy, ListTodo, Mail, ScrollText,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { AttachmentList } from '@/components/attachment-viewer';
import { EmailInvoiceSummary } from '@/components/invoice-email-summary';
import { openAttachmentViewer } from '@/lib/attachment-open';
import { EmailAttachments } from '@/Recruitment.jsx';
import { useWorkspace } from '@/context/workspace';
import { useAuthUser } from '@/lib/auth-session';
import { request } from '@/lib/api';
import {
  EMAIL_ACTIONS, EMAIL_CATEGORIES, EMAIL_INTENTS, affectedIds, createdIds, emailResult, realMailSource,
} from '@/lib/domain';
import { eventRange, fullDateTime, shanghaiDate } from '@/lib/time';
import { hasRecruitmentAccess } from '@/lib/workspace-mode';

const STATUS_LABEL = {
  skipped: '已跳过', filtered: '已过滤', needs_match: '待选择原日程',
  imported: '已导入', processed: '已处理', failed: '处理失败',
};
const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低', urgent: '紧急' };

function looksLikeHtml(value) {
  return /<(html|body|table|div|p|style|td|tr|img)\b/i.test(String(value || ''));
}

function sanitizeEmailHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<\/?(iframe|object|embed|base|link|meta)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function readablePlain(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function highlightParts(text, quote) {
  const lines = String(quote || '').split('\n').map((line) => line.trim())
    .filter((line) => line.length >= 6 && !/^(主题|发件人|摘要|附件|所属邮件)[:：]/.test(line));
  const needle = (lines.sort((a, b) => b.length - a.length)[0] || '').slice(0, 48);
  if (needle.length < 6) return [{ text, hit: false }];
  const index = text.indexOf(needle);
  if (index < 0) return [{ text, hit: false }];
  return [
    { text: text.slice(0, index), hit: false },
    { text: text.slice(index, index + needle.length), hit: true },
    { text: text.slice(index + needle.length), hit: false },
  ].filter((part) => part.text);
}

function EmailBody({ email, quote = '' }) {
  const htmlSource = looksLikeHtml(email.html) ? email.html : (looksLikeHtml(email.body) ? email.body : '');
  const plain = readablePlain(looksLikeHtml(email.body) ? '' : email.body);
  const srcDoc = useMemo(() => {
    if (!htmlSource) return '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:16px 18px;background:#fff;color:#1c1917;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}img,video{max-width:100%;height:auto;}table{max-width:100% !important;}a{color:#1d4ed8;}body>*:first-child{margin-top:0;}</style></head><body>${sanitizeEmailHtml(htmlSource)}</body></html>`;
  }, [htmlSource]);

  function fitFrame(event) {
    const frame = event.currentTarget;
    const doc = frame.contentDocument;
    const height = Math.max(doc?.body?.scrollHeight || 0, doc?.documentElement?.scrollHeight || 0);
    frame.style.height = `${Math.min(Math.max(height + 4, 200), 720)}px`;
  }

  if (!htmlSource && !plain) {
    return <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">这封邮件没有可显示的正文。</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/40 shadow-sm">
      {htmlSource ? (
        <iframe
          title="邮件正文"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          onLoad={fitFrame}
          className="block w-full border-0 bg-white"
          style={{ height: 320 }}
        />
      ) : (
        <div className="max-h-[36rem] overflow-auto bg-background px-5 py-4 text-sm leading-7 whitespace-pre-wrap break-words">
          {highlightParts(plain, quote).map((part, index) => (part.hit
            ? <mark key={index} className="rounded bg-amber-200/90 px-0.5 text-foreground">{part.text}</mark>
            : <span key={index}>{part.text}</span>))}
        </div>
      )}
    </div>
  );
}

function MetaField({ label, children, mono = false }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all ${mono ? 'font-mono text-xs leading-relaxed' : 'text-sm leading-snug'}`}>{children}</dd>
    </div>
  );
}

function Copyable({ value }) {
  if (!value) return '—';
  return (
    <span className="flex items-start gap-2">
      <span className="min-w-0 flex-1">{value}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2"
        onClick={() => navigator.clipboard.writeText(String(value)).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'))}
      >
        <Copy className="size-3.5" />复制
      </Button>
    </span>
  );
}

/** 全局邮件详情：待办 / 总览 / 邮件页均可打开并查看原文。 */
export function EmailDetailSheet() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const showRecruitment = hasRecruitmentAccess(user);
  const {
    events, tasks, closeEmail, selectedEmail, highlightQuote, setEventModal, setSelectedTraceId, traceData,
    state, reload,
  } = useWorkspace();
  const mailboxId = selectedEmail?.mailboxId || state?.settings?.activeMailboxId || '';

  const category = selectedEmail?.category || selectedEmail?.extraction?.category;
  const selectedCreated = useMemo(
    () => (selectedEmail ? events.filter((event) => createdIds(selectedEmail).includes(event.id)) : []),
    [events, selectedEmail],
  );
  const selectedAffected = useMemo(
    () => (selectedEmail ? events.filter((event) => affectedIds(selectedEmail).includes(event.id)) : []),
    [events, selectedEmail],
  );
  const selectedTasks = useMemo(
    () => (selectedEmail ? tasks.filter((task) => selectedEmail.taskIds?.includes(task.id)) : []),
    [tasks, selectedEmail],
  );
  const selectedTrace = selectedEmail
    ? traceData.traces.find((trace) => trace.trace_id === selectedEmail.trace_id)
    : null;

  return (
    <Sheet open={Boolean(selectedEmail)} onOpenChange={(open) => { if (!open) closeEmail(); }}>
      <SheetContent className="@container flex h-full w-full min-w-0 flex-col gap-0 overflow-hidden p-0 sm:w-[min(100vw,56rem)] sm:max-w-none!">
        {selectedEmail && (
          <>
            <div className="border-b px-6 py-5">
              <SheetHeader className="space-y-3 text-left">
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{emailResult(selectedEmail)}</Badge>
                  {category && <Badge variant="outline">{EMAIL_CATEGORIES[category] || category}</Badge>}
                  <Badge variant="secondary">
                    {selectedEmail.mode?.startsWith('demo') ? '示例' : realMailSource(selectedEmail)}
                  </Badge>
                </div>
                <SheetTitle className="pr-8 text-left text-xl leading-snug break-keep">
                  {selectedEmail.subject}
                </SheetTitle>
                <SheetDescription asChild>
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <div className="flex items-start gap-2">
                      <Mail className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 break-all">{selectedEmail.sender}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock3 className="size-3.5 shrink-0" />
                      <span>{fullDateTime(selectedEmail.receivedAt)}</span>
                    </div>
                  </div>
                </SheetDescription>
              </SheetHeader>
            </div>

            <ScrollArea className="min-h-0 min-w-0 flex-1">
              <div className="grid min-w-0 gap-6 px-6 py-5">
                <div className="min-w-0 space-y-6">
                  {selectedEmail.extraction?.summary && (
                    <section className="space-y-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">摘要</h3>
                      <p className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm leading-relaxed break-keep text-pretty">
                        {selectedEmail.extraction.summary}
                      </p>
                    </section>
                  )}

                  {(category === 'invoice' || selectedEmail.extraction?.invoices?.length > 0) && (
                    <EmailInvoiceSummary key={`${mailboxId}:${selectedEmail.id}`} email={selectedEmail} />
                  )}

                  {selectedEmail.conflicts?.length > 0 && (
                    <section className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <AlertTriangle className="size-4" />日程冲突
                      </div>
                      {selectedEmail.conflicts.map((conflict, index) => (
                        <div key={index} className="rounded-md border bg-background p-3 text-sm">
                          <div className="font-medium">{conflict.event.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{eventRange(conflict.event)}</div>
                        </div>
                      ))}
                    </section>
                  )}

                  {(selectedEmail.pendingActions || []).length > 0 && (
                    <PendingMatchPanel email={selectedEmail} onResolved={reload} />
                  )}

                  <section className="space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-sm font-medium">正文</h3>
                      <p className="text-xs text-muted-foreground">{looksLikeHtml(selectedEmail.html) || looksLikeHtml(selectedEmail.body) ? '按邮件版式显示，脚本不会执行。' : '纯文本'}</p>
                    </div>
                    {highlightQuote && (
                      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                        知识库命中：{highlightQuote.slice(0, 180)}
                      </p>
                    )}
                    <EmailBody email={selectedEmail} quote={highlightQuote} />
                  </section>

                  {selectedEmail.userDraft ? (
                    <section className="space-y-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">工作台回复草稿</h3>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
                        {selectedEmail.userDraft}
                      </pre>
                      <p className="text-xs text-muted-foreground">这是已保存的草稿，打开邮件不会发送。</p>
                      {selectedEmail.trace_id ? (
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/app/traces?trace=${encodeURIComponent(selectedEmail.trace_id)}`} onClick={() => { closeEmail(); setSelectedTraceId(selectedEmail.trace_id); }}>
                            在执行记录中核对
                          </Link>
                        </Button>
                      ) : null}
                    </section>
                  ) : null}

                  {showRecruitment ? (
                    <EmailAttachments
                      email={selectedEmail}
                      mailboxId={mailboxId}
                      request={request}
                      onCandidate={(id) => {
                        closeEmail();
                        navigate(`/app/recruitment?candidate=${encodeURIComponent(id)}`);
                      }}
                      onUpdated={reload}
                    />
                  ) : null}
                  {!showRecruitment && (selectedEmail.attachments || []).length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">附件</h3>
                      <AttachmentList
                        attachments={selectedEmail.attachments}
                        mailboxId={mailboxId}
                        onPreview={(file) => openAttachmentViewer(file)}
                      />
                    </section>
                  )}

                  {(selectedCreated.length > 0 || selectedAffected.length > 0 || selectedTasks.length > 0) && (
                    <>
                      <Separator />
                      <section className="grid gap-4">
                        {selectedCreated.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              <CalendarDays className="size-3.5" />新增日程
                            </div>
                            {selectedCreated.map((event) => (
                              <button
                                key={event.id}
                                type="button"
                                className="flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted/40"
                                onClick={() => { closeEmail(); setEventModal({ event, date: shanghaiDate(event.start) }); }}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{event.title}</div>
                                  <div className="text-xs text-muted-foreground">{eventRange(event)}</div>
                                </div>
                                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              </button>
                            ))}
                          </div>
                        )}
                        {selectedAffected.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              <CalendarDays className="size-3.5" />取消 / 调整的原日程
                            </div>
                            {selectedAffected.map((event) => (
                              <button
                                key={event.id}
                                type="button"
                                className="flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted/40"
                                onClick={() => { closeEmail(); setEventModal({ event, date: shanghaiDate(event.start) }); }}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{event.title}</div>
                                  <div className="text-xs text-muted-foreground">{eventRange(event)}</div>
                                </div>
                                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              </button>
                            ))}
                          </div>
                        )}
                        {selectedTasks.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              <ListTodo className="size-3.5" />关联待办
                            </div>
                            {selectedTasks.map((task) => (
                              <div key={task.id} className="rounded-lg border px-3 py-2.5 text-sm">
                                <div className="font-medium">{task.title}</div>
                                {task.description && <div className="mt-1 text-xs text-muted-foreground">{task.description}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </div>

                <section className="min-w-0 space-y-3 rounded-xl border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">完整信息与元数据</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{STATUS_LABEL[selectedEmail.status] || emailResult(selectedEmail)}</Badge>
                      <Badge variant="outline">{EMAIL_CATEGORIES[category] || category || '未分类'}</Badge>
                      <Badge variant="outline">{EMAIL_INTENTS[selectedEmail.intent || selectedEmail.extraction?.intent] || selectedEmail.intent || selectedEmail.extraction?.intent || '未识别意图'}</Badge>
                      <Badge variant="outline">{PRIORITY_LABEL[selectedEmail.priority || selectedEmail.extraction?.priority] || selectedEmail.priority || selectedEmail.extraction?.priority || '普通'}</Badge>
                    </div>
                  </div>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <MetaField label="主题">{selectedEmail.subject || '—'}</MetaField>
                    <MetaField label="发件人">{selectedEmail.sender || '—'}</MetaField>
                    <MetaField label="收件时间">{fullDateTime(selectedEmail.receivedAt)}</MetaField>
                    <MetaField label="处理时间">{fullDateTime(selectedEmail.processedAt || selectedEmail.createdAt)}</MetaField>
                    <MetaField label="来源">{selectedEmail.mode?.startsWith('demo') ? '示例邮件 · 预置提取结果' : realMailSource(selectedEmail)}</MetaField>
                    <MetaField label="日历与待办">{`新增 ${selectedCreated.length} · 取消/调整 ${selectedAffected.length} · 待办 ${selectedTasks.length}`}</MetaField>
                    <MetaField label="邮件 ID" mono><Copyable value={selectedEmail.id} /></MetaField>
                    <MetaField label="Message-ID / UID" mono><Copyable value={selectedEmail.messageId || selectedEmail.uid} /></MetaField>
                    <div className="sm:col-span-2">
                      <MetaField label="Trace" mono><Copyable value={selectedEmail.trace_id} /></MetaField>
                    </div>
                    <div className="sm:col-span-2">
                      <MetaField label="内容摘要">{selectedEmail.extraction?.summary || selectedEmail.summary || '—'}</MetaField>
                    </div>
                    {(selectedEmail.attachments || []).length > 0 && (
                      <div className="sm:col-span-2">
                        <MetaField label="附件">
                          <AttachmentList attachments={selectedEmail.attachments} mailboxId={mailboxId} onPreview={(file) => openAttachmentViewer(file)} />
                        </MetaField>
                      </div>
                    )}
                  </dl>
                </section>
              </div>
            </ScrollArea>

            <div className="border-t bg-background px-6 py-4">
              {selectedTrace ? (
                <Button variant="outline" className="w-full" asChild>
                  <Link to="/app/traces" onClick={() => { closeEmail(); setSelectedTraceId(selectedTrace.trace_id); }}>
                    <ScrollText className="size-4" />打开证据链
                  </Link>
                </Button>
              ) : (
                <p className="text-center text-xs text-muted-foreground">此邮件没有保存执行日志。</p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PendingMatchPanel({ email, onResolved }) {
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState(() => Object.fromEntries(
    (email.pendingActions || []).map((item) => [item.id, item.suggestedTargetId || item.candidates?.[0]?.id || '']),
  ));

  async function resolve(pendingActionId, resolution) {
    setBusy(`${pendingActionId}:${resolution}`);
    try {
      await request(`/emails/${encodeURIComponent(email.id)}/resolve-match`, 'POST', {
        pendingActionId,
        resolution,
        targetEventId: selected[pendingActionId] || undefined,
        mode: email.mode || 'qq',
      });
      await onResolved?.();
      toast.success(resolution === 'dismiss' ? '已忽略该项' : '已应用匹配');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/40">
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="size-4" />
        待人工选择原日程
      </div>
      <p className="text-xs text-muted-foreground">
        模型未能唯一匹配取消/调整目标。请选择对应日程后应用，或改为新建/忽略。
      </p>
      {(email.pendingActions || []).map((item) => (
        <div key={item.id} className="space-y-2 rounded-md border bg-background p-3">
          <div className="text-sm font-medium">
            {EMAIL_ACTIONS[item.action] || item.action}
            {item.reason ? ` · ${item.reason}` : ''}
          </div>
          <div className="space-y-1.5">
            <Label>候选日程</Label>
            <Select
              value={selected[item.id] || '__none'}
              onValueChange={(value) => setSelected((current) => ({ ...current, [item.id]: value === '__none' ? '' : value }))}
            >
              <SelectTrigger><SelectValue placeholder="选择原日程" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">未选择</SelectItem>
                {(item.candidates || []).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title} · {candidate.start}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={Boolean(busy) || !selected[item.id]}
              onClick={() => resolve(item.id, 'apply')}
            >
              应用到所选日程
            </Button>
            {item.action !== 'cancel' && (
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => resolve(item.id, 'create')}
              >
                当作新邀请创建
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => resolve(item.id, 'dismiss')}
            >
              忽略
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
