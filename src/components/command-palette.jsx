import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, Inbox, LayoutDashboard, ListTodo, Plus, RefreshCw, Search, Settings2, Shield,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/context/workspace';
import { useAuthUser } from '@/lib/auth-session';
import { fullDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';

export function CommandPalette() {
  const navigate = useNavigate();
  const { isAdmin } = useAuthUser();
  const {
    commandOpen, setCommandOpen, events, tasks, emails, openEmail, setEventModal, sync, isSyncing,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!commandOpen) {
      setQuery('');
      setActive(0);
    }
  }, [commandOpen]);

  const actions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = [
      { id: 'new-event', label: '新建日程', group: '操作', icon: Plus, run: () => setEventModal({ event: null, date: null }) },
      { id: 'sync', label: isSyncing ? '同步进行中…' : '同步当前邮箱', group: '操作', icon: RefreshCw, run: () => sync('qq') },
      { id: 'go-overview', label: '前往总览', group: '导航', icon: LayoutDashboard, run: () => navigate('/app') },
      { id: 'go-calendar', label: '前往日历', group: '导航', icon: CalendarDays, run: () => navigate('/app/calendar') },
      { id: 'go-todos', label: '前往待办', group: '导航', icon: ListTodo, run: () => navigate('/app/todos') },
      { id: 'go-mail', label: '前往邮件', group: '导航', icon: Inbox, run: () => navigate('/app/mail') },
      { id: 'go-settings', label: '前往设置', group: '导航', icon: Settings2, run: () => navigate('/app/settings') },
      ...(isAdmin ? [{ id: 'go-admin', label: '前往管理后台', group: '导航', icon: Shield, run: () => navigate('/admin') }] : []),
    ];
    const eventItems = events.slice(0, 80).map((event) => ({
      id: `event-${event.id}`,
      label: event.title,
      hint: `${event.mailboxTag ? `[${event.mailboxTag}] ` : ''}${fullDateTime(event.start)}`,
      group: '日程',
      icon: CalendarDays,
      run: () => setEventModal({ event, date: null }),
    }));
    const taskItems = tasks.slice(0, 80).map((task) => ({
      id: `task-${task.id}`,
      label: task.title,
      hint: task.mailboxTag ? `[${task.mailboxTag}]` : '',
      group: '待办',
      icon: ListTodo,
      run: () => {
        navigate('/app/todos');
        const source = task.sources?.[0];
        if (source?.emailId) openEmail(source.emailId);
      },
    }));
    const mailItems = emails.slice(0, 80).map((email) => ({
      id: `mail-${email.id}`,
      label: email.subject || email.id,
      hint: email.sender || '',
      group: '邮件',
      icon: Inbox,
      run: () => openEmail(email.id),
    }));
    const all = [...base, ...eventItems, ...taskItems, ...mailItems];
    if (!q) return all.slice(0, 40);
    return all.filter((item) => `${item.label} ${item.hint || ''} ${item.group}`.toLowerCase().includes(q)).slice(0, 40);
  }, [query, events, tasks, emails, isAdmin, isSyncing, navigate, openEmail, setEventModal, sync]);

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
      setActive((value) => Math.min(actions.length - 1, value + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(actions[active]);
    }
  }

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>全局搜索</DialogTitle>
          <DialogDescription>搜索日程、待办、邮件，或执行快捷操作</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索日程 / 待办 / 邮件，或输入操作…"
            className="h-12 border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[min(60vh,420px)] overflow-auto p-2">
          {actions.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配结果</p>
          ) : (
            actions.map((item, index) => (
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
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                <span className="truncate text-xs text-muted-foreground">{item.hint || item.group}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
