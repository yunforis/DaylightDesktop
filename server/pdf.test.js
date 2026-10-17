import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdf, demoResumePdf } from './pdf.js';

// Small valid PDFs generated in memory: no customer documents or real data directory.
function makePdf(pageTexts, encrypted = false) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pages = [];
  for (const text of pageTexts) {
    const pageId = objects.length;
    pages.push(`${pageId} 0 R`);
    const stream = text ? `BT /F1 16 Tf 40 750 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${pages.join(' ')}] /Count ${pages.length} >>`;
  const encryptId = objects.length;
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = Buffer.byteLength(pdf); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R ${encrypted ? `/Encrypt ${encryptId} 0 R /ID [<0011223344556677><0011223344556677>]` : ''} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function trace() {
  const spans = [];
  return { spans, startSpan(stage, label, fields) { const span = { stage, label, ...fields }; spans.push(span); return span; },
    updateSpan(span, fields) { Object.assign(span, fields); }, finishSpan(span, fields) { Object.assign(span, { status: 'success' }, fields); } };
}

function imagePdf() {
  const pixels = Buffer.alloc(64 * 64 * 3, 245);
  for (let i = 0; i < pixels.length; i += 7) pixels[i] = 40;
  const content = 'q 500 0 0 500 45 200 cm /I1 Do Q';
  const objects = [null, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /I1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from('\nendstream')])];
  let result = Buffer.from('%PDF-1.4\n');
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(result.length);
    result = Buffer.concat([result, Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
  }
  const xref = result.length;
  return Buffer.concat([result, Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
}

test('PDF 逐页读取文字层，日志仅保存提取摘要', async () => {
  const context = trace();
  const result = await extractPdf(makePdf(['Synthetic candidate Jane completed a cloud computing project.', 'University in Shanghai. Bachelor of Computer Science.']), {
    context, ocr() { throw new Error('文字层无需 OCR'); },
  });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages.map((page) => page.method), ['text', 'text']);
  assert.match(result.text, /cloud computing/);
  assert.doesNotMatch(JSON.stringify(context.spans), /Synthetic candidate|University in Shanghai/);
  assert.equal(context.spans[0].status, 'success');
});

test('混合 PDF 只对缺文字页渲染 OCR，并展示页级进度', async () => {
  const context = trace();
  const progress = [];
  const result = await extractPdf(makePdf(['Synthetic candidate with a sufficiently long native text layer.', '']), {
    context, onProgress: (event) => progress.push(event),
    ocr: async (png, { page, onProgress }) => {
      assert.equal(page, 2);
      assert.deepEqual([...png.subarray(0, 4)], [137, 80, 78, 71]);
      onProgress({ status: 'recognizing text', progress: 0.5 });
      return { text: '姓名：张三\n学校：上海交通大学\n项目：云计算平台' };
    },
  });
  assert.deepEqual(result.pages.map((page) => page.method), ['text', 'ocr']);
  assert.match(result.text, /上海交通大学/);
  assert.ok(progress.some((event) => event.page === 2 && event.progress === 0.5));
  assert.equal(context.spans.find((span) => span.stage === 'pdf_ocr').status, 'success');
  assert.doesNotMatch(JSON.stringify(context.spans), /张三|上海交通大学/);
});

test('空、损坏、加密与无可读内容 PDF 返回可处理的错误', async () => {
  await assert.rejects(extractPdf(Buffer.alloc(0)), /文件为空/);
  await assert.rejects(extractPdf(Buffer.from('not a pdf')), /损坏或格式无效/);
  await assert.rejects(extractPdf(makePdf(['Private synthetic resume'], true)), /已加密/);
  await assert.rejects(extractPdf(makePdf(['']), { ocr: async () => '' }), /未提取到可读文字/);
});

test('OCR 失败记录失败阶段，后续 PDF 仍可正常处理', async () => {
  const context = trace();
  await assert.rejects(extractPdf(makePdf(['']), { context, ocr: async () => { throw new Error('测试 OCR 不可用'); } }), /OCR 不可用/);
  assert.ok(context.spans.every((span) => span.status === 'failed'));
  const next = await extractPdf(makePdf(['Another synthetic candidate with native readable text.']));
  assert.match(next.text, /Another synthetic/);
});

test('预置中文简历 PDF 可提取中文姓名、学校及项目，并明确标识示例', async () => {
  const pdf = demoResumePdf({ personal: { name: '合成张明', age: 24, currentCity: '上海', email: 'synthetic@example.com' },
    education: [{ school: '上海交通大学', degree: '本科', major: '计算机科学' }],
    projects: [{ name: '云计算平台', description: '开发容器管理平台', technologies: ['Docker', 'Kubernetes'] }] });
  const result = await extractPdf(pdf, { ocr: () => { throw new Error('中文示例有可读文字层'); } });
  assert.match(result.text, /合成张明/);
  assert.match(result.text, /上海交通大学/);
  assert.match(result.text, /预置示例/);
  assert.match(result.text, /Kubernetes/);
});

test('OCR 首次语言包下载失败可恢复，不启动悬挂 worker、不写真实数据目录', async (t) => {
  const original = process.env.DAYLIGHT_DATA_DIR;
  await fs.mkdir('work', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('work/pdf-ocr-network-test-'));
  process.env.DAYLIGHT_DATA_DIR = directory;
  t.after(async () => {
    if (original === undefined) delete process.env.DAYLIGHT_DATA_DIR;
    else process.env.DAYLIGHT_DATA_DIR = original;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic offline'); });
  await assert.rejects(extractPdf(makePdf([''])), /语言包下载失败.*重试/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('包含嵌入扫描图像的 PDF 正常渲染，避免不同原生 canvas 实例混用崩溃', async () => {
  const result = await extractPdf(imagePdf(), { ocr: async (image) => {
    assert.ok(image.length > 1000);
    return 'Synthetic scanned image resume';
  } });
  assert.equal(result.pages[0].method, 'ocr');
  assert.equal(result.text, 'Synthetic scanned image resume');
});
