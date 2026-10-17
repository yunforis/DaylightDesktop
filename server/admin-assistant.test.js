import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'work', 'admin-assistant-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
  postgres: { enabled: false },
  auth: { requireAuth: false, allowLocalDemoLogin: true, adminEmails: ['admin@example.invalid'], jwtSecret: 'test' },
}));
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'invented',
  model: 'fixture',
  activeMailboxId: 'default',
  mailboxes: [{ id: 'default', email: 'ops@example.invalid', provider: 'qq' }],
}));

const { buildAdminSearchIndex } = await import('./admin-assistant.js');

beforeEach(() => {
  // data dir already set
});

test('管理端搜索索引覆盖导航、配置与邮箱', async () => {
  const index = await buildAdminSearchIndex({ syncState: { status: 'idle' } });
  assert.ok(Array.isArray(index.items));
  assert.ok(index.items.length >= 12);
  const labels = index.items.map((item) => item.label).join('\n');
  assert.match(labels, /总览|用户管理|认证门禁|对象存储|系统发信/);
  assert.ok(index.items.some((item) => item.group === '导航'));
  assert.ok(index.items.some((item) => item.group === '系统配置'));
  assert.ok(index.items.some((item) => /飞书|RAG|model|模型/i.test(`${item.label} ${item.keywords || ''}`)));
});
