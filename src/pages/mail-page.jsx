import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Inbox, LoaderCircle, Mail, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { RagCitations } from '@/components/rag-citations';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { EMAIL_CATEGORIES, emailResult } from '@/lib/domain';
import { shanghaiDate, shortDate } from '@/lib/time';

const RESUME_VISIBLE_KEY = 'daylight.showResumeEmails';

function MailKnowledge() {
  const { state } = useWorkspace();
  const mailboxId = state?.settings?.activeMailboxId || '';
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setStatus(null);
    if (!mailboxId) return undefined;
    request('/rag/status').then((result) => {
      if (!cancelled) setStatus(result);
    }).catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [mailboxId]);

  async function reindex() {
    setIndexing(true);
    setError('');
    try {
      const result = await request('/rag/reindex', 'POST', {});
      setStatus((current) => ({ ...(current || {}), ...result, enabled: true }));
    } catch (err) {
      setError(err.message || '纳入知识库失败');
    } finally {
      setIndexing(false);
    }
  }

  async function ask() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setError('');
    setMessages((current) => [...current, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const result = await request('/rag/ask', 'POST', { message });
      setMessages((current) => [...current, {
        role: 'assistant',
        content: result.answer || '没有找到相关片段。',
        citations: result.citations || [],
      }]);
    } catch (err) {
      setMessages((current) => [...current, { role: 'assistant', content: err.message || '查找失败' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex min-h-[28rem] flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="size-4" />在当前邮箱里找
        </CardTitle>
        <CardDescription>
          {status?.chunkCount
            ? `知识库 ${status.chunkCount} 个片段，只检索正在查看的这个邮箱。`
            : '把已处理邮件和附件纳入知识库后，可以用一句话找回通知。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={indexing || !mailboxId} onClick={reindex}>
            {indexing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            纳入已处理邮件
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="min-h-48 flex-1 space-y-3 overflow-auto rounded-lg border bg-muted/20 p-3">
          {messages.length === 0 && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              例如：我忘了之前有一个比赛的通知，帮我找找相关邮件。回答下面会列出证据片段，点开即可查看原文并高亮。
            </p>
          )}
          {messages.map((message, index) => (
            <div key={index} className={message.role === 'user' ? 'ml-6' : 'mr-2'}>
              <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-background border'}`}>
                {message.content}
              </div>
              {message.citations?.length > 0 && (
                <RagCitations className="mt-2" citations={message.citations} mailboxId={mailboxId} />
              )}
            </div>
          ))}
          {busy && <p className="text-xs text-muted-foreground">正在检索…</p>}
        </div>
        <div className="space-y-2">
          <Textarea
            value={input}
            rows={3}
            placeholder="描述你记得的比赛、截止或附件…"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                ask();
              }
            }}
          />
          <Button disabled={busy || !input.trim()} onClick={ask}>查找</Button>
        </div>
      </CardContent>
    </Card>
  );
}

const FILTERS = [
  { id: 'all', label: '全部' },
  ...Object.entries(EMAIL_CATEGORIES).map(([id, label]) => ({ id, label })),
];

export default function MailPage() {
  const {
    emails, syncResult, isSyncing, sync, openEmail, selectedEmail,
  } = useWorkspace();
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showResumes, setShowResumes] = useState(() => {
    try { return localStorage.getItem(RESUME_VISIBLE_KEY) !== 'false'; } catch { return true; }
  });

  const conflicts = emails.filter((email) => email.conflicts?.length);
  const resumeCount = emails.filter((email) => (email.category || email.extraction?.category) === 'resume').length;
  const baseEmails = useMemo(() => (
    showResumes ? emails : emails.filter((email) => (email.category || email.extraction?.category) !== 'resume')
  ), [emails, showResumes]);
  const filteredEmails = useMemo(() => {
    if (categoryFilter === 'all') return baseEmails;
    return baseEmails.filter((email) => (email.category || email.extraction?.category) === categoryFilter);
  }, [baseEmails, categoryFilter]);

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(Object.keys(EMAIL_CATEGORIES).map((id) => [id, 0]));
    for (const email of emails) {
      const category = email.category || email.extraction?.category;
      if (category && counts[category] != null) counts[category] += 1;
    }
    return counts;
  }, [emails]);

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">邮件</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {baseEmails.length} 封已处理
            {baseEmails.length !== emails.length ? ` / ${emails.length}` : ''}
            {' · '}{conflicts.length} 封冲突待确认 · 按主题分类筛选
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={showResumes}
              onCheckedChange={(checked) => {
                const next = Boolean(checked);
                setShowResumes(next);
                try { localStorage.setItem(RESUME_VISIBLE_KEY, String(next)); } catch { /* ignore */ }
              }}
            />
            显示求职简历
            <span className="tabular-nums text-xs opacity-70">{resumeCount}</span>
          </label>
          <Button disabled={isSyncing} onClick={() => sync('qq')}>
            {isSyncing ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4" />}
            同步
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isSyncing}>演示</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => sync('demo')}>示例导入</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-changes')}>取消与调整</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-conflicts')}>日程冲突</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-tasks')}>标签与待办</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.id}
            size="sm"
            variant={categoryFilter === filter.id ? 'default' : 'outline'}
            onClick={() => setCategoryFilter(filter.id)}
          >
            {filter.label}
            {filter.id !== 'all' && (
              <span className="ml-1 tabular-nums text-xs opacity-70">{categoryCounts[filter.id] || 0}</span>
            )}
            {filter.id === 'all' && (
              <span className="ml-1 tabular-nums text-xs opacity-70">{baseEmails.length}</span>
            )}
          </Button>
        ))}
      </div>

      {conflicts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-amber-600" />待确认冲突
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {conflicts.map((email) => (
              <button
                key={`${email.mailboxId || ''}:${email.id}`}
                type="button"
                className="rounded-lg border px-3 py-2 text-left hover:bg-muted/40"
                onClick={() => openEmail(email.id, email.mailboxId)}
              >
                <div className="truncate text-sm font-medium">{email.subject}</div>
                <div className="text-xs text-muted-foreground">{email.conflicts.length} 项冲突</div>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {syncResult?.errors?.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">{syncResult.errors.length} 封处理失败</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {syncResult.errors.map((error, index) => (
              <p key={index}>{error.subject}：{error.message}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">处理记录</CardTitle>
          <CardDescription>
            {categoryFilter === 'all'
              ? '点击查看原文与提取结果'
              : `当前筛选：${EMAIL_CATEGORIES[categoryFilter] || categoryFilter}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredEmails.length ? (
            <div className="divide-y rounded-lg border">
              {filteredEmails.map((email) => {
                const itemCategory = email.category || email.extraction?.category;
                return (
                  <button
                    key={`${email.mailboxId || ''}:${email.id}`}
                    type="button"
                    className={`flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 ${selectedEmail?.id === email.id ? 'bg-muted/60' : ''}`}
                    onClick={() => openEmail(email.id, email.mailboxId)}
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      {email.status === 'conflict' ? <AlertTriangle className="size-4" /> : <Inbox className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{email.subject}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {email.sender} · {shortDate(shanghaiDate(email.receivedAt))}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {itemCategory && <Badge variant="outline">{EMAIL_CATEGORIES[itemCategory] || itemCategory}</Badge>}
                        {email.priority && <Badge variant="secondary">{email.priority === 'high' ? '高优先' : email.priority === 'low' ? '低优先' : '普通'}</Badge>}
                        <Badge variant="secondary">{emailResult(email)}</Badge>
                      </div>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {emails.length ? '当前分类下没有邮件。' : '暂无邮件。同步邮箱或导入演示数据。'}
            </p>
          )}
        </CardContent>
      </Card>

    </div>
    <MailKnowledge />
    </div>
  );
}
