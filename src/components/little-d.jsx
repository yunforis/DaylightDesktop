import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays, ChevronDown, ChevronRight, FileText, ListTodo, LoaderCircle, Mail, Mic, MicOff, RefreshCw, Search, SendHorizontal, Sparkles, Video, X,
} from 'lucide-react';
import { AssistantDraftReview } from '@/components/assistant-draft-review';
import { AgentThinkingChain } from '@/components/agent-thinking';
import { RagCitations } from '@/components/rag-citations';
import { RichMarkdown } from '@/components/rich-markdown';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { streamAssistantChat } from '@/lib/assistant-stream';
import { createSpeechInput, speechErrorMessage, speechSupport } from '@/lib/little-d-speech';
import { cn } from '@/lib/utils';

const CAPABILITIES = [
  {
    id: 'send-mail',
    icon: Mail,
    title: '写邮件，审核后真实发送',
    detail: '生成可编辑草稿，展示发件邮箱、收件人及完整正文。只有点击确认才会发信。',
    prompts: [{ text: '帮我写邮件给 colleague@example.com，提醒他在本周五 18 点前提交报告。先生成草稿供我审核。', label: '提醒同事提交报告', fillOnly: true }],
  },
  {
    id: 'meeting',
    icon: Video,
    title: '飞书会议与邀约',
    detail: '预创建真实飞书链接，将安排写入日历并起草邀约；你审核后再发给参会人。',
    prompts: [{ text: '帮我安排明天北京时间 15:00 到 16:00 的项目讨论飞书会议，邀请 colleague@example.com。加入日历并生成带会议链接的邀约邮件，供我审核后发送。', label: '安排会议并准备邀约', fillOnly: true }],
  },
  {
    id: 'briefing',
    icon: FileText,
    title: '过去几天的邮件简报',
    detail: '整理当前邮箱本地已保存的邮件，突出重要信息、待办与时间，保留来源。新邮件请先同步。',
    prompts: [{ text: '整理过去 7 天已保存的邮件，给我一份简报，列出重要事项、截止时间、需要回复的内容和来源。', label: '整理过去 7 天邮件' }],
  },
  {
    id: 'calendar',
    icon: CalendarDays,
    title: '日程与时间',
    detail: '按北京时间查看、新建、修改或删除当前邮箱的日程。',
    prompts: [
      { text: '今天有什么安排？', label: '今天的安排' },
      { text: '明天北京时间 15:00 到 16:00 安排产品评审', label: '添加日程', fillOnly: true },
    ],
  },
  {
    id: 'tasks',
    icon: ListTodo,
    title: '待办',
    detail: '列出、新建、修改、完成或删除待办。只给日期时，截止默认当天 18:00。',
    prompts: [
      { text: '把未完成的待办列出来', label: '查看未完成待办' },
      { text: '新增待办：明天 18 点前提交周报，优先级高', label: '添加周报待办', fillOnly: true },
    ],
  },
  {
    id: 'mail',
    icon: Search,
    title: '邮件',
    detail: '搜索已经处理过的邮件，或查看日程关联的来源邮件。',
    prompts: [{ text: '找最近和会议相关的邮件', label: '查找会议邮件' }],
  },
  {
    id: 'knowledge',
    icon: Search,
    title: '简历检索',
    detail: '在当前邮箱已入库的简历片段里查找，并带上页码引用。未开启知识检索时没有结果。',
    prompts: [{ text: '在已入库简历里找做过后端开发的经历', label: '查找简历中的经历' }],
  },
];

const WRITE_TOOLS = new Set([
  'create_event', 'update_event', 'delete_event', 'create_task', 'update_task', 'delete_task',
  'create_feishu_meeting',
]);

const WELCOME = {
  role: 'assistant',
  content: '我是小 D，可以为当前邮箱写邮件、安排飞书会议、整理邮件简报，也能管理日程、待办和查找资料。邮件都会先生成审核草稿，由你核对并点击确认后才真实发送。点「能做什么」查看示例，先填好收件人和时间再体验。',
};

export function LittleD() {
  const { state, reload, setEventModal, viewMode } = useWorkspace();
  const mailboxId = state?.settings?.activeMailboxId || '';
  const mailboxEmail = state?.settings?.email || '未配置邮箱';
  // 混合视图（全部邮箱 / 标签）下，知识检索要和列表口径一致，能查到别的邮箱里的邮件。
  const viewScope = viewMode === 'all'
    ? { scope: 'all' }
    : (String(viewMode || '').startsWith('tag:') ? { tag: String(viewMode).slice(4) } : null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [speechState, setSpeechState] = useState('idle');
  const [speechAvailability, setSpeechAvailability] = useState({ message: '' });
  const [speechError, setSpeechError] = useState('');
  const [speechNotice, setSpeechNotice] = useState('');
  const [messages, setMessages] = useState([WELCOME]);
  const [showGuide, setShowGuide] = useState(true);
  const [drafts, setDrafts] = useState([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState('');
  const [showDrafts, setShowDrafts] = useState(true);
  const inputRef = useRef(null);
  const [liveTrace, setLiveTrace] = useState([]);
  const [liveStatus, setLiveStatus] = useState('');
  const [liveCost, setLiveCost] = useState(null);
  const bottomRef = useRef(null);
  const guideRef = useRef(null);
  const draftsRef = useRef(null);
  const recognitionRef = useRef(null);
  const mailboxRef = useRef(mailboxId);
  const requestEpochRef = useRef(0);
  const pendingRef = useRef(false);
  const draftRequestRef = useRef(0);
  const chatAbortRef = useRef(null);
  mailboxRef.current = mailboxId;
  const listening = speechState !== 'idle';

  useEffect(() => {
    setSpeechAvailability(speechSupport(window));
  }, []);

  useEffect(() => {
    requestEpochRef.current += 1;
    draftRequestRef.current += 1;
    chatAbortRef.current?.abort();
    pendingRef.current = false;
    recognitionRef.current?.cancel();
    recognitionRef.current = null;
    setSpeechState('idle');
    setSpeechError('');
    setSpeechNotice('');
    setInput('');
    setBusy(false);
    setMessages([WELCOME]);
    setShowGuide(true);
    setDrafts([]);
    setDraftsError('');
    setDraftsLoading(false);
    setShowDrafts(true);
    setLiveTrace([]);
    setLiveStatus('');
    setLiveCost(null);
  }, [mailboxId]);

  const loadDrafts = useCallback(async () => {
    if (!mailboxId) return [];
    const currentRequest = ++draftRequestRef.current;
    const isCurrent = () => currentRequest === draftRequestRef.current && mailboxRef.current === mailboxId;
    setDraftsLoading(true);
    try {
      const result = await request('/assistant/drafts', 'GET', undefined, { mailboxId });
      if (!isCurrent()) return [];
      const saved = (result.drafts || []).filter((draft) => draft.mailboxId === mailboxId);
      setDrafts((current) => {
        const latest = new Map(current.filter((draft) => draft.mailboxId === mailboxId).map((draft) => [draft.id, draft]));
        for (const draft of saved) {
          if (!latest.has(draft.id) || latest.get(draft.id).revision <= draft.revision) latest.set(draft.id, draft);
        }
        return [...latest.values()].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      });
      setDraftsError('');
      return saved;
    } catch (error) {
      if (isCurrent()) setDraftsError(error.message || '暂时无法加载审核草稿。');
      throw error;
    } finally {
      if (isCurrent()) setDraftsLoading(false);
    }
  }, [mailboxId]);

  useEffect(() => {
    if (open) loadDrafts().catch(() => {});
  }, [open, loadDrafts]);

  // 关闭或刷新后可恢复审核记录；发送中的状态从服务端核验。
  useEffect(() => {
    if (!open || !drafts.some((draft) => draft.status === 'sending')) return undefined;
    const timer = window.setInterval(() => loadDrafts().catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [open, drafts, loadDrafts]);

  function mergeDraft(draft) {
    if (!draft?.id || draft.mailboxId !== mailboxRef.current) return;
    setDrafts((current) => {
      const previous = current.find((item) => item.id === draft.id);
      if (previous && previous.revision > draft.revision) return current;
      return [draft, ...current.filter((item) => item.id !== draft.id)];
    });
    setShowDrafts(true);
  }

  useEffect(() => {
    function openFromMenu(event) {
      setOpen(true);
      const prompt = event?.detail?.prompt;
      if (prompt != null && String(prompt).trim()) {
        setInput(String(prompt).trim());
      }
    }
    window.addEventListener('daylight:open-little-d', openFromMenu);
    return () => window.removeEventListener('daylight:open-little-d', openFromMenu);
  }, []);

  useEffect(() => {
    if (!open || (messages.length === 1 && !busy)) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, open, busy, liveTrace, liveStatus]);

  useEffect(() => {
    if (open && showGuide) guideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [open, showGuide]);

  useEffect(() => () => {
    requestEpochRef.current += 1;
    draftRequestRef.current += 1;
    chatAbortRef.current?.abort();
    recognitionRef.current?.cancel();
  }, []);

  function cancelListening() {
    recognitionRef.current?.cancel();
    recognitionRef.current = null;
    setSpeechState('idle');
  }

  function toggleListen() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const availability = speechSupport(window);
    setSpeechAvailability(availability);
    if (!availability.Recognition) return;
    setSpeechError('');
    setSpeechNotice('');
    try {
      const session = createSpeechInput({
        Recognition: availability.Recognition,
        initialText: input,
        onText: setInput,
        onStatus: setSpeechState,
        onEnd: ({ transcript, error }) => {
          recognitionRef.current = null;
          setSpeechError(error);
          setSpeechNotice(!error && transcript ? '已转成文字，可编辑后点击发送。' : '');
        },
      });
      recognitionRef.current = session;
      session.start();
    } catch (error) {
      cancelListening();
      setSpeechError(speechErrorMessage(error.name));
    }
  }

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || !mailboxId || pendingRef.current) return;
    cancelListening();
    setSpeechError('');
    setSpeechNotice('');
    pendingRef.current = true;
    const epoch = ++requestEpochRef.current;
    const requestMailboxId = mailboxId;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    const isCurrent = () => epoch === requestEpochRef.current && requestMailboxId === mailboxRef.current;
    const nextMessages = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setInput('');
    setShowGuide(false);
    setBusy(true);
    setLiveTrace([]);
    setLiveStatus('正在思考…');
    setLiveCost(null);
    try {
      const payload = nextMessages
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .slice(-12)
        .map((item) => ({ role: item.role, content: item.content }));
      const result = await streamAssistantChat(payload, {
        mailboxId: requestMailboxId,
        scope: viewScope,
        signal: controller.signal,
        onEvent: (event) => {
          if (!isCurrent()) return;
          if (event.type === 'status' || event.type === 'round') {
            setLiveStatus(event.message || (event.round ? `第 ${event.round} 轮` : '处理中…'));
          }
          if (event.type === 'tool_start') {
            setLiveStatus(`正在调用：${event.name}`);
            setLiveTrace((current) => {
              const withoutRunning = current.filter((item) => !item.running);
              return [...withoutRunning, {
                name: event.name, args: event.args, result: null, running: true, ok: true,
              }];
            });
          }
          if (event.type === 'tool_end') {
            if (event.result?.draft) mergeDraft(event.result.draft);
            setLiveTrace((current) => {
              const next = [...current];
              let index = -1;
              for (let i = next.length - 1; i >= 0; i -= 1) {
                if (next[i].name === event.name && next[i].running) { index = i; break; }
              }
              const entry = {
                name: event.name,
                args: event.args,
                result: event.result,
                latency_ms: event.latency_ms,
                running: false,
                ok: event.result?.ok !== false,
              };
              if (index >= 0) next[index] = entry;
              else next.push(entry);
              return next;
            });
          }
          if (event.type === 'usage' && event.cost) setLiveCost(event.cost);
          if (event.type === 'done' && (event.cost_cny != null || event.usage)) {
            setLiveCost({
              cost_cny: event.cost_cny,
              cost_status: event.cost_status,
              usage: event.usage,
              pricing: event.pricing,
            });
          }
        },
      });
      if (!isCurrent()) return;
      for (const step of result.toolTrace || []) if (step.result?.draft) mergeDraft(step.result.draft);
      const wrote = (result.toolTrace || []).some((item) => WRITE_TOOLS.has(item.name) && item.result?.ok !== false);
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: result.reply || '好的。',
          toolTrace: result.toolTrace || [],
          citations: result.citations || [],
          cost_cny: result.cost_cny,
          cost_status: result.cost_status,
          usage: result.usage,
          pricing: result.pricing,
        },
      ]);
      setLiveTrace([]);
      setLiveStatus('');
      setLiveCost(null);
      await loadDrafts().catch(() => {});
      if (wrote) await reload();
    } catch (error) {
      if (!isCurrent()) return;
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: error.message || '小 D 暂时无法回答，请稍后再试。' },
      ]);
      setLiveTrace([]);
      setLiveStatus('');
      await loadDrafts().catch(() => {});
      try { await reload(); } catch { /* Keep the assistant's original error visible. */ }
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setBusy(false);
      }
    }
  }

  const speechHint = speechError || speechAvailability.message || ({
    starting: '正在启动麦克风，请在浏览器提示中允许使用。',
    listening: '正在听… 说完后点麦克风停止，再确认文字。',
    processing: '正在整理识别结果…',
  }[speechState]) || speechNotice || '语音转成文字后可编辑，确认后发送。';
  const pendingDraftCount = drafts.filter((draft) => ['pending', 'failed', 'sending', 'unknown'].includes(draft.status)).length;
  const settings = state?.settings || {};
  const smtpConfigured = Boolean(settings.email && settings.smtpHost && settings.smtpPort && settings.hasAuthorizationCode);

  return (
    <div data-tour="little-d" className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div
          role="dialog"
          aria-label="小 D 助手"
          className={cn(
            'pointer-events-auto flex h-[min(43rem,calc(100svh-6.5rem))] w-[min(30rem,calc(100vw-2rem))]',
            'flex-col overflow-hidden rounded-2xl border border-border/80',
            'bg-background/90 shadow-2xl shadow-black/10 backdrop-blur-xl',
            'dark:bg-background/85',
          )}
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
                <Sparkles className="size-3.5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">小 D</div>
                <div className="text-[11px] text-muted-foreground">邮件 · 会议 · 简报</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant={showGuide ? 'secondary' : 'ghost'} className="h-7 px-2 text-xs" aria-pressed={showGuide} onClick={() => setShowGuide((value) => !value)}>
                能做什么
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => { setShowDrafts(true); window.requestAnimationFrame(() => draftsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}>
                草稿{pendingDraftCount > 0 && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{pendingDraftCount}</Badge>}
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="关闭小 D" onClick={() => { cancelListening(); setOpen(false); }}>
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <p className="truncate border-b px-4 py-1.5 text-[10px] text-muted-foreground" title={`小 D 只操作当前邮箱：${mailboxEmail}`}>
            当前邮箱：{mailboxEmail} · 对话仅用于此邮箱
          </p>

          <ScrollArea className="min-h-0 flex-1 px-3 py-3">
            <div className="space-y-3">
              {showGuide && (
                <div ref={guideRef} className="space-y-3 rounded-xl border bg-muted/30 p-3">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles className="size-3.5" />从一句话开始</h2>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">写邮件和安排会议的示例会先填入输入框，请替换邮箱与时间后发给我。</p>
                  </div>
                  <div className="space-y-2.5">
                    {CAPABILITIES.slice(0, 3).map((group) => (
                      <div key={group.id} className="space-y-1.5 rounded-lg border bg-card p-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium"><group.icon className="size-3.5 text-muted-foreground" />{group.title}</div>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">{group.detail}</p>
                        <div className="flex flex-wrap gap-1">
                          {group.prompts.map((prompt) => <Button key={prompt.text} type="button" disabled={busy || !mailboxId} variant="secondary" size="xs" className="h-auto whitespace-normal py-1 text-left text-[11px]" onClick={() => {
                            if (prompt.fillOnly) { setInput(prompt.text); setShowGuide(false); inputRef.current?.focus(); }
                            else send(prompt.text);
                          }}>{prompt.label}{prompt.fillOnly ? ' · 先编辑' : ' →'}</Button>)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 border-t pt-2.5">
                    <p className="text-[11px] font-medium">也可以这样用</p>
                    {CAPABILITIES.slice(3).map((group) => <div key={group.id} className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><group.icon className="size-3" />{group.title}</span>
                      {group.prompts.map((prompt) => <Button key={prompt.text} type="button" disabled={busy || !mailboxId} variant="outline" size="xs" className="h-auto whitespace-normal px-2 py-1 text-left text-[11px] font-normal" title={group.detail} onClick={() => {
                        if (prompt.fillOnly) { setInput(prompt.text); setShowGuide(false); inputRef.current?.focus(); }
                        else send(prompt.text);
                      }}>{prompt.label}{prompt.fillOnly ? ' · 先编辑' : ''}</Button>)}
                    </div>)}
                  </div>
                  <div className="space-y-1.5 border-t pt-2.5 text-[11px] text-muted-foreground">
                    <p className="font-medium text-foreground">连接准备</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                      <Link className="underline underline-offset-4" to="/app/settings?tab=model" onClick={() => setOpen(false)}>模型：{settings.modelReady ? '已配置' : '待配置'}</Link>
                      <Link className="underline underline-offset-4" to="/app/settings?tab=mailbox" onClick={() => setOpen(false)}>SMTP：{smtpConfigured ? '已配置' : '待配置'}</Link>
                      <Link className="underline underline-offset-4" to="/app/settings?tab=model" onClick={() => setOpen(false)}>飞书：{settings.feishu?.configured ? '已配置' : '待配置'}</Link>
                    </div>
                    <p className="leading-relaxed">已配置表示字段已保存，实际连接以执行结果为准。邮件简报只整理本地已保存的邮件；需要最新内容时请先同步。可用语音输入，核对文字后发送。</p>
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[92%] space-y-2 rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      message.role === 'user'
                        ? 'bg-foreground text-background'
                        : 'border bg-card text-card-foreground',
                    )}
                  >
                    {message.role === 'user' ? (
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    ) : (
                      <RichMarkdown className={cn(message.role === 'assistant' && '[&_a]:text-inherit')}>
                        {message.content}
                      </RichMarkdown>
                    )}
                    {message.citations?.length > 0 && (
                      <RagCitations
                        citations={message.citations}
                        mailboxId={mailboxId}
                        className="mt-1"
                      />
                    )}
                    {message.toolTrace?.length > 0 && (
                      <AgentThinkingChain
                        toolTrace={message.toolTrace}
                        defaultOpen={false}
                        className="bg-background/60"
                        cost={message.cost_cny != null || message.usage ? {
                          cost_cny: message.cost_cny,
                          cost_status: message.cost_status,
                          usage: message.usage,
                        } : null}
                      />
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="space-y-2 rounded-2xl border bg-card p-3 text-card-foreground">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    {liveStatus || '小 D 正在处理…'}
                  </div>
                  <AgentThinkingChain
                    toolTrace={liveTrace}
                    running
                    defaultOpen
                    cost={liveCost}
                    title={liveTrace.length ? `思考过程 · ${liveTrace.length} 步` : '思考过程'}
                  />
                </div>
              )}
              <div ref={draftsRef} className="space-y-2 rounded-xl border bg-muted/20 p-2.5">
                <Collapsible open={showDrafts} onOpenChange={setShowDrafts}>
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <CollapsibleTrigger asChild><Button size="xs" type="button" variant="ghost" className="h-auto px-0 py-1 text-xs font-medium">{showDrafts ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}邮件审核与发送记录 <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{drafts.length}</Badge></Button></CollapsibleTrigger>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="刷新邮件草稿与发送记录" disabled={draftsLoading || !mailboxId} onClick={() => loadDrafts().catch(() => {})}><RefreshCw className={cn('size-3', draftsLoading && 'animate-spin')} /></Button>
                  </div>
                  <CollapsibleContent className="space-y-2 pt-2">
                    {draftsError && <p role="alert" className="text-xs leading-relaxed text-destructive">{draftsError}</p>}
                    {!drafts.length && <p className="text-[11px] leading-relaxed text-muted-foreground">{draftsLoading ? '正在加载已保存的草稿…' : '请告诉我收件邮箱和要写的内容。草稿会保存在这里，可在关闭或刷新页面后继续审核。'}</p>}
                    {drafts.map((draft) => <AssistantDraftReview
                      key={`${mailboxId}:${draft.id}`}
                      draft={draft}
                      mailboxId={mailboxId}
                      event={state?.events?.find((event) => event.id === draft.eventId && (!event.mailboxId || event.mailboxId === mailboxId))}
                      disabled={busy || draft.mailboxId !== mailboxId}
                      onChanged={mergeDraft}
                      onRefresh={loadDrafts}
                      onViewEvent={(event) => { setEventModal({ event }); setOpen(false); }}
                    />)}
                  </CollapsibleContent>
                </Collapsible>
              </div>
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          <div className="border-t p-3">
            <div className="rounded-xl border bg-muted/30 p-2">
              <Textarea
                ref={inputRef}
                aria-label="给小 D 的消息"
                aria-describedby="little-d-voice-status"
                value={input}
                disabled={busy || !mailboxId}
                rows={2}
                placeholder={listening ? '正在听…' : '写邮件、安排会议，或整理最近的邮件…'}
                className="min-h-[2.5rem] resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:ring-0"
                onChange={(e) => {
                  cancelListening();
                  setSpeechError('');
                  setSpeechNotice('');
                  setInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    send(input);
                  }
                }}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
                <span className="text-[10px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={listening ? 'default' : 'ghost'}
                    className={cn(listening && 'animate-pulse')}
                    disabled={busy || !mailboxId || !speechAvailability.Recognition || speechState === 'processing'}
                    aria-label={listening ? '停止语音输入' : '语音输入'}
                    aria-pressed={listening}
                    title={speechAvailability.message || (listening ? '停止语音输入' : '语音输入')}
                    onClick={toggleListen}
                  >
                    {listening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    aria-label="发送给小 D"
                    disabled={busy || !mailboxId || !input.trim()}
                    onClick={() => send(input)}
                  >
                    {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
            <p id="little-d-voice-status" role="status" aria-live="polite" className={cn('mt-1.5 px-1 text-[10px] leading-relaxed', speechError ? 'text-destructive' : 'text-muted-foreground')}>
              {speechHint}
            </p>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={open ? '关闭小 D' : '打开小 D'}
        className={cn(
          'pointer-events-auto group flex h-14 items-center gap-2.5 rounded-full border',
          'bg-background/90 px-4 text-sm font-medium shadow-lg shadow-black/10 backdrop-blur-xl',
          'transition hover:bg-background',
          open && 'ring-2 ring-foreground/15',
        )}
        onClick={() => {
          if (open) cancelListening();
          setOpen((value) => !value);
        }}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-foreground text-background">
          <Sparkles className="size-3.5" />
        </span>
        <span className="pr-1">小 D</span>
      </button>
    </div>
  );
}
