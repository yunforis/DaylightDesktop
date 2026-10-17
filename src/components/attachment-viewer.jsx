import React, { useEffect, useMemo, useState } from 'react';
import {
  Download, Eye, FileAudio, FileCode, FileText, FileVideo, Image as ImageIcon,
  LoaderCircle, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { fetchAuthorizedBlobUrl, fetchAuthorizedText } from '@/lib/auth-fetch';
import { getAuthToken } from '@/lib/auth-api';
import { RichMarkdown } from '@/components/rich-markdown';

function extOf(name = '') {
  const part = String(name).split('.').pop() || '';
  return part.toLowerCase();
}

export function kindOf(file) {
  const type = String(file.contentType || file.mimeType || '').toLowerCase();
  const ext = extOf(file.filename || file.name || file.url || '');
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
  if (type.includes('pdf') || ext === 'pdf') return 'pdf';
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
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
  if (ext === 'md' || type.includes('markdown')) return 'markdown';
  if (
    type.includes('javascript')
    || type.includes('typescript')
    || type.includes('json')
    || ['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'html', 'yml', 'yaml', 'toml', 'sh', 'sql'].includes(ext)
  ) return 'code';
  if (
    type.startsWith('text/')
    || ['txt', 'log', 'xml', 'htm', 'csv'].includes(ext)
  ) return 'text';
  return 'other';
}

export function sourceUrl(file) {
  return file.proxyUrl || file.url || (file.key ? `/api/attachments/${encodeURIComponent(file.key)}` : '')
    || (file.id ? `/api/recruitment/attachments/${encodeURIComponent(file.id)}` : '');
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

function KindIcon({ kind, className }) {
  if (kind === 'image') return <ImageIcon className={className} />;
  if (kind === 'audio') return <FileAudio className={className} />;
  if (kind === 'video') return <FileVideo className={className} />;
  if (kind === 'code' || kind === 'markdown') return <FileCode className={className} />;
  return <FileText className={className} />;
}

export function AttachmentPreview({ file, open, onOpenChange }) {
  const kind = kindOf(file || {});
  const url = sourceUrl(file || {});
  const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const officeUrl = useMemo(
    () => (['excel', 'ppt'].includes(kind) ? officeEmbedUrl(file?.url) : null),
    [kind, file?.url],
  );
  const needsText = ['text', 'code', 'markdown'].includes(kind);
  const needsBlob = ['image', 'pdf', 'audio', 'video'].includes(kind);

  useEffect(() => {
    if (!open || !url) return undefined;
    let cancelled = false;
    let revoke = false;
    let objectUrl = '';

    async function load() {
      setLoading(true);
      setError('');
      setText('');
      setMediaUrl('');
      try {
        if (needsText) {
          const body = await fetchAuthorizedText(url);
          if (!cancelled) setText(body);
        } else if (needsBlob) {
          const result = await fetchAuthorizedBlobUrl(url);
          if (cancelled) {
            if (result.revoke) URL.revokeObjectURL(result.blobUrl);
            return;
          }
          objectUrl = result.blobUrl;
          revoke = result.revoke;
          setMediaUrl(result.blobUrl);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || '读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (revoke && objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, url, needsText, needsBlob]);

  async function downloadAuthorized() {
    if (!url) return;
    try {
      const result = await fetchAuthorizedBlobUrl(url);
      const anchor = document.createElement('a');
      anchor.href = result.blobUrl;
      anchor.download = file.filename || file.name || 'attachment';
      anchor.click();
      if (result.revoke) setTimeout(() => URL.revokeObjectURL(result.blobUrl), 1500);
    } catch (err) {
      setError(err.message || '下载失败');
    }
  }

  if (!file) return null;
  const viewUrl = mediaUrl || (!needsBlob && !needsText ? url : '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="flex items-start gap-2 pr-8 text-base leading-snug break-all">
            <KindIcon kind={kind} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{file.filename || file.name || '附件预览'}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{kind}</Badge>
            {file.contentType || file.mimeType ? <span>{file.contentType || file.mimeType}</span> : null}
            {file.size != null ? <span>{formatSize(file.size)}</span> : null}
            {getAuthToken() ? null : <span className="text-destructive">未登录时无法预览受保护附件</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[48vh] flex-1 overflow-auto bg-muted/20 p-4">
          {!url && <p className="text-sm text-muted-foreground">没有可预览的地址</p>}
          {url && loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />正在加载附件…
            </div>
          )}
          {url && !loading && error && <p className="text-sm text-destructive">{error}</p>}
          {url && !loading && !error && kind === 'image' && viewUrl && (
            <img
              src={viewUrl}
              alt={file.filename || 'attachment'}
              className="mx-auto max-h-[70vh] max-w-full rounded-lg border object-contain"
            />
          )}
          {url && !loading && !error && kind === 'pdf' && viewUrl && (
            <iframe
              title={file.filename || 'pdf'}
              src={Number(file.page) > 0 ? `${viewUrl}#page=${Number(file.page)}` : viewUrl}
              className="h-[70vh] w-full rounded-lg border bg-background"
            />
          )}
          {url && !loading && !error && kind === 'audio' && viewUrl && (
            <div className="flex min-h-[40vh] items-center justify-center">
              <audio controls preload="metadata" src={viewUrl} className="w-full max-w-xl">
                您的浏览器不支持音频播放。
              </audio>
            </div>
          )}
          {url && !loading && !error && kind === 'video' && viewUrl && (
            <video controls preload="metadata" src={viewUrl} className="mx-auto max-h-[70vh] w-full rounded-lg border bg-black">
              您的浏览器不支持视频播放。
            </video>
          )}
          {url && !loading && !error && (kind === 'excel' || kind === 'ppt') && (
            officeUrl ? (
              <iframe title={file.filename || 'office'} src={officeUrl} className="h-[70vh] w-full rounded-lg border bg-background" />
            ) : (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>该附件暂无公网地址，无法内嵌 Office 预览。请下载后本地打开。</p>
                <Button type="button" onClick={downloadAuthorized}><Download className="size-4" />下载</Button>
              </div>
            )
          )}
          {url && !loading && !error && needsText && (
            kind === 'markdown' ? (
              <div className="rounded-lg border bg-background p-4">
                <RichMarkdown>{text}</RichMarkdown>
              </div>
            ) : (
              <ScrollArea className="h-[70vh] rounded-lg border bg-background">
                <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{text}</pre>
              </ScrollArea>
            )
          )}
          {url && !loading && !error && kind === 'other' && (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>暂不支持在线预览此类型，可下载查看。</p>
              <Button type="button" onClick={downloadAuthorized}><Download className="size-4" />下载</Button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {url ? (
            <Button variant="outline" type="button" onClick={downloadAuthorized}>
              <Download className="size-4" />下载
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

/** 邮件附件列表：支持预览（pdf/图片/文本/音视频/代码）与下载。 */
export function AttachmentList({ attachments = [], className, onPreview }) {
  const [active, setActive] = useState(null);
  if (!attachments.length) return null;

  function preview(file) {
    if (onPreview) onPreview(file);
    else setActive(file);
  }

  return (
    <div className={cn('space-y-2', className)}>
      {attachments.map((file, index) => {
        const url = sourceUrl(file);
        const kind = kindOf(file);
        return (
          <div key={file.key || file.id || `${file.filename}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <KindIcon kind={kind} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{file.filename || file.name || `附件 ${index + 1}`}</span>
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
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => preview({
                    ...file,
                    proxyUrl: file.proxyUrl || (file.id && !file.url && !file.key
                      ? undefined
                      : sourceUrl(file)),
                    url: sourceUrl(file),
                  })}>
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
      {!onPreview && active ? (
        <AttachmentPreview file={active} open={Boolean(active)} onOpenChange={(next) => { if (!next) setActive(null); }} />
      ) : null}
    </div>
  );
}
