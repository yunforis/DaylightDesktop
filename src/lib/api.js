import { getAuthToken } from '@/lib/auth-api';
import { apiErrorMessage } from '@/lib/api-error';

let requestMailboxId = '';

export function getRequestMailboxId() {
  return requestMailboxId;
}

export function setRequestMailboxId(id) {
  requestMailboxId = id || '';
}

export { apiErrorMessage };

export async function request(url, method = 'GET', data, options = {}) {
  const mailboxId = options.mailboxId ?? requestMailboxId;
  let response;
  try {
    response = await fetch(`/api${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}),
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch (error) {
    throw new Error(error?.message === 'Failed to fetch'
      ? '无法连接本地服务，请确认 Daylight 已启动。'
      : (error?.message || '网络请求失败，请重试。'));
  }
  const text = await response.text();
  let result = {};
  if (text) {
    try { result = JSON.parse(text); }
    catch {
      throw new Error(response.ok
        ? '服务器返回了无法解析的内容。'
        : `请求失败（HTTP ${response.status}），请重试。`);
    }
  }
  if (!response.ok) {
    const error = new Error(apiErrorMessage(result, `请求失败（HTTP ${response.status}），请重试。`));
    error.status = response.status;
    throw error;
  }
  return result;
}
