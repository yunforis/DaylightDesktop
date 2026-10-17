import { chunkPages } from './chunk.js';
import { embedTexts } from './embed.js';
import { makeChunkId, replaceChunks, reassignCandidate } from './store.js';
import { isRagEmbeddings } from './flags.js';
import { getRequestUserId } from '../request-context.js';

function ragEnabled(settings) {
  return settings?.ragEnabled !== false;
}

/**
 * 将附件页文本分块入库；可选 embedding。attachment.pages 来自 pdf.js。
 */
export async function ingestAttachmentChunks({
  mailboxId,
  attachment,
  candidateId = null,
  settings = {},
  context,
  ownerUserId = null,
} = {}) {
  if (!ragEnabled(settings)) {
    return { skipped: true, reason: 'rag_disabled', chunkCount: 0 };
  }
  if (!mailboxId || !attachment?.id) {
    throw new Error('RAG 入库缺少 mailboxId 或 attachmentId');
  }
  const pages = Array.isArray(attachment.pages) ? attachment.pages : [];
  const pieces = chunkPages(pages);
  if (!pieces.length) {
    await replaceChunks(mailboxId, attachment.id, []);
    return { skipped: false, chunkCount: 0, reason: 'no_text' };
  }

  const owner = ownerUserId || getRequestUserId() || null;
  let embeddings = pieces.map(() => null);
  // 向量检索默认开启（显式 false 才关闭）：默认 embedding 模型会从供应商模型列表自动挑，
  // 挑不到就静默退回关键词，所以开启不会因为少填一个字段而报错。
  if (isRagEmbeddings(settings)) {
    embeddings = await embedTexts(
      settings,
      pieces.map((item) => item.content),
      { context, label: 'RAG 分块向量化' },
    );
  }

  const chunks = pieces.map((piece, index) => ({
    id: makeChunkId({
      mailboxId,
      attachmentId: attachment.id,
      page: piece.page,
      chunkIndex: piece.chunkIndex,
    }),
    mailboxId,
    ownerUserId: owner,
    candidateId: candidateId || attachment.candidateId || null,
    attachmentId: attachment.id,
    filename: attachment.filename || '',
    page: piece.page,
    chunkIndex: piece.chunkIndex,
    content: piece.content,
    embedding: embeddings[index] || null,
    updatedAt: new Date().toISOString(),
  }));

  const span = context?.startSpan('rag_ingest', '简历分块入库', {
    thought: '按页分块写入检索索引，供招聘助手与小 D 引用原文。',
    input_snapshot: { attachmentId: attachment.id, pages: pages.length, chunks: chunks.length },
  });
  await replaceChunks(mailboxId, attachment.id, chunks);
  if (span) {
    context.finishSpan(span, {
      observation: `已写入 ${chunks.length} 个分块`,
      output_snapshot: {
        chunkCount: chunks.length,
        embedded: chunks.filter((item) => item.embedding).length,
      },
    });
  }
  return {
    skipped: false,
    chunkCount: chunks.length,
    embedded: chunks.filter((item) => item.embedding).length,
  };
}

export async function bindChunksToCandidate(mailboxId, attachmentId, candidateId) {
  await reassignCandidate(mailboxId, attachmentId, candidateId);
}

/**
 * 按当前邮箱已保存的附件页文本重建索引（不重新 OCR）。
 * attachments 来自 recruitment-store，需带 pages。
 */
export async function reindexMailboxAttachments({
  mailboxId,
  attachments = [],
  settings = {},
  context,
} = {}) {
  if (!ragEnabled(settings)) {
    return { skipped: true, reason: 'rag_disabled', processed: 0, chunkCount: 0 };
  }
  let processed = 0;
  let chunkCount = 0;
  let embedded = 0;
  for (const attachment of attachments) {
    if (!attachment?.id) continue;
    const pages = Array.isArray(attachment.pages) ? attachment.pages : [];
    if (!pages.length) continue;
    const result = await ingestAttachmentChunks({
      mailboxId,
      attachment,
      candidateId: attachment.candidateId || null,
      settings,
      context,
    });
    if (!result.skipped) {
      processed += 1;
      chunkCount += result.chunkCount || 0;
      embedded += result.embedded || 0;
    }
  }
  return { skipped: false, processed, chunkCount, embedded };
}
