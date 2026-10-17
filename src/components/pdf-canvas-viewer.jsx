import React, { useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * [desktop patch] 跨平台 PDF 查看器（pdfjs 自渲染）。
 *
 * 桌面端不能把 PDF 直接交给 WebView：macOS(WKWebView) 与 Windows(WebView2) 的内置查看器
 * 行为不一致，Linux 的 WebKitGTK 大多没有 PDF 插件（点开一片空白）。这里用 pdfjs-dist 自己
 * 渲染成 canvas，三个平台表现一致，完全离线，不依赖任何外部服务。
 *
 * Web 端仍保留浏览器原生查看器（滚动、搜索、打印体验更好）。
 */
const MAX_PAGES = 40;
/** 后端就地提供的 pdf.js 资源（CMap / 标准字体 / worker），随安装包分发、离线可用。 */
const PDFJS_BASE = '/desktop/pdfjs';
/** 单页渲染超时（仅在窗口可见时计时）。 */
const PAGE_TIMEOUT_MS = 20_000;

/**
 * pdf.js 的绘制循环由 requestAnimationFrame 驱动：窗口被隐藏（最小化 / 切到后台）时
 * 浏览器不再派发帧回调，渲染会原地停住，但这不是失败。所以超时只在窗口可见时计时，
 * 窗口重新可见后重新开始计时。
 */
function renderWithWatchdog(renderTask, pageNumber) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const detach = () => {
      clearTimer();
      document.removeEventListener('visibilitychange', arm);
    };
    function arm() {
      clearTimer();
      if (document.visibilityState === 'visible') {
        timer = setTimeout(() => {
          try { renderTask.cancel(); } catch { /* 已经结束 */ }
          reject(new Error(`第 ${pageNumber} 页渲染超时`));
        }, PAGE_TIMEOUT_MS);
      }
    }
    arm();
    document.addEventListener('visibilitychange', arm);
    renderTask.promise.then(
      (value) => { detach(); resolve(value); },
      (error) => { detach(); reject(error); },
    );
  });
}

export function PdfCanvasViewer({ src, page = 0, className }) {
  const hostRef = useRef(null);
  const [scale, setScale] = useState(1.25);
  const [state, setState] = useState({ loading: true, error: '', pages: 0, rendered: 0, truncated: false });

  useEffect(() => {
    if (!src) return undefined;
    let cancelled = false;
    let task = null;

    async function render() {
      setState({ loading: true, error: '', pages: 0, rendered: 0, truncated: false });
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
        const response = await fetch(src);
        const data = await response.arrayBuffer();
        if (cancelled) return;
        task = pdfjs.getDocument({
          data,
          // 应用生成的简历/发票 PDF 使用 /Encoding /UniGB-UCS2-H 预定义 CMap（中文），
          // 必须提供 cMapUrl，否则中文字形取不到。
          cMapUrl: `${PDFJS_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
          wasmUrl: `${PDFJS_BASE}/wasm/`,
          // 桌面端 CSP 不含 'unsafe-eval'，pdf.js 的 eval 优化路径会直接抛错，关掉。
          isEvalSupported: false,
        });
        const pdf = await task.promise;
        if (cancelled) { pdf.destroy(); return; }
        const total = pdf.numPages;
        setState({ loading: false, error: '', pages: total, rendered: 0, truncated: total > MAX_PAGES });
        const host = hostRef.current;
        if (!host) return;
        host.replaceChildren();
        const last = Math.min(total, MAX_PAGES);
        for (let index = 1; index <= last; index += 1) {
          const pdfPage = await pdf.getPage(index);
          if (cancelled) return;
          const viewport = pdfPage.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = 'mx-auto mb-3 block h-auto max-w-full rounded-lg border bg-white shadow-sm';
          canvas.setAttribute('data-page', String(index));
          await renderWithWatchdog(pdfPage.render({ canvas, viewport }), index);
          if (cancelled) return;
          host.appendChild(canvas);
          setState((previous) => ({ ...previous, rendered: index }));
        }
      } catch (error) {
        if (!cancelled) {
          setState({ loading: false, error: error?.message || 'PDF 渲染失败', pages: 0, rendered: 0, truncated: false });
        }
      }
    }

    render();
    return () => {
      cancelled = true;
      try { task?.destroy(); } catch { /* 已经结束 */ }
    };
  }, [src, scale]);

  // 从邮件正文跳转过来时（例如“第 3 页”），滚动到指定页。
  useEffect(() => {
    if (!page || state.rendered < page) return;
    hostRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
  }, [page, state.rendered]);

  const step = (delta) => setScale((value) => Math.min(3, Math.max(0.5, Number((value + delta).toFixed(2)))));

  return (
    <div className={cn('flex h-[70vh] flex-col overflow-hidden rounded-lg border bg-muted/30', className)}>
      <div className="flex items-center gap-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
        <FileText className="size-3.5 shrink-0" />
        {state.loading ? <span>正在渲染 PDF…</span> : null}
        {!state.loading && !state.error ? (
          <span>共 {state.pages} 页{state.truncated ? `（仅显示前 ${MAX_PAGES} 页）` : ''}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-7" onClick={() => step(-0.25)} aria-label="缩小">
            <Minus className="size-3.5" />
          </Button>
          <span className="w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <Button size="icon" variant="ghost" className="size-7" onClick={() => step(0.25)} aria-label="放大">
            <Plus className="size-3.5" />
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.loading && !state.error ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />正在渲染 PDF…
          </div>
        ) : null}
        <div ref={hostRef} className={cn(state.error && 'hidden')} />
      </div>
    </div>
  );
}
