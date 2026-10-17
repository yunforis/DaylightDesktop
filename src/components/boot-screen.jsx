import React from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 全屏启动 / 鉴权等待：与主题氛围一致，避免白屏闪烁。 */
export function BootScreen({
  label = '正在进入 Daylight…',
  className,
  compact = false,
}) {
  return (
    <div
      className={cn(
        'relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background text-foreground',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            'radial-gradient(900px 520px at 50% -10%, var(--atmosphere-a, oklch(0.92 0.03 210 / 0.55)), transparent 58%), radial-gradient(700px 400px at 15% 80%, var(--atmosphere-b, oklch(0.94 0.02 85 / 0.35)), transparent 50%), linear-gradient(180deg, var(--atmosphere-base, var(--background)) 0%, var(--background) 100%)',
        }}
      />
      <div className={cn('relative z-[1] flex flex-col items-center gap-4 px-6', compact && 'gap-3')}>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm animate-in fade-in zoom-in-95 duration-500">
          <span className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">D</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-700">
          <LoaderCircle className="size-4 animate-spin" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}
