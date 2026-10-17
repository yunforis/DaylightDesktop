import { apiErrorMessage } from '@/lib/api-error';

const TOKEN_KEY = 'daylight-auth-token';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function authRequest(url, method = 'GET', data) {
  let response;
  try {
    response = await fetch(`/api${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch (error) {
    throw new Error(error?.message === 'Failed to fetch'
      ? '无法连接本地服务，请确认 Daylight 已启动。'
      : (error?.message || '网络请求失败，请重试。'));
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(result, '请求失败'));
  return result;
}
