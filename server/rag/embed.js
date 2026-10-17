import { modelFetch } from '../model-fetch.js';
import { sanitizeSnapshot, usageMetrics } from '../traces.js';
import { createHash } from 'node:crypto';

/**
 * 供应商只给模型 id、不给能力标签，所以先按「中文与多语种检索质量」排序，再退回任何含 embed 的 id。
 * 排序覆盖优云智算/OpenAI 常见的 embedding 模型；都不在时仍能自动挑到，避免用户手动填。
 */
const EMBEDDING_PREFERENCE = [
  'qwen3-embedding-8b', 'qwen3-embedding-4b', 'qwen3-embedding-0.6b',
  'bge-m3', 'baai/bge-m3', 'baai/bge-large-zh-v1.5',
  'text-embedding-3-large', 'text-embedding-3-small',
  'gemini-embedding-2', 'text-embedding-ada-002',
];

export function pickEmbeddingModel(ids = []) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!list.length) return null;
  const lower = new Map(list.map((id) => [id.toLowerCase(), id]));
  for (const want of EMBEDDING_PREFERENCE) {
    const hit = lower.get(want);
    if (hit) return hit;
  }
  return list.find((id) => /embed/i.test(id) && !/rerank/i.test(id)) || null;
}

const modelCache = new Map();
const MODEL_TTL_MS = 10 * 60 * 1000;

const cacheKey = (settings) => `${String(settings?.baseUrl || '').trim().replace(/\/+$/, '')}::`
  + createHash('sha256').update(String(settings?.apiKey || '')).digest('hex').slice(0, 12);

/**
 * 列出供应商模型：只读列表接口，不计模型调用。失败会把空结果缓存一小会儿，
 * 避免每次入库都重试一遍。缓存键只含密钥摘要，不保存密钥本身。
 */
export async function listProviderModels(settings) {
  const base = String(settings?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base || !settings?.apiKey) return [];
  const key = cacheKey(settings);
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.models;
  let models = [];
  try {
    const response = await modelFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    models = (Array.isArray(body?.data) ? body.data : [])
      .map((item) => String(item?.id || '').trim()).filter(Boolean);
  } catch { models = []; }
  modelCache.set(key, { at: Date.now(), models });
  return models;
}

/** 填了就用手填的；没填就从供应商模型里自动挑一个，结果缓存。挑不到返回 null（退回关键词）。 */
export async function resolveEmbeddingModel(settings) {
  const configured = String(settings?.embeddingModel || '').trim();
  if (configured) return configured;
  return pickEmbeddingModel(await listProviderModels(settings));
}

// 供应商对 embedding 会限流（429/5xx/网络抖动），一次失败就静默退回关键词会让检索质量
// 时好时坏，且只体现在 /api/rag/status 的 embeddedCount 上。这里做有上限的退避重试：
// 优先遵守 Retry-After，其次指数退避；永久性错误（非限流的 4xx）不重试，重试耗尽后
// 仍退回关键词，不阻断同步。
const EMBED_MAX_ATTEMPTS = 4;
const EMBED_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const EMBED_MAX_BACKOFF_MS = 5000;

function embedRetryDelayMs(attempt) {
  return Math.min(3000, 400 * (2 ** (attempt - 1)));
}

function retryAfterMs(response) {
  const seconds = Number(response?.headers?.get?.('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(EMBED_MAX_BACKOFF_MS, Math.round(seconds * 1000));
}

/** OpenAI 兼容 embeddings；失败、未配置或找不到可用模型时返回 null（检索退回关键词）。 */
export async function embedTexts(settings, texts, { context, label = 'RAG embedding' } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item || '').slice(0, 8000));
  if (!list.length || list.every((item) => !item.trim())) return list.map(() => null);
  if (!settings?.baseUrl || !settings?.apiKey) return list.map(() => null);
  const model = await resolveEmbeddingModel(settings);
  if (!model) return list.map(() => null);

  const base = String(settings.baseUrl).trim().replace(/\/+$/, '');
  const endpoint = base.endsWith('/embeddings')
    ? base
    : `${base.replace(/\/chat\/completions$/, '')}/embeddings`;
  const tool = {
    name: 'llm.embeddings',
    arguments: { endpoint, model, count: list.length },
    result_summary: null,
  };
  const span = context?.startSpan('rag_embed', label, {
    llm_request: true,
    thought: '把文本分块转为向量，供后续检索；失败时仍可用关键词检索。',
    tool_calls: [tool],
  });


  let lastError = null;
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt += 1) {
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
      tool.result_summary = { http_status: response.status, attempt };
      if (span) context.updateSpan(span, { ...usageMetrics(body.usage, settings), tool_calls: [tool] });
      if (!response.ok) {
        const error = new Error(body.error?.message || `embedding HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response);
        throw error;
      }
      const data = Array.isArray(body.data) ? body.data : [];
      const vectors = list.map((_, index) => {
        const hit = data.find((item) => item.index === index) || data[index];
        return Array.isArray(hit?.embedding) ? hit.embedding : null;
      });
      if (span) {
        context.finishSpan(span, {
          observation: vectors.some(Boolean) ? '向量已生成' : '接口未返回向量，将使用关键词检索',
          output_snapshot: { vectors: vectors.filter(Boolean).length, attempt },
        });
      }
      return vectors;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status) || 0;
      const transient = !status || EMBED_RETRY_STATUSES.has(status);
      if (attempt >= EMBED_MAX_ATTEMPTS || !transient) break;
      const wait = Math.max(Number(error?.retryAfterMs) || 0, embedRetryDelayMs(attempt));
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    }
  }
  const message = sanitizeSnapshot(lastError?.message || 'unknown', [settings.apiKey]);
  if (span) context.finishSpan(span, { status: 'failed', error: message, observation: 'embedding 失败，回退关键词检索' });
  return list.map(() => null);
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
