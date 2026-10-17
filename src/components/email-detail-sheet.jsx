import React, { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CalendarDays, ChevronRight, Clock3, ListTodo, Mail, ScrollText,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { AttachmentList } from '@/components/attachment-viewer';
import { EmailAttachments } from '@/Recruitment.jsx';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { EMAIL_CATEGORIES, affectedIds, createdIds, emailResult, realMailSource } from '@/lib/domain';
import { eventRange, fullDateTime, shanghaiDate } from '@/lib/time';

/** 全局邮件详情：待办 / 总览 / 邮件页均可打开并查看原文。 */
export function EmailDetailSheet() {
  const navigate = useNavigate();
  const {
    events, tasks, closeEmail, selectedEmail, setEventModal, setSelectedTraceId, traceData,
    state, reload,
  } = useWorkspace();
  const mailboxId = state?.settings?.activeMailboxId || '';

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
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl lg:max-w-4xl">
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

            <ScrollArea className="flex-1">
              <div className="grid gap-6 px-6 py-5 lg:grid-cols-[1.15fr_0.85fr]">
                <div className="space-y-6">
                  {selectedEmail.extraction?.summary && (
                    <section className="space-y-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">摘要</h3>
                      <p className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm leading-relaxed break-keep text-pretty">
                        {selectedEmail.extraction.summary}
                      </p>
                    </section>
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

                  <section className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">正文</h3>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-3 text-sm leading-relaxed lg:max-h-[28rem]">
                      {selectedEmail.body || '（无正文）'}
                    </pre>
                  </section>

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
                  {(selectedEmail.attachments || []).length > 0 && !(selectedEmail.category === 'resume' || selectedEmail.extraction?.category === 'resume') && (
                    <section className="space-y-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">附件</h3>
                      <AttachmentList attachments={selectedEmail.attachments} />
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

                <section className="space-y-3 rounded-lg border bg-muted/20 p-3 lg:sticky lg:top-0 lg:self-start">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">完整信息与元数据</h3>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
                    <div>
                      <dt className="text-xs text-muted-foreground">主题</dt>
                      <dd className="mt-0.5 break-all">{selectedEmail.subject || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">发件人</dt>
                      <dd className="mt-0.5 break-all">{selectedEmail.sender || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">收件时间</dt>
                      <dd className="mt-0.5">{fullDateTime(selectedEmail.receivedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">处理时间</dt>
                      <dd className="mt-0.5">{fullDateTime(selectedEmail.processedAt || selectedEmail.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">邮件 ID</dt>
                      <dd className="mt-0.5 break-all font-mono text-xs">{selectedEmail.id}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Message-ID / UID</dt>
                      <dd className="mt-0.5 break-all font-mono text-xs">
                        {selectedEmail.messageId || selectedEmail.uid || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">来源</dt>
                      <dd className="mt-0.5">
                        {selectedEmail.mode?.startsWith('demo') ? '示例邮件 · 预置提取结果' : realMailSource(selectedEmail)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">处理状态</dt>
                      <dd className="mt-0.5">{selectedEmail.status || emailResult(selectedEmail) || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">分类 / 优先级</dt>
                      <dd className="mt-0.5">
                        {(EMAIL_CATEGORIES[category] || category || '未分类')}
                        {' · '}
                        {selectedEmail.priority || selectedEmail.extraction?.priority || 'normal'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Trace</dt>
                      <dd className="mt-0.5 break-all font-mono text-xs">{selectedEmail.trace_id || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">内容摘要</dt>
                      <dd className="mt-0.5 leading-relaxed break-keep">
                        {selectedEmail.extraction?.summary || selectedEmail.summary || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">日历操作</dt>
                      <dd className="mt-0.5">
                        新增 {selectedCreated.length} · 取消/调整 {selectedAffected.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">待办提取</dt>
                      <dd className="mt-0.5">{selectedTasks.length} 项</dd>
                    </div>
                    {(selectedEmail.attachments || []).length > 0 && (
                      <div>
                        <dt className="text-xs text-muted-foreground">附件</dt>
                        <dd className="mt-2">
                          <AttachmentList attachments={selectedEmail.attachments} />
                        </dd>
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
