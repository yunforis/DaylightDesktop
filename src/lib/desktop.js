import { setAuthToken } from './auth-api';

export const isDesktop = () => Boolean(window.__DAYLIGHT_DESKTOP__);

let linksInstalled = false;

export function installDesktopLinks() {
  if (linksInstalled) return;
  linksInstalled = true;
  // External links use the system browser; internal PDFs use our cross-platform viewer.
  document.addEventListener('click', async event => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || event.defaultPrevented || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin === location.origin) {
      if (anchor.target === '_blank') {
        event.preventDefault();
        if (/\/api\/(recruitment\/attachments|attachments)\//.test(url.pathname)) {
          window.dispatchEvent(new CustomEvent('daylight:attachment', { detail: { url: url.href, filename: anchor.textContent || '附件' } }));
        } else location.assign(url.href);
      }
      return;
    }
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      event.preventDefault();
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url.href);
    }
  });
}

/**
 * 通过原生壳层注入的一次性桌面会话换取后台 token。
 *
 * 这是桌面端唯一的鉴权入口：本地后台只监听 127.0.0.1，且要求壳层下发的 cookie，
 * 因此没有登录页。App 启动与重试都会调用它。
 *
 * @returns {Promise<boolean>} 是否拿到可用 token
 */
export async function bootstrapDesktopSession() {
  try {
    const response = await fetch('/desktop/session', { headers: { Accept: 'application/json' } });
    if (!response.ok) return false;
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    const session = await response.json();
    if (!session?.desktop || !session.token) return false;
    window.__DAYLIGHT_DESKTOP__ = session.desktop;
    setAuthToken(session.token);
    installDesktopLinks();
    return true;
  } catch {
    return false;
  }
}
