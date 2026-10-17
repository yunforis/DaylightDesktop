import React, { useEffect, useMemo, useState } from 'react';
import { Download, Eye, FileText, LoaderCircle, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function extOf(name = '') {
  const part = String(name).split('.').pop() || '';
  return part.toLowerCase();
}

function kindOf(file) {
  const type = String(file.contentType || '').toLowerCase();
  const ext = extOf(file.filename || file.name);
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (type.includes('pdf') || ext === 'pdf') return 'pdf';
  if (
    type.includes('spreadsheet')
    || type.includes('excel')
    || ['xls', 'xlsx', 'csv'].includes(ext)
  ) return 'excel';
  if (
    type.includes('presentation')
    || type.includes('powerpoint')
    || ['ppt', 'pptx'].includes(ext)
  ) return 'ppt';
  if (
    type.startsWith('text/')
    || type.includes('json')
    || ['txt', 'md', 'json', 'log', 'xml', 'html', 'htm', 'csv'].includes(ext)
  ) return 'text';
  return 'other';
}

function sourceUrl(file) {
  return file.proxyUrl || file.url || (file.key ? `/api/attachments/${encodeURIComponent(file.key)}` : '');
}

function officeEmbedUrl(url) {
  if (!url || url.startsWith('/')) return null;
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
}

function formatSize(size) {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreview({ file, open, onOpenChange }) {
  const kind = kindOf(file);
  const url = sourceUrl(file);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const officeUrl = useMemo(() => (['excel', 'ppt'].includes(kind) ? officeEmbedUrl(file.url) : null), [kind, file.url]);

  useEffect(() => {
    if (!open || kind !== 'text' || !url) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(url)
      .then(async (resp) => {
        if (!resp.ok) throw new Error('无法读取附件内容');
        const body = await resp.text();
        if (!cancelled) setText(body.slice(0, 200_000));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || '读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, kind, url]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="pr-8 text-base leading-snug break-all">
            {file.filename || file.name || '附件预览'}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{kind}</Badge>
            {file.contentType ? <span>{file.contentType}</span> : null}
            {file.size != null ? <span>{formatSize(file.size)}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[50vh] flex-1 overflow-auto bg-muted/20 p-4">
          {!url && <p className="text-sm text-muted-foreground">没有可预览的地址</p>}
          {url && kind === 'image' && (
            <img src={url} alt={file.filename || 'attachment'} className="mx-auto max-h-[70vh] max-w-full rounded-lg border object-contain" />
          )}
          {url && kind === 'pdf' && (
            <iframe title={file.filename || 'pdf'} src={url} className="h-[70vh] w-full rounded-lg border bg-background" />
          )}
          {url && (kind === 'excel' || kind === 'ppt') && (
            officeUrl ? (
              <iframe title={file.filename || 'office'} src={officeUrl} className="h-[70vh] w-full rounded-lg border bg-background" />
            ) : (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>该附件暂无公网地址，无法内嵌 Office 预览。请下载后本地打开。</p>
                <Button asChild><a href={url} target="_blank" rel="noreferrer"><Download className="size-4" />下载</a></Button>
              </div>
            )
          )}
          {url && kind === 'text' && (
            loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />读取中…
              </div>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : (
              <pre className="overflow-auto rounded-lg border bg-background p-4 text-xs leading-relaxed whitespace-pre-wrap break-all">{text}</pre>
            )
          )}
          {url && kind === 'other' && (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>暂不支持在线预览此类型，可下载查看。</p>
              <Button asChild><a href={url} download={file.filename || true}><Download className="size-4" />下载</a></Button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {url ? (
            <Button variant="outline" asChild>
              <a href={url} download={file.filename || true} target="_blank" rel="noreferrer">
                <Download className="size-4" />下载
              </a>
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            <X className="size-4" />关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 邮件附件列表：支持预览（pdf/图片/文本/Office）与下载。 */
export function AttachmentList({ attachments = [], className }) {
  const [active, setActive] = useState(null);
  if (!attachments.length) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {attachments.map((file, index) => {
        const url = sourceUrl(file);
        const kind = kindOf(file);
        return (
          <div key={file.key || `${file.filename}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{file.filename || file.name || `附件 ${index + 1}`}</span>
                <Badge variant="outline" className="text-[10px]">{kind}</Badge>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatSize(file.size)}
                {file.storage ? ` · ${file.storage}` : ''}
                {file.skipped ? ` · ${file.reason || '已跳过'}` : ''}
              </div>
            </div>
            <div className="flex gap-1">
              {!file.skipped && url ? (
                <>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setActive(file)}>
                    <Eye className="size-3.5" />预览
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" asChild>
                    <a href={url} download={file.filename || true} target="_blank" rel="noreferrer">
                      <Download className="size-3.5" />下载
                    </a>
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
      {active ? (
        <AttachmentPreview file={active} open={Boolean(active)} onOpenChange={(open) => { if (!open) setActive(null); }} />
      ) : null}
    </div>
  );
}
