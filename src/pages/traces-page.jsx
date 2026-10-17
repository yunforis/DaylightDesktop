import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Check, ChevronDown, FileText, LoaderCircle, Mail, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/context/workspace';
import { cn } from '@/lib/utils';

const STATUS = {
  running: '处理中', completed: '已完成', imported: '已完成', success: '已完成',
  skipped: '已跳过', conflict: '冲突', failed: '失败',
};
const STAGES = {
  receive_email: '接收', parse: '解析', queue_wait: '排队', check_calendar: '查日历',
  extract: '提取', create_task: '写入', draft_reply: '草稿',
};
const FLOW = ['收信', '解析', '检查日历', '提取', '更新日历', '草稿'];

function duration(ms) {
  if (!ms && ms !== 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatTokens(summary) {
  const real = summary?.qq || summary?.real;
  if (!real) return '—';
  const total = (real.tokens_in || 0) + (real.tokens_out || 0);
  return total ? total.toLocaleString('zh-CN') : '—';
}

export default function TracesPage() {
  const { emails, traceData, selectedTraceId, setSelectedTraceId, feedbackTrace, isSyncing } = useWorkspace();
  const traces = traceData.traces || [];
  const [modeFilter, setModeFilter] = useState('all');
  const filtered = useMemo(() => {
    if (modeFilter === 'real') return traces.filter((trace) => trace.mode === 'qq');
    if (modeFilter === 'demo') return traces.filter((trace) => String(trace.mode || '').startsWith('demo') || trace.mode === 'demo');
    return traces;
  }, [traces, modeFilter]);
  const selected = filtered.find((trace) => trace.trace_id === selectedTraceId)
    || traces.find((trace) => trace.trace_id === selectedTraceId)
    || filtered[0]
    || null;
  const sourceEmail = emails.find((email) => email.trace_id === selected?.trace_id);
  const summary = traceData.summary;
  const real = summary?.qq || summary?.real || {};
  const demo = summary?.demo || {};

  useEffect(() => {
    if (!selectedTraceId && filtered[0]) setSelectedTraceId(filtered[0].trace_id);
  }, [filtered, selectedTraceId, setSelectedTraceId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Mail Agent Observability
          </div>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
              <Activity className="size-4" />
            </span>
            每一步，都有迹可循。
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            从收信到回复草稿，回放实际输入、工具调用与结果。
            {isSyncing ? ' 同步进行中…' : ''}
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          本地证据链
        </Badge>
      </div>

      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">
          <Stat
            label="已记录的邮件"
            value={`${traces.length} 封`}
            hint={`真实 ${real.count || 0} 封 · 示例 ${demo.count || 0} 封`}
          />
          <Stat
            label="累计处理耗时"
            value={duration((real.latency_ms || 0) + (demo.latency_ms || 0))}
            hint="收到到草稿，含重试实际处理耗时"
          />
          <Stat
            label="真实模型累计 Token"
            value={formatTokens(summary)}
            hint="同步真实邮箱后显示实际用量"
          />
          <Stat
            label="单封真实邮件平均成本"
            value={real.avg_cost_cents == null ? '未知' : `¥${(real.avg_cost_cents / 100).toFixed(4)}`}
            hint="同步真实邮箱并配置单价后可量化"
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">邮件记录</CardTitle>
            <div className="flex flex-wrap gap-1 pt-1">
              {[
                { id: 'all', label: '全部' },
                { id: 'real', label: '真实' },
                { id: 'demo', label: '示例' },
              ].map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={modeFilter === item.id ? 'secondary' : 'ghost'}
                  className="h-7 px-2.5"
                  onClick={() => setModeFilter(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[58vh]">
              <div className="space-y-1 p-3">
                {filtered.length ? filtered.map((trace) => (
                  <button
                    key={trace.trace_id}
                    type="button"
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left hover:bg-muted/40',
                      selected?.trace_id === trace.trace_id && 'border-primary bg-accent/40',
                    )}
                    onClick={() => setSelectedTraceId(trace.trace_id)}
                  >
                    <div className="truncate text-sm font-medium">{trace.subject || '无主题'}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="secondary">{STATUS[trace.status] || trace.status}</Badge>
                      <Badge variant="outline">{trace.mode === 'qq' ? '真实' : '示例'}</Badge>
                      <span className="text-[10px] text-muted-foreground">{duration(trace.latency_ms)}</span>
                    </div>
                  </button>
                )) : (
                  <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
                    <Mail className="size-8 opacity-40" />
                    还没有邮件证据链。
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          {selected ? (
            <>
              <CardHeader>
                <CardTitle className="text-base">{selected.subject || '处理记录'}</CardTitle>
                <CardDescription>
                  {STATUS[selected.status]} · {selected.spans?.length || 0} 个阶段 · {duration(selected.latency_ms)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {FLOW.map((step, index) => (
                    <React.Fragment key={step}>
                      {index > 0 && <span>→</span>}
                      <span>{step}</span>
                    </React.Fragment>
                  ))}
                </div>
                <div className="space-y-2">
                  {(selected.spans || []).map((span, index) => (
                    <details key={span.span_id || index} className="rounded-lg border px-3 py-2" open={span.status === 'running' || span.status === 'failed'}>
                      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
                        <span className="text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                        <span className="flex-1">{span.label || STAGES[span.stage] || span.stage}</span>
                        <Badge variant="outline">{STATUS[span.status] || span.status}</Badge>
                        <ChevronDown className="size-4 text-muted-foreground" />
                      </summary>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        {span.thought && <p><span className="font-medium text-foreground">Thought · </span>{span.thought}</p>}
                        {span.action && <p><span className="font-medium text-foreground">Action · </span>{span.action}</p>}
                        {span.observation && <p><span className="font-medium text-foreground">Observation · </span>{span.observation}</p>}
                        {span.error && <p className="text-destructive">{span.error}</p>}
                        {span.tool_calls?.length > 0 && (
                          <div className="space-y-1">
                            {span.tool_calls.map((tool, i) => (
                              <div key={i} className="rounded-md bg-muted/50 px-2 py-1 font-mono text-xs">{tool.name}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
                <Separator />
                <DraftPanel trace={selected} sourceEmail={sourceEmail} onFeedback={feedbackTrace} />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Thought 显示流程的决策摘要；输入、输出与工具记录均经脱敏和截断。日志保存在本地，回放不会重新调用模型。
                </p>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-muted">
                <Activity className="size-6 text-muted-foreground" />
              </div>
              <div className="text-base font-medium">看见邮件背后的处理过程</div>
              <p className="max-w-sm text-sm text-muted-foreground">
                导入示例或同步真实邮箱后，选择一封邮件，回放它怎样变成日程与回复草稿。
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
                {FLOW.map((step, index) => (
                  <React.Fragment key={step}>
                    {index > 0 && <span>→</span>}
                    <span>{step}</span>
                  </React.Fragment>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="px-1 lg:px-4 first:lg:pl-0 last:lg:pr-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function DraftPanel({ trace, sourceEmail, onFeedback }) {
  const savedDraft = sourceEmail?.userDraft ?? trace.user_draft ?? sourceEmail?.draftReply ?? trace.draft_reply ?? '';
  const [draft, setDraft] = useState(savedDraft);
  const [editing, setEditing] = useState(false);
  const [savingAction, setSavingAction] = useState('');
  const [error, setError] = useState('');
  const realMail = trace.mode === 'qq';
  const sent = trace.reply_delivery?.status === 'sent';

  useEffect(() => { if (!editing || sent) setDraft(savedDraft); }, [savedDraft, editing, sent]);

  async function save(action) {
    if (savingAction || sent) return;
    setSavingAction(action); setError('');
    try {
      await onFeedback(trace.trace_id, action, action === 'modified' ? draft : undefined);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingAction('');
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <FileText className="size-4" />
        <h3 className="text-sm font-medium">{sent ? '已发送回复' : '回复草稿'}</h3>
        {sent && <Badge>已发送</Badge>}
      </div>
      {realMail && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Mail className="size-3.5" />
          收件人：{sourceEmail?.replyTo || sourceEmail?.sender || '来信者'}
        </p>
      )}
      {savedDraft || editing ? (
        <>
          <Textarea
            rows={trace.status === 'conflict' ? 10 : 5}
            value={draft}
            readOnly={!editing || Boolean(savingAction) || sent}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {editing && !sent ? (
              <>
                <Button size="sm" variant="outline" disabled={Boolean(savingAction)} onClick={() => { setEditing(false); setDraft(savedDraft); }}>取消</Button>
                <Button size="sm" disabled={Boolean(savingAction) || !draft.trim()} onClick={() => save('modified')}>
                  {savingAction === 'modified' ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
                  保存修改
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={Boolean(savingAction) || sent} onClick={() => save('accepted')}>
                  {savingAction === 'accepted' ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {sent ? '已发送' : realMail ? '采纳并发送' : '采纳'}
                </Button>
                <Button size="sm" variant="outline" disabled={Boolean(savingAction) || sent} onClick={() => setEditing(true)}>修改</Button>
                <Button size="sm" variant="ghost" disabled={Boolean(savingAction) || sent} onClick={() => save('rejected')}>
                  <X className="size-4" />拒绝
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {trace.status === 'running' ? '处理完成后生成草稿' : '无回复草稿'}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
