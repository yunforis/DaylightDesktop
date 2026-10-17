export const isDesktop = () => Boolean(window.__DAYLIGHT_DESKTOP__);

export function installDesktopLinks() {
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
