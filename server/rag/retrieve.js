import { listChunks } from './store.js';
import { cosineSimilarity, embedTexts } from './embed.js';
import { isRagEmbeddings } from './flags.js';
import { parseMailRef } from '../../shared/mail-ref.js';

// Reciprocal Rank Fusion 的平滑常数（Cormack et al. 2009 的 k=60）。RRF 只用名次、
// 不用原始分，天然不受「关键词覆盖率」与「余弦相似度」量纲不同的影响。
const RRF_K = 60;
// MMR 里相关性相对多样性的权重：0.72 表示宁可多给一点相关性，也要避免同一封邮件刷屏。
const MMR_LAMBDA = 0.72;
// 纯向量命中的最低余弦相似度，低于它视为噪声不进候选。
const MIN_VECTOR_SIMILARITY = 0.05;
const MAX_RESULTS = 20;

function tokenize(query) {
  const rough = String(query || '')
    .toLowerCase()
    .split(/[\s,，、;；。！？!?.|/\\]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const tokens = [];
  for (const item of rough) {
    if (/[\u4e00-\u9fff]/.test(item) && item.length > 4) {
      for (let index = 0; index < item.length - 1; index += 1) tokens.push(item.slice(index, index + 2));
    } else tokens.push(item);
  }
  return [...new Set(tokens)].slice(0, 32);
}

function keywordScore(content, tokens) {
  if (!tokens.length) return 0;
  const text = String(content || '').toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

/**
 * 证据片段以命中词为中心截取，用户先看到相关的那一句，而不是正文开头几行。
 * 关键词模式用命中词定位；没有命中词（纯向量命中）时退回开头。
 */
export function focusQuote(content, tokens = [], size = 280) {
  const text = String(content || '').trim();
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  let best = -1;
  let bestToken = '';
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at >= 0 && (best < 0 || at < best)) { best = at; bestToken = token; }
  }
  if (best < 0) return `${text.slice(0, size).trim()}…`;
  const start = Math.max(0, best - Math.floor(size * 0.35));
  const end = Math.min(text.length, start + size);
  void bestToken;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * 两个片段之间的冗余度（0..1），供 MMR 去重使用。同一个片段/附件完全重复；
 * 同一封邮件的不同片段高度冗余；跨来源优先用向量余弦衡量语义重复。
 */
export function redundancyBetween(a, b) {
  if (a.id === b.id) return 1;
  if (a.attachmentId && a.attachmentId === b.attachmentId) return 1;
  const keyOf = (chunk) => chunk.emailId || chunk.attachmentId || chunk.id;
  if (keyOf(a) === keyOf(b)) return 0.8;
  if (Array.isArray(a.embedding) && Array.isArray(b.embedding) && a.embedding.length && b.embedding.length) {
    return Math.max(0, Math.min(1, cosineSimilarity(a.embedding, b.embedding)));
  }
  return 0;
}

function toCitation(chunk, score, mode, tokens = []) {
  const ref = parseMailRef(chunk.attachmentId);
  return {
    chunkId: chunk.id,
    candidateId: chunk.candidateId || null,
    mailboxId: chunk.mailboxId || null,
    attachmentId: chunk.attachmentId,
    emailId: chunk.emailId || ref.emailId || null,
    source: chunk.source || ref.source,
    filename: chunk.filename || '',
    page: chunk.page,
    quote: focusQuote(chunk.content, tokens, 280),
    score: Number(score.toFixed(4)),
    mode,
  };
}

/**
 * 混合检索：mailbox 硬隔离 → 可选 candidateIds 过滤 → 关键词 + 向量两路召回，
 * 用 RRF 融合排名（尺度无关），再用 MMR 兼顾相关性与去冗余排出最终证据。
 *
 * 相关性用 RRF 融合分（归一到 0..1）；多样性对同一封邮件/附件或语义高度重复的片段
 * 施加冗余惩罚，从而避免一封长邮件挤满证据列表，同时不会像硬性配额那样在确实只有
 * 一封相关邮件时丢信息。
 */
function normalizeScope({ mailboxId, mailboxIds }) {
  const list = Array.isArray(mailboxIds) && mailboxIds.length ? mailboxIds : [mailboxId];
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))];
}

export async function ragSearch({
  mailboxId,
  mailboxIds,
  query,
  settings,
  candidateIds,
  limit = 6,
  context,
} = {}) {
  // 混合视图下要对多个邮箱一起检索：召回池合并后再做一次 RRF+MMR，
  // 而不是每个邮箱各排一次再拼起来，避免「某个邮箱恰好排在前面」把别的邮箱挤掉。
  const scope = normalizeScope({ mailboxId, mailboxIds });
  if (!scope.length) throw new Error('缺少 mailboxId，无法检索。');
  const q = String(query || '').trim();
  if (!q) return { hits: [], citations: [], mode: 'empty' };

  const loaded = await Promise.all(scope.map((id) => listChunks(id)));
  let chunks = loaded.flat();
  if (Array.isArray(candidateIds) && candidateIds.length) {
    const allow = new Set(candidateIds.map(String));
    chunks = chunks.filter((item) => allow.has(String(item.candidateId || '')));
  }
  // 二次隔离：绝不返回范围外邮箱的块（文件/库路径已按 mailbox 分，这里再保险）
  const allowMailbox = new Set(scope);
  chunks = chunks.filter((item) => !item.mailboxId || allowMailbox.has(item.mailboxId));

  if (!chunks.length) {
    return { hits: [], citations: [], mode: 'empty_index' };
  }

  const tokens = tokenize(q);
  let queryVector = null;
  let mode = 'keyword';
  if (isRagEmbeddings(settings) && settings?.baseUrl && settings?.apiKey) {
    const [vector] = await embedTexts(settings, [q], { context, label: 'RAG 查询向量' });
    if (vector) {
      queryVector = vector;
      mode = 'hybrid';
    }
  }

  // 两路召回各自的信号：关键词覆盖率与向量余弦相似度。
  const candidates = chunks.map((chunk) => {
    const kw = keywordScore(chunk.content, tokens);
    const vec = queryVector && Array.isArray(chunk.embedding) && chunk.embedding.length
      ? cosineSimilarity(queryVector, chunk.embedding)
      : 0;
    return { chunk, kw, vec };
  }).filter((row) => row.kw > 0 || row.vec > MIN_VECTOR_SIMILARITY);

  if (!candidates.length) {
    return { hits: [], citations: [], mode, totalIndexed: chunks.length };
  }

  // RRF：把两路排名换算成名次分再相加，避免不同量纲直接加权。
  const keywordRanked = [...candidates]
    .filter((row) => row.kw > 0)
    .sort((a, b) => b.kw - a.kw || b.vec - a.vec || a.chunk.page - b.chunk.page);
  const vectorRanked = [...candidates]
    .filter((row) => row.vec > 0)
    .sort((a, b) => b.vec - a.vec || b.kw - a.kw || a.chunk.page - b.chunk.page);

  const fused = new Map();
  const addRanking = (rows) => {
    rows.forEach((row, index) => {
      fused.set(row, (fused.get(row) || 0) + 1 / (RRF_K + index + 1));
    });
  };
  addRanking(keywordRanked);
  // 融合分的理论上限：理想情况下一个片段在两路里都排第一。
  let maxFused = 1 / (RRF_K + 1);
  if (mode === 'hybrid') {
    addRanking(vectorRanked);
    maxFused += 1 / (RRF_K + 1);
  }
  for (const row of candidates) row.score = Math.min(1, (fused.get(row) || 0) / maxFused);

  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page);

  // MMR：每轮挑「相关性 − 冗余度」最高的片段，既按相关性排序，又避免同源刷屏。
  const target = Math.min(MAX_RESULTS, Math.max(1, Number(limit) || 6));
  const pool = [...ranked];
  const picked = [];
  while (picked.length < target && pool.length) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const row = pool[index];
      let maxRedundancy = 0;
      for (const chosen of picked) {
        maxRedundancy = Math.max(maxRedundancy, redundancyBetween(row.chunk, chosen.chunk));
      }
      const value = (MMR_LAMBDA * row.score) - ((1 - MMR_LAMBDA) * maxRedundancy);
      if (value > bestValue) { bestValue = value; bestIndex = index; }
    }
    picked.push(pool.splice(bestIndex, 1)[0]);
  }

  const citations = picked.map((row) => toCitation(row.chunk, row.score, mode, tokens));
  return {
    hits: picked.map((row) => ({
      ...toCitation(row.chunk, row.score, mode, tokens),
      content: row.chunk.content,
    })),
    citations,
    mode,
    totalIndexed: chunks.length,
  };
}
