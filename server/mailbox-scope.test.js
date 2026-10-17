import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithRequestContext } from './request-context.js';

test('登录用户只看到自己的邮箱，看不到共享 demo 邮箱', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-mb-scope-'));
  process.env.DAYLIGHT_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    activeMailboxId: 'default',
    mailboxes: [
      { id: 'default', email: '3462740458@qq.com', authorizationCode: 'x', provider: 'qq' },
    ],
    userPrefs: {},
    baseUrl: 'https://example.invalid/v1',
    apiKey: '',
    model: 'm',
  }, null, 2));

  const { readSettings, saveSettings } = await import(`./store.js?scope=${Date.now()}`);

  const shared = readSettings();
  assert.equal(shared.mailboxes[0].email, '3462740458@qq.com');

  const userA = runWithRequestContext({
    userId: 'user-a',
    user: { id: 'user-a', email: '15968588744@163.com' },
  }, () => readSettings());
  assert.equal(userA.mailboxes.length, 1);
  assert.equal(userA.mailboxes[0].email, '15968588744@163.com');
  assert.equal(userA.mailboxes[0].provider, '163');
  assert.equal(userA.mailboxes[0].ownerUserId, 'user-a');
  assert.notEqual(userA.mailboxes[0].id, 'default');
  assert.equal(userA.authorizationCode || '', '');

  runWithRequestContext({
    userId: 'user-a',
    user: { id: 'user-a', email: '15968588744@163.com' },
  }, () => {
    saveSettings({
      ...userA,
      mailboxes: [{
        ...userA.mailboxes[0],
        email: '15968588744@163.com',
        provider: '163',
        authorizationCode: 'auth-a',
      }],
      activeMailboxId: userA.mailboxes[0].id,
      baseUrl: userA.baseUrl,
      apiKey: '',
      model: userA.model,
    });
  });

  const againA = runWithRequestContext({
    userId: 'user-a',
    user: { id: 'user-a', email: '15968588744@163.com' },
  }, () => readSettings());
  assert.equal(againA.email, '15968588744@163.com');
  assert.equal(againA.mailboxes.length, 1);

  const userB = runWithRequestContext({
    userId: 'user-b',
    user: { id: 'user-b', email: 'other@qq.com' },
  }, () => readSettings());
  assert.equal(userB.mailboxes[0].email, 'other@qq.com');
  assert.equal(userB.mailboxes[0].provider, 'qq');
  assert.notEqual(userB.mailboxes[0].id, againA.mailboxes[0].id);

  const stillShared = readSettings();
  assert.ok(stillShared.mailboxes.some((item) => item.email === '3462740458@qq.com'));
  assert.ok(stillShared.mailboxes.some((item) => item.email === '15968588744@163.com'));
});
