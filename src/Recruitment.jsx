import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, Clock3,
  Copy, Eye, FileText, GraduationCap, LoaderCircle, Mail, MapPin, MoreHorizontal,
  MessageSquare, RefreshCw, Search, Send, Sparkles, Users, Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { TraceReplay } from './TracePanel.jsx';
import { AgentThinkingChain } from '@/components/agent-thinking';
import { CandidateProfileModules } from '@/components/candidate-profile';
import { RichMarkdown } from '@/components/rich-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { RagCitations } from '@/components/rag-citations';
import { openAttachmentViewer } from '@/lib/attachment-open';
import { cn } from '@/lib/utils';
import {
  CHAT_EXAMPLES, EMPTY_RECRUITMENT,
  dateTime, isDemo, nameOf, pdfUrl, textOf, toIso, toLocalTime,
} from '@/lib/recruitment';

function askLittleDAboutCandidate(candidate) {
  const name = nameOf(candidate);
  window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
    detail: {
      prompt: `请根据当前邮箱人才库，介绍候选人「${name}」的经历亮点，并说明是否适合进一步面试。`,
    },
  }));
}

async function copyText(value, label = '已复制') {
  const text = String(value || '').trim();
  if (!text) {
    toast.error('没有可复制的内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error('复制失败');
  }
}

export function EmailAttachments({ email, mailboxId, request, onCandidate, onUpdated }) {
  const [retrying, setRetrying] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const attachments = email.attachments || [];
  const resume = (email.category || email.extraction?.category) === 'resume';
  if (!attachments.length && !email.candidateIds?.length && !resume) return null;

  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileText className="size-4" />
        {resume ? '简历附件与人才资料' : '邮件附件'}
      </div>
      {resume && (
        <p className="text-xs text-muted-foreground">求职简历单独整理到人才库，不创建日程或待办。</p>
      )}
      <div className="space-y-2">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="flex flex-wrap items-start gap-3 rounded-md border bg-background px-3 py-2.5">
            <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{attachment.filename || attachment.name || 'PDF 简历'}</div>
              <div className="text-xs text-muted-foreground">
                {attachment.status === 'failed' ? '提取失败，可重试'
                  : attachment.status === 'processing' || attachment.status === 'pending' ? '正在提取'
                    : attachment.candidateId ? '已加入人才库' : '附件已保存'}
                {attachment.pageCount ? ` · ${attachment.pageCount} 页` : ''}
              </div>
              {attachment.error && <p className="mt-1 text-xs text-destructive">{textOf(attachment.error)}</p>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => openAttachmentViewer({
                  id: attachment.id,
                  filename: attachment.filename || attachment.name || 'PDF 简历',
                  contentType: attachment.contentType || 'application/pdf',
                  size: attachment.size,
                  url: pdfUrl(attachment.id, mailboxId),
                  proxyUrl: pdfUrl(attachment.id, mailboxId),
                })}
              >
                预览 <FileText className="size-3" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary">
                    邮件功能 <MoreHorizontal className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>附件与邮件</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => openAttachmentViewer({
                      id: attachment.id,
                      filename: attachment.filename || attachment.name || 'PDF 简历',
                      contentType: attachment.contentType || 'application/pdf',
                      size: attachment.size,
                      url: pdfUrl(attachment.id, mailboxId),
                      proxyUrl: pdfUrl(attachment.id, mailboxId),
                    })}
                  >
                    <Eye className="size-3.5" />预览简历 PDF
                  </DropdownMenuItem>
                  {attachment.candidateId && (
                    <DropdownMenuItem onClick={() => onCandidate(attachment.candidateId)}>
                      <Users className="size-3.5" />打开候选人资料
                    </DropdownMenuItem>
                  )}
                  {email?.id && (
                    <DropdownMenuItem onClick={() => copyText(email.subject, '已复制邮件主题')}>
                      <Copy className="size-3.5" />复制邮件主题
                    </DropdownMenuItem>
                  )}
                  {email?.sender && (
                    <DropdownMenuItem onClick={() => copyText(email.sender, '已复制发件人')}>
                      <Mail className="size-3.5" />复制发件人
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => copyText(attachment.filename || attachment.name, '已复制文件名')}
                  >
                    <FileText className="size-3.5" />复制附件名
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
                      detail: {
                        prompt: `这封求职邮件「${email?.subject || '未命名'}」的简历附件是 ${attachment.filename || 'PDF'}，请帮我摘要要点。`,
                      },
                    }))}
                  >
                    <Sparkles className="size-3.5" />询问小 D
                  </DropdownMenuItem>
                  {['failed', 'error'].includes(attachment.status) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={Boolean(retrying)}
                        onClick={async () => {
                          setRetrying(attachment.id); setError('');
                          try {
                            await request(`/recruitment/attachments/${encodeURIComponent(attachment.id)}/retry`, 'POST');
                            if (alive.current) await onUpdated();
                          } catch (err) {
                            if (alive.current) setError(err.message);
                          } finally {
                            if (alive.current) setRetrying('');
                          }
                        }}
                      >
                        {retrying === attachment.id
                          ? <LoaderCircle className="size-3.5 animate-spin" />
                          : <RefreshCw className="size-3.5" />}
                        重试提取
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
      {!attachments.length && (
        <p className="text-xs text-muted-foreground">这封求职邮件尚未保存可读取的 PDF 简历附件。</p>
      )}
      {email.candidateIds?.map((id, index) => (
        <Button key={id} variant="link" className="h-auto px-0" onClick={() => onCandidate(id)}>
          查看候选人资料{email.candidateIds.length > 1 ? ` ${index + 1}` : ''}
          <ArrowRight className="size-3" />
        </Button>
      ))}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </section>
  );
}

function CandidateCard({ candidate, match, partial, mailboxId, onOpen, onInvite, onEmail, compact = false }) {
  const profile = candidate.profile || {};
  const personal = profile.personal || {};
  const education = profile.education?.[0] || {};
  const latest = candidate.versions?.find((version) => version.id === candidate.latestVersionId) || candidate.versions?.at(-1);
  const skillText = (profile.skills || []).map(textOf).filter(Boolean).slice(0, compact ? 3 : 5);

  return (
    <Card className={cn('overflow-hidden', compact && 'shadow-none')}>
      <CardContent className={cn('space-y-3 p-4', compact && 'p-3')}>
        <div className="flex items-start justify-between gap-2">
          <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={() => onOpen(candidate.id)}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
              {nameOf(candidate).slice(0, 1)}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium">{nameOf(candidate)}</span>
                {isDemo(candidate) && <Badge variant="secondary">预置示例</Badge>}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {textOf(profile.intent?.positions) || '求职意向未注明'}
              </span>
            </span>
          </button>
          {match && (
            <Badge variant={partial ? 'outline' : 'default'} className="shrink-0">
              {partial ? '部分符合' : '符合条件'}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <GraduationCap className="size-3" />
            {textOf(education.school || education.schoolName || education.university) || '学校未提供'}
            {education.degree && ` · ${textOf(education.degree)}`}
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" />
            {personal.currentCity || '现居地未提供'}
          </span>
        </div>

        {skillText.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skillText.map((skill, index) => (
              <Badge key={index} variant="outline" className="font-normal">{skill}</Badge>
            ))}
          </div>
        )}

        {match && (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-2 text-xs">
            {match.matched?.length > 0 && (
              <p className="flex gap-1.5 text-foreground">
                <Check className="mt-0.5 size-3 shrink-0" />
                <span>{match.matched.map(textOf).join('；')}</span>
              </p>
            )}
            {match.missing?.length > 0 && (
              <p className="flex gap-1.5 text-muted-foreground">
                <AlertCircle className="mt-0.5 size-3 shrink-0" />
                <span>{match.missing.map(textOf).join('；')}</span>
              </p>
            )}
            {match.evidence?.length > 0 && (
              <blockquote className="border-l-2 pl-2 text-muted-foreground">
                {match.evidence.map((item) => (typeof item === 'string' ? item : item.quote || textOf(item))).join('；')}
              </blockquote>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <Button size="sm" variant="secondary" onClick={() => onOpen(candidate.id)}>
            查看资料 <ArrowRight className="size-3" />
          </Button>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => onInvite(candidate)}>
              邀约 <Send className="size-3" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`${nameOf(candidate)}的更多邮件功能`}>
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>邮件与资料</DropdownMenuLabel>
                {latest?.emailId && (
                  <DropdownMenuItem onClick={() => onEmail(latest.emailId)}>
                    <Mail className="size-3.5" />查看原邮件
                  </DropdownMenuItem>
                )}
                {latest?.attachmentId && (
                  <DropdownMenuItem
                    onClick={() => openAttachmentViewer({
                      id: latest.attachmentId,
                      filename: `${nameOf(candidate)}.pdf`,
                      contentType: 'application/pdf',
                      url: pdfUrl(latest.attachmentId, mailboxId),
                      proxyUrl: pdfUrl(latest.attachmentId, mailboxId),
                    })}
                  >
                    <Eye className="size-3.5" />预览简历 PDF
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onOpen(candidate.id)}>
                  <Users className="size-3.5" />打开完整档案
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onInvite(candidate)}>
                  <Send className="size-3.5" />生成面试邀约
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => copyText(
                    personal.email || candidate.email || latest?.email || '',
                    '已复制候选人邮箱',
                  )}
                >
                  <Copy className="size-3.5" />复制邮箱
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => copyText(nameOf(candidate), '已复制姓名')}>
                  <Copy className="size-3.5" />复制姓名
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => askLittleDAboutCandidate(candidate)}>
                  <Sparkles className="size-3.5" />询问小 D
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
                    detail: {
                      prompt: `请用 search_knowledge 检索「${nameOf(candidate)}」简历原文，总结项目与技能证据。`,
                    },
                  }))}
                >
                  <MessageSquare className="size-3.5" />检索简历原文
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CandidateDetail({ candidate, attachments, interviews, mailboxId, onClose, onEmail, onInvite, onInterview }) {
  const versions = candidate.versions || [];
  const [versionId, setVersionId] = useState(candidate.latestVersionId || versions.at(-1)?.id || '');
  const version = versions.find((item) => item.id === versionId);
  const profile = version?.profile || candidate.profile || {};
  const attachment = attachments.find((item) => item.id === version?.attachmentId);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="flex h-full w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl lg:max-w-3xl">
        <div className="shrink-0 border-b px-6 py-5 pr-12">
          <SheetHeader className="space-y-1 p-0 text-left">
            <SheetTitle>{nameOf(candidate)}</SheetTitle>
            <SheetDescription>结构化简历 · 保留每次投递的来源与版本</SheetDescription>
          </SheetHeader>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="space-y-5 px-6 py-5 pb-10">
            {candidate.contactConflict && (
              <Alert>
                <AlertCircle className="size-4" />
                <AlertDescription>
                  {candidate.contactConflict.reason || '这份简历的联系方式关联其他档案，请核对原始资料。'}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label>简历版本</Label>
                <Select value={versionId || '__current'} onValueChange={(value) => setVersionId(value === '__current' ? '' : value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择简历版本" />
                  </SelectTrigger>
                  <SelectContent position="popper" className="z-[80]">
                    {versions.map((item, index) => (
                      <SelectItem key={item.id} value={item.id}>
                        第 {index + 1} 版 · {dateTime(item.createdAt)}{item.id === candidate.latestVersionId ? ' · 最新' : ''}
                      </SelectItem>
                    ))}
                    {!versions.length && <SelectItem value="__current">当前资料</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                {version?.emailId && (
                  <Button variant="outline" onClick={() => { onClose(); onEmail(version.emailId); }}>
                    <Mail className="size-4" />原邮件
                  </Button>
                )}
                {version?.attachmentId && (
                  <Button
                    variant="outline"
                    onClick={() => openAttachmentViewer({
                      id: version.attachmentId,
                      filename: attachment?.filename || `${nameOf(candidate)}.pdf`,
                      contentType: attachment?.contentType || 'application/pdf',
                      size: attachment?.size,
                      url: pdfUrl(version.attachmentId, mailboxId),
                      proxyUrl: pdfUrl(version.attachmentId, mailboxId),
                    })}
                  >
                    <Eye className="size-4" />预览简历
                  </Button>
                )}
                <Button onClick={() => { onClose(); onInvite(candidate); }}>
                  <Send className="size-4" />生成面试邀约
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">
                      更多 <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel>邮件功能</DropdownMenuLabel>
                    {version?.emailId && (
                      <DropdownMenuItem onClick={() => { onClose(); onEmail(version.emailId); }}>
                        <Mail className="size-3.5" />打开原邮件详情
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => copyText(profile.personal?.email || candidate.email || '', '已复制邮箱')}
                    >
                      <Copy className="size-3.5" />复制联系邮箱
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => copyText(nameOf(candidate), '已复制姓名')}>
                      <Copy className="size-3.5" />复制候选人姓名
                    </DropdownMenuItem>
                    {attachment?.filename && (
                      <DropdownMenuItem onClick={() => copyText(attachment.filename, '已复制文件名')}>
                        <FileText className="size-3.5" />复制简历文件名
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { onClose(); askLittleDAboutCandidate(candidate); }}>
                      <Sparkles className="size-3.5" />询问小 D
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        onClose();
                        window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
                          detail: {
                            prompt: `请用 search_knowledge 检索「${nameOf(candidate)}」的简历原文，列出可核验的项目与技能摘录。`,
                          },
                        }));
                      }}
                    >
                      <MessageSquare className="size-3.5" />检索简历原文
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {attachment && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="size-3" />
                {attachment.filename}
                {attachment.pageCount ? ` · ${attachment.pageCount} 页` : ''}
                {isDemo(candidate) && ' · 预置提取结果'}
              </p>
            )}

            <CandidateProfileModules profile={profile} />

            {interviews.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">面试沟通</h3>
                {interviews.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted/40"
                    onClick={() => { onClose(); onInterview(item.id); }}
                  >
                    <Clock3 className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.subject || '面试邀约'}</span>
                      <span className="text-xs text-muted-foreground">
                        {dateTime(item.start)} · {item.status === 'sent' ? '邮件已发送' : '待审核'}
                      </span>
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </section>
            )}
            <p className="text-xs text-muted-foreground">
              资料来自简历提取，未提供的信息保持为空。判断候选人时请结合原始简历与面试了解。
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TraceEvidence({ trace, inline = false }) {
  const [now, setNow] = useState(Date.now());
  const [detailOpen, setDetailOpen] = useState(false);
  const spans = trace?.spans || [];
  const running = trace?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  if (!trace) return null;

  return (
    <div className={cn('space-y-2', inline && 'mt-2')}>
      <AgentThinkingChain
        spans={spans}
        now={now}
        running={running}
        defaultOpen={running || inline}
        cost={{
          usage: {
            prompt_tokens: (trace.llm_tokens_in ?? spans.reduce((sum, span) => sum + (span.llm_tokens_in || 0), 0)) || null,
            completion_tokens: (trace.llm_tokens_out ?? spans.reduce((sum, span) => sum + (span.llm_tokens_out || 0), 0)) || null,
          },
          cost_cny: trace.cost_cny ?? null,
          cost_status: trace.cost_status,
        }}
        title={
          running
            ? `正在执行 ${spans.length || '…'} 个实际步骤`
            : trace.status === 'failed'
              ? `执行失败 · ${spans.length} 步`
              : `思考过程 · ${spans.length} 步`
        }
        footer={(
          <div className="border-t px-2 py-2">
            <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="w-full justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {running ? <LoaderCircle className="size-3 animate-spin" /> : <CheckCheck className="size-3" />}
                    {detailOpen ? '收起完整回放与计量' : '完整回放 · 时间轴与 Token'}
                  </span>
                  <ChevronDown className={cn('size-3.5 transition', detailOpen && 'rotate-180')} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 rounded-md border bg-background p-3">
                  <TraceReplay trace={trace} now={now} showDraft={false} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      />
    </div>
  );
}

function InterviewReview({ interview, previousInterview, candidate, settings, onClose, onAction, onSettings }) {
  const initial = (item = interview) => ({
    to: item.to || '', subject: item.subject || '', body: item.body || '',
    start: toLocalTime(item.start), end: toLocalTime(item.end), meetingUrl: item.meetingUrl || '',
  });
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reviewNotice, setReviewNotice] = useState('');
  const sent = interview.status === 'sent';
  const calendarFailed = sent && interview.calendarStatus === 'failed';
  const demo = isDemo(interview);
  const demoCandidate = isDemo(candidate);
  const cancelled = interview.kind === 'cancel';
  const change = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setSaved(false); };
  useEffect(() => { setForm(initial()); }, [interview.meetingUrl, interview.status]);

  async function act(action) {
    setBusy(action); setError(''); setSaved(false); setReviewNotice('');
    try {
      const result = await onAction(interview.id, action, {
        ...form, start: toIso(form.start), end: toIso(form.end),
        confirmDemoSend: action === 'send' && demo,
      });
      if (result?.interview) setForm(initial(result.interview));
      if (result?.reviewRequired) setReviewNotice('草稿内容已更新，请核对主题、正文、时间和会议安排后再次确认发送。');
      else setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const title = sent ? '已发送的面试邮件'
    : cancelled ? '审核取消面试通知'
      : interview.kind === 'reschedule' ? '审核改期邮件' : '审核面试邀约';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 border-b px-6 py-5">
          <DialogHeader className="space-y-1 p-0 text-left">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {settings.email || '当前邮箱'} → {nameOf(candidate)} · 北京时间
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            {(demo || demoCandidate) && (
              <Alert>
                <Sparkles className="size-4" />
                <AlertDescription>
                  候选人资料来自预置示例。
                  {sent ? '此面试邮件已真实发送。' : '请填写真实收件邮箱并核对正文，点击「确认并发送」将通过当前邮箱发送真实邮件。'}
                </AlertDescription>
              </Alert>
            )}
            {sent && (
              <Alert>
                <CheckCheck className="size-4" />
                <AlertDescription>
                  邮件已发送 · {dateTime(interview.sentAt || interview.sent_at || interview.updatedAt)}
                  {interview.eventId && ' · 日历已更新'}
                </AlertDescription>
              </Alert>
            )}
            {previousInterview && (
              <Card>
                <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">{cancelled ? '待取消的安排' : '原面试时间'}</div>
                    <div className="font-medium">{dateTime(previousInterview.start)} – {dateTime(previousInterview.end)}</div>
                  </div>
                  {!cancelled && (
                    <>
                      <ArrowRight className="size-4 text-muted-foreground" />
                      <div>
                        <div className="text-xs text-muted-foreground">本次调整为</div>
                        <div className="font-medium">{dateTime(interview.start)} – {dateTime(interview.end)}</div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
            {interview.recipientSource === 'source_email' && (
              <Alert>
                <AlertCircle className="size-4" />
                <AlertDescription>简历未提供邮箱，当前收件人为来源邮件回复地址，请核对是否属于候选人。</AlertDescription>
              </Alert>
            )}
            {interview.responseSummary && (
              <p className="text-sm text-muted-foreground">候选人回复：{interview.responseSummary}</p>
            )}

            {!sent && !cancelled && (interview.conflicts?.length > 0 || interview.suggestedSlots?.length > 0) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Clock3 className="size-4" />核对面试时段
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {interview.conflicts?.length > 0 && (
                    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                      <p className="flex items-center gap-1.5 font-medium">
                        <AlertCircle className="size-3.5" />请求时间与以下安排冲突
                      </p>
                      {interview.conflicts.map((item) => (
                        <div key={item.id} className="flex justify-between gap-2 text-xs">
                          <strong>{item.title}</strong>
                          <span className="text-muted-foreground">{dateTime(item.start)} – {dateTime(item.end)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {interview.suggestedSlots?.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">日历中的可用时段 · 点击填入，再保存核对正文</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {interview.suggestedSlots.map((slot, index) => (
                          <Button
                            key={index}
                            type="button"
                            variant={form.start === toLocalTime(slot.start) && form.end === toLocalTime(slot.end) ? 'default' : 'outline'}
                            disabled={Boolean(busy)}
                            className="h-auto justify-start py-2"
                            onClick={() => {
                              setForm((current) => ({ ...current, start: toLocalTime(slot.start), end: toLocalTime(slot.end) }));
                              setSaved(false);
                              setReviewNotice('已填入建议时段，请保存草稿，核对更新后的正文与会议链接。');
                            }}
                          >
                            <span className="mr-2 tabular-nums opacity-70">{index + 1}</span>
                            {dateTime(slot.start)} – {dateTime(slot.end)}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <fieldset disabled={Boolean(busy) || sent} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="interview-to">收件人</Label>
                <Input id="interview-to" type="email" value={form.to} onChange={(e) => change('to', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="interview-subject">主题</Label>
                <Input id="interview-subject" value={form.subject} onChange={(e) => change('subject', e.target.value)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="interview-start">{cancelled ? '原开始时间' : '开始时间'}</Label>
                  <Input id="interview-start" type="datetime-local" value={form.start} onChange={(e) => change('start', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="interview-end">{cancelled ? '原结束时间' : '结束时间'}</Label>
                  <Input id="interview-end" type="datetime-local" value={form.end} onChange={(e) => change('end', e.target.value)} />
                </div>
              </div>
              {!cancelled && (
                <div className="space-y-2">
                  <Label htmlFor="interview-meeting">会议地点或链接（可选）</Label>
                  <Input
                    id="interview-meeting"
                    type="text"
                    placeholder="可填会议链接、会议号或线下面试地点"
                    value={form.meetingUrl}
                    onChange={(e) => change('meetingUrl', e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {!sent && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={demo || !form.start || !form.end || Boolean(busy)}
                        onClick={() => (settings.feishu?.configured ? act('meeting') : onSettings())}
                      >
                        {busy === 'meeting' ? <LoaderCircle className="size-4 animate-spin" /> : <Video className="size-4" />}
                        {settings.feishu?.configured
                          ? (interview.meetingId ? '按当前时间更新飞书会议' : '创建飞书会议')
                          : '设置飞书会议连接'}
                      </Button>
                    )}
                    {interview.meetingId && (
                      <Badge variant="secondary"><Check className="size-3" />会议已创建</Badge>
                    )}
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="interview-body">邮件正文</Label>
                <Textarea id="interview-body" rows={10} value={form.body} onChange={(e) => change('body', e.target.value)} />
              </div>
            </fieldset>

            {(error || interview.error || interview.deliveryError || interview.meetingError || interview.calendarError) && (
              <p className="text-sm text-destructive" role="alert">
                {error || textOf(interview.error || interview.deliveryError || interview.meetingError || interview.calendarError)}
              </p>
            )}
            {reviewNotice && !sent && (
              <Alert>
                <AlertCircle className="size-4" />
                <AlertDescription>{reviewNotice}</AlertDescription>
              </Alert>
            )}
            {saved && !sent && (
              <Alert>
                <Check className="size-4" />
                <AlertDescription>草稿已更新，请核对后确认发送。</AlertDescription>
              </Alert>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2 border-t px-6 py-4 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {sent
              ? (calendarFailed ? '邮件已发送，日历保存失败。补写日历不会再次发送邮件。' : '此邮件已发送，不会重复发送。')
              : '保存只更新草稿；确认发送后，通过当前邮箱发信并更新面试日历。'}
          </p>
          <div className="flex flex-wrap gap-2">
            {calendarFailed && (
              <Button disabled={Boolean(busy)} onClick={() => act('calendar')}>
                {busy === 'calendar' ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                补写日历
              </Button>
            )}
            <Button variant="outline" disabled={Boolean(busy) || sent} onClick={() => act('save')}>
              {busy === 'save' && <LoaderCircle className="size-4 animate-spin" />}
              保存草稿
            </Button>
            <Button
              disabled={Boolean(busy) || sent || !form.to.trim() || !form.subject.trim() || !form.body.trim()
                || (!cancelled && (!form.start || !form.end))}
              onClick={() => act('send')}
            >
              {busy === 'send' ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {sent ? '已发送' : interview.status === 'failed' ? '确认并重试发送' : '确认并发送'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Recruitment({
  mailboxId, settings, request, selectedCandidateId, onSelectCandidate,
  interviewId, onSelectInterview: setInterviewId, onEmail, onSync, syncing,
  onSettings, onUpdated, refreshKey,
}) {
  const [data, setData] = useState(EMPTY_RECRUITMENT);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState('');
  const [action, setAction] = useState('');
  const [tab, setTab] = useState('candidates');
  const alive = useRef(true);
  const requestRef = useRef(request);
  const busyRef = useRef(false);
  const chatEnd = useRef(null);
  const promptRef = useRef(null);
  requestRef.current = request;
  busyRef.current = Boolean(data.busy || action || syncing);

  async function reload() {
    const result = await requestRef.current('/recruitment');
    if (!alive.current || (result.mailboxId && result.mailboxId !== mailboxId)) return;
    setData({ ...EMPTY_RECRUITMENT, ...result });
    setLoaded(true);
    setError('');
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [mailboxId]);

  useEffect(() => {
    let stopped = false;
    let timer;
    const poll = async () => {
      try { await reload(); }
      catch (err) { if (alive.current && !stopped) { setError(err.message); setLoaded(true); } }
      if (alive.current && !stopped) timer = setTimeout(poll, busyRef.current ? 2000 : 10000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [mailboxId, Boolean(action), Boolean(data.busy), syncing]);

  useEffect(() => {
    if (loaded) reload().catch((err) => { if (alive.current) setError(err.message); });
  }, [refreshKey, Boolean(action), syncing]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [data.messages.length]);

  async function mutate(path, method = 'POST', body) {
    const result = await requestRef.current(path, method, body);
    if (!alive.current) return result;
    await reload();
    if (alive.current) await onUpdated();
    return result;
  }

  async function chat(event) {
    event.preventDefault();
    if (!prompt.trim() || action || data.busy) return;
    const message = prompt.trim();
    setAction('chat'); setError(''); setPrompt('');
    try { await mutate('/recruitment/chat', 'POST', { message }); }
    catch (err) { if (alive.current) { setError(err.message); setPrompt(message); } }
    finally { if (alive.current) setAction(''); }
  }

  function invite(candidate) {
    setPrompt(`请给${nameOf(candidate)}生成面试邀约。`);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function interviewAction(id, kind, fields) {
    if (kind === 'calendar') {
      const saved = await requestRef.current(`/recruitment/interviews/${encodeURIComponent(id)}/send`, 'POST');
      if (alive.current) { await reload(); if (alive.current) await onUpdated(); }
      return { interview: saved };
    }
    let saved = await requestRef.current(`/recruitment/interviews/${encodeURIComponent(id)}`, 'PUT', fields);
    if (!alive.current) return;
    if (kind === 'send' && (saved.body !== fields.body || saved.subject !== fields.subject)) {
      await reload();
      return { reviewRequired: true, interview: saved };
    }
    if (kind !== 'save') saved = await requestRef.current(`/recruitment/interviews/${encodeURIComponent(id)}/${kind}`, 'POST',
      kind === 'send' ? { confirmDemoSend: fields.confirmDemoSend === true } : undefined);
    if (alive.current) { await reload(); if (alive.current) await onUpdated(); }
    return { interview: saved };
  }

  const pending = data.interviews.filter((item) => item.status !== 'sent');
  const selectedCandidate = data.candidates.find((item) => item.id === selectedCandidateId);
  const interview = data.interviews.find((item) => item.id === interviewId);
  const filtered = data.candidates.filter((candidate) => (
    !query.trim() || textOf(candidate.profile).toLowerCase().includes(query.trim().toLowerCase())
  ));
  const candidateProps = { mailboxId, onOpen: onSelectCandidate, onInvite: invite, onEmail };
  const failedAttachments = data.attachments.filter((attachment) => attachment.status === 'failed' || attachment.status === 'error');
  const runningTraces = data.traces.filter((trace) => trace.status === 'running');
  const sentCount = data.interviews.filter((item) => item.status === 'sent').length;
  const stats = [
    { label: '人才资料', value: data.candidates.length },
    { label: '待审核邀约', value: pending.length },
    { label: '邮件已发送', value: sentCount },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {stats.map((item) => (
          <Card key={item.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>{item.label}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="size-3.5" />
            <span className="truncate font-medium text-foreground">{settings.email || '当前邮箱尚未配置'}</span>
          </span>
          <span className="mt-0.5 block text-xs">人才资料按邮箱独立保存</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={Boolean(action) || Boolean(data.busy)}
            onClick={async () => {
              setAction('demo'); setError('');
              try { await mutate('/recruitment/demo'); }
              catch (err) { if (alive.current) setError(err.message); }
              finally { if (alive.current) setAction(''); }
            }}
          >
            {action === 'demo' ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            体验招聘示例
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(action) || Boolean(data.busy)}
            onClick={async () => {
              setAction('rag-reindex'); setError('');
              try {
                const result = await requestRef.current('/rag/reindex', 'POST');
                if (alive.current) {
                  await reload();
                  toast.success(`已重建索引：${result.chunkCount ?? 0} 个分块`);
                }
              } catch (err) {
                if (alive.current) setError(err.message);
              } finally {
                if (alive.current) setAction('');
              }
            }}
          >
            {action === 'rag-reindex' ? <LoaderCircle className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
            重建知识索引
          </Button>
          <Button disabled={syncing || !onSync} title={onSync ? '同步当前活动邮箱' : '请先在顶栏切换到该工作台绑定的邮箱'} onClick={onSync}>
            {syncing ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4" />}
            同步真实邮箱
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => reload().catch((err) => setError(err.message))}>
              重新加载
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 左：人才库 / 面试；右：招聘助手。桌面并排，小屏上下叠放。 */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="min-h-[28rem]">
          <Tabs value={tab} onValueChange={setTab} className="gap-0">
            <CardHeader className="space-y-3 border-b pb-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList>
                  <TabsTrigger value="candidates" className="gap-1.5">
                    <Users className="size-3.5" />人才库
                    <Badge variant="secondary" className="tabular-nums">{data.candidates.length}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="interviews" className="gap-1.5">
                    <Video className="size-3.5" />面试沟通
                    {pending.length > 0 && <Badge className="tabular-nums">{pending.length}</Badge>}
                  </TabsTrigger>
                </TabsList>
                {tab === 'candidates' && (
                  <div className="relative w-full max-w-xs">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-8"
                      aria-label="搜索人才资料"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="姓名、学校或技能"
                    />
                  </div>
                )}
              </div>
            </CardHeader>

            <CardContent className="p-4">
              {!loaded ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                  <LoaderCircle className="size-6 animate-spin" />
                  <p className="text-sm">正在打开人才库</p>
                </div>
              ) : (
                <>
                  <TabsContent value="candidates" className="mt-0 space-y-4">
                    {filtered.length > 0 ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        {filtered.map((candidate) => (
                          <CandidateCard key={candidate.id} candidate={candidate} {...candidateProps} />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <BookOpen className="size-8 text-muted-foreground" strokeWidth={1.4} />
                        <div>
                          <h3 className="font-medium">{query ? '没有找到相关资料' : '下一位同行者，就在收件箱里'}</h3>
                          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                            {query
                              ? '试试其他姓名、学校或技能关键词。'
                              : '同步带有 PDF 简历的求职邮件，人才资料会自动出现在这里。也可以先体验预置示例。'}
                          </p>
                        </div>
                      </div>
                    )}

                    {failedAttachments.length > 0 && (
                      <Card className="border-destructive/30">
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-sm">
                            <AlertCircle className="size-4 text-destructive" />
                            {failedAttachments.length} 份附件待处理
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {failedAttachments.map((attachment) => (
                            <div key={attachment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                              <div className="min-w-0">
                                <div className="truncate font-medium">{attachment.filename}</div>
                                <div className="text-xs text-muted-foreground">{textOf(attachment.error) || '提取未完成'}</div>
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openAttachmentViewer({
                                    id: attachment.id,
                                    filename: attachment.filename || '附件.pdf',
                                    contentType: attachment.contentType || 'application/pdf',
                                    url: pdfUrl(attachment.id, mailboxId),
                                    proxyUrl: pdfUrl(attachment.id, mailboxId),
                                  })}
                                >
                                  预览
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={Boolean(action) || Boolean(data.busy)}
                                  onClick={async () => {
                                    setAction(attachment.id);
                                    try { await mutate(`/recruitment/attachments/${encodeURIComponent(attachment.id)}/retry`); }
                                    catch (err) { if (alive.current) setError(err.message); }
                                    finally { if (alive.current) setAction(''); }
                                  }}
                                >
                                  {action === attachment.id
                                    ? <LoaderCircle className="size-3.5 animate-spin" />
                                    : <RefreshCw className="size-3.5" />}
                                  重试
                                </Button>
                              </div>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    )}
                  </TabsContent>

                  <TabsContent value="interviews" className="mt-0">
                    {data.interviews.length ? (
                      <div className="divide-y rounded-lg border">
                        {data.interviews.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40"
                            onClick={() => setInterviewId(item.id)}
                          >
                            <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                              <Video className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{item.subject || '面试邀约'}</span>
                              <span className="text-xs text-muted-foreground">
                                {nameOf(data.candidates.find((candidate) => candidate.id === item.candidateId))} · {dateTime(item.start)}
                              </span>
                            </span>
                            <Badge variant={item.status === 'sent' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'outline'}>
                              {item.status === 'sent' ? '已发送' : item.status === 'failed' ? '发送待重试' : '待审核'}
                            </Badge>
                            <ArrowRight className="size-4 text-muted-foreground" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <MessageSquare className="size-8 text-muted-foreground" />
                        <div>
                          <h3 className="font-medium">从一句邀约开始</h3>
                          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                            在右侧告诉助手想邀请谁、什么时间见面。邮件先生成草稿，由你审核后发送。
                          </p>
                        </div>
                      </div>
                    )}
                  </TabsContent>
                </>
              )}
            </CardContent>
          </Tabs>
        </Card>

        <Card className="flex min-h-[28rem] flex-col xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)]">
          <CardHeader className="flex flex-row items-start gap-3 space-y-0 border-b">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">招聘助手</CardTitle>
              <CardDescription>找人、了解经历、安排下一步</CardDescription>
            </div>
            <Badge variant={data.busy || action === 'chat' ? 'default' : 'secondary'}>
              {data.busy || action === 'chat' ? '执行中' : '随时可以聊'}
            </Badge>
          </CardHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              {!data.messages.length && (
                <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                  <p className="text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Start with a conversation</p>
                  <h3 className="text-lg font-medium">你想遇见怎样的人？</h3>
                  <p className="text-sm text-muted-foreground">
                    说出岗位需要的经历和能力，助手会查阅人才库，展示符合及部分符合条件的候选人。
                  </p>
                  <div className="space-y-2">
                    {CHAT_EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="flex w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted/40"
                        onClick={() => { setPrompt(example); promptRef.current?.focus(); }}
                      >
                        <span className="min-w-0 flex-1">{example}</span>
                        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {data.messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    'space-y-2 rounded-lg border p-3',
                    message.role === 'user' ? 'bg-primary/5' : 'bg-background',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    {message.role === 'user' ? '你' : <><Sparkles className="size-3" />招聘助手</>}
                  </div>
                  {message.role === 'user' ? (
                    <div className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</div>
                  ) : (
                    <RichMarkdown>{message.content}</RichMarkdown>
                  )}

                  {message.candidateResults && (
                    <div className="space-y-3">
                      {[['exact', '符合条件'], ['partial', '可进一步了解']].map(([key, label]) => (
                        <section key={key} className="space-y-2">
                          <div className="flex items-center gap-2 text-xs font-medium">
                            {label}
                            <Badge variant="outline" className="tabular-nums">
                              {message.candidateResults[key]?.length || 0}
                            </Badge>
                          </div>
                          {message.candidateResults[key]?.map((match) => {
                            const candidate = data.candidates.find((item) => item.id === match.candidateId);
                            return candidate
                              ? <CandidateCard key={candidate.id} candidate={candidate} match={match} partial={key === 'partial'} compact {...candidateProps} />
                              : null;
                          })}
                          {!message.candidateResults[key]?.length && (
                            <p className="text-xs text-muted-foreground">
                              暂未找到{key === 'exact' ? '完全符合' : '可补充了解'}的候选人。
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                  )}

                  {message.interviewIds?.map((id) => {
                    const item = data.interviews.find((entry) => entry.id === id);
                    return item ? (
                      <button
                        key={id}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted/40"
                        onClick={() => setInterviewId(id)}
                      >
                        <Video className="size-4" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.subject || '面试邮件草稿'}</span>
                          <span className="text-xs text-muted-foreground">
                            {dateTime(item.start)} · {item.status === 'sent' ? '已发送' : '等待你审核'}
                          </span>
                        </span>
                        <ArrowRight className="size-4 text-muted-foreground" />
                      </button>
                    ) : null;
                  })}

                  {message.citations?.length > 0 && (
                    <RagCitations citations={message.citations} mailboxId={mailboxId} />
                  )}

                  <TraceEvidence inline trace={data.traces.find((trace) => (trace.trace_id || trace.id) === message.traceId)} />
                </article>
              ))}

              {runningTraces
                .filter((trace) => !data.messages.some((message) => message.traceId === (trace.trace_id || trace.id)))
                .map((trace) => <TraceEvidence key={trace.trace_id || trace.id} trace={trace} />)}

              {(action === 'chat' || data.busy) && !runningTraces.length && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  助手正在处理，工具执行记录将显示在这里…
                </div>
              )}
              <div ref={chatEnd} />
            </div>
          </ScrollArea>

          <form className="space-y-2 border-t p-4" onSubmit={chat}>
            <div className="rounded-xl border bg-muted/20 p-2">
              <Textarea
                ref={promptRef}
                aria-label="向招聘助手发送消息"
                value={prompt}
                rows={3}
                placeholder="例如：找有云计算项目经历的同学…"
                className="min-h-[4.5rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    chat(event);
                  }
                }}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
                <span className="text-xs text-muted-foreground">Enter 发送 · Shift + Enter 换行</span>
                <Button size="sm" disabled={!prompt.trim() || Boolean(action) || Boolean(data.busy)} type="submit">
                  {action === 'chat' ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
                  发送
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">面试邮件由你审核后发送。筛选依据来自简历，缺失信息会注明。</p>
          </form>
        </Card>
      </div>

      {data.traces.length > 0 && (
        <details className="rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
            <span className="inline-flex items-center gap-2">
              <FileText className="size-4" />
              简历提取与招聘执行日志
              <Badge variant="secondary" className="tabular-nums">{data.traces.length}</Badge>
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </summary>
          <div className="space-y-3 border-t p-4">
            {[...data.traces].reverse().map((trace) => (
              <section key={trace.trace_id || trace.id} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">{trace.subject || trace.title || '招聘处理记录'}</h3>
                  <span className="text-xs text-muted-foreground">{dateTime(trace.started_at || trace.createdAt)}</span>
                </div>
                <TraceEvidence trace={trace} />
              </section>
            ))}
          </div>
        </details>
      )}

      {selectedCandidate && (
        <CandidateDetail
          key={selectedCandidate.id}
          candidate={selectedCandidate}
          attachments={data.attachments}
          interviews={data.interviews.filter((item) => item.candidateId === selectedCandidate.id)}
          mailboxId={mailboxId}
          onClose={() => onSelectCandidate(null)}
          onEmail={onEmail}
          onInvite={invite}
          onInterview={setInterviewId}
        />
      )}
      {interview && (
        <InterviewReview
          key={interview.id}
          interview={interview}
          previousInterview={data.interviews.find((item) => item.id === interview.previousInterviewId)}
          candidate={data.candidates.find((item) => item.id === interview.candidateId)}
          settings={settings}
          onClose={() => setInterviewId(null)}
          onAction={interviewAction}
          onSettings={onSettings}
        />
      )}
    </div>
  );
}
