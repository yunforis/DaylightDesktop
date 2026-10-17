/** 把接口里的 error 字段收成可读字符串，避免 Boolean true 变成红色 toast「true」。 */
export function apiErrorMessage(result, fallback = '请求失败，请重试。') {
  const err = result?.error;
  if (typeof err === 'string' && err.trim() && err !== 'true' && err !== 'false') return err.trim();
  if (err && typeof err === 'object') {
    const nested = err.message || err.msg || err.detail;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  if (typeof result?.message === 'string' && result.message.trim()) return result.message.trim();
  return fallback;
}
