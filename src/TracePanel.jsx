import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, FileText, GitBranch, LoaderCircle, Mail, Pause, Play, RotateCcw,
  Sparkles, WandSparkles, X,
} from 'lucide-react';

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

export function EvidenceStep({ span, index, now }) {
  return <article className={`trace-evidence ${span.status === 'failed' ? 'failed' : ''}`}>
    <div className="trace-evidence-heading"><span className="trace-step-number">{String(index + 1).padStart(2, '0')}</span><div><h4>{span.label || STAGES[span.stage] || span.stage}</h4><p>{span.stage} · {duration(elapsedSpan(span, now))}</p></div><span className={`trace-status ${span.status}`}>{STATUS[span.status] || '已完成'}</span></div>
    <div className="trace-react-steps">
      <details className="trace-react-step" open><summary><span className="trace-react-letter">T</span><strong>Thought <small>决策摘要</small></strong><ChevronDown size={13} /></summary><p>{span.thought || '此阶段未记录决策摘要。'}</p></details>
      <details className="trace-react-step" open><summary><span className="trace-react-letter">A</span><strong>Action <small>实际执行</small></strong><ChevronDown size={13} /></summary><p>{span.action || span.tool_calls?.map((tool) => tool.name).join('、') || '此阶段未记录动作说明。'}</p></details>
      <details className="trace-react-step" open><summary><span className="trace-react-letter">O</span><strong>Observation <small>返回与观察</small></strong><ChevronDown size={13} /></summary><p>{span.observation || (span.status === 'running' ? '等待返回…' : '此阶段未记录观察摘要。')}</p></details>
    </div>
    {span.error && <p className="trace-error" role="alert">{span.error}</p>}
    <div className="trace-evidence-snapshots"><Snapshot label="输入快照 · 已脱敏 / 截断" value={span.input_snapshot} />
      {span.tool_calls?.map((tool, i) => <details className="trace-tool-call" key={`${tool.name}-${i}`}><summary><GitBranch size={13} /><strong>{tool.name}</strong><span>工具调用 {i + 1}</span><ChevronDown size={13} /></summary><div><h5>调用参数</h5><pre>{showSnapshot(tool.arguments)}</pre><h5>返回摘要</h5><pre>{showSnapshot(tool.result_summary)}</pre></div></details>)}
      <Snapshot label="输出快照 · 已脱敏 / 截断" value={span.output_snapshot} />
      <details className="trace-snapshot trace-span-meta"><summary>Span 标识与计量<ChevronDown size={13} /></summary><dl><div><dt>span_id</dt><dd>{span.span_id}</dd></div><div><dt>parent_span</dt><dd>{span.parent_span || '—'}</dd></div><div><dt>开始时间</dt><dd>{traceClock(span.started_at)} · 北京时间</dd></div><div><dt>Token 输入 / 输出</dt><dd>{!(span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false)) ? '无模型调用' : `${hasNumber(span.llm_tokens_in) ? formatNumber(span.llm_tokens_in) : '未知'} / ${hasNumber(span.llm_tokens_out) ? formatNumber(span.llm_tokens_out) : '未知'}`}</dd></div>{(span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false)) && <div><dt>缓存命中 Token</dt><dd>{hasNumber(span.llm_tokens_cached_in) ? formatNumber(span.llm_tokens_cached_in) : '未知'}</dd></div>}<div><dt>阶段成本</dt><dd>{amount(span.cost_cny)}{span.cost_status === 'price_missing' ? ' · 未配置所需单价' : span.cost_status === 'usage_missing' ? ' · 服务商未返回完整用量' : ''}</dd></div>{span.pricing && <div><dt>本次单价快照</dt><dd>元 / 百万 Token<br />输入 {span.pricing.input_cny_per_million ?? '未知'} · 输出 {span.pricing.output_cny_per_million ?? '未知'} · 缓存 {span.pricing.cached_input_cny_per_million ?? '未知'}</dd></div>}</dl></details>
    </div>
  </article>;
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
  const spans = trace.spans || [];
  const attempts = trace.attempts || [];
  const offsets = new Map();
  let precedingDuration = 0;
  for (const attempt of attempts) { offsets.set(attempt.attempt, precedingDuration); precedingDuration += elapsedAttempt(attempt, now); }
  const spanOffset = (span) => (offsets.get(span.attempt) || 0) + (span.offset_ms || 0);
  const [cursor, setCursor] = useState(null);
  const [playing, setPlaying] = useState(false);
  const currentIndex = cursor === null ? Math.max(0, spans.length - 1) : Math.min(cursor, spans.length - 1);
  const currentSpan = spans[currentIndex];
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (currentIndex >= spans.length - 1) setPlaying(false);
      else setCursor(currentIndex + 1);
    }, 1400);
    return () => clearTimeout(timer);
  }, [playing, currentIndex, spans.length]);
  const visibleSpans = cursor === null ? spans : spans.slice(0, currentIndex + 1);
  const totalDuration = Math.max(0, elapsedTrace(trace, now), ...spans.map((span) => spanOffset(span) + elapsedSpan(span, now)));
  const chartDuration = Math.max(1, totalDuration);
  const accumulatedDuration = cursor === null ? elapsedTrace(trace, now) : Math.max(0, ...visibleSpans.map((span) => spanOffset(span) + elapsedSpan(span, now)));
  const tokensIn = visibleSpans.reduce((sum, span) => sum + (span.llm_tokens_in || 0), 0);
  const tokensOut = visibleSpans.reduce((sum, span) => sum + (span.llm_tokens_out || 0), 0);
  const hasUnknownUsage = visibleSpans.some((span) => (span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false)) && (!hasNumber(span.llm_tokens_in) || !hasNumber(span.llm_tokens_out)));
  const hasUnknownCost = visibleSpans.some((span) => span.cost_cny === null || span.cost_cny === undefined);
  const accumulatedCost = hasUnknownCost ? null : visibleSpans.reduce((sum, span) => sum + span.cost_cny, 0);
  function chooseStep(index) { setPlaying(false); setCursor(index); }
  return <div className="trace-replay">
    <div className="trace-selected-heading"><div><div className="trace-selected-tags"><span className={`trace-mode ${trace.mode}`}>{trace.mode === 'demo' ? '示例 · 预置结果' : trace.kind === 'recruitment' ? '招聘助手' : '真实邮箱'}</span><span className={`trace-status ${trace.status}`}>{STATUS[trace.status]}</span>{attempts.length > 1 && <span className="trace-attempts">共 {attempts.length} 次尝试</span>}</div><h3>{trace.subject || '无主题邮件'}</h3><p>{decisionText(trace.decision)}</p></div><span className="trace-start-clock"><Clock3 size={13} />{traceClock(trace.started_at)}</span></div>
    {trace.status === 'failed' && trace.match_retry && <p className="trace-error" role="status">待匹配原日程：当前日历没有明确的变更对象，自动同步会暂缓重复模型请求。补充或修正原日程后会自动重试，也可点击「同步真实邮箱」手动重试。</p>}
    <details className="trace-id"><summary>Trace {trace.trace_id.slice(0, 12)}…<ChevronDown size={12} /></summary><p>trace_id: {trace.trace_id}<br />email_ref: {trace.email_ref}<br />每封邮件保留一条证据链，重试记录追加到同一封邮件。</p></details>
    {trace.mode === 'demo' && <p className="trace-demo-note"><Sparkles size={13} />示例使用预置提取结果，Token 与成本不计入真实邮件统计。</p>}
    <div className="trace-replay-controls"><button className="button primary" disabled={!spans.length || trace.status === 'running'} onClick={() => { if (playing) setPlaying(false); else { setCursor(0); setPlaying(true); } }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? '暂停回放' : '完整回放'}</button><div className="trace-step-controls"><button aria-label="上一步" disabled={currentIndex <= 0 || !spans.length} onClick={() => chooseStep(currentIndex - 1)}><ChevronLeft size={15} /></button><span>第 {spans.length ? currentIndex + 1 : 0} / {spans.length} 步</span><button aria-label="下一步" disabled={currentIndex >= spans.length - 1} onClick={() => chooseStep(currentIndex + 1)}><ChevronRight size={15} /></button></div><button className="trace-show-all" onClick={() => { setCursor(null); setPlaying(false); }}><RotateCcw size={12} />{trace.status === 'running' ? '跟随实时进度' : '查看全部'}</button></div>
    <div className="trace-cumulative" aria-live="polite"><span>累计至此</span><strong>{duration(accumulatedDuration)}<small>耗时</small></strong><strong>{hasUnknownUsage ? '未知' : formatNumber(tokensIn + tokensOut)}<small>Token{!hasUnknownUsage && ` · 输入 ${formatNumber(tokensIn)} / 输出 ${formatNumber(tokensOut)}`}</small></strong><strong>{amount(accumulatedCost)}<small>成本{hasUnknownCost ? ' · 待补齐用量或单价' : ` · ${cents(accumulatedCost)}`}</small></strong></div>
    <section className="trace-timeline" aria-label="阶段耗时时间轴"><div className="trace-timeline-title"><h4>执行时间轴</h4><span>实际耗时 · {duration(totalDuration)}</span></div><div className="trace-timeline-scale"><span>0</span><span>{duration(totalDuration / 2)}</span><span>{duration(totalDuration)}</span></div>
      {spans.map((span, index) => <React.Fragment key={span.span_id}>{attempts.length > 1 && (index === 0 || spans[index - 1].attempt !== span.attempt) && <div className="trace-attempt-heading">尝试 {span.attempt}<span>{STATUS[attempts.find((attempt) => attempt.attempt === span.attempt)?.status]} · {traceClock(span.started_at)}</span></div>}<button className={`trace-gantt-row ${index === currentIndex ? 'active' : ''} ${cursor !== null && index > currentIndex ? 'future' : ''}`} onClick={() => chooseStep(index)}><span className="trace-gantt-label">{String(index + 1).padStart(2, '0')} {span.label || STAGES[span.stage] || span.stage}</span><span className="trace-gantt-track"><span className={`trace-gantt-bar ${span.status} stage-${span.stage}`} style={{ left: `${(spanOffset(span) / chartDuration) * 100}%`, width: `${Math.max(.6, (elapsedSpan(span, now) / chartDuration) * 100)}%` }} /></span><span className="trace-gantt-duration">{duration(elapsedSpan(span, now))}</span></button></React.Fragment>)}
      {!spans.length && <p className="trace-waiting"><LoaderCircle className="spin" size={15} />等待第一步记录…</p>}
    </section>
    {currentSpan && <EvidenceStep span={currentSpan} index={currentIndex} now={now} />}
    {showDraft && trace.status !== 'failed' && (cursor === null || currentIndex === spans.length - 1) && <DraftReply trace={trace} sourceEmail={sourceEmail} onFeedback={onFeedback} />}
  </div>;
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
