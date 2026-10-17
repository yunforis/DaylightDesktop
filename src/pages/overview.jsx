import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckSquare, Inbox, LoaderCircle, Mail,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { useWorkspace } from '@/context/workspace';
import { CATEGORIES, emailResult, isCancelled, isConflicting } from '@/lib/domain';
import { eventTime, onDay, shortDate, shanghaiDate, today } from '@/lib/time';

export default function OverviewPage() {
  const navigate = useNavigate();
  const {
    state, events, tasks, emails, isSyncing, sync, openEmail, setEventModal, setSelectedTraceId,
  } = useWorkspace();

  const todayEvents = events
    .filter((event) => onDay(event, today) && !isCancelled(event))
    .sort((a, b) => a.start.localeCompare(b.start));
  const pendingTasks = tasks.filter((task) => task.status !== 'done');
  const conflicts = emails.filter((email) => email.conflicts?.length);
  const recentEmails = [...emails].slice(0, 5);

  const stats = [
    { label: '今日安排', value: todayEvents.length, icon: CalendarDays, to: '/calendar' },
    { label: '待办', value: pendingTasks.length, icon: CheckSquare, to: '/app/todos' },
    { label: '待确认冲突', value: conflicts.length, icon: AlertTriangle, to: '/mail' },
    { label: '已处理邮件', value: emails.length, icon: Inbox, to: '/mail' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shortDate(today)} · {state.settings.email || '未配置邮箱'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={isSyncing} onClick={() => sync('qq').then((r) => {
            if (r?.needSettings) navigate(`/app/settings?tab=${r.settingsTab || 'mailbox'}`);
          })}>
            {isSyncing ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4" />}
            同步邮箱
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isSyncing}>演示数据</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => sync('demo')}>导入示例邮件</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-changes')}>取消与调整</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-conflicts')}>日程冲突</DropdownMenuItem>
              <DropdownMenuItem onClick={() => sync('demo-tasks')}>标签与待办</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div data-tour="overview-stats" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((item) => (
          <Link key={item.label} to={item.to}>
            <Card className="transition-colors hover:bg-muted/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardDescription>{item.label}</CardDescription>
                <item.icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tabular-nums">{item.value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">今日日程</CardTitle>
              <CardDescription>北京时间</CardDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEventModal({ event: null, date: today })}>新建</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {todayEvents.length ? todayEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                className="flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left hover:bg-muted/50"
                onClick={() => setEventModal({ event, date: shanghaiDate(event.start) })}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{event.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {eventTime(event)} · {CATEGORIES[event.category]?.label}
                    {isConflicting(event) && ' · 冲突'}
                  </div>
                </div>
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </button>
            )) : (
              <p className="py-8 text-center text-sm text-muted-foreground">今天没有安排</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">待确认</CardTitle>
              <CardDescription>冲突与回复草稿</CardDescription>
            </div>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/app/mail">全部</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {conflicts.length ? conflicts.slice(0, 5).map((email) => (
              <button
                key={email.id}
                type="button"
                className="flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left hover:bg-muted/50"
                onClick={() => openEmail(email.id)}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{email.subject}</div>
                  <div className="text-xs text-muted-foreground">
                    {email.conflicts.length} 项冲突 · {emailResult(email)}
                  </div>
                </div>
              </button>
            )) : (
              <p className="py-8 text-center text-sm text-muted-foreground">暂无待确认冲突</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">最近邮件</CardTitle>
            <CardDescription>点击查看处理结果</CardDescription>
          </div>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/app/mail">邮件箱</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recentEmails.length ? (
            <div className="divide-y rounded-lg border">
              {recentEmails.map((email) => (
                <button
                  key={email.id}
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40"
                  onClick={() => openEmail(email.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{email.subject}</div>
                    <div className="truncate text-xs text-muted-foreground">{email.sender}</div>
                  </div>
                  <Badge variant={email.status === 'conflict' ? 'destructive' : 'secondary'}>
                    {email.status === 'conflict' ? '冲突' : email.status === 'imported' ? '已导入' : '已处理'}
                  </Badge>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">还没有邮件记录</p>
              <Button className="mt-3" variant="outline" disabled={isSyncing} onClick={() => sync('demo')}>
                导入示例
              </Button>
            </div>
          )}
          <Separator className="my-4" />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/app/traces" onClick={() => setSelectedTraceId(null)}>查看执行日志</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/app/settings">连接设置</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
