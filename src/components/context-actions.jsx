import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * 简易右键菜单。在可右键区域包一层：
 * <ContextActions items={[...]}>...</ContextActions>
 */
export function ContextActions({ items = [], children, className }) {
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    if (!menu) return undefined;
    function close() { setMenu(null); }
    function onKey(event) { if (event.key === 'Escape') close(); }
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <div
      className={cn(className)}
      data-context-own
      onContextMenu={(event) => {
        if (!items.length) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {menu && createPortal(
        <div
          className="fixed z-[100] min-w-44 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.id || item.label}
              type="button"
              disabled={item.disabled}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted',
                item.disabled && 'opacity-50',
                item.destructive && 'text-destructive',
              )}
              onClick={() => {
                setMenu(null);
                item.onSelect?.();
              }}
            >
              {item.icon ? <item.icon className="size-3.5 opacity-70" /> : null}
              <span className="flex-1">{item.label}</span>
              {item.shortcut ? <span className="text-[10px] text-muted-foreground">{item.shortcut}</span> : null}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
