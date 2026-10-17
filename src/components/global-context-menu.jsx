import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, Inbox, ListTodo, Plus, Search, Settings2, Sparkles, RefreshCw,
} from 'lucide-react';
import { useWorkspace } from '@/context/workspace';
import { cn } from '@/lib/utils';

function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const el = target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
  return Boolean(el);
}

export function GlobalContextMenu() {
  const navigate = useNavigate();
  const { setEventModal, setCommandOpen, sync, isSyncing, isMixedView } = useWorkspace();
  const [menu, setMenu] = useState(null);

  const items = useMemo(() => [
    {
      id: 'new-event',
      label: '新建日程',
      icon: Plus,
      onSelect: () => setEventModal({ event: null, date: null }),
    },
    {
      id: 'search',
      label: '全局搜索',
      icon: Search,
      onSelect: () => setCommandOpen(true),
    },
    {
      id: 'sync',
      label: isSyncing ? '同步中…' : '同步真实邮箱',
      icon: RefreshCw,
      disabled: isSyncing || isMixedView,
      onSelect: () => sync('qq'),
    },
    { id: 'sep-1', separator: true },
    {
      id: 'calendar',
      label: '打开日历',
      icon: CalendarDays,
      onSelect: () => navigate('/app/calendar'),
    },
    {
      id: 'todos',
      label: '打开待办',
      icon: ListTodo,
      onSelect: () => navigate('/app/todos'),
    },
    {
      id: 'mail',
      label: '打开邮件',
      icon: Inbox,
      onSelect: () => navigate('/app/mail'),
    },
    {
      id: 'settings',
      label: '打开设置',
      icon: Settings2,
      onSelect: () => navigate('/app/settings'),
    },
    { id: 'sep-2', separator: true },
    {
      id: 'little-d',
      label: '打开小 D',
      icon: Sparkles,
      onSelect: () => window.dispatchEvent(new CustomEvent('daylight:open-little-d')),
    },
  ], [isMixedView, isSyncing, navigate, setCommandOpen, setEventModal, sync]);

  useEffect(() => {
    function onContextMenu(event) {
      if (isEditableTarget(event.target)) return;
      if (event.target.closest?.('[data-context-own]')) return;
      event.preventDefault();
      const pad = 8;
      const width = 200;
      const height = 320;
      const x = Math.min(event.clientX, window.innerWidth - width - pad);
      const y = Math.min(event.clientY, window.innerHeight - height - pad);
      setMenu({ x: Math.max(pad, x), y: Math.max(pad, y) });
    }
    function close() { setMenu(null); }
    function onKey(event) { if (event.key === 'Escape') close(); }
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!menu) return null;

  return createPortal(
    <div
      className="fixed z-[120] min-w-48 overflow-hidden rounded-xl border bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Daylight
      </div>
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} className="my-1 border-t" />;
        }
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted',
              item.disabled && 'pointer-events-none opacity-50',
            )}
            onClick={() => {
              setMenu(null);
              item.onSelect?.();
            }}
          >
            {Icon ? <Icon className="size-3.5 opacity-70" /> : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
