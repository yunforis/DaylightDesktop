/** 按页分块：页过长再按段落切分，约 500–800 字，重叠约 80 字。 */

const DEFAULT_SIZE = 700;
const DEFAULT_OVERLAP = 80;

export function normalizeChunkText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(text, size, overlap) {
  if (text.length <= size) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const soft = text.lastIndexOf('\n', end);
      const softSpace = text.lastIndexOf('。', end);
      const cut = Math.max(soft, softSpace);
      if (cut > start + Math.floor(size * 0.4)) end = cut + 1;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return parts.filter(Boolean);
}

/**
 * @param {Array<{ page?: number, text?: string, number?: number }|string>} pages
 * @returns {Array<{ page: number, chunkIndex: number, content: string }>}
 */
export function chunkPages(pages, { size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const chunks = [];
  list.forEach((page, index) => {
    const pageNumber = Number(page?.page ?? page?.number ?? index + 1) || index + 1;
    const raw = typeof page === 'string' ? page : (page?.text || page?.content || '');
    const text = normalizeChunkText(raw);
    if (!text) return;
    const pieces = splitLong(text, size, overlap);
    pieces.forEach((content, chunkIndex) => {
      chunks.push({ page: pageNumber, chunkIndex, content });
    });
  });
  return chunks;
}
