import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const hasNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = (value) => hasNumber(value) ? value.toLocaleString('zh-CN') : '未知';
const isModelCall = (span) => span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false);
const hasUsage = (span) => hasNumber(span.llm_tokens_in) && hasNumber(span.llm_tokens_out);
const isPricedCall = (span) => hasUsage(span) && hasNumber(span.cost_cny)
  && !['usage_missing', 'price_missing'].includes(span.cost_status);

export function formatCostAmount(value) {
  if (!hasNumber(value)) return '未知';
  if (value > 0 && value < 0.00000001) return '< ¥0.00000001';
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 8 })}`;
}

export function realCostMetric(summary = {}) {
  const complete = hasNumber(summary.avg_cost_cents);
  const average = complete ? summary.avg_cost_cents : summary.known_avg_cost_cents;
  const count = summary.count || 0;
  const priced = summary.priced_count || 0;
  return {
    value: hasNumber(average) ? formatCostAmount(average / 100) : '未知',
    hint: count
      ? `已完整计价 ${priced} / ${count} 封${complete ? ' · 全部均价' : priced ? ' · 已计价样本均价' : ' · 用量或单价待补齐'}`
      : '暂无真实邮件记录',
  };
}

export function RealCostSummary({ summary = {} }) {
  const unknown = summary.unknown_cost_count ?? Math.max(0, (summary.count || 0) - (summary.priced_count || 0));
  const hasPricedEvidence = summary.priced_call_count > 0 || summary.no_llm_count > 0 || summary.priced_count > 0;
  const knownCost = hasNumber(summary.known_cost_cny) && (summary.known_cost_cny > 0 || hasPricedEvidence)
    ? summary.known_cost_cny : null;
  const reasons = [
    [summary.unknown_usage_count, '封缺完整用量'],
    [summary.unknown_price_count, '封缺所需单价'],
    [summary.running_cost_count, '封仍在处理'],
    [summary.unclassified_cost_count, '封缺历史计量信息'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);

  return (
    <div className="space-y-2 border-t px-4 py-3 text-xs text-muted-foreground" aria-label="真实成本核算说明">
      {summary.count > 0 && <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>真实模型已知累计成本 <strong className="ml-1 text-base font-semibold tabular-nums text-foreground">{formatCostAmount(knownCost)}</strong></span>
          {hasNumber(summary.llm_call_count) && (
            <span>已计价 {summary.priced_call_count || 0} / {summary.llm_call_count} 次调用</span>
          )}
        </div>
        <Link className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline" to="/app/settings?tab=model">
          查看模型单价 <ArrowRight className="size-3.5" />
        </Link>
      </div>}
      {unknown > 0 && (
        <p className="leading-relaxed">
          {unknown} 封尚未完整计价{reasons.length ? `：${reasons.join('、')}` : '，完整用量或所需单价待补齐'}。
          {summary.priced_count > 0 ? '上方均价仅按已完整计价邮件计算。' : '暂时无法计算完整邮件的平均成本。'}
          累计成本包含这些邮件中已计价的调用，未计价部分不按零计算。
        </p>
      )}
      <p className="text-[11px] leading-relaxed">
        按服务商返回的实际 usage × 调用时保存的配置单价核算，包含已记录的重试；仅统计模型调用，非服务商账单。
        {summary.no_llm_count > 0 ? ` ${summary.no_llm_count} 封有证据确认未调用模型，以零成本纳入邮件均价。` : ''}
        邮件均价仅统计邮件，招聘独立操作不计入。
      </p>
    </div>
  );
}

function costStatus(span) {
  if (isPricedCall(span)) return '已计价';
  if (span.status === 'running') return '等待用量与计价返回';
  if (!hasUsage(span) || span.cost_status === 'usage_missing') return '服务商未返回完整用量';
  if (span.cost_status === 'price_missing') return '调用时缺所需单价';
  return '缺历史计量信息';
}

function formula(span) {
  const input = span.llm_tokens_in;
  const output = span.llm_tokens_out;
  const cached = span.llm_tokens_cached_in;
  const pricing = span.pricing || {};
  if (![input, output, cached].every(hasNumber)) return null;
  const terms = [
    [Math.max(0, input - cached), pricing.input_cny_per_million],
    [cached, pricing.cached_input_cny_per_million],
    [output, pricing.output_cny_per_million],
  ].filter(([tokens]) => tokens > 0);
  if (terms.some(([, price]) => !hasNumber(price))) return null;
  return terms.length ? `(${terms.map(([tokens, price]) => `${number(tokens)} × ${number(price)}`).join(' + ')}) ÷ 1,000,000` : '0 Token';
}

export function TraceCostDetails({ trace }) {
  const isDemo = String(trace.mode || '').startsWith('demo');
  const isExecution = trace.source === 'recruitment';
  const title = isExecution ? '本次执行模型成本' : '本封邮件模型成本';
  const hasSpans = trace.spans?.length > 0;
  const calls = (trace.spans || []).filter(isModelCall);
  const priced = calls.filter(isPricedCall);
  const historicalPriced = !hasSpans && trace.tokens_complete === true && hasUsage(trace)
    && hasNumber(trace.cost_cny) && !['usage_missing', 'price_missing'].includes(trace.cost_status);
  const historicalKnown = !hasSpans && hasNumber(trace.known_cost_cny) && trace.known_cost_cny > 0;
  const knownCost = hasSpans ? priced.reduce((sum, span) => sum + span.cost_cny, 0)
    : historicalPriced ? trace.cost_cny : historicalKnown ? trace.known_cost_cny : 0;
  const complete = trace.status !== 'running' && (hasSpans ? priced.length === calls.length : historicalPriced);

  return (
    <section className="min-w-0 space-y-3 rounded-lg border bg-muted/15 p-3" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {!isDemo && (
            <p className="mt-1 text-xs text-muted-foreground">
              {!hasSpans && (historicalPriced || historicalKnown)
                ? '历史汇总记录 · 无逐调用明细'
                : `${calls.length} 次模型调用，已计价 ${priced.length} 次${trace.attempts?.length > 1 ? ` · 含 ${trace.attempts.length} 次处理尝试` : ''}`}
            </p>
          )}
        </div>
        {isDemo ? <Badge variant="secondary">预置示例</Badge> : (
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{formatCostAmount(complete || priced.length || historicalKnown ? knownCost : null)}</div>
            <div className="text-[11px] text-muted-foreground">{complete ? isExecution ? '本次完整成本' : '本封完整成本' : priced.length || historicalKnown ? '已知调用成本 · 完整成本待补齐' : '用量或单价待补齐'}</div>
          </div>
        )}
      </div>
      {isDemo ? (
        <p className="text-xs text-muted-foreground">使用预置提取结果，不计入真实邮件模型成本。</p>
      ) : calls.length ? (
        <>
          <div className="space-y-2">
            {calls.map((span, index) => {
              const calculation = formula(span);
              const model = span.model || span.input_snapshot?.model || span.tool_calls?.find((tool) => tool.arguments?.model)?.arguments.model;
              return (
                <details key={span.span_id || index} className="min-w-0 rounded-md border bg-background px-3 py-2" open={calls.length === 1}>
                  <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="min-w-0 flex-1 break-words font-medium">调用 {index + 1}{span.attempt ? ` · 尝试 ${span.attempt}` : ''} · {span.label || '模型调用'}</span>
                    <span className="font-medium tabular-nums">{formatCostAmount(isPricedCall(span) ? span.cost_cny : null)}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </summary>
                  <div className="mt-3 space-y-2 text-xs">
                    <p className="text-muted-foreground">{costStatus(span)}</p>
                    {model && <p className="break-all text-muted-foreground">模型：{model}</p>}
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <TokenLine label="输入 Token（含缓存）" tokens={span.llm_tokens_in} price={span.pricing?.input_cny_per_million} />
                      <TokenLine label="其中缓存命中 Token" tokens={span.llm_tokens_cached_in} price={span.pricing?.cached_input_cny_per_million} />
                      <TokenLine label="输出 Token" tokens={span.llm_tokens_out} price={span.pricing?.output_cny_per_million} />
                    </dl>
                    {span.pricing && <p className="text-[11px] text-muted-foreground">价格来源：调用时保存的配置单价；单位为元 / 百万 Token。输入单价仅应用于非缓存部分。</p>}
                    {calculation && <p className="break-words rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">{calculation}{isPricedCall(span) ? ` = ${formatCostAmount(span.cost_cny)}` : ''}</p>}
                  </div>
                </details>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">真实调用 usage 与历史价格快照用于核算；缺用量或单价的调用保留未知，修改当前单价不会改写这些记录。</p>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {historicalPriced
            ? `已保存的历史汇总用量：输入 ${number(trace.llm_tokens_in)} / 输出 ${number(trace.llm_tokens_out)} Token。逐调用日志和价格明细未记录，保留原有成本。`
            : historicalKnown
              ? '仅保存了历史已知成本，缺少逐调用用量和价格明细，完整成本仍待补齐。'
              : trace.status === 'running'
                ? '尚未记录模型调用，用量返回后更新。'
                : complete ? '此记录未发起模型调用，模型成本为零。' : '此记录没有可核算的模型调用记录，无法补全历史用量或成本。'}
        </p>
      )}
    </section>
  );
}

function TokenLine({ label, tokens, price }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{number(tokens)}</dd>
      <dd className="mt-0.5 text-[11px] text-muted-foreground">{tokens === 0 && !hasNumber(price) ? '本项无用量，无需单价' : `单价 ${number(price)} 元 / 百万 Token`}</dd>
    </div>
  );
}
