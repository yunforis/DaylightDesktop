import React from 'react';
import { cn } from '@/lib/utils';

/**
 * 系统品牌标记：全站统一用「日出信封」徽标（public/logo.png），
 * 不再用字母占位或日历图标代替。底衬固定浅色，深色主题下深蓝徽标也看得清。
 *
 * 用法：<BrandMark className="size-8 rounded-lg" />（尺寸与圆角由调用方决定）
 */
export function BrandMark({ className, imageClassName, alt = '' }) {
  return (
    <span
      aria-hidden={alt ? undefined : 'true'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]',
        className,
      )}
    >
      <img
        src="/logo.png"
        alt={alt}
        draggable={false}
        className={cn('h-[92%] w-[92%] object-contain', imageClassName)}
      />
    </span>
  );
}
