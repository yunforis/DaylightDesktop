import { modelFetch } from '../model-fetch.js';
import { sanitizeSnapshot, usageMetrics } from '../traces.js';

/** OpenAI 兼容 embeddings；失败或未配置时返回 null（检索退回关键词）。 */
export async function embedTexts(settings, texts, { context, label = 'RAG embedding' } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item || '').slice(0, 8000));
  if (!list.length || list.every((item) => !item.trim())) return list.map(() => null);
  if (!settings?.baseUrl || !settings?.apiKey) return list.map(() => null);

  const base = String(settings.baseUrl).trim().replace(/\/+$/, '');
  const endpoint = base.endsWith('/embeddings')
    ? base
    : `${base.replace(/\/chat\/completions$/, '')}/embeddings`;
  const model = settings.embeddingModel || settings.model || 'text-embedding-3-small';
  const tool = {
    name: 'llm.embeddings',
    arguments: { endpoint, model, count: list.length },
    result_summary: null,
  };
  const span = context?.startSpan('rag_embed', label, {
    llm_request: true,
    thought: '将简历分块转为向量，供后续检索；失败时仍可用关键词检索。',
    tool_calls: [tool],
  });

  try {
    const response = await modelFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, input: list.length === 1 ? list[0] : list }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    tool.result_summary = { http_status: response.status };
    if (span) context.updateSpan(span, { ...usageMetrics(body.usage, settings), tool_calls: [tool] });
    if (!response.ok) {
      throw new Error(body.error?.message || `embedding HTTP ${response.status}`);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    const vectors = list.map((_, index) => {
      const hit = data.find((item) => item.index === index) || data[index];
      return Array.isArray(hit?.embedding) ? hit.embedding : null;
    });
    if (span) {
      context.finishSpan(span, {
        observation: vectors.some(Boolean) ? '向量已生成' : '接口未返回向量，将使用关键词检索',
        output_snapshot: { vectors: vectors.filter(Boolean).length },
      });
    }
    return vectors;
  } catch (error) {
    const message = sanitizeSnapshot(error.message, [settings.apiKey]);
    if (span) context.finishSpan(span, { status: 'failed', error: message, observation: 'embedding 失败，回退关键词检索' });
    return list.map(() => null);
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
