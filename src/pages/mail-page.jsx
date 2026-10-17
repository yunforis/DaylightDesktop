import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Inbox, LoaderCircle, Mail, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { HighlightText } from '@/components/highlight-text';
import { Textarea } from '@/components/ui/textarea';
import { RagCitations } from '@/components/rag-citations';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { EMAIL_CATEGORIES, emailResult } from '@/lib/domain';
import { shanghaiDate, shortDate } from '@/lib/time';

const RESUME_VISIBLE_KEY = 'daylight.showResumeEmails';

function MailKnowledge() {
  const { state, saveSettings, viewMode } = useWorkspace();
  const mailboxId = state?.settings?.activeMailboxId || '';
  // 混合视图（全部邮箱 / 标签）下，列表里能看到多个邮箱的邮件，检索必须覆盖同一批邮箱，
  // 否则会出现「列表里明明有这封信，问小 D 却说找不到」。
  const scopeParams = viewMode === 'all'
    ? { scope: 'all' }
    : (String(viewMode || '').startsWith('tag:') ? { tag: String(viewMode).slice(4) } : {});
  const mixedView = Boolean(scopeParams.scope || scopeParams.tag);
  const statusQuery = scopeParams.scope ? '?scope=all' : (scopeParams.tag ? `?tag=${encodeURIComponent(scopeParams.tag)}` : '');
  const scopeTitle = scopeParams.scope === 'all'
    ? '在全部邮箱里找'
    : (scopeParams.tag ? `在「${scopeParams.tag}」邮箱里找` : '在当前邮箱里找');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  // 新消息总是出现在底部，且视图停在底部：消息区自身滚动，页面不再被撑高而把输入框顶出视口。
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setStatus(null);
    if (!mailboxId && !mixedView) return undefined;
    request(`/rag/status${statusQuery}`).then((result) => {
      if (!cancelled) setStatus(result);
    }).catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [mailboxId, mixedView, statusQuery]);

  async function reindex() {
    setIndexing(true);
    setError('');
    try {
      const result = await request('/rag/reindex', 'POST', { ...scopeParams });
      setStatus((current) => ({ ...(current || {}), ...result, enabled: true }));
    } catch (err) {
      setError(err.message || '纳入知识库失败');
    } finally {
      setIndexing(false);
    }
  }

  async function enableEmbedding() {
    setIndexing(true);
    setError('');
    try {
      // 走和设置页同一条保存链路，避免只改一个字段时把邮箱配置改回默认值。
      const base = state?.settings || {};
      await saveSettings({ ...base, mailboxId: base.activeMailboxId, ragEmbeddings: true });
      const result = await request('/rag/reindex', 'POST', { ...scopeParams });
      setStatus((current) => ({ ...(current || {}), ...result, embeddings: true, keywordOnly: false }));
    } catch (err) {
      setError(err.message || '启用向量检索失败');
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
      const result = await request('/rag/ask', 'POST', { message, ...scopeParams });
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
    // 与「招聘助手」同一套布局：桌面端贴住视口顶部并占满可视高度，左侧列表很长时
    // 也不再出现「右侧卡片到一半就断掉、下面留一大片空白」。
    <Card className="flex min-h-[28rem] flex-col xl:sticky xl:top-4 xl:h-[calc(100vh-6rem)] xl:max-h-[calc(100vh-6rem)] xl:min-h-0">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="size-4" />{scopeTitle}
        </CardTitle>
        <CardDescription>
          {status?.chunkCount
            ? `知识库 ${status.chunkCount} 个片段${status.embeddings ? '（关键词 + 向量）' : '（关键词）'}，${(status.mailboxCount || 1) > 1 ? `覆盖当前视图的 ${status.mailboxCount} 个邮箱。` : '只检索正在查看的这个邮箱。'}`
            : (mixedView
              ? '把已处理邮件和附件纳入知识库后，可以用一句话在当前视图的多个邮箱里找回通知。'
              : '把已处理邮件和附件纳入知识库后，可以用一句话找回通知。')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={indexing || !mailboxId} onClick={reindex}>
            {indexing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            纳入已处理邮件
          </Button>
          {status?.keywordOnly === true && (
            <Button size="sm" variant="ghost" disabled={indexing} onClick={enableEmbedding}>启用向量检索</Button>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border bg-muted/20 p-3">
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

const EMAIL_PAGE_SIZE = 20;

/**
 * 关键词快速查找用的检索文本：主题、发件人、提取摘要、正文、附件名与分类名。
 * 字段与命令面板的邮件检索保持一致——查的就是这份「已处理邮件」，不需要再建一份索引表。
 */
function emailSearchText(email) {
  const category = email.category || email.extraction?.category;
  return [
    email.subject,
    email.sender,
    email.summary,
    email.extraction?.summary,
    email.body,
    ...(email.attachments || []).map((attachment) => attachment?.filename || attachment?.name),
    category ? (EMAIL_CATEGORIES[category] || category) : '',
    email.mailboxEmail,
  ].filter((value) => typeof value === 'string' && value).join('\n').toLowerCase();
}

export default function MailPage() {
  const {
    emails, syncResult, isSyncing, sync, openEmail, selectedEmail,
  } = useWorkspace();
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
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

  // 关键词查找：命中主题、发件人、摘要、正文、附件名或分类名中的任意一处。
  const matchedEmails = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return filteredEmails;
    return filteredEmails.filter((email) => emailSearchText(email).includes(needle));
  }, [filteredEmails, keyword]);

  const pageCount = Math.max(1, Math.ceil(matchedEmails.length / EMAIL_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleEmails = matchedEmails.slice((safePage - 1) * EMAIL_PAGE_SIZE, safePage * EMAIL_PAGE_SIZE);

  // 切分类、切换「显示求职简历」或改关键词时回到第一页，免得停在一个已经变短的页码上。
  useEffect(() => { setPage(1); }, [keyword, categoryFilter, showResumes]);

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(Object.keys(EMAIL_CATEGORIES).map((id) => [id, 0]));
    for (const email of emails) {
      const category = email.category || email.extraction?.category;
      if (category && counts[category] != null) counts[category] += 1;
    }
    return counts;
  }, [emails]);

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
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
          <CardContent className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {conflicts.map((email) => (
              <button
                key={`${email.mailboxId || ''}:${email.id}`}
                type="button"
                className="min-w-0 rounded-lg border px-3 py-2 text-left hover:bg-muted/40"
                onClick={() => openEmail(email.id, email.mailboxId)}
              >
                <div className="truncate text-sm font-medium">
                  <HighlightText text={email.subject} query={keyword} />
                </div>
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base">处理记录</CardTitle>
              <CardDescription>
                {keyword.trim()
                  ? `关键词命中 ${matchedEmails.length} / ${filteredEmails.length} 封`
                  : categoryFilter === 'all'
                    ? '点击查看原文与提取结果'
                    : `当前筛选：${EMAIL_CATEGORIES[categoryFilter] || categoryFilter}`}
              </CardDescription>
            </div>
            <div className="relative w-full min-w-0 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="按关键词查找已处理邮件"
                className="pl-8"
                placeholder="关键词：主题、发件人、正文或附件"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {visibleEmails.length ? (
            <div className="divide-y rounded-lg border">
              {visibleEmails.map((email) => {
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
                      <div className="truncate text-sm font-medium">
                        <HighlightText text={email.subject} query={keyword} />
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        <HighlightText text={email.sender} query={keyword} />
                        {` · ${shortDate(shanghaiDate(email.receivedAt))}`}
                      </div>
                      {email.summary && (
                        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          <HighlightText text={email.summary} query={keyword} />
                        </div>
                      )}
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
              {keyword.trim()
                ? `没有匹配「${keyword.trim()}」的已处理邮件。`
                : emails.length ? '当前分类下没有邮件。' : '暂无邮件。同步邮箱或导入演示数据。'}
            </p>
          )}
          {pageCount > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
              <p className="text-xs text-muted-foreground">
                第 {safePage} / {pageCount} 页 · 共 {matchedEmails.length} 封 · 每页 {EMAIL_PAGE_SIZE} 封
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                  上一页
                </Button>
                <Button size="sm" variant="outline" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
    <MailKnowledge />
    </div>
  );
}
