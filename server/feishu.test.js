import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMeeting } from './feishu.js';

function settings() { return { feishu: { appId: `test-${randomUUID()}`, appSecret: 'synthetic-secret', ownerId: 'ou_test_hr' } }; }
function interview(offsetDays = 1) {
  const start = new Date(Date.now() + offsetDays * 86400000);
  return { topic: '候选人面试', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }

test('飞书使用新版应用凭证接口，创建真实返回链接；改期复用预约与缓存凭证', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://accounts.feishu.cn/oauth/v3/token') {
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      assert.equal(options.body.get('client_secret'), 'synthetic-secret');
      return json({ code: 0, access_token: 'synthetic-token', expires_in: 7200 });
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    const payload = JSON.parse(options.body);
    assert.equal(payload.meeting_settings.topic, '候选人面试');
    return json({ code: 0, data: { reserve: { id: 'reserve-123', url: 'https://vc.feishu.cn/j/123456789',
      meeting_no: '123456789', end_time: payload.end_time } } });
  });
  const config = settings();
  const original = interview();
  const created = await prepareMeeting(config, original);
  assert.equal(created.url, 'https://vc.feishu.cn/j/123456789');
  assert.equal(created.id, 'reserve-123');
  assert.ok(Math.abs(Date.parse(created.expiresAt) - Date.parse(original.end) - 3600000) < 1000);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).owner_id, 'ou_test_hr');
  await prepareMeeting(config, { ...interview(2), id: created.id });
  assert.equal(calls.length, 3, '改期不重复获取 token');
  assert.equal(calls[2].options.method, 'PUT');
  assert.match(calls[2].url, /reserves\/reserve-123\?user_id_type=open_id$/);
  assert.equal(JSON.parse(calls[2].options.body).owner_id, undefined);
});

test('飞书配置、时间缺失与超过 30 天范围在发请求前提示', async (t) => {
  const fakeFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应请求'); });
  await assert.rejects(prepareMeeting({}, interview()), /App ID.*Open ID/);
  await assert.rejects(prepareMeeting(settings(), interview(31)), /30 天.*手动填写/);
  await assert.rejects(prepareMeeting(settings(), interview(-2)), /已经过去/);
  await assert.rejects(prepareMeeting(settings(), { ...interview(), end: 'not-a-date' }), /有效的面试/);
  assert.equal(fakeFetch.mock.callCount(), 0);
});

test('飞书接口错误不会泄露密钥，不伪造链接', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('/oauth/')
    ? json({ access_token: 'sensitive-token', expires_in: 7200 })
    : json({ code: 121005, msg: 'denied synthetic-secret sensitive-token' }, 403));
  await assert.rejects(prepareMeeting(settings(), interview()), (error) => {
    assert.match(error.message, /denied/);
    assert.doesNotMatch(error.message, /synthetic-secret|sensitive-token/);
    return true;
  });
});

test('飞书没有返回真实链接时失败，过期凭证重新获取', async (t) => {
  let authCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/oauth/')) { authCalls++; return json({ access_token: 'short-token', expires_in: 1 }); }
    return json({ code: 0, data: { reserve: { id: 'reserve-123', end_time: String(Math.floor(Date.now() / 1000) + 3600) } } });
  });
  const config = settings();
  await assert.rejects(prepareMeeting(config, interview()), /真实入会链接/);
  await assert.rejects(prepareMeeting(config, interview()), /真实入会链接/);
  assert.equal(authCalls, 2);
});
