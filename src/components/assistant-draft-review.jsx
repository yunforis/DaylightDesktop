import React, { useEffect, useRef, useState } from 'react';
import { CalendarCheck2, Check, ChevronDown, ChevronRight, ExternalLink, LoaderCircle, Mail, Pencil, RefreshCw, Save, SendHorizontal, Video, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { request } from '@/lib/api';

const STATUS_LABELS = {
  pending: '待审核', sending: '正在发送', sent: '已发送', failed: '发送失败',
  unknown: '发送结果待核验', discarded: '已放弃',
};

function formOf(draft) {
  return { to: (draft.to || []).join(', '), subject: draft.subject || '', body: draft.body || '' };
}

function addressText(value) {
  return (Array.isArray(value) ? value : []).map((item) => typeof item === 'string' ? item : item?.address || '').filter(Boolean).join('、');
}

function beijingTime(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

/** 每次发送都审核持久化版本；发送失败后先取回状态，才允许再次操作。 */
export function AssistantDraftReview({ draft, mailboxId, event, disabled = false, onChanged, onRefresh, onViewEvent }) {
  const [expanded, setExpanded] = useState(!['sent', 'discarded'].includes(draft.status));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formOf(draft));
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const pendingRef = useRef(false);
  const editRevisionRef = useRef(draft.revision);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!editing) setForm(formOf(draft));
    if (!['pending', 'failed'].includes(draft.status)) setEditing(false);
    if (editing && draft.revision !== editRevisionRef.current) {
      setEditing(false);
      setError('草稿内容或状态已更新，请核对最新版本后再编辑。');
    }
  }, [draft.revision, draft.status, editing]);

  const blocked = disabled || Boolean(operation) || needsRefresh;
  const canEdit = draft.status === 'pending' || (draft.status === 'failed' && draft.canRetry === true);
  const canSend = canEdit && !editing;
  const meetingUrl = /^https:\/\//i.test(draft.meeting?.url || '') ? draft.meeting.url : '';
  const accepted = addressText(draft.delivery?.accepted);
  const rejected = addressText(draft.delivery?.rejected);
  const start = beijingTime(event?.start || draft.meeting?.scheduledStart);
  const end = beijingTime(event?.end || draft.meeting?.scheduledEnd);
  const expiresAt = beijingTime(draft.meeting?.expiresAt);

  async function refresh() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setOperation('refresh');
    try {
      const refreshed = await onRefresh();
      if (!mountedRef.current) return;
      if (!refreshed?.some((item) => item.id === draft.id)) throw new Error('未能取回这份草稿，请稍后刷新核验。');
      setNeedsRefresh(false);
      setError('');
    } catch (failure) {
      if (mountedRef.current) setError(failure.message || '暂时无法刷新发送状态。');
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setOperation('');
    }
  }

  async function perform(action) {
    if (pendingRef.current || blocked || (action === 'send' && !canSend)) return;
    pendingRef.current = true;
    setOperation(action);
    setError('');
    const payload = action === 'edit'
      ? { revision: draft.revision, to: form.to.split(/[,;，；\n]+/).map((value) => value.trim()).filter(Boolean), subject: form.subject, body: form.body }
      : { revision: draft.revision, ...(action === 'send' ? { confirmed: true } : {}) };
    try {
      const result = await request(`/assistant/drafts/${encodeURIComponent(draft.id)}${action === 'edit' ? '' : `/${action}`}`, action === 'edit' ? 'PATCH' : 'POST', payload, { mailboxId });
      if (!mountedRef.current) return;
      if (!result.draft) throw new Error('未收到草稿状态，请刷新核验后继续。');
      onChanged(result.draft);
      setEditing(false);
      setNeedsRefresh(false);
    } catch (failure) {
      if (!mountedRef.current) return;
      setError(failure.message || '操作未完成，请刷新核验。');
      // 网络错误并不证明未发出。先读取服务端持久化回执，禁止直接重发。
      setNeedsRefresh(true);
      try {
        const refreshed = await onRefresh();
        if (mountedRef.current && refreshed?.some((item) => item.id === draft.id)) setNeedsRefresh(false);
      } catch { /* 保留核验按钮及重发禁用状态。 */ }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setOperation('');
    }
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card className="gap-0 overflow-hidden py-0 shadow-none" data-draft-id={draft.id}>
        <CardHeader className="gap-0 p-0">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-start gap-2.5 px-3 py-3 text-left hover:bg-muted/30">
              {draft.kind === 'meeting_invitation' ? <Video className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-semibold">{draft.kind === 'meeting_invitation' ? '会议邀约' : '邮件草稿'}</span>
                <span className="block break-words text-xs text-muted-foreground">{draft.subject || '（无主题）'}</span>
              </span>
              <Badge variant={['failed', 'unknown'].includes(draft.status) ? 'destructive' : 'secondary'} className="text-[10px] font-normal">
                {draft.status === 'sending' && <LoaderCircle className="size-3 animate-spin" />}
                {draft.status === 'sent' && <Check className="size-3" />}
                {STATUS_LABELS[draft.status] || draft.status}
              </Badge>
              {expanded ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3 border-t px-3 py-3 text-xs">
            {draft.kind === 'meeting_invitation' && (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
                {event && event.status !== 'cancelled' ? (
                  <Button type="button" size="xs" variant="link" className="h-auto whitespace-normal px-0 text-left" onClick={() => onViewEvent?.(event)}>
                    <CalendarCheck2 className="size-3" />日程已加入日历 · 查看
                  </Button>
                ) : <a href="/app/calendar" className="flex items-center gap-1.5 underline underline-offset-4"><CalendarCheck2 className="size-3" />{event?.status === 'cancelled' ? '日程已取消 · 打开日历核对' : '打开日历核对会议安排'}</a>}
                {(start || end) && <p>{start}{end ? ` — ${end}` : ''}（北京时间）</p>}
                {meetingUrl && <a href={meetingUrl} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1.5 break-all underline underline-offset-4"><ExternalLink className="mt-0.5 size-3 shrink-0" /><span>{meetingUrl}</span></a>}
                {draft.meeting?.meetingNo && <p className="break-all">会议号：{draft.meeting.meetingNo}</p>}
                {expiresAt && <p className="text-[11px] text-muted-foreground">链接有效至 {expiresAt}（北京时间）</p>}
                <p className="text-[11px] leading-relaxed text-muted-foreground">飞书会议链接已预创建，会议时间以日历安排为准。{draft.status === 'sent' ? '邀约邮件已发送，回执见下方。' : draft.status === 'discarded' ? '邀约邮件已放弃。' : ['sending', 'unknown'].includes(draft.status) ? '邀约邮件的发送状态见下方。' : '邀约邮件需在下方审核发送。'}</p>
              </div>
            )}
            <dl className="space-y-2">
              <div className="space-y-1"><dt className="font-medium text-muted-foreground">发件邮箱</dt><dd className="break-all">{draft.from || '发件邮箱待核验'}</dd></div>
              {editing ? (
                <>
                  <div className="space-y-1.5"><Label htmlFor={`draft-to-${draft.id}`} className="text-xs">收件人</Label><Input id={`draft-to-${draft.id}`} value={form.to} disabled={Boolean(operation)} onChange={(e) => setForm((current) => ({ ...current, to: e.target.value }))} placeholder="邮箱地址，多个用逗号分隔" className="h-8 text-xs" /></div>
                  <div className="space-y-1.5"><Label htmlFor={`draft-subject-${draft.id}`} className="text-xs">主题</Label><Input id={`draft-subject-${draft.id}`} value={form.subject} disabled={Boolean(operation)} onChange={(e) => setForm((current) => ({ ...current, subject: e.target.value }))} className="h-8 text-xs" /></div>
                  <div className="space-y-1.5"><Label htmlFor={`draft-body-${draft.id}`} className="text-xs">邮件正文</Label><Textarea id={`draft-body-${draft.id}`} value={form.body} disabled={Boolean(operation)} onChange={(e) => setForm((current) => ({ ...current, body: e.target.value }))} rows={8} className="min-h-40 text-xs leading-relaxed" /></div>
                </>
              ) : (
                <>
                  <div className="space-y-1"><dt className="font-medium text-muted-foreground">收件人</dt><dd className="space-y-0.5 break-all">{(draft.to || []).map((address, index) => <div key={`${address}-${index}`}>{address}</div>)}</dd></div>
                  <div className="space-y-1"><dt className="font-medium text-muted-foreground">主题</dt><dd className="whitespace-pre-wrap break-words">{draft.subject}</dd></div>
                  <div className="space-y-1.5"><dt className="font-medium text-muted-foreground">完整邮件正文</dt><dd className="whitespace-pre-wrap break-words rounded-lg border bg-background p-2.5 text-xs leading-relaxed">{draft.body}</dd></div>
                </>
              )}
            </dl>
            {draft.status === 'sent' && <p role="status" className="leading-relaxed text-muted-foreground">{draft.sentAt ? `${beijingTime(draft.sentAt)}（北京时间）· ` : ''}SMTP 服务已接受发送，不代表最终送达或对方已读。</p>}
            {draft.status === 'sending' && <p role="status" className="leading-relaxed text-muted-foreground">正在发送，请稍候。可刷新状态查看回执。</p>}
            {draft.status === 'unknown' && <p role="alert" className="leading-relaxed text-destructive">发送结果需要核验，可能已发送给部分或全部收件人。请到发件箱核查，避免重复发信。</p>}
            {accepted && <p className="break-all leading-relaxed text-muted-foreground">服务已接受：{accepted}</p>}
            {rejected && <p className="break-all leading-relaxed text-destructive">服务拒绝：{rejected}</p>}
            {(draft.error || error) && <p role="alert" className="whitespace-pre-wrap break-words leading-relaxed text-destructive">{error || draft.error}</p>}
            {needsRefresh && <p className="leading-relaxed text-destructive">请先刷新核验服务端状态，再继续操作。</p>}
            {draft.status === 'pending' && !editing && <p className="text-[11px] leading-relaxed text-muted-foreground">请核对上方发件邮箱、全部收件人、主题和正文。点击确认后将真实发信。</p>}
            {draft.status === 'failed' && draft.canRetry !== true && <p className="leading-relaxed text-muted-foreground">这次发送暂不能直接重试，请根据错误提示核查回执。</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              {editing ? (
                <>
                  <Button type="button" size="sm" disabled={blocked || !form.to.trim() || !form.subject.trim() || !form.body.trim()} onClick={() => perform('edit')}>
                    {operation === 'edit' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}保存修改
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={Boolean(operation)} onClick={() => { setEditing(false); setForm(formOf(draft)); }}>取消编辑</Button>
                </>
              ) : (
                <>
                  {canSend && <Button type="button" size="sm" className="h-auto whitespace-normal py-2" disabled={blocked || !draft.from} onClick={() => perform('send')}>
                    {operation === 'send' ? <LoaderCircle className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}{draft.status === 'failed' ? '确认重试发送' : '确认发送真实邮件'}
                  </Button>}
                  {canEdit && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { editRevisionRef.current = draft.revision; setForm(formOf(draft)); setEditing(true); setError(''); }}><Pencil className="size-3.5" />编辑</Button>}
                  {canEdit && <Button type="button" size="sm" variant="ghost" disabled={blocked} onClick={() => perform('discard')}><X className="size-3.5" />放弃</Button>}
                </>
              )}
              <Button type="button" size="sm" variant="ghost" disabled={Boolean(operation) || disabled} onClick={refresh} aria-label="刷新这份邮件的发送状态"><RefreshCw className={operation === 'refresh' ? 'size-3.5 animate-spin' : 'size-3.5'} />核验状态</Button>
            </div>
            {draft.status === 'discarded' && draft.kind === 'meeting_invitation' && <p className="text-[11px] text-muted-foreground">邀约邮件已放弃，已创建的会议和日程仍可在日历核对。</p>}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
