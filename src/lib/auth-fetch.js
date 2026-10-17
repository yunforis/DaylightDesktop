import { getAuthToken } from '@/lib/auth-api';
import { getRequestMailboxId } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';

/** 带登录态与邮箱头的 fetch（iframe/img 无法带 Authorization，需先拉 blob）。 */
export async function authFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  const mailboxId = getRequestMailboxId();
  if (mailboxId && !headers.has('X-Mailbox-Id')) headers.set('X-Mailbox-Id', mailboxId);
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    throw new Error(error?.message === 'Failed to fetch'
      ? '无法连接本地服务，请确认 Daylight 已启动。'
      : (error?.message || '网络请求失败，请重试。'));
  }
  return response;
}

/** 拉取受保护附件为 blob URL；调用方负责 revoke。 */
export async function fetchAuthorizedBlobUrl(url) {
  if (!url) throw new Error('没有可预览的地址');
  // 外链公网资源不必带本地登录态
  if (/^https?:\/\//i.test(url) && !url.includes(window.location.host)) {
    return { blobUrl: url, revoke: false, contentType: '' };
  }
  const response = await authFetch(url);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let result = {};
    try { result = await response.json(); } catch { /* binary or empty */ }
    throw new Error(apiErrorMessage(result, `无法读取附件（HTTP ${response.status}）`));
  }
  // 误把 JSON 错误当 PDF
  if (contentType.includes('application/json')) {
    const result = await response.json().catch(() => ({}));
    throw new Error(apiErrorMessage(result, '附件接口返回了错误信息'));
  }
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, revoke: true, contentType: blob.type || contentType };
}

export async function fetchAuthorizedText(url, maxChars = 400_000) {
  const response = await authFetch(url);
  if (!response.ok) {
    let result = {};
    try { result = await response.json(); } catch { /* ignore */ }
    throw new Error(apiErrorMessage(result, `无法读取附件（HTTP ${response.status}）`));
  }
  const body = await response.text();
  return body.slice(0, maxChars);
}
