import React, { useMemo, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, LoaderCircle, Wrench, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const STAGE_LABELS = {
  receive_email: '接收邮件',
  parse: '解析邮件',
  queue_wait: '等待前序邮件',
  check_calendar: '检查日历与待办',
  extract: '模型提取',
  create_task: '更新日历与待办',
  draft_reply: '整理回复草稿',
};

const TOOL_LABELS = {
  get_current_time: '查看北京时间',
  search_events: '查询日程',
  create_event: '创建日程',
  update_event: '修改日程',
  delete_event: '删除日程',
  list_tasks: '查询待办',
  create_task: '创建待办',
  update_task: '更新待办',
  delete_task: '删除待办',
  search_emails: '搜索邮件',
  get_email: '查看邮件',
  get_event_related_emails: '查看关联邮件',
  draft_email: '起草待审核邮件',
  create_feishu_meeting: '创建飞书会议与邀约草稿',
  get_email_briefing: '整理邮件简报',
  list_email_drafts: '查询邮件草稿与发送记录',
  get_email_draft: '查看邮件草稿',
  search_candidates: '检索人才库',
  get_candidate: '查看候选人',
  draft_interview: '起草面试邮件',
  search_knowledge: '知识检索',
  rag_search: '简历原文检索',
  declare_intent: '意图识别',
  list_capabilities: '列出管理能力',
  get_overview: '系统总览',
  get_monitor: '运维监控',
  search_system: '跨库检索',
  list_users: '列出用户',
  get_user: '用户详情',
  create_user: '创建用户',
  update_user: '更新用户',
  force_logout_user: '强制下线',
  delete_user: '删除用户',
  list_mailboxes: '列出邮箱',
  get_infra: '基础设施',
  test_oss: '测试对象存储',
  test_mq: '测试消息队列',
  reload_infra: '重载 infra',
  update_auth_gate: '更新认证门禁',
  get_mail_templates: '邮件模板',
  preview_mail_template: '预览模板',
  send_test_mail: '发送测试邮件',
  reset_mail_templates: '重置邮件模板',
  get_onboarding_guide: '新手引导',
  reset_onboarding_guide: '重置引导',
  get_workspace_settings: '工作区设置',
  list_jobs: '队列任务',
};

function formatMs(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function previewJson(value, max = 160) {
  if (value == null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function statusOf(step) {
  if (step.status === 'running' || step.running) return 'running';
  if (step.status === 'failed' || step.ok === false || step.error) return 'failed';
  return 'success';
}

function StatusBadge({ status }) {
  if (status === 'running') {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <LoaderCircle className="size-3 animate-spin" />处理中
      </Badge>
    );
  }
  if (status === 'failed') {
    return <Badge variant="destructive" className="font-normal">失败</Badge>;
  }
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <Check className="size-3" />成功
    </Badge>
  );
}

/** 将招聘 trace.spans 或小 D toolTrace 归一为步骤列表。 */
export function normalizeThinkingSteps({ spans, toolTrace, now = Date.now() } = {}) {
  if (Array.isArray(spans) && spans.length) {
    return spans.map((span, index) => {
      const running = span.status === 'running';
      const latency = running
        ? Math.max(0, now - Date.parse(span.started_at || 0))
        : (span.latency_ms ?? null);
      const tools = span.tool_calls || [];
      const detail = span.action
        || span.thought
        || span.observation
        || tools.map((tool) => tool.name).filter(Boolean).join(' · ')
        || span.stage
        || '';
      return {
        id: span.span_id || `span-${index}`,
        title: span.label || STAGE_LABELS[span.stage] || span.stage || `步骤 ${index + 1}`,
        detail: previewJson(detail, 220),
        status: span.status || 'success',
        latencyMs: latency,
        args: span.input_snapshot ?? tools[0]?.arguments,
        result: span.output_snapshot ?? tools[0]?.result_summary ?? span.observation,
        error: span.error,
        tools,
      };
    });
  }
  if (Array.isArray(toolTrace) && toolTrace.length) {
    return toolTrace.map((item, index) => {
      const running = Boolean(item.running);
      const ok = !running && item.result?.ok !== false && !item.error && item.ok !== false;
      return {
        id: `tool-${index}-${item.name}`,
        title: TOOL_LABELS[item.name] || item.name || `工具 ${index + 1}`,
        detail: previewJson(item.args || item.arguments, 180),
        status: running ? 'running' : (ok ? 'success' : 'failed'),
        ok,
        latencyMs: item.latency_ms ?? item.latencyMs ?? null,
        args: item.args ?? item.arguments,
        result: item.result,
        error: item.error || (item.result?.ok === false ? item.result?.error : ''),
        tools: [{ name: item.name, arguments: item.args, result_summary: item.result }],
      };
    });
  }
  return [];
}

function StepRow({ step }) {
  const [showParams, setShowParams] = useState(false);
  const status = statusOf(step);
  const hasParams = step.args != null || step.result != null || step.error || step.tools?.length;

  return (
    <li className="border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {status === 'running'
            ? <LoaderCircle className="size-3.5 animate-spin" />
            : status === 'failed'
              ? <X className="size-3.5 text-destructive" />
              : <Wrench className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-snug">{step.title}</p>
              {step.detail ? (
                <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground break-all">
                  {step.detail}
                </p>
              ) : null}
              {hasParams && (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-0.5 h-auto px-0 text-[11px]"
                  onClick={() => setShowParams((value) => !value)}
                >
                  {showParams ? '收起参数' : '查看参数'}
                </Button>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={status} />
              {formatMs(step.latencyMs) ? (
                <span className="tabular-nums text-[11px] text-muted-foreground">{formatMs(step.latencyMs)}</span>
              ) : null}
            </div>
          </div>
          {showParams && (
            <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2.5 text-[11px]">
              {step.args != null && (
                <div>
                  <div className="mb-1 font-medium text-muted-foreground">参数</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                    {typeof step.args === 'string' ? step.args : JSON.stringify(step.args, null, 2)}
                  </pre>
                </div>
              )}
              {step.result != null && (
                <div>
                  <div className="mb-1 font-medium text-muted-foreground">返回</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                    {typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2)}
                  </pre>
                </div>
              )}
              {step.error ? <p className="text-destructive">{String(step.error)}</p> : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * ChatGPT 风格「思考过程 / 执行链」：可折叠步骤列表。
 * 用于小 D toolTrace 与招聘助手 trace.spans。
 */
function CostFooter({ cost }) {
  if (!cost) return null;
  const tokensIn = cost.usage?.prompt_tokens;
  const tokensOut = cost.usage?.completion_tokens;
  const tokenText = tokensIn != null || tokensOut != null
    ? `${((tokensIn || 0) + (tokensOut || 0)).toLocaleString('zh-CN')} Token`
    : 'Token 未知';
  const costText = cost.cost_cny != null
    ? `≈ ¥${Number(cost.cost_cny).toFixed(5)}`
    : (cost.cost_status === 'price_missing' ? '未配置单价' : '费用未知');
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
      <Badge variant="outline" className="font-normal tabular-nums">{tokenText}</Badge>
      <Badge variant="outline" className="font-normal tabular-nums">{costText}</Badge>
      {cost.cost_status === 'price_missing' && (
        <span>可在设置中填写模型费用单价（元/百万 Token）</span>
      )}
    </div>
  );
}

export function AgentThinkingChain({
  spans,
  toolTrace,
  now,
  running = false,
  title,
  defaultOpen,
  className,
  footer = null,
  cost = null,
}) {
  const steps = useMemo(
    () => normalizeThinkingSteps({ spans, toolTrace, now }),
    [spans, toolTrace, now],
  );
  const openByDefault = defaultOpen ?? (running || steps.some((step) => statusOf(step) === 'running'));
  const [open, setOpen] = useState(openByDefault);

  if (!steps.length && !running && !cost) return null;

  const heading = title
    || (running
      ? `正在执行 · ${steps.length || '…'} 步`
      : `思考过程 · ${steps.length} 步`);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-lg border bg-muted/15', className)}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/30"
        >
          <span className="inline-flex items-center gap-2 font-medium">
            {running
              ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
              : open
                ? <ChevronDown className="size-3.5 text-muted-foreground" />
                : <ChevronRight className="size-3.5 text-muted-foreground" />}
            {open && !running ? `收起${heading}` : heading}
          </span>
          <Badge variant="secondary" className="tabular-nums font-normal">{steps.length}</Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="border-t px-3">
          {steps.map((step) => <StepRow key={step.id} step={step} />)}
          {!steps.length && running && (
            <li className="py-3 text-xs text-muted-foreground">等待第一步工具调用…</li>
          )}
        </ul>
        <CostFooter cost={cost} />
        {footer}
      </CollapsibleContent>
    </Collapsible>
  );
}
