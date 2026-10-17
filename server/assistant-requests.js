import { createHash, randomUUID } from 'node:crypto';
import { getRequestUserId } from './request-context.js';
import { mutateAssistantState } from './assistant-state.js';
import { readSettings } from './store.js';
import { sanitizeSnapshot } from './traces.js';

const running = new Map();

/** A stream reconnect reuses the persisted result instead of rerunning tools. */
export async function runAssistantRequest({ messages, requestId, mailboxIds }, run, { onEvent } = {}) {
  const settings = readSettings();
  const mailboxId = settings.activeMailboxId;
  // 混合视图下知识检索要覆盖同样的邮箱集合；写入类工具仍然只作用于当前邮箱。
  const owned = new Set((settings.mailboxes || []).map((mailbox) => mailbox.id));
  const knowledgeScope = Array.isArray(mailboxIds)
    ? [...new Set(mailboxIds.map((id) => String(id || '').trim()).filter((id) => owned.has(id)))]
    : [];
  const id = requestId || randomUUID();
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw Object.assign(new Error('无效的小 D 请求编号。'), { status: 400 });
  const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const key = `${getRequestUserId() || 'local'}:${mailboxId}:${id}`;
  const active = running.get(key);
  if (active) {
    if (active.hash !== hash) throw Object.assign(new Error('请求编号对应的消息不同，请重新发起。'), { status: 409 });
    const result = await active.promise;
    onEvent?.({ type: 'done', ...result });
    return result;
  }
  const promise = (async () => {
    const existing = await mutateAssistantState(mailboxId, 'requests', (data) => {
      const found = data.items.find((item) => item.id === id);
      if (found) return found;
      data.items.push({ id, hash, status: 'running', createdAt: new Date().toISOString() });
      return null;
    });
    if (existing) {
      if (existing.hash !== hash) throw Object.assign(new Error('请求编号对应的消息不同，请重新发起。'), { status: 409 });
      if (existing.status === 'done') return existing.result;
      if (existing.status === 'failed') throw Object.assign(new Error(existing.error), { status: existing.httpStatus || 502 });
      throw Object.assign(new Error('此请求的执行结果尚待核对，未重复执行。请查看已保存的草稿、日程和工具记录。'), { status: 409 });
    }
    try {
      const result = await run({ messages, requestId: id }, {
        settings: structuredClone(settings),
        mailboxId,
        ...(knowledgeScope.length > 1 ? { mailboxIds: knowledgeScope } : {}),
        onEvent: (event) => {
          // Persist the final response before delivering it to either transport.
          if (event.type !== 'done') onEvent?.(event);
        },
      });
      await mutateAssistantState(mailboxId, 'requests', (data) => Object.assign(data.items.find((item) => item.id === id),
        { status: 'done', result, updatedAt: new Date().toISOString() }));
      return result;
    } catch (error) {
      const message = sanitizeSnapshot(error.message || '助手执行失败', [settings.apiKey, settings.authorizationCode, settings.feishu?.appSecret]);
      await mutateAssistantState(mailboxId, 'requests', (data) => Object.assign(data.items.find((item) => item.id === id),
        { status: 'failed', error: message, httpStatus: error.status || 502, updatedAt: new Date().toISOString() })).catch(() => {});
      throw Object.assign(new Error(message), { status: error.status || 502 });
    }
  })();
  running.set(key, { hash, promise });
  try {
    const result = await promise;
    onEvent?.({ type: 'done', ...result });
    return result;
  } finally { if (running.get(key)?.promise === promise) running.delete(key); }
}
