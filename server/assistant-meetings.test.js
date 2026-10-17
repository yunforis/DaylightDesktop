import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// All meetings, addresses, credentials and remote responses are synthetic. No external services are contacted.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(root, 'work', 'assistant-meetings-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
const { saveInfraConfig } = await import('./infra/config.js');
const { readStore, saveStore, saveSettings, mailboxDirectory } = await import('./store.js');
const { createAssistantMeeting } = await import('./assistant-meetings.js');
const { readAssistantMeetingOperations, withAssistantMeetingMailboxLock } = await import('./assistant-meetings-store.js');
const { listAssistantDrafts, updateAssistantDraft } = await import('./assistant-actions.js');
saveInfraConfig({ postgres: { enabled: false }, mq: { enabled: false } });

let sequence = 0;
const mailboxes = [];
const config = () => {
  const id = `synthetic-meetings-${++sequence}`;
  mailboxes.push({ id, email: `sender-${sequence}@example.invalid`, authorizationCode: 'invented-smtp-code' });
  const settings = { mailboxes: [...mailboxes], activeMailboxId: id,
    feishu: { appId: `invented-app-${sequence}`, appSecret: 'invented-secret', ownerId: 'ou_synthetic_owner' } };
  saveSettings(settings);
  return { id, settings };
};
function args(extra = {}) {
  const start = Date.now() + 2 * 86400_000;
  return { title: '合成项目周会', start: new Date(start).toISOString(), end: new Date(start + 3600_000).toISOString(),
    attendees: 'colleague@example.invalid;other@example.invalid', description: '讨论合成报告的提交进度。',
    operationKey: `synthetic-operation-${++sequence}`, ...extra };
}
const reserve = () => ({ id: 'synthetic-reserve', url: 'https://vc.feishu.cn/j/synthetic',
  meetingNo: 'synthetic-123', password: 'synthetic-password', expiresAt: new Date(Date.now() + 4 * 86400_000).toISOString() });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('模拟飞书接口返回链接后写入当前邮箱日历，生成可审核邀约并幂等返回最新草稿', async (t) => {
  const { id, settings } = config();
  const input = args({ start: new Date(Date.now() + 86400_000).toISOString() });
  input.end = new Date(Date.parse(input.start) + 3600_000).toISOString();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/oauth/')) return json({ access_token: 'synthetic-access-token', expires_in: 7200 });
    const payload = JSON.parse(options.body);
    assert.equal(payload.meeting_settings.topic, input.title);
    assert.equal(payload.start_time, undefined, '飞书 reserve 没有按日历时间预约开始');
    return json({ code: 0, data: { reserve: { ...reserve(), end_time: payload.end_time } } });
  });
  const first = await createAssistantMeeting(id, input, settings);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 2, '仅有凭证和建会调用，没有 SMTP 或模型调用');
  assert.equal(first.event.source, 'assistant');
  assert.match(first.event.start, /\+08:00$/);
  assert.equal(first.meeting.scheduledStart, first.event.start);
  assert.equal(first.meeting.scheduledEnd, first.event.end);
  assert.equal(first.meeting.reservationOnly, true);
  assert.match(first.draft.body, /北京时间，UTC\+08:00/);
  assert.ok(first.draft.body.includes(first.meeting.url));
  assert.match(first.draft.body, /colleague@example.invalid、other@example.invalid/);
  assert.match(first.draft.body, /有效期不限制入会开始时间/);
  assert.equal(first.draft.status, 'pending');
  assert.equal(first.draft.kind, 'meeting_invitation');
  assert.equal(first.draft.eventId, first.event.id);
  assert.equal(readStore(id).events.length, 1);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 1);
  const edited = await updateAssistantDraft(id, first.draft.id, { revision: 1, body: `${first.draft.body}\n请提前准备。` });
  const replay = await createAssistantMeeting(id, input, settings);
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.body, edited.draft.body, '重试返回审核后的最新草稿');
  assert.equal(calls.length, 2);
  assert.equal(readStore(id).events.length, 1);
  assert.equal((await readAssistantMeetingOperations(id)).operations[0].status, 'completed');
});

test('时间、收件人、归属和飞书配置在外部副作用前校验，缺时区按北京时间，日期不自动滚动', async () => {
  const { id, settings } = config();
  let called = 0;
  const dependencies = { prepareMeeting: async () => { called++; return reserve(); } };
  for (const [extra, pattern] of [
    [{ start: '2026-02-30T10:00' }, /日期或时间无效/],
    [{ start: 'tomorrow' }, /明确/],
    [{ start: '2026-10-20T25:00' }, /无效/],
    [{ start: '2026-10-20T10:00+15:00' }, /无效/],
    [{ attendees: 'Friendly <person@example.invalid>' }, /裸邮箱/],
    [{ attendees: 'person@example.invalid\r\nBcc: hidden@example.invalid' }, /裸邮箱/],
    [{ attendees: [] }, /收件人/],
    [{ start: new Date(Date.now() - 86400_000).toISOString() }, /已经过去/],
    [{ end: new Date(Date.now() + 31 * 86400_000).toISOString() }, /30 天/],
  ]) await assert.rejects(createAssistantMeeting(id, args(extra), settings, dependencies), pattern);
  await assert.rejects(createAssistantMeeting('not-owned', args(), settings, dependencies), /无权访问/);
  await assert.rejects(createAssistantMeeting(id, args(), { ...settings, feishu: {} }, dependencies), /App ID/);
  const next = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const local = await createAssistantMeeting(id, args({ start: `${next}T10:00`, end: `${next}T11:00`, attendees: ['person@example.invalid'] }), settings, dependencies);
  assert.equal(local.event.start, `${next}T10:00:00+08:00`);
  assert.equal(called, 1);
});

test('已有有效日程冲突阻止建会，取消或全天安排不阻止，保留其他邮箱数据', async () => {
  const { id, settings } = config();
  const input = args();
  const event = { id: 'existing', title: '原有合成安排', start: input.start, end: input.end, source: 'manual' };
  saveStore({ events: [event], emails: [{ id: 'synthetic-email' }], tasks: [{ id: 'synthetic-task' }] }, id);
  let called = 0;
  const dependencies = { prepareMeeting: async () => { called++; return reserve(); } };
  const conflict = await createAssistantMeeting(id, input, settings, dependencies);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflicts[0].id, 'existing');
  assert.ok(conflict.suggestedSlots.length);
  assert.equal(called, 0);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 0);
  saveStore({ events: [{ ...event, status: 'cancelled' }, { ...event, id: 'all-day', allDay: true }],
    emails: [{ id: 'synthetic-email' }], tasks: [{ id: 'synthetic-task' }] }, id);
  const result = await createAssistantMeeting(id, input, settings, dependencies);
  assert.equal(result.ok, true);
  assert.equal(readStore(id).events.length, 3);
  assert.equal(readStore(id).emails[0].id, 'synthetic-email');
  assert.equal(readStore(id).tasks[0].id, 'synthetic-task');
  const another = config();
  assert.equal(readStore(another.id).events.length, 0);
});

test('相同操作并发只建一次会议，不同参数复用操作编号会明确拒绝', async () => {
  const { id, settings } = config();
  const input = args();
  let called = 0;
  const dependencies = { prepareMeeting: async () => { called++; await Promise.resolve(); return reserve(); } };
  const results = await Promise.all([createAssistantMeeting(id, input, settings, dependencies), createAssistantMeeting(id, input, settings, dependencies)]);
  assert.ok(results.every((item) => item.ok));
  assert.equal(called, 1);
  assert.equal(new Set(results.map((item) => item.draft.id)).size, 1);
  assert.equal(readStore(id).events.length, 1);
  await assert.rejects(createAssistantMeeting(id, { ...input, title: '另一项会议' }, settings, dependencies), /另一组安排/);
  assert.equal(called, 1);
});

test('外部超时或无效链接保留未知状态，重复操作不盲重建且错误脱敏', async () => {
  for (const failure of [new Error('timeout invented-secret invented-smtp-code'), null]) {
    const { id, settings } = config();
    const input = args();
    let called = 0;
    const dependencies = { prepareMeeting: async () => { called++; if (failure) throw failure; return { id: 'synthetic', url: 'http://invalid.example.invalid' }; } };
    const first = await createAssistantMeeting(id, input, settings, dependencies);
    assert.equal(first.ok, false);
    assert.equal(first.status, 'needs_attention');
    assert.equal(first.code, 'MEETING_OUTCOME_UNKNOWN');
    assert.doesNotMatch(first.error, /invented-secret|invented-smtp-code/);
    const retry = await createAssistantMeeting(id, input, settings, dependencies);
    assert.equal(retry.code, 'MEETING_OUTCOME_UNKNOWN');
    const newChatRetry = await createAssistantMeeting(id, { ...input, operationKey: `new-chat-${input.operationKey}` }, settings, dependencies);
    assert.equal(newChatRetry.code, 'MEETING_OUTCOME_UNKNOWN', '新的聊天请求也不能绕过待核对的外部结果');
    assert.equal(called, 1);
    assert.equal(readStore(id).events.length, 0);
    assert.equal((await listAssistantDrafts(id)).drafts.length, 0);
    assert.equal((await readAssistantMeetingOperations(id)).operations[0].status, 'needs_attention');
  }
});

test('飞书链接已取得但本地日历写入失败时可追溯，并只恢复保存，不重复建会', async () => {
  const { id, settings } = config();
  const input = args();
  let called = 0;
  const prepare = async () => { called++; return reserve(); };
  const first = await createAssistantMeeting(id, input, settings, {
    prepareMeeting: prepare,
    withMailboxLock: (mailboxId, change) => withAssistantMeetingMailboxLock(mailboxId, (repository) => change({ ...repository,
      saveCalendar: async () => { throw new Error('synthetic disk failure'); } })),
  });
  assert.equal(first.ok, false);
  assert.equal(first.meeting.url, reserve().url);
  assert.match(first.error, /disk failure/);
  assert.equal(readStore(id).events.length, 0);
  const checkpoint = (await readAssistantMeetingOperations(id)).operations[0];
  assert.equal(checkpoint.meeting.id, 'synthetic-reserve');
  const resumed = await createAssistantMeeting(id, input, settings, { prepareMeeting: prepare });
  assert.equal(resumed.ok, true);
  assert.equal(called, 1);
  assert.equal(readStore(id).events.length, 1);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 1);
});

test('审核草稿保存失败保留会议和日程，重试补草稿且不重复日程', async () => {
  const { id, settings } = config();
  const input = args();
  let called = 0;
  const prepare = async () => { called++; return reserve(); };
  const first = await createAssistantMeeting(id, input, settings, { prepareMeeting: prepare,
    createAssistantDraft: async () => { throw new Error('synthetic draft storage failure'); } });
  assert.equal(first.status, 'needs_attention');
  assert.equal(first.event.id, readStore(id).events[0].id);
  assert.ok(first.meeting.url);
  const recovered = await createAssistantMeeting(id, input, settings, { prepareMeeting: prepare });
  assert.equal(recovered.ok, true);
  assert.equal(called, 1);
  assert.equal(readStore(id).events.length, 1);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 1);
});

test('飞书返回后检查点持续写失败仍向用户给出已创建链接，持久化的preparing禁止再次建会', async () => {
  const { id, settings } = config();
  const input = args();
  let called = 0;
  let saves = 0;
  const dependencies = { prepareMeeting: async () => { called++; return reserve(); },
    withMailboxLock: (mailboxId, change) => withAssistantMeetingMailboxLock(mailboxId, (repository) => change({ ...repository,
      save: async (data) => {
        saves++;
        if (saves > 1) throw new Error('synthetic checkpoint disk failure');
        await repository.save(data);
      } })),
  };
  const result = await createAssistantMeeting(id, input, settings, dependencies);
  assert.equal(result.code, 'MEETING_CHECKPOINT_FAILED');
  assert.ok(result.meeting.url);
  assert.match(result.notice, /保留本次链接/);
  const persisted = (await readAssistantMeetingOperations(id)).operations[0];
  assert.equal(persisted.status, 'preparing');
  const retry = await createAssistantMeeting(id, input, settings, { prepareMeeting: dependencies.prepareMeeting });
  assert.equal(retry.code, 'MEETING_OUTCOME_UNKNOWN');
  assert.equal(called, 1);
  assert.equal(readStore(id).events.length, 0);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 0);
});

test('建会后并发出现冲突会展示已生成链接，不生成可发草稿；消除冲突后复用链接', async () => {
  const { id, settings } = config();
  const input = args();
  let called = 0;
  const dependencies = { prepareMeeting: async () => {
    called++;
    const store = readStore(id);
    store.events.push({ id: 'racing-event', title: '合成并发安排', start: input.start, end: input.end });
    saveStore(store, id);
    return reserve();
  } };
  const first = await createAssistantMeeting(id, input, settings, dependencies);
  assert.equal(first.status, 'conflict');
  assert.ok(first.meeting.url);
  assert.equal((await listAssistantDrafts(id)).drafts.length, 0);
  const store = readStore(id);
  store.events[0].status = 'cancelled';
  saveStore(store, id);
  const resumed = await createAssistantMeeting(id, input, settings, dependencies);
  assert.equal(resumed.ok, true);
  assert.equal(called, 1);
});

test('已经完成的操作在日程被删除后不会把日程重新加回', async () => {
  const { id, settings } = config();
  const input = args();
  const first = await createAssistantMeeting(id, input, settings, { prepareMeeting: async () => reserve() });
  assert.equal(first.ok, true);
  const store = readStore(id);
  store.events = [];
  saveStore(store, id);
  const replay = await createAssistantMeeting(id, input, settings, { prepareMeeting: async () => { throw new Error('must not recreate'); } });
  assert.equal(replay.ok, true);
  assert.equal(replay.event, null);
  assert.match(replay.notice, /已删除/);
  assert.equal(readStore(id).events.length, 0);
});

test('PostgreSQL已启用但未连接时拒绝建会，不静默退到本地', async () => {
  const { id, settings } = config();
  let called = 0;
  saveInfraConfig({ postgres: { enabled: true }, mq: { enabled: false } });
  try {
    await assert.rejects(createAssistantMeeting(id, args(), settings, { prepareMeeting: async () => { called++; return reserve(); } }), /数据库未连接/);
    assert.equal(called, 0);
    assert.equal(fs.existsSync(path.join(mailboxDirectory(id), 'assistant-meetings.json')), false);
  } finally { saveInfraConfig({ postgres: { enabled: false }, mq: { enabled: false } }); }
});

function runChild(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...process.env, DAYLIGHT_DATA_DIR: directory }, windowsHide: true });
    let output = '';
    let errors = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child ${status}: ${errors}`)));
  });
}

test('独立进程并发通过本地文件锁串行，相同operationKey只有一个外部建会动作', async () => {
  const { id } = config();
  const input = args();
  const marker = path.join(directory, 'synthetic-external-creates.txt');
  const code = `import fs from 'node:fs';
    import { readSettings } from ${JSON.stringify(pathToFileURL(path.join(root, 'server', 'store.js')).href)};
    import { createAssistantMeeting } from ${JSON.stringify(pathToFileURL(path.join(root, 'server', 'assistant-meetings.js')).href)};
    const result = await createAssistantMeeting(${JSON.stringify(id)}, ${JSON.stringify(input)}, readSettings(), {
      prepareMeeting: async () => { fs.appendFileSync(${JSON.stringify(marker)}, 'created\\n'); await new Promise(resolve => setTimeout(resolve, 100)); return ${JSON.stringify(reserve())}; }
    });
    process.stdout.write(JSON.stringify({ ok: result.ok, draftId: result.draft?.id }));`;
  const results = await Promise.all([runChild(code), runChild(code)]);
  assert.ok(results.every((item) => item.ok));
  assert.equal(results[0].draftId, results[1].draftId);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
  assert.equal(readStore(id).events.length, 1);
});

test('调用飞书途中进程退出后移除死进程锁，但保留结果未知标记阻止盲重试', async () => {
  const { id, settings } = config();
  const input = args();
  const code = `import { readSettings } from ${JSON.stringify(pathToFileURL(path.join(root, 'server', 'store.js')).href)};
    import { createAssistantMeeting } from ${JSON.stringify(pathToFileURL(path.join(root, 'server', 'assistant-meetings.js')).href)};
    await createAssistantMeeting(${JSON.stringify(id)}, ${JSON.stringify(input)}, readSettings(), {
      prepareMeeting: async () => { process.stdout.write(JSON.stringify({ crashed: true })); process.exit(0); }
    });`;
  assert.equal((await runChild(code)).crashed, true);
  assert.equal(fs.existsSync(path.join(mailboxDirectory(id), 'assistant-meetings.json.lock')), true);
  let called = 0;
  const retries = await Promise.all([1, 2].map(() => createAssistantMeeting(id, input, settings, {
    prepareMeeting: async () => { called++; return reserve(); },
  })));
  assert.ok(retries.every((item) => item.code === 'MEETING_OUTCOME_UNKNOWN'));
  assert.equal(called, 0);
  assert.equal(fs.existsSync(path.join(mailboxDirectory(id), 'assistant-meetings.json.lock')), false);
});

test('PostgreSQL分支使用已提交检查点和持久租约，网络期间释放连接；删除JSON缓存后不重复建会（模拟数据库）', async (t) => {
  const { id, settings } = config();
  const concurrent = [config(), config(), config()];
  const input = args();
  const statements = [];
  const documents = new Map();
  const calendars = new Map();
  let activeLocks = 0;
  let activeTransactions = 0;
  let connections = 0;
  const connectionsWaiting = [];
  const query = async (sql, parameters = []) => {
    const text = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    statements.push({ text, parameters });
    if (text === 'select 1' || text.startsWith('create table')) return { rows: [] };
    if (text.startsWith('select count(*)')) return { rows: [{ count: 1 }] };
    if (text.startsWith('select pg_try_advisory_lock')) { activeLocks++; return { rows: [{ locked: true }] }; }
    if (text.startsWith('select pg_advisory_unlock')) { activeLocks--; return { rows: [] }; }
    if (text === 'begin') { activeTransactions++; return { rows: [] }; }
    if (text === 'commit' || text === 'rollback') { activeTransactions--; return { rows: [] }; }
    if (text.startsWith('insert into app_settings')) {
      if (!text.includes('do nothing') || !documents.has(parameters[0])) documents.set(parameters[0], JSON.parse(parameters[1]));
      return { rows: [] };
    }
    if (text.startsWith('update app_settings')) { documents.set(parameters[0], JSON.parse(parameters[1])); return { rows: [] }; }
    if (text.startsWith('select payload from app_settings')) return { rows: documents.has(parameters[0]) ? [{ payload: structuredClone(documents.get(parameters[0])) }] : [] };
    if (text.startsWith('insert into mailbox_calendars')) { calendars.set(parameters[0], JSON.parse(parameters[1])); return { rows: [] }; }
    if (text.startsWith('select payload from mailbox_calendars')) return { rows: calendars.has(parameters[0]) ? [{ payload: structuredClone(calendars.get(parameters[0])) }] : [] };
    throw new Error(`Unexpected synthetic database query: ${text}`);
  };
  const pg = await import('pg');
  const { initPostgres } = await import('./infra/postgres.js');
  t.mock.method(pg.default, 'Pool', function SyntheticPool() {
    this.options = { max: 2 };
    this.query = query;
    this.connect = async () => {
      if (connections >= 2) await new Promise((resolve) => connectionsWaiting.push(resolve));
      else connections++;
      return { query, release() {
        const next = connectionsWaiting.shift();
        if (next) next();
        else connections--;
      } };
    };
    this.end = async () => {};
  });
  saveInfraConfig({ postgres: { enabled: true }, mq: { enabled: false } });
  try {
    assert.equal((await initPostgres()).mode, 'postgres');
    let called = 0;
    const dependencies = { prepareMeeting: async () => {
      called++;
      assert.equal(activeLocks, 0);
      assert.equal(connections, 0, '外部网络调用不占用PG连接');
      assert.equal(activeTransactions, 0, '外部网络调用没有占用未提交事务');
      assert.equal(documents.get(`assistant-meetings:${id}`).operations[0].status, 'preparing');
      return reserve();
    } };
    const first = await createAssistantMeeting(id, input, settings, dependencies);
    assert.equal(first.ok, true);
    assert.equal(calendars.get(id).events.length, 1);
    assert.equal(documents.get(`assistant-meetings:${id}`).operations[0].status, 'completed');
    for (const name of ['assistant-meetings.json', 'calendar.json']) fs.unlinkSync(path.join(mailboxDirectory(id), name));
    const replay = await createAssistantMeeting(id, input, settings, dependencies);
    assert.equal(replay.ok, true);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.draft.id, first.draft.id);
    assert.equal(called, 1);
    assert.equal(activeLocks, 0);
    assert.equal(activeTransactions, 0);
    assert.equal(statements.some(({ text }) => text.includes('pg_try_advisory_lock')), false);
    let deadline;
    try {
      const results = await Promise.race([
        Promise.all(concurrent.map(({ id: mailboxId, settings: configSettings }) => createAssistantMeeting(mailboxId, args(), configSettings, {
          prepareMeeting: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return reserve(); },
        }))),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('会议锁占满连接池导致审核草稿无法提交')), 2000); }),
      ]);
      assert.ok(results.every((item) => item.ok), '两个连接的池仍可完成多邮箱并发流程');
      assert.equal(connections, 0);
      assert.equal(activeLocks, 0);
    } finally { clearTimeout(deadline); }
  } finally {
    saveInfraConfig({ postgres: { enabled: false }, mq: { enabled: false } });
    await initPostgres();
  }
});
