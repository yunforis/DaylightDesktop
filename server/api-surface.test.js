import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyApiPath, isProductionApiPath, LEGACY_AREAS, PRODUCTION_AREAS } from './api-surface.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 这份清单是「生产模式到底能服务哪些业务」的答案。曾经邮箱知识库、邀请回信、私密日历订阅
// 和两个 emails/:id 重跑入口都实现了却不在生产白名单里，部署后一律 503，功能等于不存在。
test('生产接口面：共享存储上的业务可服务', () => {
  const production = [
    '/auth/login', '/auth/captcha', '/state', '/settings', '/mailboxes/mb-1/activate',
    '/scenarios/sc-1', '/jobs', '/jobs/9f1/retry', '/sync/qq',
    '/tasks', '/tasks/t-1', '/events', '/events/e-1', '/events/e-1/materials',
    '/traces', '/traces/abc/feedback', '/recruitment', '/recruitment/chat',
    '/assistant/chat', '/assistant/drafts/d-1/send',
    '/calendar-sync/connections', '/calendar-sync/subscription', '/calendar-sync/oauth/callback',
    '/infra/public', '/material-kinds',
    // 本轮修复：这些路径已经迁到共享存储，但当时没有登记，生产直接 503
    '/rag/status', '/rag/search', '/rag/reindex', '/rag/ensure', '/rag/ask',
    '/invitations', '/invitations/e-1', '/invitation-preferences',
    '/emails/e-1/extract-invoices', '/emails/e-1/resolve-match',
    // 附件下载：正则路由（/^\/api\/attachments\/(.+)$/）不会被下面的字符串路由枚举扫到，
    // 曾经因此没有登记、生产 503，而它本来就由共享存储中间件 + 归属校验服务。
    '/attachments/resume.pdf',
    '/calendar.ics',
    // 提醒规则解析：无状态，只把一句话翻成规则草稿，规则本身存在手机端
    '/reminders/parse',
  ];
  for (const route of production) {
    assert.equal(isProductionApiPath(route), true, `${route} 必须在生产可服务`);
  }
});

test('生产接口面：本地文件流程被显式拒绝，而不是静默降级', () => {
  const legacy = [
    '/admin/overview', '/admin/users/u-1', '/backup', '/backup/restore',
    '/calendar-categories', '/demo', '/infra/reload', '/mail-filters',
    '/onboarding/guide', '/persistence', '/prompts', '/prompts/revisions',
    '/report-prompts', '/report-prompts/presets/p-1', '/test/model', '/test/mailbox',
  ];
  for (const route of legacy) {
    const verdict = classifyApiPath(route);
    assert.equal(verdict.status, 'legacy', `${route} 应被明确判为未迁移流程`);
    assert.ok(verdict.reason, `${route} 需要一句为什么还不能上生产`);
  }
  // 旧版直达发信入口：路径已迁移，但发信必须经助手审核发送
  assert.equal(classifyApiPath('/traces/abc/send').status, 'legacy_workflow');
  assert.equal(isProductionApiPath('/traces/abc/send'), false);
  // 没人为它表态的路径不能悄悄放过
  assert.equal(classifyApiPath('/nobody/registered/this').status, 'unclassified');
  assert.equal(classifyApiPath('').status, 'unclassified');
});

test('生产接口面：按段匹配，不能把前缀相同的陌生路径放进来', () => {
  assert.equal(isProductionApiPath('/material-kindsx'), false);
  assert.equal(isProductionApiPath('/statex'), false);
  assert.equal(isProductionApiPath('/settingsx'), false);
  assert.equal(isProductionApiPath('/state/x'), false);
  assert.equal(isProductionApiPath('/settings/x'), false);
  assert.equal(isProductionApiPath('/invitation-preferences/x'), false);
  assert.equal(isProductionApiPath('/infra/public/x'), false);
  assert.equal(isProductionApiPath('/calendar-syncx'), false);
  assert.equal(isProductionApiPath('/calendar.ics/x'), false);
  assert.equal(isProductionApiPath('/rag'), true, '区域根路径本身也应可服务');
});

test('接口面分类表自身一致：条目互不重叠且都能匹配自身', () => {
  for (const entry of PRODUCTION_AREAS.keys()) {
    const area = entry.replace(/\$$/, '');
    assert.equal(LEGACY_AREAS.has(entry), false, `${entry} 不能同时登记为生产与旧流程`);
    const verdict = classifyApiPath(`/${area}`);
    assert.equal(verdict.status, 'production', `${entry} 应能匹配自身样本`);
    assert.equal(verdict.area, area);
    assert.ok(PRODUCTION_AREAS.get(entry), `${entry} 需要写明为什么可以上生产`);
  }
  for (const entry of LEGACY_AREAS.keys()) {
    const area = entry.replace(/\$$/, '');
    assert.equal(classifyApiPath(`/${area}`).status, 'legacy', `${entry} 应能匹配自身样本`);
  }
});

test('index.js 注册的每个 /api 路由都必须在接口面里被明确表态', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const routes = new Set();
  for (const match of source.matchAll(/app\.(?:get|post|put|patch|delete|use)\(\s*'(\/api[^']*)'/g)) {
    const full = match[1];
    if (full === '/api' || full === '/api/') continue;
    routes.add(full.slice('/api'.length));
  }
  assert.ok(routes.size >= 40, `应当能解析出全部 /api 路由，实际只找到 ${routes.size} 个`);
  const unclassified = [...routes].filter((route) => classifyApiPath(route).status === 'unclassified').sort();
  assert.deepEqual(unclassified, [],
    '新增的 /api 路由必须在 api-surface.js 里登记为生产可服务或刻意保留的旧流程，否则生产会 503 而没人知道为什么');
  assert.ok(routes.has('/rag/ask'), '解析结果应当包含本轮修复的知识库路由');
  assert.ok(routes.has('/calendar.ics'));
  assert.ok(routes.has('/invitations'));
});
