import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { storageHttpMiddleware } from './storage-http.js';
import { stageSnapshotDocument, readSnapshotDocument, settingsKey, calendarKey, commitStorage, STORAGE_SCHEMA } from './storage/index.js';

process.env.DAYLIGHT_RUNTIME = 'production';
const settings = { mailboxes: [{ id: 'a', ownerUserId: 'alice' }, { id: 'c', ownerUserId: 'alice' }, { id: 'b', ownerUserId: 'bob' }] };
const stage = () => stageSnapshotDocument(calendarKey('a'), { events: [{ id: 'saved' }] });
function controlledPool({ failCommit = false, missingSettings = false, waitCommit } = {}) {
  const state = { writes: 0, commits: 0, releases: 0, loaded: [] };
  return { state, async connect() {
    let readonly = false;
    return { release() { state.releases++; }, async query(sql, args) {
      if (sql.startsWith('BEGIN')) readonly = sql.includes('READ ONLY');
      if (sql.startsWith('SELECT payload')) {
        state.loaded.push(args[0]);
        return { rows: args[0] === 'default' && !missingSettings ? [{ payload: settings, version: '1' }] : [] };
      }
      if (sql.startsWith('SELECT version')) return { rows: args[0] === 'default' ? [{ version: '1' }] : [] };
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) { state.writes++; return { rows: [{ version: '1' }] }; }
      if (sql === 'COMMIT' && !readonly) {
        if (waitCommit) await waitCommit;
        if (failCommit) throw Object.assign(new Error('postgres secret: do-not-return'), { code: '08006' });
        state.commits++;
      }
      return { rows: [] };
    } };
  } };
}
async function serve(t, pool, route, limits = {}) {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'alice' }; next(); });
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  let escapedError;
  const middleware = storageHttpMiddleware({ pool, ...limits });
  app.use((req, res, next) => { middleware(req, res, next).then(complete); });
  app.get('/', route);
  app.use((error, req, res, next) => { escapedError = error; res.status(500).end('route failed'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, done, error: () => escapedError };
}
test('HTTP status, headers and body wait for commit; all owner boxes load, other owners do not', async t => {
  let release;
  const pool = controlledPool({ waitCommit: new Promise(resolve => { release = resolve; }) });
  let responded = false;
  const server = await serve(t, pool, (req, res) => {
    assert.deepEqual(readSnapshotDocument(calendarKey('c')).events, []);
    stage();
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    res.end('{"ok":true}');
  });
  const responsePromise = fetch(server.url).then(response => { responded = true; return response; });
  // A network turn after the snapshot is loaded, before the commit is released.
  while (!pool.state.writes) await new Promise(resolve => setImmediate(resolve));
  assert.equal(responded, false);
  assert.equal(pool.state.commits, 0);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  await server.done;
  assert.equal(pool.state.commits, 1);
  for (const id of ['default', 'a', 'c', 'scenarios:alice']) assert.ok(pool.state.loaded.includes(id));
  for (const id of ['b', 'scenarios:bob', 'traces:b', 'recruitment:b']) assert.equal(pool.state.loaded.includes(id), false);
});
test('production HTTP commit failure replaces success and clears sensitive/stale headers', async t => {
  const pool = controlledPool({ failCommit: true });
  const server = await serve(t, pool, (req, res) => {
    stage();
    res.setHeader('Set-Cookie', 'secret=not-saved');
    res.setHeader('Content-Length', '2');
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200);
    res.write('ok');
    res.end();
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.deepEqual(await response.json(), { error: '数据未能提交，请稍后重试。' });
  await server.done;
  assert.equal(server.error(), undefined);
});
test('error response discards dirty documents without committing or uncommitted failure', async t => {
  const pool = controlledPool();
  let late;
  const server = await serve(t, pool, (req, res) => {
    stage();
    res.status(422).end('invalid input');
    late = () => stage();
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 422);
  assert.equal(await response.text(), 'invalid input');
  await server.done;
  assert.equal(pool.state.writes, 0);
  assert.equal(pool.state.commits, 0);
  assert.equal(server.error(), undefined);
  assert.throws(late, { code: 'STORAGE_SNAPSHOT_REQUIRED' });
});

test('an explicitly committed partial business result survives an unsuccessful HTTP response', async t => {
  const pool = controlledPool();
  const server = await serve(t, pool, async (req, res) => {
    stageSnapshotDocument(calendarKey('a'), { emails: [{ id: 'invoice', invoiceStatus: 'partial', invoiceErrors: ['synthetic extraction failure'] }] });
    await commitStorage();
    res.status(502).json({ error: '识别未完成，已保留此前结果。' });
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /已保留/);
  await server.done;
  assert.equal(pool.state.writes, 1);
  assert.equal(pool.state.commits, 1);
  assert.equal(server.error(), undefined);
});
test('SSE stays buffered until commit; write callbacks can advance a finite stream', async t => {
  const pool = controlledPool();
  const server = await serve(t, pool, (req, res) => {
    stage();
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('event: progress\ndata: {}\n\n', error => {
      assert.ifError(error);
      res.end('event: done\ndata: {}\n\n');
    });
  });
  const response = await fetch(server.url);
  assert.equal(pool.state.commits, 1);
  assert.match(await response.text(), /event: progress[\s\S]*event: done/);
  await server.done;
});
test('SSE overflow discards and responds with a bounded generic error; callbacks settle', async t => {
  const pool = controlledPool();
  let callbackError;
  const server = await serve(t, pool, (req, res) => {
    stage();
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('x'.repeat(33), error => { callbackError = error; res.end('event: done'); });
  }, { maxBufferBytes: 32 });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /xxx|event: done/);
  await server.done;
  assert.ok(callbackError);
  assert.equal(pool.state.commits, 0);
});
test('idle stream expires and closes its dirty snapshot', async t => {
  const pool = controlledPool();
  const server = await serve(t, pool, (req, res) => { stage(); res.write('progress'); }, { maxDurationMs: 30 });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /progress/);
  await server.done;
  assert.equal(pool.state.commits, 0);
});
test('tiny chunks have an independent metadata bound', async t => {
  const pool = controlledPool();
  const server = await serve(t, pool, (req, res) => {
    stage();
    for (let index = 0; index < 16_385; index++) res.write('x');
    res.end('success');
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /xxx|success/);
  await server.done;
  assert.equal(pool.state.commits, 0);
});
test('client disconnect discards before commit and rejects detached writes', async t => {
  const pool = controlledPool();
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let continuation;
  const server = await serve(t, pool, (req, res) => {
    stage();
    res.write('progress');
    continuation = () => { assert.throws(stage, { code: 'STORAGE_SNAPSHOT_REQUIRED' }); res.end('success'); };
    entered();
  });
  const request = http.get(server.url);
  request.on('error', () => {});
  await enteredPromise;
  request.destroy();
  await server.done;
  continuation();
  assert.equal(pool.state.commits, 0);
});
test('deadline during commit never emits buffered success after commit settles', async t => {
  let release;
  const pool = controlledPool({ waitCommit: new Promise(resolve => { release = resolve; }) });
  const server = await serve(t, pool, (req, res) => { stage(); res.end('success'); }, { maxDurationMs: 20 });
  const pending = fetch(server.url);
  while (!pool.state.writes) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /success/);
  await server.done;
  // The already-running DB commit can succeed; HTTP must not claim success.
  assert.equal(pool.state.commits, 1);
});
test('disconnect during commit settles snapshot without writing to a dead socket', async t => {
  let release;
  const pool = controlledPool({ waitCommit: new Promise(resolve => { release = resolve; }) });
  const server = await serve(t, pool, (req, res) => { stage(); res.end('success'); });
  const request = http.get(server.url);
  request.on('error', () => {});
  while (!pool.state.writes) await new Promise(resolve => setImmediate(resolve));
  request.destroy();
  await new Promise(resolve => setImmediate(resolve));
  release();
  await server.done;
  assert.equal(server.error(), undefined);
});
test('route exception is discarded by error response without committing staged effects', async t => {
  const pool = controlledPool();
  const server = await serve(t, pool, () => { stage(); throw new Error('route exception'); });
  const response = await fetch(server.url);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'route failed');
  await server.done;
  assert.equal(pool.state.commits, 0);
});
test('missing shared default settings rejects production HTTP before running a route', async t => {
  let ran = false;
  const server = await serve(t, controlledPool({ missingSettings: true }), (req, res) => { ran = true; res.end('success'); });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.equal(ran, false);
  assert.doesNotMatch(await response.text(), /STORAGE_|settings|success/);
});

const url = process.env.DAYLIGHT_STORAGE_TEST_URL;
test('real PG production HTTP: constraint failure cannot return success or persist staged calendar', { skip: !url }, async t => {
  const schema = `storage_http_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE app_settings (id text primary key,payload jsonb not null,updated_at timestamptz not null);
    CREATE TABLE mailbox_calendars (mailbox_id text primary key,payload jsonb not null,updated_at timestamptz not null,
      CHECK (NOT (payload ? 'rejectCommit')));`);
  await pool.query(STORAGE_SCHEMA);
  await pool.query('INSERT INTO app_settings (id,payload,updated_at) VALUES ($1,$2,now())', ['default', settings]);
  const server = await serve(t, pool, (req, res) => {
    stageSnapshotDocument(calendarKey('a'), { rejectCommit: true });
    res.status(201).json({ success: true });
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /success|rejectCommit/);
  await server.done;
  assert.equal((await pool.query('SELECT * FROM mailbox_calendars')).rowCount, 0);
});
