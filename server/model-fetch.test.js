import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelFetchProxyUrl, modelFetch, resetModelFetchProxyCache } from './model-fetch.js';

test('无代理时 modelFetch 仍可调用（本机环回）', async () => {
  resetModelFetchProxyCache();
  // 不强制有代理；只确认函数可返回 Response / 抛出带 message 的错误
  try {
    await modelFetch('http://127.0.0.1:9/', { method: 'GET', signal: AbortSignal.timeout(500) });
  } catch (error) {
    assert.ok(error.message || error.cause);
  }
});

test('探测缓存可重置', () => {
  resetModelFetchProxyCache();
  assert.equal(getModelFetchProxyUrl(), process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
});
