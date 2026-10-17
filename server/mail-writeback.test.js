import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-writeback-'));
process.env.DAYLIGHT_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  activeMailboxId: 'default',
  mailboxes: [{
    id: 'default', provider: 'qq', email: 'fixture@qq.com', authorizationCode: 'invented-code',
    imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true,
  }],
  baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'm',
}, null, 2));

const {
  parseMailboxMessageRef, resolveMailFolder, resolveMailWriteBack,
  writeBackMailboxMessage, listMailboxFolders, readMailboxFlags,
} = await import(`./agent.js?writeback=${Date.now()}`);
const { normalizeMailboxWriteBack, normalizeMailbox, updateStoredEmail, saveStore, readStore } = await import(`./store.js?writeback=${Date.now()}`);

const scopedId = 'imap-v2:user-1:fixture%40qq.com:INBOX:42:7';

// 记录所有发出的 IMAP 写指令，验证「真的改到了哪一封、改了什么」。
function fakeClient({ flags = ['\\Seen'], folders = [], mailbox = { exists: 3, uidValidity: 42 }, fail = null } = {}) {
  const calls = [];
  const client = {
    calls,
    options: {},
    mailbox,
    async connect() {},
    async getMailboxLock(name) { calls.push({ op: 'lock', name }); return { release() {} }; },
    async messageFlagsAdd(range, list, options) {
      if (fail) throw fail;
      calls.push({ op: 'flagsAdd', range, list, options });
    },
    async messageFlagsRemove(range, list, options) {
      if (fail) throw fail;
      calls.push({ op: 'flagsRemove', range, list, options });
    },
    async messageMove(range, target, options) {
      if (fail) throw fail;
      calls.push({ op: 'move', range, target, options });
    },
    async *list() {
      for (const folder of folders) yield folder;
    },
    async *fetch(range, query) {
      if (fail) throw fail;
      calls.push({ op: 'fetch', range, query });
      yield { uid: 7, flags: new Set(flags) };
    },
    async logout() {},
  };
  return client;
}

test('parseMailboxMessageRef 还原两种历史 id，不能解析时返回 null', () => {
  assert.deepEqual(parseMailboxMessageRef(scopedId), {
    format: 'imap-v2', address: 'fixture@qq.com', folder: 'INBOX', uidValidity: 42, uid: 7,
  });
  assert.deepEqual(parseMailboxMessageRef('qq:fixture@qq.com:42:7'), {
    format: 'legacy', address: 'fixture@qq.com', folder: 'INBOX', uidValidity: 42, uid: 7,
  });
  assert.deepEqual(parseMailboxMessageRef('imap:fixture@qq.com:42:7'), {
    format: 'legacy', address: 'fixture@qq.com', folder: 'INBOX', uidValidity: 42, uid: 7,
  });
  // 绝不猜 uid：uid / uidValidity 必须都是正整数。
  for (const bad of ['', null, undefined, 'demo-1', 'qq:fixture@qq.com:42', 'qq:fixture@qq.com:42:0',
    'qq:fixture@qq.com:0:7', 'imap-v2:user-1:fixture%40qq.com:INBOX:42', 'trace-abc']) {
    assert.equal(parseMailboxMessageRef(bad), null, `应拒绝：${bad}`);
  }
});

test('resolveMailFolder 优先用 SPECIAL-USE，其次按常见命名兜底', () => {
  const folders = [
    { path: 'INBOX', name: 'Inbox', flags: [] },
    { path: '其他文件夹', name: '其他文件夹', flags: [] },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', flags: ['\\Archive'] },
    { path: '已删除', name: '已删除', specialUse: '\\Trash', flags: ['\\Trash'] },
  ];
  assert.equal(resolveMailFolder(folders, 'archive'), 'Archive');
  assert.equal(resolveMailFolder(folders, 'trash'), '已删除');

  // 服务器不报 SPECIAL-USE 时按名字兜底（含中文）。
  assert.equal(resolveMailFolder([{ path: '归档', name: '归档' }, { path: '废纸篓', name: '废纸篓' }], 'archive'), '归档');
  assert.equal(resolveMailFolder([{ path: 'Trash', name: 'Trash' }], 'trash'), 'Trash');
  assert.equal(resolveMailFolder([{ path: 'INBOX', name: 'Inbox' }], 'archive'), null);
  assert.equal(resolveMailFolder([], 'trash'), null);
  assert.equal(resolveMailFolder(null, 'trash'), null);
});

test('resolveMailWriteBack 关闭写回时一律拒绝，不给本地静默降级', () => {
  const reference = parseMailboxMessageRef(scopedId);
  assert.throws(() => resolveMailWriteBack({ action: 'read', reference, writeBack: { enabled: false } }),
    (error) => error.code === 'MAIL_WRITE_BACK_DISABLED' && error.status === 400);
  assert.throws(() => resolveMailWriteBack({ action: 'read', reference }),
    (error) => error.code === 'MAIL_WRITE_BACK_DISABLED');
});

test('resolveMailWriteBack 把动作翻译成 IMAP 指令与本地镜像补丁', () => {
  const reference = parseMailboxMessageRef(scopedId);
  const writeBack = { enabled: true, archiveFolder: '', trashFolder: '' };
  const now = new Date('2026-10-17T02:00:00.000Z');

  assert.deepEqual(resolveMailWriteBack({ action: 'read', reference, writeBack, now }).call,
    { ref: reference, action: 'flags', add: ['\\Seen'] });
  assert.deepEqual(resolveMailWriteBack({ action: 'unread', reference, writeBack, now }).patch, { seen: false });
  assert.deepEqual(resolveMailWriteBack({ action: 'flag', reference, writeBack, now }).call.add, ['\\Flagged']);
  assert.deepEqual(resolveMailWriteBack({ action: 'unflag', reference, writeBack, now }).call.remove, ['\\Flagged']);

  // 归档：设置里指定过就用指定的。
  const archived = resolveMailWriteBack({ action: 'archive', reference, writeBack: { ...writeBack, archiveFolder: '归档2026' }, now });
  assert.equal(archived.call.target, '归档2026');
  assert.deepEqual(archived.patch, { folder: '归档2026', archivedAt: '2026-10-17T02:00:00.000Z' });

  // 没指定过就从文件夹列表里找。
  const folders = [{ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }];
  assert.equal(resolveMailWriteBack({ action: 'archive', reference, writeBack, folders, now }).call.target, 'Archive');
  assert.throws(() => resolveMailWriteBack({ action: 'archive', reference, writeBack, folders: [], now }),
    (error) => error.code === 'MAIL_FOLDER_NOT_FOUND');

  // 手动移动必须带目标文件夹；未知动作直接拒绝。
  assert.throws(() => resolveMailWriteBack({ action: 'move', reference, writeBack, now }),
    (error) => error.code === 'MAIL_FOLDER_REQUIRED');
  assert.throws(() => resolveMailWriteBack({ action: 'delete-forever', reference, writeBack, now }),
    (error) => error.code === 'MAIL_ACTION_UNSUPPORTED');
});

test('normalizeMailboxWriteBack 默认关闭，缺省值稳定', () => {
  assert.deepEqual(normalizeMailboxWriteBack(undefined), { enabled: false, archiveFolder: '', trashFolder: '' });
  assert.deepEqual(normalizeMailboxWriteBack('yes'), { enabled: false, archiveFolder: '', trashFolder: '' });
  assert.deepEqual(normalizeMailboxWriteBack({ enabled: 'true' }), { enabled: false, archiveFolder: '', trashFolder: '' });
  assert.deepEqual(normalizeMailboxWriteBack({ enabled: true, archiveFolder: '  归档  ', trashFolder: '废纸篓' }),
    { enabled: true, archiveFolder: '归档', trashFolder: '废纸篓' });
  // 旧数据没有这个字段：读一遍不能把开关打开。
  assert.equal(normalizeMailbox({ id: 'default', email: 'a@qq.com' }).writeBack.enabled, false);
  assert.equal(normalizeMailbox({ id: 'default', email: 'a@qq.com', writeBack: { enabled: true } }).writeBack.enabled, true);
});

test('writeBackMailboxMessage 只改指定 uid，并把真邮箱错误翻成人话', async () => {
  const reference = parseMailboxMessageRef(scopedId);
  const client = fakeClient();
  const result = await writeBackMailboxMessage({ email: 'fixture@qq.com' }, {
    ref: reference, action: 'flags', add: ['\\Seen'],
  }, { clientFactory: () => client });
  assert.deepEqual(result, { ok: true, folder: 'INBOX' });
  assert.deepEqual(client.calls, [
    { op: 'lock', name: 'INBOX' },
    { op: 'flagsAdd', range: '7', list: ['\\Seen'], options: { uid: true } },
  ]);

  const mover = fakeClient();
  const moved = await writeBackMailboxMessage({ email: 'fixture@qq.com' }, {
    ref: reference, action: 'move', target: 'Archive',
  }, { clientFactory: () => mover });
  assert.equal(moved.folder, 'Archive');
  assert.deepEqual(mover.calls.at(-1), { op: 'move', range: '7', target: 'Archive', options: { uid: true } });

  // 定位不到（id 解析失败）时必须直接失败，不能连 IMAP 猜。
  await assert.rejects(writeBackMailboxMessage({ email: 'fixture@qq.com' }, {
    ref: null, action: 'flags', add: ['\\Seen'],
  }, { clientFactory: () => { throw new Error('不应该连接邮箱'); } }),
  (error) => error.code === 'MAIL_REF_UNKNOWN');

  // 真邮箱拒绝时如实报错，错误信息里带原始原因。
  const failing = fakeClient({ fail: Object.assign(new Error('Mailbox does not exist'), { responseText: 'NO Mailbox does not exist' }) });
  await assert.rejects(writeBackMailboxMessage({ email: 'fixture@qq.com' }, {
    ref: reference, action: 'move', target: '不存在的目录',
  }, { clientFactory: () => failing }),
  (error) => error.code === 'MAIL_WRITE_FAILED' && /写回邮箱失败/.test(error.message));
});

test('listMailboxFolders / readMailboxFlags 只读，不改真邮箱', async () => {
  const client = fakeClient({ folders: [
    { path: 'INBOX', name: 'Inbox', flags: new Set() },
    { path: 'Archive', name: 'Archive', flags: new Set(['\\Archive']) },
  ] });
  const folders = await listMailboxFolders({ email: 'fixture@qq.com' }, { clientFactory: () => client });
  assert.deepEqual(folders, [
    { path: 'INBOX', name: 'Inbox', specialUse: '', flags: [] },
    { path: 'Archive', name: 'Archive', specialUse: '', flags: ['\\Archive'] },
  ]);
  assert.equal(resolveMailFolder(folders, 'archive'), 'Archive');

  const seenClient = fakeClient({ flags: ['\\Seen', '\\Flagged'] });
  const flags = await readMailboxFlags({ email: 'fixture@qq.com' }, [7], { clientFactory: () => seenClient });
  assert.deepEqual([...flags], [[7, { seen: true, flagged: true }]]);
  // 一个 uid 都没有时不连接邮箱。
  const untouched = await readMailboxFlags({ email: 'fixture@qq.com' }, [], { clientFactory: () => { throw new Error('不应该连接邮箱'); } });
  assert.equal(untouched.size, 0);
});

test('updateStoredEmail 就地更新镜像字段，找不到时返回 null', () => {
  const mailboxId = 'default';
  saveStore({ events: [], tasks: [], emails: [{ id: scopedId, subject: '测试邮件', seen: false, flagged: false }] }, mailboxId);
  const updated = updateStoredEmail(mailboxId, scopedId, { seen: true, mailActions: [{ type: 'read', at: '2026-10-17T02:00:00.000Z' }] });
  assert.equal(updated.seen, true);
  assert.equal(readStore(mailboxId).emails[0].seen, true);
  assert.equal(readStore(mailboxId).emails[0].subject, '测试邮件');
  assert.equal(updateStoredEmail(mailboxId, '不存在', { seen: true }), null);
});
