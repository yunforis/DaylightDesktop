import { getAuthToken } from '@/lib/auth-api';
import { getRequestMailboxId } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';

function friendlyAssistantError(message) {
  const raw = String(message || '').trim();
  if (/upstream stream ended abnormally|reason=eof|stream ended/i.test(raw)) {
    return '模型中转在返回途中断开了。请确认本地代理在线，或在设置里做连通性测试。';
  }
  return raw || '小 D 暂时无法回答，请稍后再试。';
}

function isAborted(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

/**
 * SSE 中断时以同一个 requestId 取回服务端执行结果。
 * 一个调用的邮箱、认证及请求 ID 均固定，避免回退时重复执行工具或串到新邮箱。
 */
export async function streamAssistantChat(messages, {
  onEvent,
  signal,
  mailboxId = getRequestMailboxId(),
  requestId = globalThis.crypto?.randomUUID?.() || `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
} = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const call = (stream) => fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { ...headers, Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify({ messages, stream, requestId }),
    signal,
  });

  async function readJson(response) {
    let result = {};
    try { result = await response.json(); } catch (error) {
      if (isAborted(error, signal)) throw error;
      if (response.ok) throw new Error('服务器返回了无法解析的结果。请刷新邮件审核记录核对执行状态。');
    }
    if (!response.ok) throw new Error(friendlyAssistantError(apiErrorMessage(result, `请求失败（HTTP ${response.status}）`)));
    onEvent?.({ ...result, type: 'done' });
    return result;
  }

  async function recover(message, originalError) {
    if (isAborted(originalError, signal)) throw originalError || signal.reason || new DOMException('Aborted', 'AbortError');
    onEvent?.({ type: 'status', message });
    try {
      return await readJson(await call(false));
    } catch (error) {
      if (isAborted(error, signal)) throw error;
      throw new Error(friendlyAssistantError(error.message || originalError?.message));
    }
  }

  let response;
  try {
    response = await call(true);
  } catch (error) {
    return recover('正在恢复本次请求的执行结果…', error);
  }

  if (!response.ok) {
    // 权限、配置、请求冲突等明确错误由用户处理，不另起一次执行。
    if (response.status < 500) return readJson(response);
    return recover('服务连接异常，正在取回本次请求结果…');
  }
  if (!response.body || response.headers.get('content-type')?.includes('application/json')) return readJson(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  function consume(chunk) {
    const data = chunk.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'error') throw new Error(friendlyAssistantError(event.message));
    onEvent?.(event);
    if (event.type === 'done') finalResult = event;
  }

  try {
    while (!finalResult) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || '';
      for (const chunk of chunks) consume(chunk);
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
  } catch (error) {
    if (finalResult) return finalResult;
    return recover('连接中断，正在取回本次请求结果…', error);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!finalResult) return recover('正在取回本次请求的完整结果…');
  return finalResult;
}
