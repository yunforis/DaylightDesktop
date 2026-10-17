import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMailboxEmails, processEmails } from './agent.js';
import { createTraceRecorder } from './traces.js';

const settings = { email: 'synthetic@example.invalid', authorizationCode: 'invented-mailbox-read-code', fetchLimit: 3 };
const idFor = (uid, validity = 10, prefix = 'qq') => `${prefix}:${settings.email}:${validity}:${uid}`;

function message(uid, minute, textLength = 100) {
  const date = new Date(`2026-10-14T08:${String(minute).padStart(2, '0')}:00+08:00`);
  return { uid, internalDate: date, source: Buffer.from([
    'From: Fixture <sender@example.invalid>', `Subject: Synthetic UID ${uid}`,
    `Date: ${date.toUTCString()}`, 'Content-Type: text/plain; charset=utf-8', '',
    'x'.repeat(textLength),
  ].join('\r\n')) };
}

function fixture(messages, uidValidity = 10) {
  const calls = [];
  const lifecycle = [];
  let metadataFinished = false;
  let downloadedBytes = 0;
  const client = {
    mailbox: { exists: messages.length, uidValidity },
    async connect() { lifecycle.push('connect'); },
    async getMailboxLock(mailbox) {
      lifecycle.push(`lock:${mailbox}`);
      return { release() { lifecycle.push('release'); } };
    },
    async *fetch(range, query, options) {
      calls.push({ range, query, options });
      if (!query.source) {
        const first = Number(range.split(':')[0]);
        for (const { uid, internalDate } of messages.slice(first - 1)) yield { uid, internalDate };
        metadataFinished = true;
      } else {
        assert.equal(metadataFinished, true, '先完整消费元数据获取，不能嵌套 IMAP 命令');
        assert.equal(options?.uid, true, '原文范围是 UID，不是邮件序号');
        const uids = new Set(range.split(',').map(Number));
        for (const item of messages.filter(({ uid }) => uids.has(uid))) {
          downloadedBytes += item.source.length;
          yield item;
        }
      }
    },
    async logout() { lifecycle.push('logout'); },
    close() { lifecycle.push('close'); },
  };
  return { clientFactory: () => client, calls, lifecycle, get downloadedBytes() { return downloadedBytes; } };
}

test('最近 N 封先获取 UID，成功邮件不下载或解析，失败与新邮件仍按发送时间提取', async () => {
  // UIDs intentionally differ from sequence numbers; the two new dates are out of UID order.
  const messages = [message(11, 1), message(12, 2), message(13, 3), message(101, 4), message(205, 6), message(309, 5)];
  const imap = fixture(messages);
  const store = { events: [], tasks: [], emails: [{ id: idFor(101), status: 'skipped' }] };
  const recorder = createTraceRecorder();
  const progress = [];
  const emails = await readMailboxEmails(settings, { clientFactory: imap.clientFactory, recorder,
    processedIds: new Set(store.emails.map(({ id }) => id)), onProgress: (item) => progress.push(item) });
  assert.deepEqual(imap.calls, [
    { range: '4:*', query: { uid: true, internalDate: true }, options: undefined },
    { range: '205,309', query: { source: true, uid: true, internalDate: true }, options: { uid: true } },
  ]);
  assert.equal(imap.downloadedBytes, messages[4].source.length + messages[5].source.length);
  assert.deepEqual(emails.find(({ id }) => id === idFor(101)), { id: idFor(101), receivedAt: messages[3].internalDate.toISOString() });
  assert.equal(recorder.traces.length, 2);
  assert.ok(recorder.traces.every((trace) => trace.spans.some(({ stage, status }) => stage === 'queue_wait' && status === 'running')));
  const order = [];
  const result = await processEmails(store, emails, async (email) => {
    order.push(email.id);
    return { summary: '合成普通通知。', events: [], tasks: [] };
  }, 'qq', { recorder });
  assert.deepEqual(order, [idFor(309), idFor(205)]);
  assert.equal(result.total, 3);
  assert.equal(result.duplicate, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.errors, []);
  assert.ok(recorder.traces.every((trace) => trace.status === 'skipped'));
  assert.deepEqual(imap.lifecycle, ['connect', 'lock:INBOX', 'release', 'logout']);
  assert.equal(progress.at(-1).received, 3);
  assert.equal(progress.at(-1).total, 3);
});

test('15 封已处理的大邮件仅检查元数据，正文下载字节为零且不创建新日志或模型请求', async () => {
  const messages = Array.from({ length: 20 }, (_, index) => message(100 + index, index, 64 * 1024));
  const imap = fixture(messages);
  const store = { events: [], tasks: [], emails: messages.slice(5).map(({ uid }) => ({ id: idFor(uid), status: 'imported' })) };
  const recorder = createTraceRecorder();
  const emails = await readMailboxEmails({ ...settings, fetchLimit: 15 }, { clientFactory: imap.clientFactory, recorder,
    processedIds: new Set(store.emails.map(({ id }) => id)) });
  assert.deepEqual(imap.calls, [{ range: '6:*', query: { uid: true, internalDate: true }, options: undefined }]);
  assert.equal(imap.downloadedBytes, 0);
  assert.ok(messages.slice(5).reduce((sum, item) => sum + item.source.length, 0) > 960 * 1024);
  assert.deepEqual(recorder.traces, []);
  const result = await processEmails(store, emails, async () => assert.fail('已处理邮件不能调用模型'), 'qq', { recorder });
  assert.equal(result.total, 15);
  assert.equal(result.duplicate, 15);
  assert.deepEqual(recorder.traces, []);
});

test('UIDVALIDITY 变化需要重新读取，同账号默认前缀与新邮箱前缀保持原去重规则', async (t) => {
  for (const [name, mailboxSettings, prefix] of [
    ['默认邮箱切换服务商仍使用 qq 前缀', { ...settings, email: settings.email.toUpperCase(), provider: 'custom' }, 'qq'],
    ['独立邮箱使用 imap 前缀', { ...settings, id: 'synthetic-mailbox' }, 'imap'],
  ]) await t.test(name, async () => {
    const imap = fixture([message(101, 1)], 11);
    const emails = await readMailboxEmails(mailboxSettings, { clientFactory: imap.clientFactory,
      processedIds: new Set([idFor(101, 10, prefix)]) });
    assert.equal(emails[0].id, idFor(101, 11, prefix));
    assert.equal(imap.calls[1].range, '101');
    assert.ok(imap.downloadedBytes > 0);
  });
});

test('失败邮件再次读取原文并重试，成功后只读取元数据并保留同一条历史日志', async () => {
  const messages = [message(101, 1)];
  const store = { events: [], tasks: [], emails: [] };
  const recorder = createTraceRecorder();
  const first = fixture(messages);
  const emails = await readMailboxEmails(settings, { clientFactory: first.clientFactory, recorder });
  const failure = await processEmails(store, emails, async () => { throw new Error('合成模型暂时失败'); }, 'qq', { recorder });
  assert.equal(failure.errors.length, 1);
  assert.equal(store.emails.length, 0);
  assert.equal(recorder.traces[0].status, 'failed');
  const second = fixture(messages);
  const retryEmails = await readMailboxEmails(settings, { clientFactory: second.clientFactory, recorder,
    processedIds: new Set(store.emails.map(({ id }) => id)) });
  const success = await processEmails(store, retryEmails, async () => ({ summary: '合成普通通知。', events: [], tasks: [] }), 'qq', { recorder });
  assert.deepEqual(success.errors, []);
  assert.equal(second.downloadedBytes, messages[0].source.length);
  assert.equal(recorder.traces.length, 1);
  assert.deepEqual(recorder.traces[0].attempts.map(({ status }) => status), ['failed', 'skipped']);
  const third = fixture(messages);
  await readMailboxEmails(settings, { clientFactory: third.clientFactory, recorder,
    processedIds: new Set(store.emails.map(({ id }) => id)) });
  assert.equal(third.downloadedBytes, 0);
  assert.equal(recorder.traces[0].attempts.length, 2);
});

test('空收件箱不获取元数据或原文，仍正常释放锁并退出', async () => {
  const imap = fixture([]);
  assert.deepEqual(await readMailboxEmails(settings, { clientFactory: imap.clientFactory }), []);
  assert.deepEqual(imap.calls, []);
  assert.deepEqual(imap.lifecycle, ['connect', 'lock:INBOX', 'release', 'logout']);
});

test('连接或打开收件箱失败立即关闭连接，保留原错误且不执行额外登出网络请求', async (t) => {
  for (const stage of ['connect', 'select']) await t.test(stage, async () => {
    const lifecycle = [];
    const client = {
      async connect() {
        lifecycle.push('connect');
        if (stage === 'connect') throw new Error('合成连接失败');
      },
      async getMailboxLock() { lifecycle.push('select'); throw new Error('合成收件箱打开失败'); },
      async logout() { assert.fail('失败连接无需等待额外登出请求'); },
      close() { lifecycle.push('close'); },
    };
    await assert.rejects(readMailboxEmails(settings, { clientFactory: () => client }),
      stage === 'connect' ? /合成连接失败/ : /合成收件箱打开失败/);
    assert.deepEqual(lifecycle, stage === 'connect' ? ['connect', 'close'] : ['connect', 'select', 'close']);
  });
});

test('原文读取中断结束已创建日志，释放锁并立即关闭连接', async () => {
  const imap = fixture([message(101, 1)]);
  const client = imap.clientFactory();
  const originalFetch = client.fetch;
  client.fetch = async function* (range, query, options) {
    yield* originalFetch(range, query, options);
    if (query.source) throw new Error('合成读取中断');
  };
  const recorder = createTraceRecorder();
  await assert.rejects(readMailboxEmails(settings, { clientFactory: imap.clientFactory, recorder }), /合成读取中断/);
  assert.deepEqual(imap.lifecycle, ['connect', 'lock:INBOX', 'release', 'close']);
  assert.equal(recorder.traces.length, 1);
  assert.equal(recorder.traces[0].status, 'failed');
  assert.ok(recorder.traces[0].spans.every(({ status }) => status !== 'running'));
});
