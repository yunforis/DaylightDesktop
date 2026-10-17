import { sanitizeSnapshot, usageMetrics } from './traces.js';

export function parseModelJson(content) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Some compatible endpoints put literal newlines in JSON string values.
  // Escape only those controls; do not guess missing fields or repair invalid actions.
  let quoted = false, escaped = false, normalized = '';
  for (const character of text) {
    if (quoted && character.charCodeAt(0) < 32) {
      normalized += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    normalized += character;
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return JSON.parse(normalized);
}

// The application tool loop uses the JSON capability already required by Daylight.
// Only metadata is logged: application data and private model reasoning stay out of traces.
export async function callJsonModel(settings, messages, { context, label = '模型处理', timeoutMs = 60_000, repairJson = true } = {}) {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) throw new Error('请先配置模型接口、API Key 和模型名称。');
  const base = settings.baseUrl.trim().replace(/\/+$/, '');
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const request = { model: settings.model, messages, response_format: { type: 'json_object' } };
  if (new URL(endpoint).hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model)) request.thinking = { type: 'disabled' };
  const tool = { name: 'llm.chat_completions', arguments: { endpoint, model: settings.model, message_count: messages.length,
    input_characters: messages.reduce((sum, message) => sum + String(message.content).length, 0), timeout_ms: timeoutMs }, result_summary: null };
  const span = context?.startSpan('model', label, { llm_request: true, cost_cny: null, cost_status: 'usage_missing',
    thought: '将当前业务所需资料交给配置的模型，返回结构化结果；日志只记录调用元数据。', tool_calls: [tool] });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify(request), signal });
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    tool.result_summary = { http_status: response.status, finish_reason: result.choices?.[0]?.finish_reason || null, output_characters: content.length };
    if (span) context.updateSpan(span, { ...usageMetrics(result.usage, settings), tool_calls: [tool] });
    if (!response.ok) throw new Error(`模型请求失败：${result.error?.message || response.status}`);
    let parsed;
    try { parsed = parseModelJson(content); }
    catch (error) {
      if (span) context.finishSpan(span, { status: 'failed', error: '模型输出不是完整的 JSON 对象。', observation: repairJson ? '请求模型修正一次 JSON 格式，尚未执行任何业务工具。' : 'JSON 格式修正失败，可重试。' });
      if (repairJson) return callJsonModel(settings, [...messages,
        { role: 'assistant', content }, { role: 'user', content: '上一条输出不是有效JSON。请仅修正格式，返回完整JSON对象，字符串内换行必须转义，不要额外说明；不要重复或编造已经完成的工具操作。' }],
      { context, label: `${label} · 修正 JSON 格式`, timeoutMs, repairJson: false });
      throw new Error('模型输出不是完整的 JSON 对象，请重试。');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('模型未返回 JSON 对象。');
    if (span) context.finishSpan(span, { observation: '已收到结构化结果，交由业务工具核对并处理。', output_snapshot: { fields: Object.keys(parsed) } });
    return parsed;
  } catch (error) {
    const detail = error.message === 'fetch failed' ? '模型接口连接失败，请检查网络或接口地址后重试。' : error.message;
    const message = sanitizeSnapshot(signal.aborted ? `模型请求超过 ${timeoutMs / 1000} 秒，请重试。` : detail,
      [settings.apiKey, settings.authorizationCode, settings.feishu?.appSecret]);
    if (span) context.finishSpan(span, { status: 'failed', error: message, observation: message });
    throw new Error(message);
  }
}
