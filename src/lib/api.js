import { getAuthToken } from '@/lib/auth-api';
import { apiErrorMessage } from '@/lib/api-error';

let requestMailboxId = '';
let requestScopeParams = null;

export function getRequestMailboxId() {
  return requestMailboxId;
}

export function setRequestMailboxId(id) {
  requestMailboxId = id || '';
}

export function getRequestScope() {
  return requestScopeParams;
}

/**
 * 当前视图范围（scope=all / tag=）。列表在混合视图里显示多个邮箱的记录，
 * 单条记录的读写也必须落在同一范围里，否则会出现「列表里有、一点就说日程不存在」。
 */
export function setRequestScope(params) {
  requestScopeParams = params && (params.scope || params.tag) ? { ...params } : null;
}

/** 把当前视图范围拼到接口地址上；地址里已经带了 scope / tag 时保持原样（避免 scope=all 盖掉 tag=）。 */
export function withViewScope(url, params = requestScopeParams) {
  if (!params) return url;
  const keys = Object.keys(params).filter((key) => params[key]);
  if (!keys.length || /[?&](scope|tag)=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(
    keys.map((key) => [key, params[key]]),
  ).toString()}`;
}

export { apiErrorMessage };

export async function request(url, method = 'GET', data, options = {}) {
  const mailboxId = options.mailboxId ?? requestMailboxId;
  const target = options.scope === false ? url : withViewScope(url, options.scope ?? requestScopeParams);
  let response;
  try {
    response = await fetch(`/api${target}`, {
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
