import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-report-prompts-'));
process.env.DAYLIGHT_DATA_DIR = dataDir;

const {
  readReportPrompts,
  upsertReportPreset,
  deleteReportPreset,
  resetReportPrompts,
  DEFAULT_REPORT_PRESETS,
} = await import('./report-prompts.js');

test('report prompt presets persist and reset', () => {
  const initial = readReportPrompts();
  assert.equal(initial.presets.length, DEFAULT_REPORT_PRESETS.length);

  const saved = upsertReportPreset({
    name: '校招复盘',
    requirements: '突出候选人亮点与风险，语气客观。',
    templateText: '一、亮点\n二、风险',
  });
  assert.ok(saved.presets.some((item) => item.name === '校招复盘'));

  const again = readReportPrompts();
  const hit = again.presets.find((item) => item.name === '校招复盘');
  assert.ok(hit?.id);
  assert.match(hit.requirements, /候选人亮点/);

  deleteReportPreset(hit.id);
  assert.equal(
    readReportPrompts().presets.some((item) => item.id === hit.id),
    false,
  );

  const reset = resetReportPrompts();
  assert.equal(reset.presets.length, DEFAULT_REPORT_PRESETS.length);
});
