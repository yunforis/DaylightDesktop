import React, { useEffect, useRef, useState } from 'react';
import {
  LoaderCircle, Mic, MicOff, SendHorizontal, Sparkles, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  '今天有什么安排？',
  '下周的会议安排在什么时候？',
  '帮我创建一个明天下午 3 点的产品评审',
  '把未完成的待办列出来',
];

const WRITE_TOOLS = new Set([
  'create_event', 'update_event', 'delete_event', 'update_task',
]);

function SpeechCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function LittleD() {
  const { reload } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '我是小 D。可以帮你查日程、改安排、看待办和关联邮件。直接打字，或点麦克风说话。',
    },
  ]);
  const bottomRef = useRef(null);
  const recognitionRef = useRef(null);
  const listeningRef = useRef(false);

  useEffect(() => {
    setSpeechSupported(Boolean(SpeechCtor()));
  }, []);

  useEffect(() => {
    function openFromMenu() { setOpen(true); }
    window.addEventListener('daylight:open-little-d', openFromMenu);
    return () => window.removeEventListener('daylight:open-little-d', openFromMenu);
  }, []);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, busy]);

  useEffect(() => () => {
    recognitionRef.current?.stop?.();
  }, []);

  function stopListening() {
    listeningRef.current = false;
    setListening(false);
    try { recognitionRef.current?.stop?.(); } catch { /* ignore */ }
  }

  function toggleListen() {
    const Ctor = SpeechCtor();
    if (!Ctor) return;
    if (listeningRef.current) {
      stopListening();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognitionRef.current = recognition;
    let finalText = '';
    recognition.onstart = () => {
      listeningRef.current = true;
      setListening(true);
    };
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      setInput((finalText + interim).trim());
    };
    recognition.onerror = () => stopListening();
    recognition.onend = () => {
      listeningRef.current = false;
      setListening(false);
    };
    try {
      recognition.start();
    } catch {
      stopListening();
    }
  }

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || busy) return;
    stopListening();
    const nextMessages = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setInput('');
    setBusy(true);
    try {
      const payload = nextMessages
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .slice(-12)
        .map((item) => ({ role: item.role, content: item.content }));
      const result = await request('/assistant/chat', 'POST', { messages: payload });
      const wrote = (result.toolTrace || []).some((item) => WRITE_TOOLS.has(item.name) && item.result?.ok !== false);
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: result.reply || '好的。',
          tools: (result.toolTrace || []).map((item) => item.name),
        },
      ]);
      if (wrote) await reload();
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: error.message || '小 D 暂时无法回答，请稍后再试。' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-tour="little-d" className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div
          className={cn(
            'pointer-events-auto flex h-[min(34rem,calc(100svh-6.5rem))] w-[min(24rem,calc(100vw-2rem))]',
            'flex-col overflow-hidden rounded-2xl border border-white/30',
            'bg-background/55 shadow-2xl shadow-black/10 backdrop-blur-2xl',
            'dark:border-white/10 dark:bg-background/45',
          )}
        >
          <div className="flex items-center justify-between border-b border-white/20 px-4 py-3 dark:border-white/10">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
                <Sparkles className="size-3.5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">小 D</div>
                <div className="text-[11px] text-muted-foreground">日程 · 待办 · 邮件助手</div>
              </div>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => { stopListening(); setOpen(false); }}>
              <X className="size-4" />
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-3 py-3">
            <div className="space-y-3">
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      message.role === 'user'
                        ? 'bg-foreground text-background'
                        : 'border border-white/25 bg-white/40 text-foreground dark:border-white/10 dark:bg-white/5',
                    )}
                  >
                    <div className="whitespace-pre-wrap">{message.content}</div>
                    {message.tools?.length > 0 && (
                      <div className="mt-1.5 text-[10px] opacity-60">
                        已调用：{message.tools.join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  小 D 正在处理…
                </div>
              )}
              {messages.length <= 1 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {SUGGESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      disabled={busy}
                      className="rounded-full border border-white/30 bg-white/35 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-white/55 dark:border-white/10 dark:bg-white/5"
                      onClick={() => send(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          <div className="border-t border-white/20 p-3 dark:border-white/10">
            <div className="flex items-end gap-2 rounded-xl border border-white/25 bg-white/35 p-2 backdrop-blur-md dark:border-white/10 dark:bg-white/5">
              <Textarea
                value={input}
                disabled={busy}
                rows={2}
                placeholder={listening ? '正在听…' : '问问小 D，或说说你的安排'}
                className="min-h-[2.75rem] resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
              />
              <div className="flex shrink-0 flex-col gap-1">
                {speechSupported && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={listening ? 'default' : 'ghost'}
                    className={cn(listening && 'animate-pulse')}
                    disabled={busy}
                    title={listening ? '停止语音输入' : '语音输入'}
                    onClick={toggleListen}
                  >
                    {listening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  disabled={busy || !input.trim()}
                  onClick={() => send(input)}
                >
                  {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
                </Button>
              </div>
            </div>
            {!speechSupported && (
              <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
                当前浏览器不支持语音输入，可改用文字。
              </p>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={open ? '关闭小 D' : '打开小 D'}
        className={cn(
          'pointer-events-auto group flex h-14 items-center gap-2.5 rounded-full border border-white/35',
          'bg-background/60 px-4 text-sm font-medium shadow-lg shadow-black/10 backdrop-blur-xl',
          'transition hover:bg-background/80 dark:border-white/15 dark:bg-background/50',
          open && 'ring-2 ring-foreground/15',
        )}
        onClick={() => {
          if (open) stopListening();
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
