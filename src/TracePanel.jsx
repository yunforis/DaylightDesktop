import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowRight, Check, ChevronDown,
  Clock3, FileText, GitBranch, LoaderCircle, Mail,
  Sparkles, WandSparkles, X,
} from 'lucide-react';
import { TraceReplayView } from '@/components/trace-replay-view';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const STATUS = { running: '处理中', completed: '已完成', imported: '已完成', success: '已完成', skipped: '已跳过', conflict: '日程冲突', failed: '失败，可重试' };
const STAGES = { receive_email: '接收邮件', parse: '解析邮件', queue_wait: '等待前序邮件', check_calendar: '检查日历与待办', extract: '模型提取', create_task: '更新日历与待办', draft_reply: '整理回复草稿' };
const ACTIONS = { accepted: '已采纳', modified: '已修改', rejected: '已拒绝' };
const formatNumber = (value) => Number(value).toLocaleString('zh-CN');
const duration = (value) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
const amount = (value) => value === null || value === undefined ? '未知' : `¥${Number(value).toFixed(5)}`;
const cents = (value) => `${Number((Number(value) * 100).toFixed(3))} 分钱`;
const showSnapshot = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const traceClock = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const deliveryTime = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const hasNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const elapsedSpan = (span, now) => span.status === 'running' ? Math.max(0, now - Date.parse(span.started_at)) : span.latency_ms || 0;
const elapsedAttempt = (attempt, now) => attempt.status === 'running' ? Math.max(0, now - Date.parse(attempt.started_at)) : attempt.latency_ms || 0;
const elapsedTrace = (trace, now) => trace.attempts?.length ? trace.attempts.reduce((sum, attempt) => sum + elapsedAttempt(attempt, now), 0) : trace.latency_ms || 0;
const decisionText = (decision) => typeof decision === 'string' ? decision : decision?.summary || '等待处理结果';

function Metric({ label, value, note, className = '' }) {
  return <div className={`trace-metric ${className}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Snapshot({ label, value }) {
  if (value === undefined || value === null || value === '') return null;
  return <details className="trace-snapshot"><summary>{label}<ChevronDown size={13} /></summary><pre>{showSnapshot(value)}</pre></details>;
}

function EvidenceBlock({ letter, title, hint, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40">
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground">{letter}</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium">{title}</span>
          {hint ? <span className="ml-2 text-[11px] text-muted-foreground">{hint}</span> : null}
        </span>
        <ChevronDown className={cn('size-3.5 text-muted-foreground transition', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function EvidenceStep({ span, index, now }) {
  return (
    <article className="bg-card">
      <div className="flex items-start gap-3 border-b px-3 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium leading-snug">{span.label || STAGES[span.stage] || span.stage}</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{span.stage} · {duration(elapsedSpan(span, now))}</p>
        </div>
        <Badge variant={span.status === 'failed' ? 'destructive' : 'outline'} className="font-normal">
          {STATUS[span.status] || '已完成'}
        </Badge>
      </div>
      <EvidenceBlock letter="T" title="Thought" hint="决策摘要">
        <p>{span.thought || '此阶段未记录决策摘要。'}</p>
      </EvidenceBlock>
      <EvidenceBlock letter="A" title="Action" hint="实际执行">
        <p className="font-mono text-xs text-foreground">
          {span.action || span.tool_calls?.map((tool) => tool.name).join('、') || '此阶段未记录动作说明。'}
        </p>
      </EvidenceBlock>
      <EvidenceBlock letter="O" title="Observation" hint="返回与观察">
        <p>{span.observation || (span.status === 'running' ? '等待返回…' : '此阶段未记录观察摘要。')}</p>
      </EvidenceBlock>
      {span.error && <p className="px-3 py-2 text-sm text-destructive" role="alert">{span.error}</p>}
      <div className="space-y-1 border-t bg-muted/20 p-2">
        <Snapshot label="输入快照 · 已脱敏 / 截断" value={span.input_snapshot} />
        {span.tool_calls?.map((tool, i) => (
          <details className="rounded-md border bg-background px-2 py-1.5 text-xs" key={`${tool.name}-${i}`}>
            <summary className="flex cursor-pointer list-none items-center gap-2">
              <GitBranch size={13} />
              <strong>{tool.name}</strong>
              <span className="text-muted-foreground">工具调用 {i + 1}</span>
            </summary>
            <div className="mt-2 space-y-2">
              <div>
                <h5 className="mb-1 text-muted-foreground">调用参数</h5>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">{showSnapshot(tool.arguments)}</pre>
              </div>
              <div>
                <h5 className="mb-1 text-muted-foreground">返回摘要</h5>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">{showSnapshot(tool.result_summary)}</pre>
              </div>
            </div>
          </details>
        ))}
        <Snapshot label="输出快照 · 已脱敏 / 截断" value={span.output_snapshot} />
        <details className="rounded-md border bg-background px-2 py-1.5 text-xs">
          <summary className="cursor-pointer list-none text-muted-foreground">Span 标识与计量</summary>
          <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <div><dt className="text-muted-foreground">span_id</dt><dd className="break-all font-mono">{span.span_id}</dd></div>
            <div><dt className="text-muted-foreground">parent_span</dt><dd>{span.parent_span || '—'}</dd></div>
            <div><dt className="text-muted-foreground">开始时间</dt><dd>{traceClock(span.started_at)} · 北京时间</dd></div>
            <div>
              <dt className="text-muted-foreground">Token 输入 / 输出</dt>
              <dd>
                {!(span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false))
                  ? '无模型调用'
                  : `${hasNumber(span.llm_tokens_in) ? formatNumber(span.llm_tokens_in) : '未知'} / ${hasNumber(span.llm_tokens_out) ? formatNumber(span.llm_tokens_out) : '未知'}`}
              </dd>
            </div>
            {(span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false)) && (
              <div>
                <dt className="text-muted-foreground">缓存命中 Token</dt>
                <dd>{hasNumber(span.llm_tokens_cached_in) ? formatNumber(span.llm_tokens_cached_in) : '未知'}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">阶段成本</dt>
              <dd>
                {amount(span.cost_cny)}
                {span.cost_status === 'price_missing' ? ' · 未配置所需单价' : ''}
                {span.cost_status === 'usage_missing' ? ' · 服务商未返回完整用量' : ''}
              </dd>
            </div>
            {span.pricing && (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">本次单价快照（元 / 百万 Token）</dt>
                <dd>
                  输入 {span.pricing.input_cny_per_million ?? '未知'} · 输出 {span.pricing.output_cny_per_million ?? '未知'} · 缓存 {span.pricing.cached_input_cny_per_million ?? '未知'}
                </dd>
              </div>
            )}
          </dl>
        </details>
      </div>
    </article>
  );
}

function DraftReply({ trace, sourceEmail, onFeedback }) {
  const savedDraft = sourceEmail?.userDraft ?? trace.user_draft ?? sourceEmail?.draftReply ?? trace.draft_reply ?? '';
  const originalDraft = sourceEmail?.draftReply ?? trace.draft_reply ?? '';
  const modifiedDraft = sourceEmail?.userDraft ?? trace.user_draft;
  const [draft, setDraft] = useState(savedDraft);
  const [editing, setEditing] = useState(false);
  const [savingAction, setSavingAction] = useState('');
  const [error, setError] = useState('');
  const realMail = trace.mode === 'qq';
  const delivery = trace.reply_delivery;
  const sent = delivery?.status === 'sent';
  const saving = Boolean(savingAction);
  const recipient = sourceEmail?.replyTo || sourceEmail?.sender;
  const failure = sent ? '' : error || (delivery?.status === 'failed' ? `发送失败：${delivery.error}。可再次点击「采纳并发送」重试。` : '');
  useEffect(() => { if (!editing || sent) setDraft(savedDraft); }, [savedDraft, editing, sent]);
  async function save(action) {
    if (saving || sent) return;
    setSavingAction(action); setError('');
    try { await onFeedback(trace.trace_id, action, action === 'modified' ? draft : undefined); setEditing(false); }
    catch (err) { setError(err.message); } finally { setSavingAction(''); }
  }
  return <section className="trace-draft"><header><div><FileText size={16} /><h4>{sent ? '已发送的回复' : '回复草稿'}</h4><span>{realMail ? sent ? '通过当前绑定邮箱发送' : '未发送 · 采纳后通过当前绑定邮箱发送' : '示例 · 预置结果，不发送邮件'}</span></div>{(sent || trace.user_action) && <span className={`trace-feedback-label ${sent ? 'accepted' : trace.user_action}`}>{sent ? '已发送' : ACTIONS[trace.user_action]}</span>}</header>
    {realMail && <p className="trace-draft-recipient"><Mail size={13} /><span>收件人：{recipient || '原邮件的来信者'}<small>（{sourceEmail?.replyTo ? '仅回复第一个邮箱地址' : '默认回复来信者'}）</small></span></p>}
    {sent && <p className="trace-draft-delivery" role="status"><Check size={14} /><span>回复已发送 · {deliveryTime(delivery.sent_at)} · 北京时间</span></p>}
    {trace.status === 'conflict' && <p className="trace-draft-conflict-note">{realMail ? sent ? '回复已发送；建议时段不会自动加入日历。' : '请确认冲突说明和 3 个建议时段。「采纳并发送」会回复来信者；保存修改只保存草稿。建议时段不会自动加入日历。' : '请确认冲突说明和 3 个建议时段。示例采纳或修改只保存草稿反馈，不发送邮件；建议时段不会自动加入日历。'}</p>}
    {originalDraft ? <><textarea aria-label="回复草稿" rows={trace.status === 'conflict' ? 10 : 4} value={draft} readOnly={!editing || saving || sent} onChange={(event) => setDraft(event.target.value)} />{modifiedDraft && <details className="trace-snapshot trace-original-draft"><summary>查看原始草稿<ChevronDown size={13} /></summary><pre>{originalDraft}</pre></details>}<div className="trace-draft-actions">{editing && !sent ? <><button className="button secondary" disabled={saving} onClick={() => { setEditing(false); setDraft(savedDraft); }}>取消编辑</button><button className="button primary" disabled={saving || !draft.trim()} onClick={() => save('modified')}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存修改</button></> : <><button className={`button ${realMail && !sent ? 'primary' : 'secondary'} ${trace.user_action === 'accepted' ? 'selected' : ''}`} disabled={saving || sent} onClick={() => save('accepted')}>{savingAction === 'accepted' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{sent ? '已发送' : savingAction === 'accepted' ? realMail ? '发送中…' : '保存中…' : realMail ? '采纳并发送' : '采纳草稿'}</button><button className="button secondary" disabled={saving || sent} onClick={() => setEditing(true)}><WandSparkles size={14} />修改草稿</button><button className={`button secondary ${trace.user_action === 'rejected' ? 'selected' : ''}`} disabled={saving || sent} onClick={() => save('rejected')}><X size={14} />拒绝草稿</button></>}</div>{editing && !sent && <p className="trace-draft-save-note">保存修改不会发送邮件。{realMail && '保存后点击「采纳并发送」，发送修改后的回复。'}</p>}</> : <p className="trace-draft-empty">{trace.status === 'running' ? '处理完成后，草稿会出现在这里。' : trace.status === 'failed' ? '本次处理失败，未生成回复草稿。再次同步可重试。' : '这条历史或跳过记录没有回复草稿。'}</p>}
    {failure && <p className="trace-error" role="alert">{failure}</p>}
  </section>;
}

export function TraceReplay({ trace, sourceEmail, now = Date.now(), onFeedback, showDraft = true }) {
  return (
    <TraceReplayView
      trace={trace}
      now={now}
      showDraft={showDraft && trace.status !== 'failed'}
      renderEvidence={(span, index) => <EvidenceStep span={span} index={index} now={now} />}
      draftSlot={<DraftReply trace={trace} sourceEmail={sourceEmail} onFeedback={onFeedback} />}
    />
  );
}

export default function TracePanel({ data, emails = [], selectedTraceId, onSelectTrace, onFeedback, onSettings, error, syncing }) {
  const [filter, setFilter] = useState('all');
  const [now, setNow] = useState(Date.now());
  const traces = useMemo(() => [...(data?.traces || [])].sort((a, b) => b.started_at.localeCompare(a.started_at)), [data?.traces]);
  const running = syncing || data?.sync?.running;
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, [running]);
  const filtered = traces.filter((trace) => filter === 'all' || trace.mode === filter);
  const processingTrace = (rows) => rows.find((trace) => trace.status === 'running' && trace.spans?.some((span) => span.status === 'running' && span.stage !== 'queue_wait')) || rows.find((trace) => trace.status === 'running');
  const selected = filtered.find((trace) => trace.trace_id === selectedTraceId) || (running && processingTrace(filtered)) || filtered[0];
  useEffect(() => { const external = traces.find((trace) => trace.trace_id === selectedTraceId); if (external && filter !== 'all' && filter !== external.mode) setFilter(external.mode); }, [selectedTraceId]);
  const qq = traces.filter((trace) => trace.mode === 'qq');
  const finalQQ = qq.filter((trace) => trace.status !== 'running');
  const priced = finalQQ.filter((trace) => hasNumber(trace.cost_cny));
  const cost = priced.reduce((sum, trace) => sum + trace.cost_cny, 0);
  const tokensKnown = qq.filter((trace) => trace.tokens_complete);
  const tokensTotal = qq.reduce((sum, trace) => sum + (trace.llm_tokens_in || 0) + (trace.llm_tokens_out || 0), 0);
  const knownCost = qq.reduce((sum, trace) => sum + (trace.known_cost_cny || 0), 0);
  const completeCost = finalQQ.length > 0 && priced.length === finalQQ.length;
  const liveTrace = processingTrace(traces);
  const liveStage = liveTrace?.spans?.findLast((span) => span.status === 'running');
  return <section className="trace-panel" id="trace-panel" aria-label="邮件处理证据链">
    <header className="trace-panel-heading"><div className="trace-heading-icon"><Activity size={20} /></div><div><span className="eyebrow">MAIL AGENT OBSERVABILITY</span><h2>每一步，都有迹可循。</h2><p>从收信到回复草稿，回放实际输入、工具调用与结果。</p></div><span className={`trace-live-indicator ${running ? 'running' : ''}`}><span />{running ? '实时记录中' : '本地证据链'}</span></header>
    {running && <div className="trace-sync-progress" role="status"><LoaderCircle size={15} className="spin" /><strong>{liveStage?.label || data?.sync?.stage || (liveTrace ? '正在整理邮件…' : '连接邮箱，读取最近的邮件…')}</strong><span>{liveTrace?.subject || '日历与日志会随每封邮件的处理实时更新。'}</span>{hasNumber(data?.sync?.total) && data.sync.total > 0 && <small>{data.sync.processed || 0} / {data.sync.total} 封</small>}</div>}
    {error && <p className="trace-panel-error" role="alert">日志读取失败：{error}</p>}
    {data?.sync?.error && !running && <p className="trace-panel-error" role="alert">上次同步未完成：{data.sync.error}</p>}
    <div className="trace-summary-grid"><Metric label="已记录的邮件" value={`${traces.length} 封`} note={`真实 ${qq.length} 封 · 示例 ${traces.length - qq.length} 封`} /><Metric label="累计处理耗时" value={duration(traces.reduce((sum, trace) => sum + elapsedTrace(trace, now), 0))} note="收信到草稿 · 含重试实际处理耗时" /><Metric label={tokensKnown.length === qq.length ? '真实模型累计 Token' : '真实模型已知 Token'} value={qq.length ? qq.some((trace) => hasNumber(trace.llm_tokens_in)) ? formatNumber(tokensTotal) : '未知' : '—'} note={qq.length ? `完整用量 ${tokensKnown.length} / ${qq.length} 封` : '同步真实邮箱后显示实际用量'} /><Metric className="trace-cost-metric" label="单封真实邮件平均成本" value={completeCost ? cents(cost / finalQQ.length) : '未知'} note={completeCost ? `已计价 ${priced.length} 封 · 合计 ${amount(cost)}` : priced.length ? `已计价样本平均 ${cents(cost / priced.length)} · ${priced.length} / ${finalQQ.length} 封` : qq.length ? '需模型返回用量，并填写 Token 单价' : '同步真实邮箱并配置单价后可量化'} /></div>
    {finalQQ.length > priced.length && <div className="trace-pricing-note"><span>有 {finalQQ.length - priced.length} 封真实邮件的成本未知，完整平均成本待补齐；已知累计 {amount(knownCost)}。</span><button onClick={onSettings}>设置模型单价<ArrowRight size={12} /></button></div>}
    <div className="trace-body"><aside className="trace-mail-list"><div className="trace-list-toolbar"><h3>邮件记录</h3><div className="trace-filters" role="group" aria-label="日志来源筛选">{[['all', '全部'], ['qq', '真实'], ['demo', '示例']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); onSelectTrace(null); }}>{label}</button>)}</div></div><div className="trace-mail-scroll">{filtered.map((trace) => <button className={`trace-mail-item ${selected?.trace_id === trace.trace_id ? 'selected' : ''}`} key={trace.trace_id} onClick={() => onSelectTrace(trace.trace_id)}><div><span className={`trace-mode ${trace.mode}`}>{trace.mode === 'qq' ? '真实邮箱' : '预置示例'}</span><span className={`trace-status ${trace.status}`}>{STATUS[trace.status]}</span></div><strong>{trace.subject || '无主题邮件'}</strong><p>{decisionText(trace.decision)}</p><small><Clock3 size={11} />{duration(elapsedTrace(trace, now))}<span>{traceClock(trace.started_at)}</span></small></button>)}{!filtered.length && <div className="trace-list-empty"><Mail size={23} /><p>还没有{filter === 'qq' ? '真实' : filter === 'demo' ? '示例' : ''}邮件证据链。</p></div>}</div></aside>
      <div className="trace-detail">{selected ? <TraceReplay key={selected.trace_id} trace={selected} sourceEmail={emails.find((email) => email.trace_id === selected.trace_id)} now={now} onFeedback={onFeedback} /> : <div className="trace-empty"><div><GitBranch size={30} /></div><h3>看见邮件背后的处理过程</h3><p>导入示例或同步真实邮箱后，选择一封邮件，<br />回放它怎样变成日程与回复草稿。</p><span>收信 → 解析 → 检查日历 → 提取 → 更新日历 → 草稿</span></div>}</div>
    </div><footer className="trace-panel-footnote"><GitBranch size={13} /><span>Thought 显示流程的决策摘要；输入、输出与工具记录均经脱敏和截断。日志保存在本地，回放不会重新调用模型。</span></footer>
  </section>;
}
