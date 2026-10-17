import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { usesStorageSnapshot, readSnapshotDocument, stageSnapshotDocument, settingsKey } from './storage/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const promptsFile = path.join(dataDir, 'report-prompts.json');

export const DEFAULT_REPORT_PRESETS = [
  {
    id: 'weekly',
    name: '周报复盘',
    requirements: '按公司周报格式，含成果、风险、下周计划；语气正式、条理清晰，用条目列出。',
    templateText: '一、本周成果\n二、问题与风险\n三、下周计划',
  },
  {
    id: 'activity',
    name: '活动纪要',
    requirements: '写成活动纪要：背景、过程亮点、参与反馈、改进建议；口语可保留但结论要明确。',
    templateText: '一、背景\n二、过程\n三、反馈\n四、改进',
  },
  {
    id: 'brief',
    name: '一页摘要',
    requirements: '控制在一页内：三句话摘要 + 五条要点 + 一条后续行动；不要空话。',
    templateText: '摘要\n要点\n后续行动',
  },
];

function ensureFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(promptsFile)) {
    fs.writeFileSync(promptsFile, JSON.stringify({
      presets: DEFAULT_REPORT_PRESETS,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }
}

function normalizePreset(item, index = 0) {
  const id = String(item?.id || '').trim() || randomUUID();
  const name = String(item?.name || '').trim() || `模板 ${index + 1}`;
  return {
    id,
    name: name.slice(0, 40),
    requirements: String(item?.requirements || '').trim().slice(0, 4000),
    templateText: String(item?.templateText || '').trim().slice(0, 2000),
  };
}

export function readReportPrompts() {
  let stored;
  if (usesStorageSnapshot()) stored = readSnapshotDocument(settingsKey('report-prompts'));
  else {
    ensureFile();
    stored = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  }
  const presets = Array.isArray(stored.presets)
    ? stored.presets.map(normalizePreset).filter((item) => item.requirements || item.templateText || item.name)
    : [...DEFAULT_REPORT_PRESETS];
  return {
    presets: presets.length ? presets : [...DEFAULT_REPORT_PRESETS],
    updatedAt: stored.updatedAt || null,
  };
}

export function saveReportPrompts(presets) {
  const list = (Array.isArray(presets) ? presets : []).map(normalizePreset);
  if (list.length > 40) {
    throw new Error('提示词模板最多保存 40 条');
  }
  const next = {
    presets: list,
    updatedAt: new Date().toISOString(),
  };
  if (usesStorageSnapshot()) stageSnapshotDocument(settingsKey('report-prompts'), next);
  else {
    ensureFile();
    fs.writeFileSync(promptsFile, JSON.stringify(next, null, 2));
  }
  return next;
}

export function resetReportPrompts() {
  return saveReportPrompts(DEFAULT_REPORT_PRESETS);
}

export function upsertReportPreset(preset) {
  const current = readReportPrompts();
  const nextItem = normalizePreset(preset);
  const index = current.presets.findIndex((item) => item.id === nextItem.id);
  const presets = [...current.presets];
  if (index >= 0) presets[index] = nextItem;
  else presets.push(nextItem);
  return saveReportPrompts(presets);
}

export function deleteReportPreset(id) {
  const current = readReportPrompts();
  return saveReportPrompts(current.presets.filter((item) => item.id !== id));
}
