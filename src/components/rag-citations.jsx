import { useState } from 'react';
import { ArrowUpRight, FileText, Mail, Quote } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { openAttachmentViewer } from '@/lib/attachment-open';
import { pdfUrl } from '@/lib/recruitment';
import { useWorkspace } from '@/context/workspace';
import { parseMailRef } from '../../shared/mail-ref.js';
import { cn } from '@/lib/utils';

/**
 * RAG 证据片段。
 *
 * 一次命中可能有很多条，全部铺开会把回答淹掉，所以这里分块展示：
 * 上面是编号（1、2、3…），点哪个看哪条；下面是当前这条的摘录，点开就是原文。
 * 邮件命中打开原信并高亮；简历附件打开 PDF 预览。
 */
export function RagCitations({
  citations = [],
  mailboxId,
  className,
  title = '证据片段',
}) {
  const { openEmail } = useWorkspace();
  const [active, setActive] = useState(0);
  const list = (Array.isArray(citations) ? citations : [])
    .filter((item) => item?.quote || item?.attachmentId || item?.emailId);
  if (!list.length) return null;

  const index = Math.min(Math.max(active, 0), list.length - 1);
  const item = list[index];
  const ref = parseMailRef(item.attachmentId);
  const emailId = item.emailId || ref.emailId;
  const key = item.chunkId || `${item.attachmentId}-${item.page}-${index}`;
  const label = item.filename || (emailId ? '邮件' : '附件');
  const page = Number(item.page) || 1;
  const isMail = Boolean(emailId);
  const score = item.score != null && Number.isFinite(Number(item.score)) ? Number(item.score).toFixed(2) : null;
  const kind = isMail ? (ref.kind === 'attachment' ? '附件摘录' : '邮件') : `第 ${page} 页`;
  const truncated = list.length > 1;

  function open() {
    // 混合视图下命中可能来自别的邮箱：优先用片段自带的 mailboxId，才能打开对应邮箱里的原信。
    const targetMailbox = item.mailboxId || mailboxId;
    if (isMail) {
      openEmail(emailId, targetMailbox, item.quote || '');
      return;
    }
    openAttachmentViewer({
      id: item.attachmentId,
      filename: label,
      contentType: 'application/pdf',
      url: pdfUrl(item.attachmentId, targetMailbox),
      proxyUrl: pdfUrl(item.attachmentId, targetMailbox),
      page,
    });
  }

  return (
    <div className={cn('rounded-lg border bg-muted/20 p-2', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <Quote className="size-3" />
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {truncated ? `共 ${list.length} 条` : '1 条'}
        </span>
        {truncated && (
          <div className="flex flex-wrap gap-1" aria-label={`${title}编号`}>
            {list.map((entry, position) => (
              <button
                key={entry.chunkId || `${entry.attachmentId}-${entry.page}-${position}`}
                type="button"
                aria-pressed={position === index}
                aria-label={`第 ${position + 1} 条证据`}
                onClick={() => setActive(position)}
                className={cn(
                  'min-w-6 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums transition-colors',
                  position === index
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {position + 1}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        key={key}
        type="button"
        aria-label={`${label} ${kind}`}
        onClick={open}
        className="mt-1.5 flex w-full flex-col gap-1 rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <span className="flex w-full flex-wrap items-center gap-1.5">
          {isMail
            ? <Mail className="size-3.5 shrink-0 text-muted-foreground" />
            : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{kind}</Badge>
          {score && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">{score}</Badge>
          )}
        </span>
        {item.quote && (
          <span className="block max-h-24 overflow-hidden text-[11px] leading-relaxed break-words text-muted-foreground">
            {item.quote}
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] text-primary">
          {isMail ? '打开原信并高亮' : '打开原文预览'}
          <ArrowUpRight className="size-3" />
        </span>
      </button>
    </div>
  );
}
