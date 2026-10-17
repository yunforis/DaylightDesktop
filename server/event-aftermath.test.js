import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(root, 'work', 'aftermath-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;

const { readStore, saveStore, readSettings, saveSettings } = await import('./store.js');
const {
  listMaterials, addMaterial, removeMaterial, readMaterialFile,
  generateEventReport, deleteReport, MATERIAL_KINDS,
} = await import('./event-aftermath.js');

// 材料跟随日程所在邮箱：这里显式声明邮箱，附件前缀与存储邮箱才是同一个。
saveSettings({
  ...readSettings(),
  mailboxes: [{ id: 'mb1', email: 'aftermath@qq.com', authorizationCode: '' }],
  activeMailboxId: 'mb1',
});

function seedEvent() {
  saveStore({
    events: [{
      id: 'evt-aftermath-1',
      title: '产品复盘会',
      start: '2026-10-10T14:00:00+08:00',
      end: '2026-10-10T16:00:00+08:00',
      allDay: false,
      category: 'work',
      location: '会议室 A',
      description: '季度产品复盘',
      source: 'manual',
    }],
    emails: [],
    tasks: [],
    lastSync: null,
  });
}

test('材料类型清单完整', () => {
  assert.ok(MATERIAL_KINDS.some((item) => item.id === 'photo'));
  assert.ok(MATERIAL_KINDS.some((item) => item.id === 'template'));
});

test('可上传文字感受与文件材料，并预览读取', async () => {
  seedEvent();
  const note = await addMaterial('evt-aftermath-1', {
    kind: 'note',
    filename: '感受.txt',
    mimeType: 'text/plain',
    note: '现场气氛好',
    textContent: '今天讨论很充分，下一步要跟进指标看板。',
  });
  assert.equal(note.kind, 'note');
  assert.equal(note.hasFile, false);
  assert.match(note.textContent, /指标看板/);

  const photo = await addMaterial('evt-aftermath-1', {
    kind: 'photo',
    filename: '现场.png',
    mimeType: 'image/png',
    note: '合影',
    contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
  }, { userId: 'u1', username: 'demo', mailboxId: 'mb1' });
  assert.equal(photo.hasFile, true);
  assert.ok(photo.previewUrl.includes('/materials/'));

  const listed = listMaterials('evt-aftermath-1');
  assert.equal(listed.materials.length, 2);

  const file = await readMaterialFile('evt-aftermath-1', photo.id);
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.filename, '现场.png');
  assert.ok(file.buffer.length >= 8);

  removeMaterial('evt-aftermath-1', note.id);
  assert.equal(listMaterials('evt-aftermath-1').materials.length, 1);
});

test('材料按日程归属邮箱读写：换成别的邮箱就按「日程不存在」拒绝', () => {
  seedEvent();
  assert.equal(listMaterials('evt-aftermath-1', { mailboxId: 'mb1' }).materials.length, 0);
  assert.throws(() => listMaterials('evt-aftermath-1', { mailboxId: 'mb2' }), /日程不存在/);
});

test('按模板与要求调用模型生成报告并落库', async (t) => {
  seedEvent();
  await addMaterial('evt-aftermath-1', {
    kind: 'note',
    filename: '要点.txt',
    mimeType: 'text/plain',
    textContent: '完成了指标看板初稿；风险是数据口径未统一。',
  });
  const template = await addMaterial('evt-aftermath-1', {
    kind: 'template',
    filename: '周报模板.md',
    mimeType: 'text/markdown',
    textContent: '# 周报\n## 成果\n## 风险\n## 下周计划\n',
  });

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    assert.match(JSON.stringify(payload), /指标看板|周报|正式语气/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '产品复盘会 · 复盘报告',
            summary: '完成看板初稿，口径待统一。',
            markdown: '## 成果\n- 指标看板初稿\n\n## 风险\n- 数据口径未统一\n\n## 下周计划\n- 对齐口径\n',
          }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const settings = readSettings();
  saveSettings({
    ...settings,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'invented-aftermath-key',
    model: 'local-aftermath-model',
  });

  const report = await generateEventReport('evt-aftermath-1', {
    requirements: '正式语气，按周报结构',
    templateMaterialId: template.id,
  });
  assert.equal(report.title, '产品复盘会 · 复盘报告');
  assert.match(report.markdown, /指标看板/);
  assert.equal(listMaterials('evt-aftermath-1').reports.length, 1);

  deleteReport('evt-aftermath-1', report.id);
  assert.equal(listMaterials('evt-aftermath-1').reports.length, 0);
  assert.equal(readStore().events[0].id, 'evt-aftermath-1');
});
