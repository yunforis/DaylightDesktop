import 'temporal-polyfill/global';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { setAuthToken } from './lib/auth-api';
import { installDesktopLinks } from './lib/desktop';

try {
  const response = await fetch('/desktop/session');
  if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
    const session = await response.json();
    window.__DAYLIGHT_DESKTOP__ = session.desktop;
    if (session.desktop) { setAuthToken(session.token); installDesktopLinks(); }
  }
} catch { /* The existing error page handles unavailable services. */ }

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
