import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectProductionData, migrateProductionAttachments, applyProductionData,
  productionMigrationSummary, verifyProductionSource, verifyProductionData,
  productionMigrationS3Options, productionMigrationPutCommand } from '../scripts/migrate-production-data.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const now = '2026-10-17T01:00:00.000Z';
const user = { id: 'alice', email: 'synthetic@example.invalid', username: 'synthetic-user', password_hash: 'synthetic-password-hash',
  role: 'admin', workspace_mode: 'hr', workspace_mode_changes: [{ from: 'personal', to: 'hr', changedAt: now }],
  last_login_at: now, session_version: 7, created_at: now, updated_at: now };

async function fixture(t) {
  await fs.mkdir('work', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('work/production-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  await write('settings.json', { mailboxes: [{ id: 'default' }, { id: 'owned', ownerUserId: 'alice' }],
    apiKey: 'synthetic-api-secret', userPrefs: { alice: { activeMailboxId: 'owned', apiKey: 'synthetic-private-pref' } } });
  await write('users.json', { users: [user], resets: [{ token: 'synthetic-reset-token', user_id: 'alice', expires_at: now, used_at: null }] });
  await write('calendar.json', { events: [], emails: [], tasks: [] });
  return { root, write };
}

function cloud() {
  const objects = new Map(), uploaded = [];
  return { mode: 'aliyun', objects, uploaded,
    async head(key) { return objects.has(key) ? { size: objects.get(key).length } : null; },
    async get(key) { return objects.get(key); },
    async put(key, bytes) { assert.equal(objects.has(key), false, 'existing object is never overwritten'); uploaded.push(key); objects.set(key, Buffer.from(bytes)); },
    publicUrl: key => `https://objects.example.invalid/${key}` };
}

function database({ corruptReadback = false } = {}) {
  const tables = new Map(['users', 'password_resets', 'app_settings', 'mailbox_calendars', 'rag_chunks'].map(name => [name, []]));
  const calls = [];
  let staged = null;
  const client = { release() {}, async query(sql, values) {
    calls.push(sql);
    if (sql.startsWith('BEGIN')) staged = structuredClone(tables);
    if (sql === 'COMMIT') { for (const [name, rows] of staged) tables.set(name, rows); staged = null; }
    if (sql === 'ROLLBACK') staged = null;
    const read = /^SELECT (.+) FROM (users|password_resets|app_settings|mailbox_calendars|rag_chunks) ORDER BY/.exec(sql);
    if (read) {
      const rows = structuredClone(staged.get(read[2]));
      if (corruptReadback && read[2] === 'app_settings' && rows.length) rows[0].payload = { corrupt: true };
      return { rows };
    }
    const insert = /^INSERT INTO (\w+) \(([^)]+)\)/.exec(sql);
    if (insert) {
      const fields = insert[2].split(',').slice(0, values.length);
      const row = Object.fromEntries(fields.map((field, index) => [field,
        ['payload', 'embedding', 'workspace_mode_changes'].includes(field) && values[index] !== null ? JSON.parse(values[index]) : values[index]]));
      staged.get(insert[1]).push(row);
    }
    return { rows: [] };
  } };
  return { tables, calls, async connect() { return client; } };
}

test('migration preserves raw settings, users, resets, orphan mailboxes, owner-scoped assistants, scenarios, SQLite and RAG', async t => {
  const { root, write } = await fixture(t);
  await write('prompts.json', { extractionSystem: 'synthetic custom prompt' });
  await write('report-prompts.json', { presets: [{ id: 'report', requirements: 'synthetic' }] });
  await write('mail-templates.json', { register: { body: 'synthetic' } });
  await write('onboarding-guide.json', { title: 'synthetic guide' });
  await write('mailboxes/owned/assistant-drafts.json', { schemaVersion: 1, items: [{ id: 'draft', status: 'sent' }] });
  await write('mailboxes/owned/assistant-meetings.json', { schemaVersion: 1, operations: [{ id: 'meeting', status: 'unknown' }] });
  await write('mailboxes/orphan/assistant-requests.json', { schemaVersion: 1, items: [{ id: 'request', status: 'unknown' }] });
  await write(`scenarios/${sha('alice')}.json`, { workbenches: [{ id: 'board' }] });
  await write(`scenarios/${sha('deleted-user')}.json`, { items: [{ id: 'orphan-item' }] });
  await write('mailboxes/owned/rag-chunks.json', { chunks: [{ id: 'chunk', mailboxId: 'owned', ownerUserId: 'alice',
    attachmentId: 'resume', candidateId: 'candidate', filename: 'synthetic.pdf', page: 2, chunkIndex: 3,
    content: 'synthetic private source', embedding: [0.25, 0.75], updatedAt: now }], updatedAt: now });
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs(), sqlite = new SQL.Database();
  sqlite.run('CREATE TABLE kv (key TEXT,value TEXT,updated_at TEXT); CREATE TABLE prompt_revisions (id INTEGER,kind TEXT,body TEXT,created_at TEXT)');
  sqlite.run('INSERT INTO kv VALUES (?,?,?)', ['prompts.updatedAt', JSON.stringify(now), now]);
  sqlite.run('INSERT INTO prompt_revisions VALUES (?,?,?,?)', [12, 'extraction', 'synthetic old prompt', now]);
  await write('daylight.sqlite', Buffer.from(sqlite.export())); sqlite.close();
  const plan = await collectProductionData(root);
  const byId = new Map(plan.documents.filter(doc => doc.table === 'app_settings').map(doc => [doc.id, doc.payload]));
  assert.deepEqual(byId.get('default'), JSON.parse(await fs.readFile(path.join(root, 'settings.json'))));
  assert.deepEqual(plan.users, [user]);
  assert.equal(plan.resets[0].token, 'synthetic-reset-token');
  assert.equal(byId.get(`assistant:drafts:${sha('alice\0owned')}`).items[0].status, 'sent');
  assert.equal(byId.get(`assistant:requests:${sha('local\0orphan')}`).items[0].status, 'unknown');
  assert.equal(byId.get('assistant-meetings:owned').operations[0].status, 'unknown');
  assert.equal(byId.get('scenarios:alice').workbenches[0].id, 'board');
  assert.equal(byId.get(`migration-orphan-scenarios:${sha('deleted-user')}`).items.length, 1);
  assert.deepEqual(byId.get('aux-prompt-revisions'), [{ id: 12, kind: 'extraction', body: 'synthetic old prompt', createdAt: now }]);
  assert.deepEqual(byId.get('aux-kv:prompts.updatedAt'), { value: now });
  assert.deepEqual(plan.chunks[0].embedding, [0.25, 0.75]);
  assert.equal(plan.chunks[0].owner_user_id, 'alice');
  assert.equal(plan.warnings.unownedMailboxes, 1);
  assert.equal(plan.warnings.orphanMailboxes, 1);
  assert.equal(plan.warnings.orphanScenarios, 1);
  const publicText = JSON.stringify(productionMigrationSummary(plan));
  assert.doesNotMatch(publicText, /alice|synthetic|password_hash|reset-token|sourcePath|apiKey/);
  await verifyProductionSource(plan);
});

test('all local/legacy PDF/material references and unreferenced binaries upload with verified bytes; cloud keys remain valid; source never changes', async t => {
  const { root, write } = await fixture(t);
  const localKey = 'users/workspace/mailboxes/default/2026-10-17/a.pdf';
  await write(`attachments/${localKey}`, Buffer.from('synthetic-local-pdf'));
  await write('attachments/unreferenced.txt', Buffer.from('synthetic-unreferenced'));
  await write('attachments/materials/default/event/material.png', Buffer.from('synthetic-image'));
  await write('attachments/legacy.pdf', Buffer.from('synthetic-legacy-pdf'));
  await write('recruitment.json', { candidates: [{ id: 'candidate' }], attachments: [{ id: 'legacy', filename: 'synthetic.pdf', pages: [{ text: 'OCR unchanged' }] }], messages: [], interviews: [], traces: [] });
  await write('calendar.json', { events: [{ id: 'event', materials: [{ storageKey: 'materials/default/event/material.png', storage: 'local' }] }],
    emails: [{ id: 'mail', attachments: [{ id: 'local', key: localKey, storage: 'local', url: `/api/attachments/${encodeURIComponent(localKey)}` },
      { id: 'legacy', filename: 'synthetic.pdf' }, { key: 'existing/cloud.pdf', storage: 'aliyun' }] }], tasks: [] });
  await write('traces.json', [{ snapshot: { key: localKey, storage: 'local', proxyUrl: `/api/attachments/${encodeURIComponent(localKey)}` } }]);
  const plan = await collectProductionData(root), storage = cloud();
  storage.objects.set('existing/cloud.pdf', Buffer.from('synthetic-cloud-pdf'));
  await assert.rejects(applyProductionData(database(), plan), { code: 'ATTACHMENTS_NOT_VERIFIED' });
  const results = await migrateProductionAttachments(plan, storage);
  assert.equal(results.uploaded, 4);
  assert.equal(results.verifiedCloud, 1);
  const calendar = plan.documents.find(doc => doc.table === 'mailbox_calendars' && doc.id === 'default').payload;
  const recruitment = plan.documents.find(doc => doc.id === 'recruitment:default').payload;
  const traces = plan.documents.find(doc => doc.id === 'traces:default').payload;
  assert.equal(calendar.emails[0].attachments[0].key, traces[0].snapshot.key);
  assert.equal(calendar.emails[0].attachments[1].key, recruitment.attachments[0].key);
  assert.equal(calendar.emails[0].attachments[2].key, 'existing/cloud.pdf');
  assert.equal(calendar.events[0].materials[0].storage, 'aliyun');
  assert.deepEqual(recruitment.attachments[0].pages, [{ text: 'OCR unchanged' }]);
  assert.equal(plan.documents.find(doc => doc.id.startsWith('migration-attachments:')).payload.objects.length, 5);
  assert.equal(JSON.stringify(calendar).includes('"storage":"local"'), false);
  await verifyProductionSource(plan);
  // A second collected plan reuses deterministic objects and produces identical rows.
  const again = await collectProductionData(root);
  assert.equal((await migrateProductionAttachments(again, storage)).uploaded, 0);
  assert.deepEqual(again.documents, plan.documents);
});

test('cloud readback mismatch or missing existing cloud object refuses before any PG transaction', async t => {
  const { root, write } = await fixture(t);
  await write('attachments/local.pdf', Buffer.from('expected'));
  await write('calendar.json', { events: [], tasks: [], emails: [{ attachments: [{ key: 'local.pdf', storage: 'local' }] }] });
  const plan = await collectProductionData(root), storage = cloud();
  storage.get = async () => Buffer.from('corrupt');
  await assert.rejects(migrateProductionAttachments(plan, storage), { code: 'CLOUD_READBACK_MISMATCH' });
  assert.equal(plan.attachmentsVerified, false);
  await write('calendar.json', { events: [], tasks: [], emails: [{ attachments: [{ key: 'remote.pdf', storage: 'aliyun' }] }] });
  const missing = await collectProductionData(root);
  await assert.rejects(migrateProductionAttachments(missing, cloud()), { code: 'MISSING_CLOUD_ATTACHMENT' });
});

test('PG migration is idempotent and preserves user authentication fields, ownership and vectors', async t => {
  const { root } = await fixture(t);
  const plan = await collectProductionData(root), pool = database();
  const result = await applyProductionData(pool, plan);
  assert.ok(result.inserted > 0);
  assert.deepEqual(pool.tables.get('users'), [user]);
  assert.equal(pool.tables.get('password_resets')[0].token, 'synthetic-reset-token');
  assert.equal(pool.tables.get('app_settings').find(row => row.id === 'default').payload.mailboxes[0].ownerUserId, undefined);
  const again = await applyProductionData(pool, plan);
  assert.equal(again.inserted, 0);
  assert.equal(again.reused, result.inserted);
  assert.equal(pool.calls.filter(sql => sql === 'COMMIT').length, 2);
  const before = pool.calls.length;
  assert.equal((await verifyProductionData(pool, plan)).verifiedRows, result.inserted);
  assert.equal(pool.calls[before], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.slice(before).some(sql => /INSERT|UPDATE|LOCK TABLE/.test(sql)), false);
});

test('conflicting authority, unrecognized target rows and failed final verification roll back all inserts', async t => {
  const { root } = await fixture(t);
  const plan = await collectProductionData(root);
  for (const row of [{ id: 'default', payload: { conflicting: true } }, { id: 'unknown-authority', payload: {} }]) {
    const pool = database(); pool.tables.get('app_settings').push(row);
    await assert.rejects(applyProductionData(pool, plan), { code: 'TARGET_AUTHORITY_CONFLICT' });
    assert.equal(pool.tables.get('users').length, 0);
    assert.equal(pool.calls.at(-1), 'ROLLBACK');
  }
  const corrupt = database({ corruptReadback: true });
  await assert.rejects(applyProductionData(corrupt, plan), { code: 'TARGET_AUTHORITY_CONFLICT' });
  assert.equal(corrupt.tables.get('users').length, 0);
  assert.equal(corrupt.calls.at(-1), 'ROLLBACK');
});

test('source changes, PG authority markers, missing files and path escapes are refused', async t => {
  const { root, write } = await fixture(t);
  const plan = await collectProductionData(root);
  await write('calendar.json', { changed: true });
  await assert.rejects(applyProductionData(database(), plan), { code: 'SOURCE_CHANGED' });
  await write('assistant-requests.json.postgres', { authoritative: 'postgres' });
  await assert.rejects(collectProductionData(root), { code: 'POSTGRES_AUTHORITY_SOURCE' });
  await fs.unlink(path.join(root, 'assistant-requests.json.postgres'));
  await write('calendar.json', { emails: [{ attachments: [{ storage: 'local', key: '../escape.pdf' }] }] });
  await assert.rejects(collectProductionData(root), { code: 'UNSAFE_PATH' });
  await write('calendar.json', { emails: [{ attachments: [{ storage: 'local', key: 'missing.pdf' }] }] });
  await assert.rejects(collectProductionData(root), { code: 'MISSING_LOCAL_ATTACHMENT' });
  await write('calendar.json', { emails: [] });
  const external = await fixture(t);
  await fs.symlink(external.root, path.join(root, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectProductionData(root), { code: 'SYMLINK_SOURCE' });
});

test('CLI defaults to a private dry-run summary without network or leaking data and rejects output inside source', async t => {
  const { root, write } = await fixture(t);
  const environment = { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000',
    DAYLIGHT_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
    DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
    DAYLIGHT_JWT_SECRET: 'synthetic-jwt-secret-is-at-least-32-characters',
    DAYLIGHT_OSS_PROVIDER: 'aliyun', DAYLIGHT_OSS_BUCKET: 'synthetic-bucket',
    DAYLIGHT_OSS_ACCESS_KEY: 'synthetic-access', DAYLIGHT_OSS_SECRET_KEY: 'synthetic-secret' };
  await write('runtime/environment.json', environment);
  const output = path.resolve('work', `migration-cli-${path.basename(root)}.json`);
  t.after(() => fs.rm(output, { force: true }));
  const args = ['scripts/migrate-production-data.mjs', '--source', root, '--environment', path.join(root, 'runtime/environment.json'), '--output', output];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
  assert.doesNotMatch(result.stdout + result.stderr + await fs.readFile(output, 'utf8'), /synthetic|alice|password_hash|apiKey|sourcePath/);
  const forbidden = spawnSync(process.execPath, [...args.slice(0, -1), path.join(root, 'report.json')], { encoding: 'utf8' });
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /OUTPUT_INSIDE_SOURCE/);
  assert.doesNotMatch(forbidden.stdout + forbidden.stderr, /synthetic|alice|password_hash|apiKey/);
});

test('S3 migration disables optional checksum trailers and protects Aliyun writes with its native no-overwrite header', async () => {
  const config = { provider: 'aliyun', endpoint: 'oss.example.invalid', region: 'oss-cn-beijing', bucket: 'synthetic', accessKey: 'synthetic', secretKey: 'synthetic' };
  const options = productionMigrationS3Options(config);
  assert.equal(options.requestChecksumCalculation, 'WHEN_REQUIRED');
  assert.equal(options.responseChecksumValidation, 'WHEN_REQUIRED');
  assert.equal(options.endpoint, 'https://oss.example.invalid');
  const middleware = [];
  class Put {
    constructor(input) { this.input = input; this.middlewareStack = { add: (run, settings) => middleware.push({ run, settings }) }; }
  }
  const command = productionMigrationPutCommand(Put, config, 'key.pdf', Buffer.from('pdf'), 'application/pdf');
  assert.equal(command.input.IfNoneMatch, undefined);
  const request = { headers: {} };
  await middleware[0].run(async args => args)({ request });
  assert.equal(request.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(middleware[0].settings.step, 'build');
  const s3 = productionMigrationPutCommand(Put, { ...config, provider: 's3' }, 'key.pdf', Buffer.from('pdf'), 'application/pdf');
  assert.equal(s3.input.IfNoneMatch, '*');
});
