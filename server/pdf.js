import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
// Use PDF.js's canvas instance: mixing native canvas versions can crash while drawing scan images.
const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resources = (name) => `${path.join(pdfRoot, name).replaceAll('\\', '/')}/`;

function pageText(items) {
  return items.filter((item) => typeof item.str === 'string')
    .map((item) => `${item.str}${item.hasEOL ? '\n' : ''}`).join('')
    .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function readableCount(text) { return (text.match(/[\p{L}\p{N}]/gu) || []).length; }

async function prepareLanguages(cachePath, progress) {
  await fs.mkdir(cachePath, { recursive: true });
  for (const language of ['eng', 'chi_sim']) {
    const filename = path.join(cachePath, `${language}.traineddata`);
    try { if ((await fs.stat(filename)).size > 0) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    progress({ status: `首次下载 ${language === 'eng' ? '英文' : '中文'} OCR 语言包`, progress: 0 });
    try {
      const response = await fetch(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
        { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = gunzipSync(Buffer.from(await response.arrayBuffer()));
      await fs.writeFile(filename, bytes);
    } catch {
      throw new Error(`OCR ${language === 'eng' ? '英文' : '中文'}语言包下载失败，请检查网络后重试；已保存的语言包会复用。`);
    }
    progress({ status: `${language === 'eng' ? '英文' : '中文'} OCR 语言包已缓存`, progress: 1 });
  }
}

function pdfError(cause) {
  const error = cause instanceof Error ? cause : new Error(`PDF/OCR 处理失败：${String(cause)}`);
  if (error.name === 'PasswordException') return new Error('PDF 已加密，请发送不需要密码的简历 PDF。');
  if (error.name === 'InvalidPDFException' || error.name === 'MissingPDFException') return new Error('PDF 文件损坏或格式无效，请重新导出后发送。');
  return error;
}

/** Extract readable text page by page; OCR receives rendered PNG bytes, never a file path. */
export async function extractPdf(buffer, { context, onProgress, ocr } = {}) {
  if (!buffer?.length) throw new Error('PDF 文件为空，请重新发送。');
  const span = context?.startSpan('pdf_extract', '读取 PDF 简历', {
    thought: '逐页读取文字层；没有足够文字的页面渲染后进行中英文 OCR。',
    input_snapshot: { bytes: buffer.length },
    tool_calls: [{ name: 'pdf.extract_text', arguments: { bytes: buffer.length, strategy: 'text_then_page_ocr' } }],
  });
  let document, worker, ocrSpan, loadingTask;
  let activePage = 0, pageCount = 0;
  let lastProgress = '';
  const progress = (event) => {
    const current = { page: activePage, pageCount, ...event };
    onProgress?.(current);
    if (!ocrSpan) return;
    const percent = Math.floor((Number(event.progress) || 0) * 20) * 5;
    const key = `${activePage}:${event.status}:${percent}`;
    if (key === lastProgress) return;
    lastProgress = key;
    context?.updateSpan(ocrSpan, { output_snapshot: { page: activePage, pageCount, status: event.status, progress: percent },
      observation: `第 ${activePage}/${pageCount} 页 · ${event.status || 'OCR'} ${percent}%` });
  };
  try {
    loadingTask = getDocument({ data: Uint8Array.from(buffer), cMapUrl: resources('cmaps'), cMapPacked: true,
      standardFontDataUrl: resources('standard_fonts'), wasmUrl: resources('wasm'), useSystemFonts: true,
      isEvalSupported: false, verbosity: 0 });
    document = await loadingTask.promise;
    pageCount = document.numPages;
    const pages = [];
    for (let number = 1; number <= pageCount; number++) {
      activePage = number;
      const page = await document.getPage(number);
      let canvas;
      try {
        let text = pageText((await page.getTextContent()).items);
        let method = 'text';
        if (readableCount(text) < 20) {
          method = 'ocr';
          ocrSpan = context?.startSpan('pdf_ocr', `第 ${number} 页 · 中英文 OCR`, {
            input_snapshot: { page: number, pageCount, textLayerChars: text.length, languages: ['chi_sim', 'eng'] },
            tool_calls: [{ name: 'pdf.ocr_page', arguments: { page: number, languages: ['chi_sim', 'eng'], engine: 'tesseract.js' } }],
          });
          progress({ status: '渲染扫描页面', progress: 0, method });
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2.5, 3200 / Math.max(base.width, base.height)) });
          canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
          const png = await canvas.encode('png');
          let result;
          if (ocr) result = await ocr(png, { page: number, onProgress: progress });
          else {
            if (!worker) {
              const cachePath = path.join(process.env.DAYLIGHT_DATA_DIR || path.join(projectRoot, 'data'), 'cache', 'ocr');
              progress({ status: '准备 OCR 引擎和语言包（首次使用需下载）', progress: 0, method });
              // Download before spawning the worker so a network failure cannot leave an initializing worker behind.
              await prepareLanguages(cachePath, progress);
              worker = await createWorker('eng+chi_sim', 1, { cachePath, langPath: cachePath, gzip: false, logger: progress,
                // Surface worker errors as rejected operations rather than uncaught process errors.
                errorHandler: () => {} });
              await worker.setParameters({ preserve_interword_spaces: '1' });
            }
            const response = await worker.recognize(png);
            result = response.data;
          }
          const recognized = String(typeof result === 'string' ? result : result?.text || '').trim();
          // A short native heading/page number may survive when OCR cannot read an otherwise blank page.
          if (readableCount(recognized) >= readableCount(text)) text = recognized;
          context?.finishSpan(ocrSpan, { observation: `第 ${number} 页 OCR 完成，识别 ${text.length} 个字符。`,
            output_snapshot: { page: number, characters: text.length, method },
            tool_calls: [{ name: 'pdf.ocr_page', arguments: { page: number, languages: ['chi_sim', 'eng'], engine: 'tesseract.js' },
              result_summary: { characters: text.length } }] });
          ocrSpan = null;
        }
        pages.push({ page: number, text, method });
        progress({ status: '页面提取完成', progress: number / pageCount, method });
        context?.updateSpan(span, { output_snapshot: { pageCount, processedPages: number,
          pages: pages.map(({ page, method, text }) => ({ page, method, characters: text.length })) } });
      } finally {
        if (canvas) { canvas.width = 1; canvas.height = 1; }
        page.cleanup();
      }
    }
    const text = pages.map((page) => page.text).filter(Boolean).join('\n\n');
    if (readableCount(text) < 2) throw new Error('PDF 未提取到可读文字，请提供更清晰的简历或含文字层的 PDF。');
    context?.finishSpan(span, { observation: `已提取 ${pageCount} 页，共 ${text.length} 个字符；正文不写入日志。`,
      output_snapshot: { pageCount, characters: text.length, ocrPages: pages.filter((page) => page.method === 'ocr').length } });
    return { pages, text, pageCount };
  } catch (cause) {
    const error = pdfError(cause);
    if (ocrSpan) context?.finishSpan(ocrSpan, { status: 'failed', error: error.message, observation: '此页 OCR 未完成，可检查网络及文件后重试。' });
    context?.finishSpan(span, { status: 'failed', error: error.message, observation: '未完成 PDF 提取，本次不写入候选人。' });
    throw error;
  } finally {
    await Promise.allSettled([worker?.terminate(), loadingTask?.destroy()]);
  }
}

const fieldNames = { school: '学校', degree: '学历', major: '专业', start: '开始', end: '结束', city: '城市',
  company: '公司', role: '岗位', type: '类型', description: '内容', name: '名称', technologies: '技术',
  title: '名称', date: '日期', organization: '机构', level: '等级', result: '成果', achievement: '成果',
  institution: '机构', issuer: '颁发机构', score: '成绩', proficiency: '水平', content: '内容' };

function readableValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readableValue).filter(Boolean).join('、');
  if (typeof value === 'object') return Object.entries(value).filter(([key]) => !/Id$|^id$|evidence|confidence/i.test(key))
    .map(([key, item]) => item ? `${fieldNames[key] || key}：${readableValue(item)}` : '').filter(Boolean).join(' · ');
  return String(value);
}

function wrapLine(value, limit = 46) {
  const lines = [];
  for (const source of String(value).split(/\r?\n/)) {
    let line = '', width = 0;
    for (const character of source) {
      const size = /[\u0000-\u007f]/.test(character) ? 0.55 : 1;
      if (width + size > limit) { lines.push(line); line = ''; width = 0; }
      line += character; width += size;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function pdfHex(value) {
  // UniGB-UCS2-H accepts UTF-16 big endian character codes.
  return Buffer.from(String(value), 'utf16le').swap16().toString('hex');
}

/** A readable, selectable Chinese PDF for the explicitly labelled preset recruitment demo. */
export function demoResumePdf(profile) {
  const person = profile.personal || profile;
  const name = person.name || '示例候选人';
  const rows = [];
  const add = (text, heading = false) => wrapLine(text).forEach((line) => rows.push({ text: line, heading }));
  add([person.age != null ? `${person.age} 岁` : '', person.currentCity, person.email, person.phone].filter(Boolean).join(' · '));
  if (profile.intent) add(`求职意向：${readableValue(profile.intent.positions)}    期望城市：${readableValue(profile.intent.cities)}`);
  const sections = [['education', '教育背景'], ['experience', '工作与实习经历'], ['projects', '项目经历'],
    ['research', '科研经历'], ['awards', '竞赛与获奖'], ['honors', '个人荣誉'], ['skills', '专业技能'],
    ['certificates', '证书'], ['languages', '语言能力'], ['other', '其他信息']];
  for (const [key, label] of sections) {
    const items = profile[key];
    if (!items || (Array.isArray(items) && !items.length)) continue;
    add(label, true);
    if (Array.isArray(items) && items.every((item) => typeof item === 'string')) add(readableValue(items));
    else for (const item of Array.isArray(items) ? items : [items]) add(readableValue(item));
  }
  const pages = [];
  let lines = [], y = 690;
  for (const row of rows) {
    const height = row.heading ? 31 : 21;
    if (y - height < 80) { pages.push(lines); lines = []; y = 690; }
    lines.push({ ...row, y }); y -= height;
  }
  pages.push(lines);
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>'];
  const pageRefs = [];
  for (const [index, page] of pages.entries()) {
    const pageId = objects.length;
    pageRefs.push(`${pageId} 0 R`);
    const drawText = (text, size, x, y, color = '0.13 0.19 0.29') => {
      const glyphs = [...text].map((character) => `<${pdfHex(character)}> ${character === ' ' ? 700 : /[\u0000-\u007f]/.test(character) ? 450 : 0}`).join(' ');
      return `${color} rg BT /F1 ${size} Tf ${x} ${y} Td [${glyphs}] TJ ET\n`;
    };
    let stream = '0.96 0.97 0.99 rg 0 0 595 842 re f\n1 1 1 rg 25 40 545 762 re f\n0.90 0.93 0.99 rg 25 720 545 82 re f\n';
    stream += drawText(name, 26, 47, 763);
    stream += drawText('DAYLIGHT 人才库 · 预置示例简历', 10, 48, 739, '0.31 0.42 0.62');
    for (const row of page) stream += drawText(row.text, row.heading ? 13 : 10.5, 48, row.y, row.heading ? '0.23 0.36 0.68' : undefined);
    stream += drawText(`全部信息为合成示例，不代表真实候选人    ${index + 1} / ${pages.length}`, 9, 48, 58, '0.45 0.49 0.57');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = Buffer.byteLength(pdf); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
