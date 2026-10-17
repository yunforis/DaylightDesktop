import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, saveSettings, readStore, saveStore, mailboxDirectory, normalizeMailbox } from './store.js';
import { readTraces, saveTraces } from './traces.js';
import { readPrompts, savePrompts } from './prompts.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');

export function exportBackup() {
  const settings = readSettings();
  const stores = {};
  const traces = {};
  for (const mailbox of settings.mailboxes) {
    stores[mailbox.id] = readStore(mailbox.id);
    traces[mailbox.id] = readTraces(mailbox.id);
  }
  return {
    version: 1,
    app: 'daylight',
    exportedAt: new Date().toISOString(),
    settings,
    prompts: readPrompts(),
    stores,
    traces,
    note: '本地备份包含授权码与 API Key，请勿上传到公开仓库或聊天。',
  };
}

export function restoreBackup(payload = {}) {
  if (!payload || payload.app !== 'daylight' || !payload.settings?.mailboxes) {
    throw new Error('备份格式不正确，需要 Daylight 导出的 JSON。');
  }
  const settings = {
    ...payload.settings,
    mailboxes: payload.settings.mailboxes.map(normalizeMailbox),
  };
  if (!settings.mailboxes.some((mailbox) => mailbox.id === settings.activeMailboxId)) {
    settings.activeMailboxId = settings.mailboxes[0].id;
  }
  saveSettings(settings);
  if (payload.prompts?.extractionSystem) {
    savePrompts({ extractionSystem: payload.prompts.extractionSystem });
  }
  for (const mailbox of settings.mailboxes) {
    const store = payload.stores?.[mailbox.id] || { events: [], emails: [], tasks: [], lastSync: null };
    fs.mkdirSync(mailboxDirectory(mailbox.id), { recursive: true });
    saveStore({
      events: store.events || [],
      emails: store.emails || [],
      tasks: store.tasks || [],
      lastSync: store.lastSync || null,
    }, mailbox.id);
    saveTraces(payload.traces?.[mailbox.id] || [], mailbox.id);
  }
  return { ok: true, mailboxes: settings.mailboxes.length, activeMailboxId: settings.activeMailboxId };
}

export function backupFileHint() {
  return path.join(dataDir, `daylight-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
