import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button';

GlobalWorkerOptions.workerSrc = workerUrl;

// Bundle PDF.js's CJK maps, fonts and image decoders for offline/private deployments.
const resourceUrls = import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  eager: true, query: '?url', import: 'default',
});
class PdfBinaryDataFactory {
  async fetch({ kind, filename }) {
    const directory = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
    const resource = resourceUrls[`/node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!resource) throw new Error('PDF resource is unavailable');
    const response = await fetch(resource);
    if (!response.ok) throw new Error('PDF resource could not be loaded');
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Render authenticated PDF blobs even in browsers without a built-in PDF viewer. */
export default function PdfPreview({ url, page: initialPage = 1, filename = 'PDF 附件' }) {
  const [document, setDocument] = useState(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const container = useRef(null);
  const canvas = useRef(null);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setLoading(true);
    setError('');
    setZoom(1);
    const task = getDocument({ url, isEvalSupported: false,
      BinaryDataFactory: PdfBinaryDataFactory, useWorkerFetch: false });
    task.promise.then((pdf) => {
      if (cancelled) return;
      setPage(Math.max(1, Math.min(pdf.numPages, Math.trunc(Number(initialPage) || 1))));
      setDocument(pdf);
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError('无法解析这份 PDF，请下载原文件查看。');
      }
    });
    return () => {
      cancelled = true;
      task.destroy().catch(() => {});
    };
  }, [url, initialPage]);

  useEffect(() => {
    if (!document || !width) return undefined;
    let cancelled = false;
    let render;
    setLoading(true);
    setError('');
    async function draw() {
      try {
        const pdfPage = await document.getPage(page);
        if (cancelled) return;
        const original = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: Math.max(1, width - 24) / original.width * zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height));
        const target = canvas.current;
        target.width = Math.ceil(viewport.width * ratio);
        target.height = Math.ceil(viewport.height * ratio);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        render = pdfPage.render({ canvas: target, viewport,
          transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
        await render.promise;
      } catch (failure) {
        if (!cancelled && failure.name !== 'RenderingCancelledException') {
          setError('这页 PDF 无法显示，请下载原文件查看。');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    draw();
    return () => { cancelled = true; render?.cancel(); };
  }, [document, page, width, zoom]);

  return (
    <div ref={container} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="上一页" disabled={!document || page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft className="size-4" /></Button>
          <span aria-live="polite" className="min-w-20 text-center text-xs">第 {page} / {document?.numPages || '…'} 页</span>
          <Button size="icon" variant="ghost" aria-label="下一页" disabled={!document || page >= document.numPages} onClick={() => setPage((current) => current + 1)}><ChevronRight className="size-4" /></Button>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="缩小" disabled={!document || zoom <= 0.5} onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}><Minus className="size-4" /></Button>
          <span className="min-w-10 text-center text-xs">{Math.round(zoom * 100)}%</span>
          <Button size="icon" variant="ghost" aria-label="放大" disabled={!document || zoom >= 2} onClick={() => setZoom((current) => Math.min(2, current + 0.25))}><Plus className="size-4" /></Button>
        </div>
      </div>
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在渲染 PDF…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="max-h-[62vh] overflow-auto rounded-lg border bg-muted/30 p-2">
        <canvas ref={canvas} role="img" aria-label={`${filename}，第 ${page} 页`} className={`mx-auto bg-white shadow-sm ${loading || error ? 'invisible' : ''}`} />
      </div>
    </div>
  );
}
