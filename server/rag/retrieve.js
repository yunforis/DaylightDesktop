import { listChunks } from './store.js';
import { cosineSimilarity, embedTexts } from './embed.js';
import { parseMailRef } from './mail-ref.js';

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

function toCitation(chunk, score, mode) {
  const ref = parseMailRef(chunk.attachmentId);
  return {
    chunkId: chunk.id,
    candidateId: chunk.candidateId || null,
    attachmentId: chunk.attachmentId,
    emailId: chunk.emailId || ref.emailId || null,
    source: chunk.source || ref.source,
    filename: chunk.filename || '',
    page: chunk.page,
    quote: String(chunk.content || '').slice(0, 280),
    score: Number(score.toFixed(4)),
    mode,
  };
}

/**
 * 混合检索：mailbox 硬隔离 → 可选 candidateIds 过滤 → 关键词 + 向量（有则加权）。
 */
export async function ragSearch({
  mailboxId,
  query,
  settings,
  candidateIds,
  limit = 6,
  context,
} = {}) {
  if (!mailboxId) throw new Error('缺少 mailboxId，无法检索。');
  const q = String(query || '').trim();
  if (!q) return { hits: [], citations: [], mode: 'empty' };

  let chunks = await listChunks(mailboxId);
  if (Array.isArray(candidateIds) && candidateIds.length) {
    const allow = new Set(candidateIds.map(String));
    chunks = chunks.filter((item) => allow.has(String(item.candidateId || '')));
  }
  // 二次隔离：绝不返回其他邮箱的块（文件/库路径已按 mailbox 分，这里再保险）
  chunks = chunks.filter((item) => item.mailboxId === mailboxId || !item.mailboxId);

  if (!chunks.length) {
    return { hits: [], citations: [], mode: 'empty_index' };
  }

  const tokens = tokenize(q);
  let queryVector = null;
  let mode = 'keyword';
  if (settings?.ragEmbeddings === true && settings?.baseUrl && settings?.apiKey) {
    const [vector] = await embedTexts(settings, [q], { context, label: 'RAG 查询向量' });
    if (vector) {
      queryVector = vector;
      mode = 'hybrid';
    }
  }

  const ranked = chunks.map((chunk) => {
    const kw = keywordScore(chunk.content, tokens);
    const vec = queryVector && chunk.embedding
      ? cosineSimilarity(queryVector, chunk.embedding)
      : 0;
    const score = mode === 'hybrid'
      ? (kw * 0.45) + (vec * 0.55)
      : kw;
    return { chunk, score, kw, vec };
  })
    .filter((row) => row.score > 0.02 || row.kw > 0)
    .sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page)
    .slice(0, Math.min(20, Math.max(1, Number(limit) || 6)));

  const citations = ranked.map((row) => toCitation(row.chunk, row.score, mode));
  return {
    hits: ranked.map((row) => ({
      ...toCitation(row.chunk, row.score, mode),
      content: row.chunk.content,
    })),
    citations,
    mode,
    totalIndexed: chunks.length,
  };
}
