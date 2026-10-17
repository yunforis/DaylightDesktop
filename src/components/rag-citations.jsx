import { FileText, Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { openAttachmentViewer } from '@/lib/attachment-open';
import { pdfUrl } from '@/lib/recruitment';
import { useWorkspace } from '@/context/workspace';
import { parseMailRef } from '../../server/rag/mail-ref.js';
import { cn } from '@/lib/utils';

/**
 * RAG 证据片段。邮件命中打开原信并高亮；简历附件仍打开预览。
 */
export function RagCitations({
  citations = [],
  mailboxId,
  className,
  title = '证据片段',
}) {
  const { openEmail } = useWorkspace();
  const list = Array.isArray(citations) ? citations.filter((item) => item?.quote || item?.attachmentId || item?.emailId) : [];
  if (!list.length) return null;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
      <ul className="space-y-1.5">
        {list.map((item, index) => {
          const ref = parseMailRef(item.attachmentId);
          const emailId = item.emailId || ref.emailId;
          const key = item.chunkId || `${item.attachmentId}-${item.page}-${index}`;
          const label = item.filename || (emailId ? '邮件' : '附件');
          const page = Number(item.page) || 1;
          const isMail = Boolean(emailId);
          return (
            <li key={key}>
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded-md border bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
                onClick={() => {
                  if (isMail) {
                    openEmail(emailId, mailboxId || item.mailboxId, item.quote || '');
                    return;
                  }
                  openAttachmentViewer({
                    id: item.attachmentId,
                    filename: label,
                    contentType: 'application/pdf',
                    url: pdfUrl(item.attachmentId, mailboxId),
                    proxyUrl: pdfUrl(item.attachmentId, mailboxId),
                    page,
                  });
                }}
              >
                {isMail
                  ? <Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  : <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{label}</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {isMail ? (ref.kind === 'attachment' ? '附件摘录' : '邮件') : `第 ${page} 页`}
                    </Badge>
                    {item.score != null && Number.isFinite(Number(item.score)) && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
                        {Number(item.score).toFixed(2)}
                      </Badge>
                    )}
                  </span>
                  {item.quote && (
                    <span className="block text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
                      {item.quote}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
