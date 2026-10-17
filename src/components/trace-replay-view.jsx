import React, { useEffect, useState } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, Clock3, LoaderCircle,
  Pause, Play, RotateCcw, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const STATUS = {
  running: '处理中', completed: '已完成', imported: '已完成', success: '已完成',
  skipped: '已跳过', conflict: '日程冲突', failed: '失败，可重试',
};
const STAGES = {
  receive_email: '接收邮件', parse: '解析邮件', queue_wait: '等待前序邮件',
  check_calendar: '检查日历与待办', extract: '模型提取', create_task: '更新日历与待办',
  draft_reply: '整理回复草稿',
};

const formatNumber = (value) => Number(value).toLocaleString('zh-CN');
const duration = (value) => (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`);
const amount = (value) => (value === null || value === undefined ? '未知' : `¥${Number(value).toFixed(5)}`);
const cents = (value) => `${Number((Number(value) * 100).toFixed(3))} 分钱`;
const traceClock = (value) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(value));
const hasNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const elapsedSpan = (span, now) => (span.status === 'running' ? Math.max(0, now - Date.parse(span.started_at)) : span.latency_ms || 0);
const elapsedAttempt = (attempt, now) => (attempt.status === 'running' ? Math.max(0, now - Date.parse(attempt.started_at)) : attempt.latency_ms || 0);
const elapsedTrace = (trace, now) => (trace.attempts?.length
  ? trace.attempts.reduce((sum, attempt) => sum + elapsedAttempt(attempt, now), 0)
  : trace.latency_ms || 0);
const decisionText = (decision) => (typeof decision === 'string' ? decision : decision?.summary || '等待处理结果');

function MetricCard({ label, value, note }) {
  return (
    <Card className="shadow-none">
      <CardHeader className="space-y-1 p-3 pb-1">
        <CardDescription className="text-[11px]">{label}</CardDescription>
        <CardTitle className="text-xl font-medium tabular-nums tracking-tight">{value}</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <p className="text-[10px] leading-relaxed text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

/**
 * shadcn 风格完整回放与计量；数据字段与旧 TraceReplay 一致。
 * DraftReply 仍由调用方在 showDraft 时通过 children / 外层传入。
 */
export function TraceReplayView({
  trace, now = Date.now(), showDraft = true, draftSlot = null, renderEvidence = null,
}) {
  const spans = trace.spans || [];
  const attempts = trace.attempts || [];
  const offsets = new Map();
  let precedingDuration = 0;
  for (const attempt of attempts) {
    offsets.set(attempt.attempt, precedingDuration);
    precedingDuration += elapsedAttempt(attempt, now);
  }
  const spanOffset = (span) => (offsets.get(span.attempt) || 0) + (span.offset_ms || 0);
  const [cursor, setCursor] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [idOpen, setIdOpen] = useState(false);
  const currentIndex = cursor === null ? Math.max(0, spans.length - 1) : Math.min(cursor, spans.length - 1);
  const currentSpan = spans[currentIndex];

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setTimeout(() => {
      if (currentIndex >= spans.length - 1) setPlaying(false);
      else setCursor(currentIndex + 1);
    }, 1400);
    return () => clearTimeout(timer);
  }, [playing, currentIndex, spans.length]);

  const visibleSpans = cursor === null ? spans : spans.slice(0, currentIndex + 1);
  const totalDuration = Math.max(0, elapsedTrace(trace, now), ...spans.map((span) => spanOffset(span) + elapsedSpan(span, now)));
  const chartDuration = Math.max(1, totalDuration);
  const accumulatedDuration = cursor === null
    ? elapsedTrace(trace, now)
    : Math.max(0, ...visibleSpans.map((span) => spanOffset(span) + elapsedSpan(span, now)));
  const tokensIn = visibleSpans.reduce((sum, span) => sum + (span.llm_tokens_in || 0), 0);
  const tokensOut = visibleSpans.reduce((sum, span) => sum + (span.llm_tokens_out || 0), 0);
  const hasUnknownUsage = visibleSpans.some((span) => (
    (span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false))
    && (!hasNumber(span.llm_tokens_in) || !hasNumber(span.llm_tokens_out))
  ));
  const hasUnknownCost = visibleSpans.some((span) => span.cost_cny === null || span.cost_cny === undefined);
  const accumulatedCost = hasUnknownCost ? null : visibleSpans.reduce((sum, span) => sum + span.cost_cny, 0);

  function chooseStep(index) {
    setPlaying(false);
    setCursor(index);
  }

  const modeLabel = trace.mode === 'demo' ? '示例 · 预置结果'
    : trace.kind === 'recruitment' ? '招聘助手' : '真实邮箱';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{modeLabel}</Badge>
            <Badge variant={trace.status === 'failed' ? 'destructive' : 'outline'}>
              {STATUS[trace.status] || trace.status}
            </Badge>
            {attempts.length > 1 && <Badge variant="outline">共 {attempts.length} 次尝试</Badge>}
          </div>
          <h3 className="text-base font-medium leading-snug">{trace.subject || '无主题邮件'}</h3>
          <p className="text-sm text-muted-foreground">{decisionText(trace.decision)}</p>
        </div>
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" />
          {traceClock(trace.started_at)}
        </div>
      </div>

      {trace.status === 'failed' && trace.match_retry && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-50" role="status">
          待匹配原日程：当前日历没有明确的变更对象，自动同步会暂缓重复模型请求。补充或修正原日程后会自动重试，也可点击「同步真实邮箱」手动重试。
        </p>
      )}

      <Collapsible open={idOpen} onOpenChange={setIdOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-auto px-0 text-xs text-muted-foreground">
            Trace {String(trace.trace_id || '').slice(0, 12)}…
            <ChevronDown className={cn('size-3.5 transition', idOpen && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
            {`trace_id: ${trace.trace_id}\nemail_ref: ${trace.email_ref}\n每封邮件保留一条证据链，重试记录追加到同一封邮件。`}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      {trace.mode === 'demo' && (
        <p className="inline-flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />
          示例使用预置提取结果，Token 与成本不计入真实邮件统计。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!spans.length || trace.status === 'running'}
          onClick={() => {
            if (playing) setPlaying(false);
            else { setCursor(0); setPlaying(true); }
          }}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? '暂停回放' : '完整回放'}
        </Button>
        <div className="inline-flex items-center gap-1 rounded-md border px-1">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="上一步" disabled={currentIndex <= 0 || !spans.length} onClick={() => chooseStep(currentIndex - 1)}>
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground">
            第 {spans.length ? currentIndex + 1 : 0} / {spans.length} 步
          </span>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="下一步" disabled={currentIndex >= spans.length - 1} onClick={() => chooseStep(currentIndex + 1)}>
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => { setCursor(null); setPlaying(false); }}
        >
          <RotateCcw className="size-3.5" />
          {trace.status === 'running' ? '跟随实时进度' : '查看全部'}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3" aria-live="polite">
        <MetricCard label="耗时" value={duration(accumulatedDuration)} note="累计至此" />
        <MetricCard
          label="Token"
          value={hasUnknownUsage ? '未知' : formatNumber(tokensIn + tokensOut)}
          note={hasUnknownUsage ? '用量待补齐' : `输入 ${formatNumber(tokensIn)} / 输出 ${formatNumber(tokensOut)}`}
        />
        <MetricCard
          label="成本"
          value={amount(accumulatedCost)}
          note={hasUnknownCost ? '待补齐用量或单价' : cents(accumulatedCost)}
        />
      </div>

      <Card className="shadow-none">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 pb-2">
          <CardTitle className="text-sm font-medium">执行时间轴</CardTitle>
          <CardDescription className="text-xs">实际耗时 · {duration(totalDuration)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 p-3 pt-0">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>0</span>
            <span>{duration(totalDuration / 2)}</span>
            <span>{duration(totalDuration)}</span>
          </div>
          {spans.map((span, index) => (
            <React.Fragment key={span.span_id || index}>
              {attempts.length > 1 && (index === 0 || spans[index - 1].attempt !== span.attempt) && (
                <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground">
                  <span>尝试 {span.attempt}</span>
                  <span>
                    {STATUS[attempts.find((attempt) => attempt.attempt === span.attempt)?.status]}
                    {' · '}
                    {traceClock(span.started_at)}
                  </span>
                </div>
              )}
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition',
                  index === currentIndex ? 'border-foreground/30 bg-muted/40' : 'hover:bg-muted/30',
                  cursor !== null && index > currentIndex && 'opacity-45',
                )}
                onClick={() => chooseStep(index)}
              >
                <span className="w-28 shrink-0 truncate text-[11px] font-medium">
                  {String(index + 1).padStart(2, '0')}{' '}
                  {span.label || STAGES[span.stage] || span.stage}
                </span>
                <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn(
                      'absolute top-0 h-full rounded-full',
                      span.status === 'failed' ? 'bg-destructive' : 'bg-foreground/70',
                    )}
                    style={{
                      left: `${(spanOffset(span) / chartDuration) * 100}%`,
                      width: `${Math.max(0.6, (elapsedSpan(span, now) / chartDuration) * 100)}%`,
                    }}
                  />
                </span>
                <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {duration(elapsedSpan(span, now))}
                </span>
              </button>
            </React.Fragment>
          ))}
          {!spans.length && (
            <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />等待第一步记录…
            </p>
          )}
        </CardContent>
      </Card>

      {currentSpan && renderEvidence && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-none">
          {renderEvidence(currentSpan, currentIndex)}
        </div>
      )}

      {showDraft && draftSlot && (cursor === null || currentIndex === spans.length - 1) ? draftSlot : null}
    </div>
  );
}
