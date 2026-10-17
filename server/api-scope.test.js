import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, beforeEach, test } from 'node:test';

// 前端按浏览器别名引入，Node 里换成真实源文件。
const encodeModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const imports = {
  '@/lib/auth-api': encodeModule('export const getAuthToken = () => globalThis.__apiScopeFixture.token;'),
  '@/lib/api-error': new URL('../src/lib/api-error.js', import.meta.url).href,
};
let source = await readFile(new URL('../src/lib/api.js', import.meta.url), 'utf8');
for (const [alias, target] of Object.entries(imports)) source = source.replace(`'${alias}'`, `'${target}'`);
const { request, setRequestMailboxId, setRequestScope, withViewScope } = await import(encodeModule(source));

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.__apiScopeFixture = { token: 'synthetic-token' };

beforeEach(() => {
  calls.length = 0;
  setRequestMailboxId('');
  setRequestScope(null);
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, headers: options?.headers || {} });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__apiScopeFixture;
});

// 混合视图下列表里能看到多个邮箱的日程/待办，写请求必须带上同一视图范围，
// 否则后端只会在活动邮箱里找，点开别的邮箱的日程就报「日程不存在。」。
test('混合视图下单个记录的写请求带上 scope=all', async () => {
  setRequestMailboxId('mb-active');
  setRequestScope({ scope: 'all' });
  await request('/events/evt-1', 'PUT', { title: '改期后的安排' });
  assert.equal(calls[0].url, '/api/events/evt-1?scope=all');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['X-Mailbox-Id'], 'mb-active');
});

test('标签视图用 tag 参数，单邮箱视图不带范围参数', async () => {
  setRequestScope({ tag: '招聘' });
  await request('/tasks/t-1', 'PUT', { status: 'done' });
  assert.equal(calls[0].url, `/api/tasks/t-1?tag=${encodeURIComponent('招聘')}`);

  setRequestScope(null);
  await request('/tasks/t-1', 'PUT', { status: 'done' });
  assert.equal(calls[1].url, '/api/tasks/t-1');
});

test('地址里已经带了范围参数就不重复拼接', async () => {
  setRequestScope({ scope: 'all' });
  await request('/state?scope=all');
  assert.equal(calls[0].url, '/api/state?scope=all');
  await request('/rag/search?tag=x');
  assert.equal(calls[1].url, '/api/rag/search?tag=x');
});

test('withViewScope 让直接 fetch 的地址（附件预览）也能定位归属邮箱', () => {
  setRequestScope({ scope: 'all' });
  assert.equal(withViewScope('/events/evt-1/materials/m-1/file'), '/events/evt-1/materials/m-1/file?scope=all');
  setRequestScope(null);
  assert.equal(withViewScope('/events/evt-1/materials/m-1/file'), '/events/evt-1/materials/m-1/file');
});
