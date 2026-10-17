import React, { useMemo, useState } from 'react';
import { CheckSquare, Circle, ListTodo, Mail, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextActions } from '@/components/context-actions';
import { useWorkspace } from '@/context/workspace';
import { fullDateTime, shortDate } from '@/lib/time';
import { cn } from '@/lib/utils';

const PRIORITY = {
  high: { label: '高', className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100' },
  normal: { label: '普通', className: 'bg-muted text-muted-foreground' },
  low: { label: '低', className: 'bg-muted text-muted-foreground' },
};

export default function TodosPage() {
  const { tasks, changeTaskStatus, openEmail } = useWorkspace();
  const [showDone, setShowDone] = useState(false);

  const pending = useMemo(
    () => tasks.filter((task) => task.status !== 'done')
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.dueAt || '').localeCompare(String(b.dueAt || ''))),
    [tasks],
  );
  const done = useMemo(
    () => tasks.filter((task) => task.status === 'done')
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))),
    [tasks],
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
        <div className="flex gap-2">
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
            <CardDescription>同步邮件或导入「标签与待办」示例后，任务会出现在这里。</CardDescription>
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
                    onCheckedChange={(checked) => changeTaskStatus(task.id, checked ? 'done' : 'pending')}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className={cn('text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>
                        {task.title}
                      </h2>
                      {task.assignee && <Badge variant="outline">责任人 · {task.assignee}</Badge>}
                      {task.mailboxTag && <Badge variant="outline">{task.mailboxTag}</Badge>}
                      <Badge variant="secondary" className={priority.className}>{priority.label}</Badge>
                      {task.source === 'demo' && <Badge variant="outline">示例</Badge>}
                      {task.reopenedAt && task.status !== 'done' && <Badge variant="secondary">提醒已重开</Badge>}
                      {overdue && <Badge variant="destructive">已过期</Badge>}
                    </div>
                    {task.description && (
                      <p className="text-sm text-muted-foreground">{task.description}</p>
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
                            className="h-8 px-3 text-xs"
                            onClick={() => openEmail(source.emailId)}
                          >
                            查看原文：{source.emailSubject || source.emailId}
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
