import React from 'react';
import { cn } from '@/lib/utils';

/**
 * 关键词高亮：把 text 里命中 query 的片段用 <mark> 标出来。
 * 大小写不敏感、按子串匹配（中文同样适用），与列表的筛选口径保持一致。
 */
export function HighlightText({ text, query, className, markClassName }) {
  const value = text == null ? '' : String(text);
  const needle = (query || '').trim();
  if (!needle) return <span className={className}>{value}</span>;

  const lowerValue = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let cursor = 0;
  let at = lowerValue.indexOf(lowerNeedle);
  while (at !== -1) {
    if (at > cursor) parts.push(value.slice(cursor, at));
    parts.push(
      <mark
        key={`${at}-${parts.length}`}
        className={cn('rounded-sm bg-amber-200/80 px-0.5 text-inherit dark:bg-amber-400/30', markClassName)}
      >
        {value.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
    at = lowerValue.indexOf(lowerNeedle, cursor);
  }
  if (!parts.length) return <span className={className}>{value}</span>;
  parts.push(value.slice(cursor));
  return <span className={className}>{parts}</span>;
}
