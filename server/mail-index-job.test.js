// The production path for the mailbox knowledge base: a real sync runs inside the worker
// (`runMailJob`), not in the request handler, so the default indexer must copy a committed
// mail into the mailbox knowledge base on its own. This drives the real default indexer and
// the real chunk store against an isolated data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'work', 'mail-index-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));

const { runMailJob } = await import('./mail-job.js');
const { listChunks } = await import('./rag/store.js');

const job = { id: 'job', tenant_id: 'tenant', owner_id: 'owner', mailbox_id: 'box', lease_token: 'lease', payload: {} };
const settings = { activeMailboxId: 'box', email: 'synthetic@example.invalid', mailFilters: [] };
const extraction = { summary: '需在截止日前报名', events: [], tasks: [] };

function fixture(emails) {
  const state = { store: { emails: [], events: [], tasks: [] }, version: 0, commits: 0, steps: new Map() };
  const storage = {
    load: async () => ({ version: state.version, store: structuredClone(state.store) }),
    runSnapshot: async (_snapshot, fn) => fn(),
    commit: async ({ client, snapshot, expectedVersion }) => {
      if (expectedVersion !== state.version) throw Object.assign(new Error('conflict'), { code: 'MAIL_SNAPSHOT_CONFLICT' });
      client.next = snapshot.store;
    },
  };
  const repository = { checkpoint: async (_id, _token, name, value, write) => {
    if (state.steps.has(name)) return state.steps.get(name);
    const client = { transaction: true };
    await write(client, job);
    state.store = structuredClone(client.next);
    state.version++;
    state.commits++;
    state.steps.set(name, value);
    return value;
  } };
  return { state, args: { job, settings, storage, repository, readEmails: async () => emails,
    handleSpecialEmail: async () => null, extractor: async () => extraction } };
}

const mail = { id: 'qq:index-1', subject: '全国大学生算法竞赛报名通知', sender: 'contest@example.edu',
  body: '请于 10 月 20 日前提交算法竞赛报名表，附件里有赛题说明。', receivedAt: '2026-10-01T08:00:00+08:00' };

test('真实同步（默认索引器）把已提交邮件的主题与正文写进邮箱知识库，重放不重复', async () => {
  const { state, args } = fixture([mail]);
  const result = await runMailJob(args);
  assert.equal(result.errors.length, 0);
  assert.ok(result.knowledgeChunks >= 1, '提交成功之后必须写入知识库分块，否则同步后仍然搜不到邮件');

  const chunks = await listChunks('box');
  const body = chunks.find((chunk) => String(chunk.attachmentId).startsWith('mailbody:'));
  assert.ok(body, '邮件正文必须入库');
  assert.match(body.content, /全国大学生算法竞赛报名通知/);
  assert.match(body.content, /10 月 20 日前提交/);
  // 引用编码要让界面能从检索结果回到原邮件
  assert.equal(body.emailId, 'qq:index-1');
  assert.equal(body.source, 'email');

  await runMailJob(args);
  assert.equal((await listChunks('box')).length, chunks.length, '重放同一封邮件不能堆叠分块');
});

test('知识库未开启时不写入分块', async () => {
  const { args } = fixture([{ ...mail, id: 'qq:index-off' }]);
  args.settings = { ...settings, ragEnabled: false };
  const result = await runMailJob({ ...args, job: { ...job, id: 'job-off' } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.knowledgeChunks, 0);
  assert.equal((await listChunks('box', { attachmentId: 'mailbody:qq%3Aindex-off' })).length, 0);
});
