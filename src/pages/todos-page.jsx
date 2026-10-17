import React, { useMemo, useState } from 'react';
import { CheckSquare, Circle, ListTodo, Mail, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextActions } from '@/components/context-actions';
import { matchesWorkbench, useWorkbenchOptions, WorkbenchFilter } from '@/components/workbench-filter';
import { useWorkspace } from '@/context/workspace';
import { fullDateTime, shortDate, shanghaiDate, clock } from '@/lib/time';
import { cn } from '@/lib/utils';

const PRIORITY = {
  high: { label: '高', className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100' },
  normal: { label: '普通', className: 'bg-muted text-muted-foreground' },
  low: { label: '低', className: 'bg-muted text-muted-foreground' },
};
const VERIFY = {
  scenario_receipt: '回执后才能完成',
  reply_sent: '需已发送回复',
  email_ack: '需对方回信确认',
  manual: '人工核验',
};

export default function TodosPage() {
  const { tasks, changeTaskStatus, updateTask, openEmail } = useWorkspace();
  const { workbenches, loaded } = useWorkbenchOptions();
  const [showDone, setShowDone] = useState(false);
  const [workbenchId, setWorkbenchId] = useState('all');
  const scoped = useMemo(
    () => tasks.filter((task) => matchesWorkbench(task, workbenchId, loaded ? workbenches : null)),
    [tasks, workbenchId, workbenches, loaded],
  );

  const pending = useMemo(
    () => scoped.filter((task) => task.status !== 'done')
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.dueAt || '').localeCompare(String(b.dueAt || ''))),
    [scoped],
  );
  const done = useMemo(
    () => scoped.filter((task) => task.status === 'done')
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))),
    [scoped],
  );
  const visible = showDone ? done : pending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">待办</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pending.length} 项待完成 · {done.length} 项已完成
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WorkbenchFilter value={workbenchId} onChange={setWorkbenchId} workbenches={workbenches} loaded={loaded} />
          <Button variant={showDone ? 'outline' : 'default'} size="sm" onClick={() => setShowDone(false)}>
            <Circle className="size-4" />进行中
          </Button>
          <Button variant={showDone ? 'default' : 'outline'} size="sm" onClick={() => setShowDone(true)}>
            <CheckSquare className="size-4" />已完成
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTodo className="size-4" />暂无{showDone ? '已完成' : '进行中'}待办
            </CardTitle>
            <CardDescription>让右下角「小 D」创建待办，或同步邮件、导入「标签与待办」示例。</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {visible.map((task) => {
            const priority = PRIORITY[task.priority] || PRIORITY.normal;
            const overdue = task.dueAt && task.status !== 'done' && Date.parse(task.dueAt) < Date.now();
            const sourceId = task.sources?.[0]?.emailId || task.emailId;
            return (
              <ContextActions
                key={task.id}
                items={[
                  sourceId ? {
                    id: 'open',
                    label: '查看原文',
                    icon: Mail,
                    onSelect: () => openEmail(sourceId),
                  } : null,
                  task.status === 'done'
                    ? {
                      id: 'reopen',
                      label: '恢复待办',
                      icon: RotateCcw,
                      onSelect: () => changeTaskStatus(task.id, 'pending'),
                    }
                    : {
                      id: 'done',
                      label: '标记完成',
                      icon: CheckSquare,
                      onSelect: () => changeTaskStatus(task.id, 'done'),
                    },
                ].filter(Boolean)}
              >
              <Card className={cn(overdue && 'border-amber-300 dark:border-amber-800')}>
                <CardContent className="flex items-start gap-3 p-4">
                  <Checkbox
                    checked={task.status === 'done'}
                    onCheckedChange={(checked) => {
                      changeTaskStatus(task.id, checked ? 'done' : 'pending').catch((error) => {
                        // toast 已由 request 抛错冒泡；这里避免未处理 Promise
                        console.warn(error.message);
                      });
                    }}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className={cn('text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>
                        {task.title}
                      </h2>
                      {task.workbenchName && <Badge variant="outline">{task.workbenchName}</Badge>}
                      {task.assignee && <Badge variant="outline">责任人 · {task.assignee}</Badge>}
                      {task.mailboxTag && <Badge variant="outline">{task.mailboxTag}</Badge>}
                      {task.linkedTaskRef && (
                        <Badge variant="outline">
                          关联 {task.linkedTaskRef.mailboxEmail || task.linkedTaskRef.mailboxId}
                        </Badge>
                      )}
                      <Badge variant="secondary" className={priority.className}>{priority.label}</Badge>
                      {task.requiresVerification && (
                        <Badge variant="outline">
                          {VERIFY[task.verification?.mode || task.verificationMode] || '需核验'}
                          {task.verification?.status === 'verified' ? ' · 已通过' : ''}
                        </Badge>
                      )}
                      {task.source === 'demo' && <Badge variant="outline">示例</Badge>}
                      {task.reopenedAt && task.status !== 'done' && <Badge variant="secondary">提醒已重开</Badge>}
                      {overdue && <Badge variant="destructive">已过期</Badge>}
                    </div>
                    {task.description && (
                      <p className="text-sm text-muted-foreground">{task.description}</p>
                    )}
                    {task.status !== 'done' && (
                      <div key={`${task.id}-${task.updatedAt || ''}`} className="flex flex-wrap gap-2">
                        <input
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          defaultValue={task.assignee || ''}
                          placeholder="责任人"
                          onBlur={(e) => {
                            if (e.target.value !== (task.assignee || '')) {
                              updateTask(task.id, { assignee: e.target.value }).catch(() => {});
                            }
                          }}
                        />
                        <input
                          type="datetime-local"
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          defaultValue={toLocalInput(task.dueAt)}
                          onBlur={(e) => {
                            const next = fromLocalInput(e.target.value);
                            if (next !== (task.dueAt || null)) {
                              updateTask(task.id, { dueAt: next }).catch(() => {});
                            }
                          }}
                        />
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          defaultValue={PRIORITY[task.priority] ? task.priority : 'normal'}
                          onChange={(e) => updateTask(task.id, { priority: e.target.value }).catch(() => {})}
                        >
                          <option value="high">高</option>
                          <option value="normal">普通</option>
                          <option value="low">低</option>
                        </select>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {task.dueAt && <span>截止 {fullDateTime(task.dueAt)}</span>}
                      {task.deadlineText && <span>原话：{task.deadlineText}</span>}
                      {task.createdAt && <span>创建 {shortDate(task.createdAt)}</span>}
                      {task.reopenedAt && <span>重开 {shortDate(task.reopenedAt)}</span>}
                    </div>
                    {(task.sources || []).length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {task.sources.map((source) => (
                          <Button
                            key={`${task.id}-${source.emailId}`}
                            size="sm"
                            variant="outline"
                            className="h-8 max-w-full min-w-0 px-3 text-xs"
                            onClick={() => openEmail(source.emailId)}
                          >
                            <span className="truncate">查看原文：{source.emailSubject || source.emailId}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                    {!(task.sources || []).length && task.emailId && (
                      <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={() => openEmail(task.emailId)}>
                        查看原文
                      </Button>
                    )}
                  </div>
                  {task.status === 'done' && (
                    <Button size="icon-sm" variant="ghost" onClick={() => changeTaskStatus(task.id, 'pending')} title="恢复">
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                </CardContent>
              </Card>
              </ContextActions>
            );
          })}
        </div>
      )}
    </div>
  );
}

function priorityRank(value) {
  if (value === 'high') return 0;
  if (value === 'low') return 2;
  return 1;
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${shanghaiDate(date)}T${clock(date)}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  // 按北京时间墙钟写入（与日程存储约定一致）
  return `${value.length === 16 ? `${value}:00` : value}+08:00`;
}
