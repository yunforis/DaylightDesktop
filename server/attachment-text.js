/**
 * 将邮件 PDF / 图片附件转为可供主提取链路使用的文本摘录。
 * 招聘旁路仍走 resumes.js；此处服务主邮件提取（含发票）。
 */
import { extractPdf } from './pdf.js';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_CHARS_PER_FILE = 8_000;
const MAX_FILES = 6;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PDF_MIME = /application\/pdf/i;
const PDF_EXT = /\.pdf$/i;

async function ensureLanguages(cachePath) {
  await fs.mkdir(cachePath, { recursive: true });
  for (const language of ['eng', 'chi_sim']) {
    const filename = path.join(cachePath, `${language}.traineddata`);
    try {
      if ((await fs.stat(filename)).size > 0) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const response = await fetch(
        `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
        { signal: AbortSignal.timeout(120_000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fs.writeFile(filename, gunzipSync(Buffer.from(await response.arrayBuffer())));
    } catch {
      throw new Error(`OCR ${language === 'eng' ? '英文' : '中文'}语言包下载失败，请检查网络后重试；已保存的语言包会复用。`);
    }
  }
}

export async function ocrImageBuffer(buffer, { workerFactory = createWorker, prepareLanguages = ensureLanguages } = {}) {
  if (!buffer?.length) throw new Error('图片附件为空，请重新发送。');
  let worker;
  try {
    const cachePath = path.join(process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data'), 'cache', 'ocr');
    // Download first; a network failure must not leave an initializing worker behind.
    await prepareLanguages(cachePath);
    worker = await workerFactory('eng+chi_sim', 1, {
      cachePath, langPath: cachePath, gzip: false, errorHandler: () => {},
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    const result = await worker.recognize(buffer);
    const text = String(result?.data?.text || '').trim();
    if (!/[\p{L}\p{N}]/u.test(text)) throw new Error('图片未识别到可读文字，请提供更清晰的图片后重试。');
    return text;
  } finally {
    await Promise.allSettled([worker?.terminate()]);
  }
}

function asBuffer(content) {
  if (!content) return null;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === 'string') {
    try { return Buffer.from(content, 'base64'); } catch { return null; }
  }
  return null;
}

function isPdf(item) {
  return PDF_MIME.test(item.contentType || item.mimeType || '') || PDF_EXT.test(item.filename || '');
}

function isImage(item) {
  return IMAGE_MIME.test(item.contentType || item.mimeType || '') || IMAGE_EXT.test(item.filename || '');
}

export function isSupportedTextAttachment(item) {
  return isPdf(item) || isImage(item);
}

function attachmentId(item) {
  return item?.id || item?.attachmentId || '';
}

function collectFiles(email) {
  const metadata = email.attachments || [];
  const raw = Array.isArray(email._textAttachments) ? email._textAttachments : (email._pdfAttachments || []);
  const files = [];
  const usedMetadata = new Set();
  const seenObjects = new Set();
  const seenIds = new Set();
  for (const [index, item] of raw.entries()) {
    const id = attachmentId(item);
    if (seenObjects.has(item) || (id && seenIds.has(id))) continue;
    seenObjects.add(item);
    if (id) seenIds.add(id);
    let metadataIndex = metadata.findIndex((entry, position) => !usedMetadata.has(position)
      && ((id && attachmentId(entry) === id) || entry === item));
    // Older messages have no attachment IDs. Match each metadata entry once, without
    // collapsing distinct files that happen to have the same filename and size.
    if (metadataIndex < 0 && !id) metadataIndex = metadata.findIndex((entry, position) => !usedMetadata.has(position)
      && entry.filename === item.filename);
    const entry = metadataIndex >= 0 ? metadata[metadataIndex] : null;
    if (entry) usedMetadata.add(metadataIndex);
    const resolvedId = id || attachmentId(entry) || `attachment-${metadataIndex >= 0 ? metadataIndex + 1 : metadata.length + index + 1}`;
    if (entry) entry.id = resolvedId;
    files.push({ item, metadata: entry, attachmentId: resolvedId });
  }
  for (const [index, item] of metadata.entries()) {
    if (usedMetadata.has(index)) continue;
    const id = attachmentId(item) || `attachment-${index + 1}`;
    item.id = id;
    files.push({ item, metadata: item, attachmentId: id });
  }
  return files;
}

/**
 * @param {object} email
 * @param {{ context?: object, skipRecruitment?: boolean, extractPdf?: Function, ocr?: Function }} [options]
 * @returns {Promise<{ attachmentTexts: Array<{ attachmentId, filename, kind, text, characters, pageCount? }>, errors: string[] }>}
 */
export async function enrichEmailWithAttachmentText(email, {
  context, skipRecruitment = true, extractPdf: readPdf = extractPdf, ocr = ocrImageBuffer,
} = {}) {
  if (skipRecruitment && (email.category === 'resume' || email._skipAttachmentIngest)) {
    return { attachmentTexts: [], errors: [] };
  }
  const cachedTexts = email.attachmentTexts || [];
  const files = collectFiles(email);
  const attachmentTexts = [];
  const errors = [];
  email.attachmentTexts = attachmentTexts;
  email.attachmentTextErrors = errors;
  if (!files.length) {
    return { attachmentTexts, errors };
  }
  const span = context?.startSpan?.('attachment_ingest', '读取附件文本', {
    thought: '把 PDF/图片附件转为文字摘录，供主提取链路使用。每封最多 6 个支持的附件，每个最多 8,000 字符。',
    input_snapshot: { file_count: files.length, max_files: MAX_FILES, max_characters_per_file: MAX_CHARS_PER_FILE },
    tool_calls: [{ name: 'attachments.extract_text', arguments: { file_count: files.length }, result_summary: null }],
  });

  let processedFiles = 0;
  for (const { item, metadata, attachmentId } of files) {
    const filename = item.filename || 'attachment';
    const setStatus = (status, message = '', recordError = true) => {
      if (metadata) {
        metadata.textStatus = status;
        if (message) metadata.textError = message;
        else delete metadata.textError;
      }
      if (message && recordError) errors.push(`${filename}（${attachmentId}）：${message}`);
    };
    if (metadata) {
      delete metadata.textCharacters;
      delete metadata.pageCount;
    }
    if (!isSupportedTextAttachment(item)) {
      setStatus('unsupported', '暂只支持 PDF 和 PNG/JPG/GIF/WebP/BMP 图片附件的文字提取。', false);
      continue;
    }
    if (processedFiles >= MAX_FILES) {
      setStatus('skipped_limit', '每封邮件最多提取 6 个 PDF/图片附件，此附件未提取。');
      continue;
    }
    processedFiles += 1;
    try {
      const buffer = asBuffer(item.content || item.buffer || item._buffer);
      if (Math.max(Number(item.size) || 0, buffer?.length || 0) > MAX_ATTACHMENT_BYTES) {
        setStatus('skipped_size', '附件超过 25MB，未进行文字提取。');
        continue;
      }
      const pdf = isPdf(item);
      // Saved recruitment PDFs may already have readable page text after a retry.
      // Reuse only an explicit matching source; a previous failure must stay visible.
      const cached = !buffer?.length && metadata?.textStatus !== 'failed'
        ? cachedTexts.find((text) => text.attachmentId === attachmentId
          && (pdf ? text.kind === 'pdf' : ['image', 'image_ocr'].includes(text.kind))
          && typeof text.text === 'string' && text.text.trim()) : null;
      if (!buffer?.length && !cached) throw new Error('附件原始内容不可用或为空，请重新同步邮件后重试。');
      const extracted = cached || (pdf ? await readPdf(buffer, { context }) : null);
      const fullText = String(extracted ? extracted.text || '' : await ocr(buffer)).trim();
      if (!/[\p{L}\p{N}]/u.test(fullText)) throw new Error(`${pdf ? 'PDF' : '图片'}未提取到可读文字，请提供更清晰的附件后重试。`);
      const text = fullText.slice(0, MAX_CHARS_PER_FILE);
      const result = { attachmentId, filename, kind: pdf ? 'pdf' : 'image_ocr', text, characters: text.length };
      if (extracted?.pageCount) result.pageCount = extracted.pageCount;
      attachmentTexts.push(result);
      if (metadata) {
        metadata.textCharacters = text.length;
        if (result.pageCount) metadata.pageCount = result.pageCount;
      }
      const truncated = fullText.length > MAX_CHARS_PER_FILE || (cached && metadata?.textStatus === 'truncated');
      setStatus(truncated ? 'truncated' : 'success', truncated
        ? '附件文字超过 8,000 字符，仅提取前 8,000 字符；后续内容未进入分析。' : '');
    } catch (error) {
      setStatus('failed', error.message || '附件识别失败，请重试。');
    }
  }

  if (span) {
    context.finishSpan(span, {
      status: attachmentTexts.length || !errors.length ? 'success' : 'failed',
      observation: attachmentTexts.length
        ? `已提取 ${attachmentTexts.length} 个附件的文字摘录${errors.length ? `，另有 ${errors.length} 项错误或处理局限。` : '。'}`
        : '没有可用的附件文字，请查看附件错误或处理局限。',
      output_snapshot: {
        count: attachmentTexts.length,
        files: attachmentTexts.map(({ attachmentId, filename, kind, characters, pageCount }) => ({ attachmentId, filename, kind, characters, pageCount })),
        errors,
      },
      tool_calls: [{
        name: 'attachments.extract_text',
        arguments: { file_count: files.length },
        result_summary: { count: attachmentTexts.length, errors: errors.length },
      }],
    });
  }
  return { attachmentTexts, errors };
}
