import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/assistant-state-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ activeMailboxId: 'default', mailboxes: [{ id: 'default', email: 'sender@example.invalid', smtpHost: 'smtp.example.invalid', smtpPort: 465, authorizationCode: 'invented-fixture-code' }] }));
const { mutateAssistantState, readAssistantState } = await import('./assistant-state.js');
const { createAssistantDraft, sendAssistantDraft } = await import('./assistant-actions.js');
const { readSettings } = await import('./store.js');
const { saveInfraConfig } = await import('./infra/config.js');
const { initPostgres } = await import('./infra/postgres.js');
const input = { to: ['recipient@example.invalid'], subject: '合成报告提醒', body: '请按时提交合成报告。' };
const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.resolve('server', name)).href);
const child = (source) => new Promise((resolve, reject) => {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
    env: { ...globalThis.process.env, DAYLIGHT_DATA_DIR: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  process.stdout.on('data', (value) => { output += value; });
  process.stderr.on('data', (value) => { error += value; });
  process.on('error', reject);
  process.on('exit', (status) => status === 0 ? resolve(output) : reject(new Error(`child ${status}: ${error}`)));
});

test('独立进程同时确认同一草稿，SMTP副作用只有一次', async () => {
  const { draft } = await createAssistantDraft('default', input);
  const marker = path.join(directory, 'synthetic-sends.txt');
  const source = `import fs from 'node:fs';
    import {sendAssistantDraft} from ${moduleUrl('assistant-actions.js')};
    import {readSettings} from ${moduleUrl('store.js')};
    try {
      const result = await sendAssistantDraft('default', ${JSON.stringify(draft.id)}, {confirmed:true,revision:1}, readSettings(), {sendMail:async(settings,mail)=>{
        fs.appendFileSync(${JSON.stringify(marker)},'sent\\n');
        await new Promise(resolve=>setTimeout(resolve,100));
        return {accepted:mail.to,messageId:mail.messageId};
      }});
      process.stdout.write(result.draft.status);
    } catch(error) {process.stdout.write('blocked:'+error.status);}`;
  const results = await Promise.all([child(source), child(source)]);
  assert.ok(results.includes('sent'));
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
});

test('事务进程崩溃后回收文件锁，遗留 sending 仍阻止重复发送', async () => {
  const source = `import {mutateAssistantState} from ${moduleUrl('assistant-state.js')};
    await mutateAssistantState('default','requests',()=>{process.exit(0)});`;
  await child(source);
  assert.ok(fs.existsSync(path.join(directory, 'assistant-requests.json.lock')));
  await mutateAssistantState('default', 'requests', (data) => data.items.push({ id: 'after-crash' }));
  assert.equal((await readAssistantState('default', 'requests')).items[0].id, 'after-crash');
  assert.equal(fs.existsSync(path.join(directory, 'assistant-requests.json.lock')), false);
  const { draft } = await createAssistantDraft('default', { ...input, operationKey: 'crash-sending' });
  await child(`import {mutateAssistantState} from ${moduleUrl('assistant-state.js')};
    await mutateAssistantState('default','drafts',data=>Object.assign(data.items.find(item=>item.id===${JSON.stringify(draft.id)}),{status:'sending',revision:2,attemptedAt:new Date().toISOString()}));
    process.exit(0);`);
  await assert.rejects(sendAssistantDraft('default', draft.id, { confirmed: true, revision: 2 }, readSettings(), { sendMail: () => assert.fail('不能重复发信') }), /不能修改/);
});

test('PG为权威时损坏JSON不阻断写入，停用PG或缺权威行不能复活旧pending', async (t) => {
  const documents = new Map();
  const statements = [];
  const query = async (sql, parameters = []) => {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    statements.push(normalized);
    if (normalized.startsWith('select count')) return { rows: [{ count: 1 }] };
    if (normalized.startsWith('select payload')) return { rows: documents.has(parameters[0]) ? [{ payload: structuredClone(documents.get(parameters[0])) }] : [] };
    if (normalized.startsWith('insert into app_settings')) {
      if (!documents.has(parameters[0])) documents.set(parameters[0], JSON.parse(parameters[1]));
    }
    if (normalized.startsWith('update app_settings')) documents.set(parameters[0], JSON.parse(parameters[1]));
    return { rows: [] };
  };
  const pg = await import('pg');
  t.mock.method(pg.default, 'Pool', function Pool() { this.query = query; this.connect = async () => ({ query, release() {} }); this.end = async () => {}; });
  saveInfraConfig({ postgres: { enabled: true } });
  try {
    assert.equal((await initPostgres()).mode, 'postgres');
    await mutateAssistantState('default', 'requests', (data) => { data.items = [{ id: 'durable-request', status: 'done' }]; });
    const file = path.join(directory, 'assistant-requests.json');
    fs.writeFileSync(file, '{bad cache');
    await mutateAssistantState('default', 'requests', (data) => { data.items[0].status = 'verified'; });
    assert.equal((await readAssistantState('default', 'requests')).items[0].status, 'verified');
    assert.equal(statements.filter((sql) => sql.startsWith('insert into app_settings')).length, 1, '只有首次迁移读本地文件');
    assert.ok(fs.existsSync(`${file}.postgres`));
    const authoritative = structuredClone([...documents.values()][0]);
    documents.clear();
    await assert.rejects(readAssistantState('default', 'requests'), /权威记录缺失/);
    await assert.rejects(mutateAssistantState('default', 'requests', () => assert.fail('不能复活缓存')), /权威记录缺失/);
    const id = JSON.parse(fs.readFileSync(`${file}.postgres`, 'utf8')).id;
    documents.set(id, authoritative);
    saveInfraConfig({ postgres: { enabled: false } });
    await initPostgres();
    await assert.rejects(readAssistantState('default', 'requests'), /已由 PostgreSQL 管理/);
    await assert.rejects(mutateAssistantState('default', 'requests', () => assert.fail('不能复活缓存')), /已由 PostgreSQL 管理/);
  } finally { saveInfraConfig({ postgres: { enabled: false } }); await initPostgres(); }
});

test('生产操作检查点不读取旧JSON、不创建本地权威标记且在网络前释放连接', async (t) => {
  const settings = readSettings();
  const documents = new Map([['default', settings]]);
  let connections = 0;
  const query = async (sql, parameters = []) => {
    const text = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (text.startsWith('select count')) return { rows: [{ count: 1 }] };
    if (text.startsWith('select payload')) return { rows: documents.has(parameters[0]) ? [{ payload: structuredClone(documents.get(parameters[0])), version: '1' }] : [] };
    if (text.startsWith('insert into app_settings') && !documents.has(parameters[0])) documents.set(parameters[0], JSON.parse(parameters[1]));
    if (text.startsWith('update app_settings')) documents.set(parameters[0], JSON.parse(parameters[1]));
    return { rows: [] };
  };
  const pg = await import('pg');
  t.mock.method(pg.default, 'Pool', function Pool() {
    this.query = query; this.on = () => {};
    this.connect = async () => { connections++; return { query, release() { connections--; } }; };
    this.end = async () => {};
  });
  saveInfraConfig({ postgres: { enabled: true } });
  await initPostgres();
  const { withStorageSnapshot } = await import('./storage/index.js');
  const file = path.join(directory, 'assistant-recruitment-effects.json');
  fs.writeFileSync(file, '{invalid obsolete file');
  process.env.DAYLIGHT_RUNTIME = 'production';
  try {
    await withStorageSnapshot({ system: true }, async () => {
      await mutateAssistantState('default', 'recruitment-effects', data => data.items.push({ id: 'attempt', status: 'sending' }));
      assert.equal(connections, 0);
      assert.equal((await readAssistantState('default', 'recruitment-effects')).items[0].status, 'sending');
      assert.equal(fs.existsSync(`${file}.postgres`), false);
      assert.equal(fs.readFileSync(file, 'utf8'), '{invalid obsolete file');
    });
  } finally {
    delete process.env.DAYLIGHT_RUNTIME;
    saveInfraConfig({ postgres: { enabled: false } }); await initPostgres();
  }
});
