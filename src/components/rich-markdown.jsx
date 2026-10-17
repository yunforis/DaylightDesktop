import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { cn } from '@/lib/utils';
import { openAttachmentViewer } from '@/lib/attachment-open';

const REMARK = [remarkGfm, remarkMath];
const REHYPE = [rehypeKatex];

function MediaFrame({ children, caption }) {
  return (
    <figure className="my-3 overflow-hidden rounded-lg border bg-muted/20">
      <div className="flex justify-center bg-background/60 p-2">{children}</div>
      {caption ? <figcaption className="border-t px-3 py-1.5 text-xs text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

function looksLikeAttachment(href = '') {
  return /\/api\/(attachments|recruitment\/attachments)\//i.test(href)
    || /\.(pdf|png|jpe?g|gif|webp|svg|mp3|wav|ogg|m4a|mp4|webm|mov|txt|md|json|csv|log|js|ts|jsx|tsx|py|go|rs|java|c|cpp|h)$/i.test(href.split('?')[0] || '');
}

function filenameFromHref(href = '') {
  try {
    const path = href.split('?')[0];
    return decodeURIComponent(path.split('/').pop() || '附件');
  } catch {
    return '附件';
  }
}

/** 助手与系统消息共用的 Markdown 渲染：GFM、公式、图片/音视频、换行。 */
export function RichMarkdown({ children, className, compact = false }) {
  const text = useMemo(() => {
    if (children == null) return '';
    return typeof children === 'string' ? children : String(children);
  }, [children]);

  if (!text.trim()) return null;

  return (
    <div
      className={cn(
        'rich-markdown text-sm leading-relaxed break-words',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]',
        '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1',
        '[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto',
        compact && '[&_p]:my-1.5',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={{
          a({ href, children: linkChildren, ...props }) {
            const url = href || '';
            if (looksLikeAttachment(url)) {
              return (
                <button
                  type="button"
                  className="inline font-medium text-foreground underline underline-offset-2"
                  onClick={(event) => {
                    event.preventDefault();
                    openAttachmentViewer({
                      filename: filenameFromHref(url),
                      url,
                      proxyUrl: url.startsWith('/') ? url : undefined,
                    });
                  }}
                >
                  {linkChildren}
                </button>
              );
            }
            return (
              <a href={url} target="_blank" rel="noreferrer noopener" {...props}>
                {linkChildren}
              </a>
            );
          },
          img({ src, alt }) {
            if (!src) return null;
            return (
              <MediaFrame caption={alt}>
                <button
                  type="button"
                  className="block max-w-full"
                  onClick={() => openAttachmentViewer({
                    filename: alt || filenameFromHref(src),
                    url: src,
                    contentType: 'image/*',
                  })}
                >
                  <img src={src} alt={alt || ''} className="max-h-72 max-w-full rounded-md object-contain" loading="lazy" />
                </button>
              </MediaFrame>
            );
          },
          // GFM / raw HTML audio/video 不走默认；用 paragraph 中的链接即可打开查看器。
          code({ className: codeClass, children: codeChildren, ...props }) {
            const matched = /language-(\w+)/.exec(codeClass || '');
            const isBlock = Boolean(matched) || String(codeChildren).includes('\n');
            if (!isBlock) {
              return <code className={codeClass} {...props}>{codeChildren}</code>;
            }
            return (
              <code className={cn(codeClass, 'block font-mono text-[12px] leading-relaxed')} {...props}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
