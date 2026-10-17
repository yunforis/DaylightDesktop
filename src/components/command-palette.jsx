import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, FileText, GitBranch, Inbox, LayoutDashboard, ListTodo, Mail,
  PanelsTopLeft, Paperclip, Plus, ReceiptText, RefreshCw, Search, Settings2, SlidersHorizontal, Sparkles, Users, Video,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/context/workspace';
import { useWorkbenches } from '@/context/workbenches';
import { request } from '@/lib/api';
import { useAuthUser } from '@/lib/auth-session';
import { nameOf } from '@/lib/recruitment';
import { fullDateTime } from '@/lib/time';
import { invoiceHref, invoiceRows } from '@/lib/invoices';
import { hasRecruitmentAccess } from '@/lib/workspace-mode';
import { cn } from '@/lib/utils';

/** 在文本中高亮所有 query 出现位置（大小写不敏感）。 */
export function HighlightText({ text, query, className }) {
  const raw = String(text ?? '');
  const q = String(query || '').trim();
  if (!q || !raw) return <span className={className}>{raw}</span>;
  const lower = raw.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let start = 0;
  let idx = lower.indexOf(needle);
  let key = 0;
  while (idx !== -1) {
    if (idx > start) parts.push(<span key={`t${key++}`}>{raw.slice(start, idx)}</span>);
    parts.push(
      <mark
        key={`m${key++}`}
        className="rounded-sm bg-amber-200/90 px-0.5 font-medium text-foreground dark:bg-amber-500/35"
      >
        {raw.slice(idx, idx + needle.length)}
      </mark>,
    );
    start = idx + needle.length;
    idx = lower.indexOf(needle, start);
  }
  if (start < raw.length) parts.push(<span key={`t${key++}`}>{raw.slice(start)}</span>);
  return <span className={className}>{parts}</span>;
}

function haystackOf(item) {
  return [item.label, item.hint, item.group, item.keywords, item.searchText]
    .filter(Boolean)
    .join('\u0001')
    .toLowerCase();
}

function matchQuery(query, item) {
  if (!query) return true;
  const hay = haystackOf(item);
  // 支持空格分词：全部 token 都命中才算匹配
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((token) => hay.includes(token));
}

function groupLabel(group) {
  return group;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { user, isAdmin } = useAuthUser();
  const {
    commandOpen, setCommandOpen, events, tasks, emails, openEmail, closeEmail, setEventModal, sync, isSyncing,
    traceData, state,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recruitment, setRecruitment] = useState({ candidates: [], attachments: [], interviews: [], messages: [] });
  const { visibleFeatures, visibleWorkbenches } = useWorkbenches();
  const showRecruitment = hasRecruitmentAccess(user);
  const mailboxId = state?.settings?.activeMailboxId || '';
  const settings = state?.settings || {};

  useEffect(() => {
    if (!commandOpen) {
      setQuery('');
      setActive(0);
      return;
    }
    let cancelled = false;
    if (!showRecruitment || !mailboxId) return () => { cancelled = true; };
    request('/recruitment')
      .then((data) => {
        if (cancelled || !data) return;
        setRecruitment({
          candidates: data.candidates || [],
          attachments: data.attachments || [],
          interviews: data.interviews || [],
          messages: data.messages || [],
        });
      })
      .catch(() => {
        if (!cancelled) setRecruitment({ candidates: [], attachments: [], interviews: [], messages: [] });
      });
    return () => { cancelled = true; };
  }, [commandOpen, showRecruitment, mailboxId]);

  const actions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = [];

    const push = (item) => {
      if (!matchQuery(q, item)) return;
      items.push(item);
    };

    // 操作
    push({
      id: 'new-event',
      label: '新建日程',
      group: '操作',
      icon: Plus,
      keywords: '新增 创建 添加日程',
      run: () => setEventModal({ event: null, date: null }),
    });
    push({
      id: 'sync',
      label: isSyncing ? '同步进行中…' : '同步当前邮箱',
      group: '操作',
      icon: RefreshCw,
      keywords: 'imap 拉取 收信',
      run: () => sync('qq'),
    });
    push({
      id: 'open-little-d',
      label: '打开小 D 助手',
      hint: '写邮件 · 飞书会议 · 邮件简报 · 日程待办',
      group: '操作',
      icon: Sparkles,
      keywords: '助手 小d assistant chatbot 写邮件 发邮件 发送 草稿 审核 飞书会议 邀约 邮件简报 整理邮件',
      run: () => window.dispatchEvent(new CustomEvent('daylight:open-little-d')),
    });

    // 导航
    const nav = [
      { id: 'go-overview', label: '前往总览', path: '/app', icon: LayoutDashboard, keywords: '首页 overview' },
      { id: 'go-calendar', label: '前往日历', path: '/app/calendar', icon: CalendarDays, keywords: '日程 calendar' },
      { id: 'go-todos', label: '前往待办', path: '/app/todos', icon: ListTodo, keywords: '任务 todo' },
      { id: 'go-mail', label: '前往邮件', path: '/app/mail', icon: Inbox, keywords: '邮箱 inbox mail' },
      { id: 'go-workbenches', label: '前往我的工作台', path: '/app/workbenches', icon: PanelsTopLeft, keywords: '功能 场景 人才 简历 面试 HR' },
      { id: 'adjust-workbenches', label: '管理工作台', path: '/app/workbenches?adjust=1', icon: SlidersHorizontal, keywords: '添加 隐藏 显示 功能 模板 移除' },
      { id: 'go-traces', label: '前往证据链', path: '/app/traces', icon: GitBranch, keywords: 'trace 日志 回放' },
      { id: 'go-jobs', label: '前往后台任务', path: '/app/jobs', icon: GitBranch, keywords: 'job 队列 同步 进度 重试 取消' },
      { id: 'go-settings', label: '前往设置', path: '/app/settings', icon: Settings2, keywords: '配置 settings' },
      { id: 'go-account', label: '前往账号', path: '/app/account', icon: Users, keywords: '个人 场景 HR' },
    ];
    const recruitmentPath = '/app/recruitment';
    for (const feature of visibleFeatures) {
      push({
        id: `feature-${feature.id}`,
        label: `前往${feature.name}`,
        hint: feature.description,
        group: '我的工作台',
        icon: feature.icon,
        keywords: feature.keywords,
        run: () => navigate(feature.path),
      });
    }
    for (const workbench of visibleWorkbenches) {
      push({
        id: `workbench-${workbench.id}`,
        label: workbench.name,
        hint: workbench.template?.name || '工作台',
        group: '我的工作台',
        icon: PanelsTopLeft,
        keywords: `${workbench.template?.name || ''} ${workbench.template?.subtitle || ''} 工作台`,
        run: () => navigate(`/app/workbenches/${workbench.id}`),
      });
    }
    for (const item of nav) {
      push({
        id: item.id,
        label: item.label,
        group: '导航',
        icon: item.icon,
        keywords: item.keywords,
        run: () => navigate(item.path),
      });
    }

    // 设置：完整入口 + 可检索关键词（含飞书、RAG 等嵌在「模型」页的配置）
    const settingsEntries = [
      {
        id: 'settings-mailbox',
        tab: 'mailbox',
        label: '设置 · 邮箱与同步',
        keywords: 'imap smtp 授权码 收信 轮询 IDLE QQ 163',
        hint: settings.email || '配置收信邮箱',
      },
      {
        id: 'settings-model',
        tab: 'model',
        label: '设置 · 模型与 API Key',
        keywords: 'openai deepseek base url 模型 key 单价 token',
        hint: settings.model || '配置聊天模型',
      },
      {
        id: 'settings-feishu',
        tab: 'model',
        label: '设置 · 飞书会议',
        keywords: '飞书 会议 feishu lark 面试 招聘 App ID App Secret Open ID 腾讯会议',
        hint: settings.feishu?.configured ? '已配置飞书会议' : '可在智能招聘中建会',
        searchText: `飞书会议 ${settings.feishu?.appId || ''} ${settings.feishu?.ownerId || ''}`,
      },
      {
        id: 'settings-rag',
        tab: 'model',
        label: '设置 · 知识检索（RAG）',
        keywords: 'rag 检索 embedding 向量 分块 简历原文 知识库',
        hint: settings.ragEnabled === false ? '已关闭' : (settings.ragEmbeddings ? '关键词 + Embedding' : '关键词检索'),
        searchText: `RAG ${settings.embeddingModel || ''}`,
      },
      {
        id: 'settings-calendar-external',
        tab: 'calendar',
        label: '设置 · 外部日历',
        keywords: 'google outlook caldav ics 同步 推送',
        hint: 'Google / Outlook / CalDAV',
      },
      {
        id: 'settings-categories',
        tab: 'categories',
        label: '设置 · 日历分类',
        keywords: '分类 颜色 关键词 work personal',
        hint: '自定义日程类别',
      },
      {
        id: 'settings-filters',
        tab: 'filters',
        label: '设置 · 邮件过滤',
        keywords: '过滤 规则 跳过 垃圾 推广',
        hint: '命中规则可跳过模型',
      },
      {
        id: 'settings-prompt',
        tab: 'prompt',
        label: '设置 · 提示词',
        keywords: 'prompt 提取 系统提示',
        hint: '邮件提取提示词',
      },
      {
        id: 'settings-hotkeys',
        tab: 'hotkeys',
        label: '设置 · 快捷键',
        keywords: 'hotkey 键盘 快捷键',
        hint: '命令面板与新建等',
      },
      {
        id: 'settings-data',
        tab: 'data',
        label: '设置 · 数据与备份',
        keywords: '备份 导出 导入 清除 示例 持久化',
        hint: '本地数据管理',
      },
    ];
    for (const entry of settingsEntries) {
      push({
        id: entry.id,
        label: entry.label,
        hint: entry.hint,
        group: '设置',
        icon: Settings2,
        keywords: entry.keywords,
        searchText: entry.searchText,
        run: () => navigate(`/app/settings?tab=${entry.tab}`),
      });
    }

    // 当前配置快照（让「飞书」「deepseek」等字段值也能搜到）
    if (settings.email) {
      push({
        id: 'cfg-email',
        label: `当前邮箱 · ${settings.email}`,
        hint: '收信地址',
        group: '当前配置',
        icon: Mail,
        keywords: `邮箱 ${settings.email} ${settings.provider || ''}`,
        run: () => navigate('/app/settings?tab=mailbox'),
      });
    }
    if (settings.model || settings.baseUrl) {
      push({
        id: 'cfg-model',
        label: `当前模型 · ${settings.model || '未命名'}`,
        hint: settings.baseUrl || '',
        group: '当前配置',
        icon: Sparkles,
        keywords: `模型 ${settings.model || ''} ${settings.baseUrl || ''} api`,
        run: () => navigate('/app/settings?tab=model'),
      });
    }
    if (settings.feishu?.configured || settings.feishu?.appId) {
      push({
        id: 'cfg-feishu',
        label: '飞书会议已配置',
        hint: settings.feishu.appId ? `App ID · ${settings.feishu.appId}` : '可在智能招聘中建会',
        group: '当前配置',
        icon: Video,
        keywords: '飞书 会议 feishu lark 已配置',
        searchText: `飞书 ${settings.feishu.appId || ''} ${settings.feishu.ownerId || ''}`,
        run: () => navigate('/app/settings?tab=model'),
      });
    }

    // 日程
    for (const event of events) {
      push({
        id: `event-${event.id}`,
        label: event.title || '未命名日程',
        hint: `${event.mailboxTag ? `[${event.mailboxTag}] ` : ''}${fullDateTime(event.start)}${event.location ? ` · ${event.location}` : ''}`,
        group: event.status === 'cancelled' ? '已取消日程' : '日程',
        icon: CalendarDays,
        keywords: `${event.description || ''} ${event.location || ''} ${event.category || ''} ${event.status || ''} ${event.emailSubject || ''}`,
        searchText: `${event.title || ''} ${event.location || ''} ${event.description || ''}`,
        run: () => setEventModal({ event, date: null }),
      });
    }

    // 待办
    for (const task of tasks) {
      push({
        id: `task-${task.id}`,
        label: task.title || '未命名待办',
        hint: [
          task.mailboxTag ? `[${task.mailboxTag}]` : '',
          task.status === 'done' ? '已完成' : '待办',
          task.dueAt ? fullDateTime(task.dueAt) : '',
          task.assignee || '',
        ].filter(Boolean).join(' · '),
        group: '待办',
        icon: ListTodo,
        keywords: `${task.description || ''} ${task.assignee || ''} ${task.priority || ''} ${task.status || ''}`,
        searchText: `${task.title || ''} ${task.description || ''}`,
        run: () => {
          navigate('/app/todos');
          const source = task.sources?.[0];
          if (source?.emailId) openEmail(source.emailId);
        },
      });
    }

    // 邮件
    for (const email of emails) {
      push({
        id: `mail-${email.mailboxId || ''}-${email.id}`,
        label: email.subject || email.id,
        hint: [email.sender, email.category, email.status].filter(Boolean).join(' · '),
        group: email.category === 'resume' ? '求职邮件' : '邮件',
        icon: Mail,
        keywords: `${email.body || ''} ${email.summary || ''} ${email.extraction?.summary || ''} ${(email.attachments || []).map((a) => a.filename || a.name).join(' ')}`,
        searchText: `${email.subject || ''} ${email.sender || ''} ${email.summary || ''}`,
        run: () => openEmail(email.id, email.mailboxId),
      });
      for (const file of email.attachments || []) {
        push({
          id: `mail-att-${email.id}-${file.key || file.id || file.filename}`,
          label: file.filename || file.name || '邮件附件',
          hint: `来自：${email.subject || email.id}`,
          group: '附件',
          icon: Paperclip,
          keywords: `${file.contentType || ''} ${email.subject || ''}`,
          run: () => openEmail(email.id, email.mailboxId),
        });
      }
    }

    for (const { invoice, email, key } of invoiceRows(emails, mailboxId).filter((row) => row.invoice).slice(0, 80)) {
      push({
        id: `invoice-${key}`,
        label: invoice.sellerName || invoice.invoiceType || '发票',
        hint: [invoice.invoiceNumber, invoice.totalAmount, invoice.currency, invoice.buyerName].filter(Boolean).join(' · '),
        group: '发票',
        icon: ReceiptText,
        keywords: `${invoice.invoiceNumber || ''} ${invoice.buyerName || ''} ${invoice.sellerTaxId || ''} ${email.subject || ''}`,
        run: () => { closeEmail(); navigate(invoiceHref(email, invoice, mailboxId)); },
      });
    }

    // 证据链
    for (const trace of traceData?.traces || []) {
      push({
        id: `trace-${trace.trace_id}`,
        label: trace.subject || '处理记录',
        hint: `${trace.mode === 'demo' ? '示例' : trace.kind === 'recruitment' ? '招聘' : '邮箱'} · ${trace.status || ''}`,
        group: '证据链',
        icon: GitBranch,
        keywords: `${trace.decision?.summary || trace.decision || ''} ${trace.trace_id}`,
        run: () => navigate(`/app/traces?trace=${encodeURIComponent(trace.trace_id)}`),
      });
    }

    // 招聘
    if (showRecruitment) {
      for (const candidate of recruitment.candidates || []) {
        const profile = candidate.profile || candidate.versions?.find((v) => v.id === candidate.latestVersionId)?.profile || {};
        const name = nameOf(candidate) || candidate.name || '候选人';
        push({
          id: `candidate-${candidate.id}`,
          label: name,
          hint: [
            profile.personal?.currentCity || profile.city,
            profile.intent?.positions?.[0],
            profile.education?.[0]?.school || profile.school,
          ].filter(Boolean).join(' · '),
          group: '人才库',
          icon: Users,
          keywords: `${JSON.stringify(profile)} ${candidate.email || ''} ${(candidate.tags || []).join(' ')}`,
          searchText: name,
          run: () => navigate(`${recruitmentPath}?candidate=${encodeURIComponent(candidate.id)}`),
        });
      }
      for (const attachment of recruitment.attachments || []) {
        push({
          id: `recruit-att-${attachment.id}`,
          label: attachment.filename || '简历附件',
          hint: attachment.status || '附件',
          group: '简历附件',
          icon: FileText,
          keywords: `${attachment.error || ''} ${attachment.candidateId || ''}`,
          run: () => {
            if (attachment.candidateId) {
              navigate(`${recruitmentPath}?candidate=${encodeURIComponent(attachment.candidateId)}`);
            } else {
              navigate(recruitmentPath);
            }
          },
        });
      }
      for (const interview of recruitment.interviews || []) {
        push({
          id: `interview-${interview.id}`,
          label: interview.subject || '面试邮件',
          hint: [interview.status, interview.to].filter(Boolean).join(' · '),
          group: '面试邀约',
          icon: Video,
          keywords: `${interview.body || ''} ${interview.meetingUrl || ''} 飞书 腾讯会议`,
          searchText: `${interview.subject || ''} ${interview.body || ''} ${interview.meetingUrl || ''}`,
          run: () => navigate(`${recruitmentPath}?interview=${encodeURIComponent(interview.id)}`),
        });
      }
      for (const message of recruitment.messages || []) {
        const content = String(message.content || '');
        if (!content.trim()) continue;
        push({
          id: `recruit-msg-${message.id}`,
          label: content.slice(0, 80) || '招聘对话',
          hint: message.role === 'user' ? '你说的' : '助手回复',
          group: '招聘对话',
          icon: Sparkles,
          keywords: content,
          searchText: content,
          run: () => navigate(recruitmentPath),
        });
      }
    }

    const limit = q ? 120 : 50;
    if (!q) {
      const preferred = ['操作', '导航', '我的工作台', '设置', '当前配置', '日程', '待办', '发票', '邮件', '求职邮件', '人才库', '证据链'];
      items.sort((a, b) => {
        const ai = preferred.indexOf(a.group);
        const bi = preferred.indexOf(b.group);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
    }
    return items.slice(0, limit);
  }, [
    query, events, tasks, emails, isAdmin, isSyncing, navigate, openEmail, closeEmail, setEventModal, sync,
    showRecruitment, recruitment, visibleFeatures, visibleWorkbenches, traceData, settings,
  ]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of actions) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group).push(item);
    }
    return [...map.entries()];
  }, [actions]);

  const flat = actions;

  useEffect(() => {
    setActive(0);
  }, [query, commandOpen]);

  function runItem(item) {
    if (!item) return;
    setCommandOpen(false);
    item.run();
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(flat.length - 1, value + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(flat[active]);
    }
  }

  let flatIndex = -1;
  const highlightQuery = query.trim();

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>全局搜索</DialogTitle>
          <DialogDescription>搜索日程、待办、发票、邮件、设置、人才、附件、证据链与快捷操作</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索日程 / 待办 / 发票 / 邮件 / 设置（飞书、RAG）/ 人才 / 证据链…"
            className="h-12 border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[min(70vh,520px)] overflow-auto p-2">
          {flat.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配结果</p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} className="mb-2">
                <div className="px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {groupLabel(group)}
                </div>
                {list.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm',
                        index === active ? 'bg-muted' : 'hover:bg-muted/60',
                      )}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runItem(item)}
                    >
                      <item.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <HighlightText
                          text={item.label}
                          query={highlightQuery}
                          className="block truncate font-medium"
                        />
                        {item.hint ? (
                          <HighlightText
                            text={item.hint}
                            query={highlightQuery}
                            className="block truncate text-[11px] text-muted-foreground"
                          />
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{item.group}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
          ↑↓ 选择 · Enter 打开 · Esc 关闭 · 匹配项已高亮
          {showRecruitment ? ' · 含人才库、面试、设置与飞书' : ' · 含设置与当前配置'}
        </div>
      </DialogContent>
    </Dialog>
  );
}
