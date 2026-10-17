import 'temporal-polyfill/global';
import 'katex/dist/katex.min.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { bootstrapDesktopSession } from './lib/desktop';

// [desktop patch] 先向原生壳层换取本地会话 token，再挂载 App；失败由 RequireAuth 渲染可重试错误页。
await bootstrapDesktopSession();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const boot = document.getElementById('daylight-boot');
    if (!boot) return;
    boot.dataset.done = '1';
    boot.setAttribute('aria-busy', 'false');
    window.setTimeout(() => boot.remove(), 400);
  });
});
