import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { issueDesktopAuth } from './auth.js';
const matches = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * 浏览器端 PDF 渲染需要 pdf.js 自带的 CMap 表、标准字体与 worker 文件。
 * 应用自己生成的简历/发票 PDF 用的是 `/Encoding /UniGB-UCS2-H` 预定义 CMap（中文），
 * 缺了这些文件 pdf.js 会加载不出字形；而桌面端离线运行，不能依赖公网 CDN。
 * 这些文件随 `pdfjs-dist` 一起被打进运行时，这里就地以只读静态目录提供。
 */
const PDFJS_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'node_modules', 'pdfjs-dist'),
    path.join(here, '..', 'src-tauri', 'runtime', 'node_modules', 'pdfjs-dist'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'build'))) || '';
})();

export function mountDesktopHttp(app) {
  if (process.env.DAYLIGHT_DESKTOP !== '1') return;
  const token = process.env.DAYLIGHT_DESKTOP_TOKEN;
  let bootstrapped = false;
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (!/^127\.0\.0\.1:\d+$/.test(host)) return res.status(403).send('Invalid desktop host');
    const origin = req.get('origin');
    if (origin && origin !== `http://${host}`) return res.status(403).send('Invalid desktop origin');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    if (req.path === '/desktop/start' && !bootstrapped && matches(req.query.token, token)) {
      bootstrapped = true;
      res.cookie('daylight-desktop', token, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.set('Cache-Control', 'no-store');
      return res.redirect('/app');
    }
    // pdf.js 的 CMap/字体/worker 是公开的库资源，不含任何用户数据；worker 与 fetch 也不一定带 cookie。
    if (req.path.startsWith('/desktop/pdfjs/')) return next();
    // OAuth callbacks originate in the external browser; the OAuth module verifies a short-lived state.
    if (req.path === '/api/calendar-sync/oauth/callback' && req.method === 'GET') return next();
    const cookie = (req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith('daylight-desktop='))?.slice('daylight-desktop='.length);
    if (!matches(cookie, token)) return res.status(403).json({ error: '请通过 Daylight 桌面窗口访问。' });
    next();
  });
  app.get('/desktop/session', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ ...await issueDesktopAuth(), desktop: true, version: '0.1.0' });
    } catch (error) { next(error); }
  });

  if (PDFJS_DIR) {
    for (const dir of ['build', 'cmaps', 'standard_fonts', 'wasm']) {
      const target = path.join(PDFJS_DIR, dir);
      if (fs.existsSync(target)) {
        app.use(`/desktop/pdfjs/${dir}`, express.static(target, { index: false, dotfiles: 'deny', maxAge: '7d', immutable: true }));
      }
    }
  }
}
