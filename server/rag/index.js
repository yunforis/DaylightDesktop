export { chunkPages, normalizeChunkText } from './chunk.js';
export { listChunks, deleteChunksByAttachment, replaceChunks, reassignCandidate } from './store.js';
export { embedTexts, cosineSimilarity } from './embed.js';
export { ragSearch } from './retrieve.js';
export {
  ingestAttachmentChunks,
  bindChunksToCandidate,
  reindexMailboxAttachments,
} from './ingest.js';
export { ingestEmailKnowledge, reindexMailboxEmails } from './mail-index.js';
export { askMailboxKnowledge } from './ask.js';

export function isRagEnabled(settings) {
  return settings?.ragEnabled !== false;
}

export function ragPublicSettings(settings = {}) {
  return {
    ragEnabled: settings.ragEnabled !== false,
    ragEmbeddings: settings.ragEmbeddings === true,
    embeddingModel: settings.embeddingModel || '',
  };
}
