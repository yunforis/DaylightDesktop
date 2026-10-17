import { getAuthToken } from '@/lib/auth-api';

let requestMailboxId = '';

export function getRequestMailboxId() {
  return requestMailboxId;
}

export function setRequestMailboxId(id) {
  requestMailboxId = id || '';
}

export async function request(url, method = 'GET', data) {
  const response = await fetch(`/api${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(requestMailboxId ? { 'X-Mailbox-Id': requestMailboxId } : {}),
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
  return result;
}
