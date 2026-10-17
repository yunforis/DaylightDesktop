import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createHash } from 'node:crypto';
import { productionWorkflowMiddleware, productionStorageMiddleware, ownsAttachmentKey, readProductionAdminJobs } from './production-api.js';
import { readSettings, readStore, saveSettings } from './store.js';

process.env.DAYLIGHT_RUNTIME = 'production';

function workflow(method, path) {
  let result;
  const res = { status(status) { this.statusCode = status; return this; }, json(body) { result = { status: this.statusCode, ...body }; return this; } };
  productionWorkflowMiddleware({ method, path }, res, () => { result = { status: 200 }; });
  return result;
}

test('production opens shared attachments, RAG, settings and administrator operations', () => {
  for (const [method, path] of [
    ['GET', '/attachments/users/alice/mailboxes/a/file.pdf'], ['HEAD', '/attachments/key'],
    ['GET', '/rag/status'], ['POST', '/rag/search'], ['POST', '/rag/reindex'],
    ['GET', '/infra'], ['GET', '/persistence'], ['GET', '/onboarding/guide'],
    ['GET', '/prompts'], ['GET', '/prompts/revisions'], ['PUT', '/prompts'], ['POST', '/prompts/reset'],
    ['GET', '/report-prompts'], ['PUT', '/report-prompts'], ['POST', '/report-prompts/presets'], ['DELETE', '/report-prompts/presets/preset'],
    ['GET', '/admin/overview'], ['GET', '/admin/monitor'], ['GET', '/admin/users'], ['GET', '/admin/users/alice'],
    ['POST', '/admin/users'], ['PUT', '/admin/users/alice'], ['DELETE', '/admin/users/alice'],
    ['POST', '/admin/users/alice/force-logout'], ['DELETE', '/admin/users/alice/sessions/session'],
    ['GET', '/admin/mailboxes'], ['GET', '/admin/infra'], ['GET', '/admin/search'], ['GET', '/admin/settings'], ['PUT', '/admin/settings'],
    ['PUT', '/admin/mail-templates'], ['POST', '/admin/mail-templates/preview'], ['PUT', '/admin/onboarding-guide'],
    ['POST', '/emails/mail/extract-invoices'],
    ['POST', '/emails/mail/resolve-match'], ['PUT', '/calendar-categories'], ['PUT', '/mail-filters'],
  ]) assert.equal(workflow(method, path).status, 200, `${method} ${path}`);
});

test('production retains method-specific gates for unconverted workflows and environment configuration', () => {
  for (const [method, path] of [
    ['GET', '/backup'], ['POST', '/backup/restore'], ['POST', '/traces/trace/send'],
    ['POST', '/admin/assistant/chat'], ['POST', '/admin/mail-templates/send-test'],
    ['POST', '/admin/infra/test-oss'], ['POST', '/admin/infra/test-mq'],
    ['POST', '/attachments/key'], ['DELETE', '/attachments/key'], ['GET', '/rag/reindex'],
    ['GET', '/admin/users/alice/private'], ['GET', '/emails/mail/extract-invoices'], ['GET', '/unknown'],
  ]) assert.equal(workflow(method, path).code, 'WORKFLOW_NOT_MIGRATED', `${method} ${path}`);
  for (const path of ['/infra', '/admin/infra', '/infra/reload']) {
    assert.equal(workflow('PUT', path).code, 'PRODUCTION_CONFIG_MANAGED', path);
  }
});

function fixturePool() {
  const state = { loaded: [], writes: [] };
  let version = 1;
  let settings = { model: 'initial-shared-model', userPrefs: { alice: { model: 'alice-model' }, bob: { model: 'bob-model' } }, activeMailboxId: 'a', mailboxes: [
    { id: 'a', ownerUserId: 'alice' }, { id: 'b', ownerUserId: 'bob' }, { id: 'legacy' },
  ] };
  const calendars = new Map([
    ['a', { events: [], emails: [{ id: 'mail', attachments: [{ key: 'alice-file' }] }], tasks: [] }],
    ['b', { events: [], emails: [{ id: 'mail', attachments: [{ key: 'bob-file' }] }], tasks: [] }],
    ['legacy', { events: [], emails: [], tasks: [] }],
  ]);
  return { state, async connect() {
    return { release() {}, async query(sql, args = []) {
      if (sql.startsWith('SELECT payload') || sql.startsWith('SELECT version')) {
        const calendar = sql.includes('mailbox_calendars');
        const payload = calendar ? calendars.get(args[0]) : args[0] === 'default' ? settings : undefined;
        if (sql.startsWith('SELECT payload')) state.loaded.push(`${calendar ? 'calendar' : 'settings'}:${args[0]}`);
        return { rows: payload === undefined ? [] : [{ payload: structuredClone(payload), version: !calendar && args[0] === 'default' ? String(version) : '1' }] };
      }
      if (sql.startsWith('UPDATE app_settings') && args[0] === 'default') {
        settings = JSON.parse(args[1]);
        state.writes.push(structuredClone(settings));
        return { rows: [{ version: String(++version) }] };
      }
      return { rows: [] };
    } };
  } };
}

async function serve(t, user) {
  const pool = fixturePool();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(productionStorageMiddleware({ pool }));
  app.use(productionWorkflowMiddleware);
  app.get(['/state', '/admin/overview'], (req, res) => {
    res.json({ mailboxes: readSettings().mailboxes.map(box => box.id),
      emails: readSettings().mailboxes.flatMap(box => readStore(box.id).emails).length });
  });
  app.put('/admin/settings', (req, res) => {
    saveSettings({ ...readSettings(), model: req.body.model });
    res.json({ model: readSettings().model });
  });
  app.get('/attachments/:key', (req, res) => {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!ownsAttachmentKey(req.params.key)) return res.status(404).json({ error: '附件不存在或无权访问。' });
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (path, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: response.status, data: await response.json() };
  };
  return { pool, get: call, put: (path, body) => call(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('administrator overview loads all shared mailboxes while the user workspace remains isolated', async t => {
  const admin = await serve(t, { id: 'alice', isAdmin: true });
  assert.deepEqual(await admin.get('/admin/overview'), { status: 200, data: { mailboxes: ['a', 'b', 'legacy'], emails: 2 } });
  assert.ok(admin.pool.state.loaded.includes('calendar:b'));
  assert.deepEqual(await admin.get('/state'), { status: 200, data: { mailboxes: ['a'], emails: 1 } });
});

test('ordinary and unauthenticated requests cannot select an administrative snapshot', async t => {
  const user = await serve(t, { id: 'alice', isAdmin: false });
  assert.equal((await user.get('/admin/overview?system=true')).status, 403);
  assert.deepEqual(user.pool.state.loaded, []);
  const anonymous = await serve(t, undefined);
  assert.equal((await anonymous.get('/admin/overview')).status, 401);
  assert.deepEqual(anonymous.pool.state.loaded, []);
});

test('administrator shared settings edits commit to PG and preserve personal models and mailbox ownership', async t => {
  const admin = await serve(t, { id: 'alice', isAdmin: true });
  assert.equal((await admin.put('/admin/settings', { model: 'new-shared-model' })).status, 200);
  const saved = admin.pool.state.writes.at(-1);
  assert.equal(saved.model, 'new-shared-model');
  assert.equal(saved.userPrefs.alice.model, 'alice-model');
  assert.equal(saved.userPrefs.bob.model, 'bob-model');
  assert.equal(saved.mailboxes.find(box => box.id === 'b').ownerUserId, 'bob');
  const user = await serve(t, { id: 'alice', isAdmin: false });
  assert.equal((await user.put('/admin/settings', { model: 'forbidden' })).status, 403);
  assert.deepEqual(user.pool.state.writes, []);
});

test('attachment downloads use mailbox metadata rather than treating a known bucket key as authorization', async t => {
  const user = await serve(t, { id: 'alice', isAdmin: false });
  assert.equal((await user.get('/attachments/alice-file')).status, 200);
  assert.equal((await user.get('/attachments/bob-file')).status, 404);
  assert.equal((await user.get('/attachments/unregistered-file')).status, 404);
  assert.equal(user.pool.state.loaded.includes('calendar:b'), false);
});

test('registered recruitment files and event materials can be read without relying on key path conventions', () => {
  const options = { settings: { mailboxes: [{ id: 'a' }] },
    calendar: () => ({ events: [{ materials: [{ storageKey: 'old-material-key' }] }] }),
    recruitment: () => ({ attachments: [{ key: 'old-recruitment-key' }] }) };
  assert.equal(ownsAttachmentKey('old-material-key', options), true);
  assert.equal(ownsAttachmentKey('old-recruitment-key', options), true);
  assert.equal(ownsAttachmentKey('users/alice/guessed-key', options), false);
});

test('only attachment GET and HEAD responses may exceed the normal 8 MiB response limit', async t => {
  const payload = Buffer.alloc(8 * 1024 * 1024 + 1, 0x6d);
  const digest = createHash('sha256').update(payload).digest('hex');
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'alice', isAdmin: true }; next(); });
  app.use(productionStorageMiddleware({ pool: fixturePool() }));
  app.use((req, res) => {
    res.type('application/octet-stream');
    res.setHeader('Content-Length', payload.length);
    res.end(payload);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/attachments/users/alice/file.pdf', '/recruitment/attachments/file', '/recruitment/attachments/file/']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, payload.length, path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, path);
    const head = await fetch(`${url}${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path}`);
    assert.equal(Number(head.headers.get('content-length')), payload.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  for (const [method, path] of [
    ['GET', '/state'], ['GET', '/admin/overview'],
    ['POST', '/attachments/file'], ['PUT', '/recruitment/attachments/file'],
    ['GET', '/recruitment/attachments/file/retry'],
  ]) {
    const response = await fetch(`${url}${path}`, { method });
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: '数据未能提交，请稍后重试。' });
  }
});

test('attachment downloads retain a finite 64 MiB staging budget', async t => {
  const chunk = Buffer.alloc(1024 * 1024, 0x6d);
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'alice' }; next(); });
  app.use(productionStorageMiddleware({ pool: fixturePool() }));
  app.get('/attachments/file', (req, res) => {
    for (let index = 0; index < 65; index++) res.write(chunk);
    res.end();
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/attachments/file`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '数据未能提交，请稍后重试。' });
});

test('administrator task monitor reads persistent jobs and redacts internal task data and error messages', async () => {
  const jobs = await readProductionAdminJobs(1000, { async query(sql, params) {
    assert.match(sql, /FROM daylight_jobs/);
    assert.doesNotMatch(sql, /SELECT \*/);
    assert.deepEqual(params, [80]);
    return { rows: [{ id: 'job', mailbox_id: 'a', kind: 'mailbox.sync', status: 'failed',
      payload: { apiKey: 'fixture-secret' }, error: { code: 'UNAVAILABLE', message: 'fixture-secret' } }] };
  } });
  assert.equal(jobs[0].topic, 'mailbox.sync');
  assert.equal(jobs[0].mailboxId, 'a');
  assert.doesNotMatch(JSON.stringify(jobs), /fixture-secret|apiKey|payload/);
});
