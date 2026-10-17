import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/auxiliary-persistence-'));
process.env.DAYLIGHT_DATA_DIR = directory;
process.env.DAYLIGHT_RUNTIME = 'production';
Object.assign(process.env, {
  DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/daylight',
  DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
  DAYLIGHT_JWT_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic',
  DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
});
const pg = await import('./infra/postgres.js');
const rag = await import('./rag/store.js');
const guide = await import('./onboarding-guide.js');
const db = await import('./db.js');
const storage = await import('./storage/index.js');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

// RAG reads and writes require a mailbox owned by the active production snapshot.
// Keep this ownership fixture independent of the PG client being fault-injected.
const mailboxSnapshotPool = { async connect() { return {
  async query(sql, values) {
    return { rows: /SELECT payload, version FROM app_settings/i.test(sql) && values[0] === 'default'
      ? [{ payload: { mailboxes: [{ id: 'mailbox', ownerUserId: 'owner' }] }, version: 1 }] : [] };
  },
  release() {},
}; } };
const withOwnedMailbox = fn => storage.withStorageSnapshot({ pool: mailboxSnapshotPool, userId: 'owner' }, fn);

test('production auxiliary persistence refuses missing PG without accessing local data', async () => {
  await assert.rejects(rag.listChunks('mailbox'), { code: 'STORAGE_SNAPSHOT_REQUIRED' });
  await withOwnedMailbox(async () => {
    for (const action of [
      () => rag.listChunks('mailbox'),
      () => rag.replaceChunks('mailbox', 'attachment', []),
      () => rag.deleteChunksByAttachment('mailbox', 'attachment'),
      () => rag.reassignCandidate('mailbox', 'attachment', 'candidate'),
    ]) await assert.rejects(action(), /unavailable/);
  });
  for (const action of [
    () => guide.readOnboardingGuideAsync(),
    () => guide.resetOnboardingGuide(),
    () => db.getKv('key'), () => db.setKv('key', 'value'),
    () => db.appendPromptRevision('kind', 'body'), () => db.listPromptRevisions(),
  ]) await assert.rejects(action(), /unavailable/);
  assert.throws(() => guide.readOnboardingGuide(), /unavailable/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('RAG failure rolls back replacement; every attachment mutation locks; production performs no DDL', async (t) => {
  const driver = (await import('pg')).default;
  const queries = [];
  let rows = [{ id: 'old', mailbox_id: 'mailbox', attachment_id: 'attachment', content: 'old' }];
  let saved;
  let failInsert = true;
  let released = 0;
  t.mock.method(driver.Pool.prototype, 'query', async (sql) => {
    queries.push(sql);
    return { rows };
  });
  t.mock.method(driver.Pool.prototype, 'connect', async () => ({
    async query(sql, values) {
      queries.push(sql);
      if (sql === 'BEGIN') saved = structuredClone(rows);
      if (sql === 'ROLLBACK') rows = saved;
      if (/^delete /i.test(sql)) rows = [];
      if (/^insert /i.test(sql)) {
        if (failInsert) throw new Error('synthetic insertion failure');
        rows.push({ id: values[0], mailbox_id: values[1], attachment_id: values[4], content: values[8] });
      }
      return { rows };
    },
    release() { released++; },
  }));
  await pg.initPostgres();
  const chunk = { id: 'new', content: 'new', page: 1, chunkIndex: 0 };
  await withOwnedMailbox(async () => {
    await assert.rejects(rag.replaceChunks('mailbox', 'attachment', [chunk]), /synthetic insertion/);
    assert.equal(rows[0].id, 'old');
    assert.equal(released, 1);
    assert.ok(queries.includes('ROLLBACK'));
    failInsert = false;
    const result = await rag.replaceChunks('mailbox', 'attachment', [chunk]);
    assert.equal(result[0].id, 'new');
    await rag.reassignCandidate('mailbox', 'attachment', 'candidate');
    await rag.deleteChunksByAttachment('mailbox', 'attachment');
    await assert.rejects(rag.replaceChunks('mailbox', 'attachment', [{ ...chunk, mailboxId: 'other' }]), /scope/);
  });
  const locks = queries.filter((sql) => sql.includes('pg_advisory_xact_lock'));
  assert.equal(locks.length, 8);
  for (let index = 0; index < locks.length; index += 2) {
    assert.match(locks[index], /^SELECT pg_advisory_xact_lock_shared\(/);
    assert.match(locks[index + 1], /^SELECT pg_advisory_xact_lock\(/);
  }
  assert.equal(released, 4);
  assert.ok(!queries.some((sql) => /CREATE|ALTER/i.test(sql)));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('onboarding reads shared authority, initializes without overwriting, and propagates PG faults', async (t) => {
  const driver = (await import('pg')).default;
  const queries = [];
  let payload = null;
  let fail = false;
  t.mock.method(driver.Pool.prototype, 'query', async (sql, values) => {
    queries.push(sql);
    if (fail) throw new Error('synthetic PG outage');
    if (sql.includes('insert into app_settings')) {
      // Simulate an administrator winning the initial insert race.
      if (sql.includes('do nothing')) payload = { steps: [{ id: 'admin', title: 'Concurrent admin', text: 'shared' }] };
      else payload = JSON.parse(values[1]);
    }
    return { rows: payload ? [{ payload }] : [] };
  });
  assert.equal((await guide.readOnboardingGuideAsync()).steps[0].id, 'admin');
  assert.equal((await guide.resetOnboardingGuide()).storage, 'postgres');
  fail = true;
  await assert.rejects(guide.readOnboardingGuideAsync(), /synthetic PG outage/);
  await assert.rejects(guide.resetOnboardingGuide(), /synthetic PG outage/);
  assert.ok(queries.some((sql) => sql.includes('do nothing')));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('audit uses shared atomic append and returns PG errors rather than SQLite fallback', async (t) => {
  const driver = (await import('pg')).default;
  let revisions = [];
  let fail = false;
  t.mock.method(driver.Pool.prototype, 'query', async (sql, values) => {
    if (fail) throw new Error('synthetic audit outage');
    if (sql.includes('app_settings.payload || excluded.payload')) revisions.push(...JSON.parse(values[1]));
    return { rows: sql.includes('jsonb_array_elements') ? revisions.slice().reverse().map((revision) => ({ revision })) : [] };
  });
  await Promise.all([db.appendPromptRevision('system', 'first'), db.appendPromptRevision('system', 'second')]);
  assert.equal((await db.listPromptRevisions()).length, 2);
  assert.equal((await db.dbStatus()).engine, 'postgres');
  fail = true;
  await assert.rejects(db.appendPromptRevision('system', 'failed'), /synthetic audit outage/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('synchronous auxiliary modules use only ALS snapshots, stage atomic revisions, and preserve local compatibility', async () => {
  const prompts = await import('./prompts.js');
  const reports = await import('./report-prompts.js');
  const templates = await import('./mail-templates.js');
  const recruitment = await import('./recruitment-store.js');
  const traces = await import('./traces.js');
  for (const action of [prompts.readPrompts, reports.readReportPrompts, templates.readMailTemplates,
    () => recruitment.readRecruitment('mailbox'), () => traces.readTraces('mailbox')]) {
    assert.throws(action, /snapshot/);
  }
  const rowsByDocument = new Map([['app_settings:default', {
    payload: { mailboxes: [{ id: 'mailbox', ownerUserId: 'owner' }] }, version: 1,
  }]]);
  const queries = [];
  const pool = { async connect() { return {
    async query(sql, values) {
      queries.push(sql);
      const table = sql.match(/(?:FROM|INTO|UPDATE)\s+(app_settings|mailbox_calendars)\b/i)?.[1];
      const key = `${table}:${values?.[0]}`;
      const row = rowsByDocument.get(key);
      if (/SELECT (?:payload, )?version FROM/i.test(sql)) return {
        rows: row ? [structuredClone(row)] : [],
      };
      if (/^INSERT INTO/i.test(sql)) {
        if (row) return { rows: [] };
        rowsByDocument.set(key, { payload: JSON.parse(values[1]), version: 1 });
        return { rows: [{ version: 1 }] };
      }
      if (/^UPDATE /i.test(sql)) {
        if (!row || String(row.version) !== String(values[2])) return { rows: [] };
        rowsByDocument.set(key, { payload: JSON.parse(values[1]), version: row.version + 1 });
        return { rows: [{ version: row.version + 1 }] };
      }
      return { rows: [] };
    }, release() {},
  }; } };
  await storage.withStorageSnapshot({ pool, userId: 'owner' }, async () => {
    prompts.savePrompts({ extractionSystem: 'synthetic shared prompt' });
    assert.equal(prompts.readPrompts().extractionSystem, 'synthetic shared prompt');
    assert.equal(storage.readSnapshotDocument(storage.settingsKey('aux-prompt-revisions')).length, 1);
    reports.upsertReportPreset({ id: 'custom', name: 'Shared preset' });
    assert.ok(reports.readReportPrompts().presets.some((item) => item.id === 'custom'));
    templates.saveMailTemplates({ notification: { subject: 'Shared subject' } });
    assert.equal(templates.readMailTemplates().notification.subject, 'Shared subject');
    recruitment.updateRecruitment('mailbox', (data) => data.candidates.push({ id: 'candidate' }));
    assert.equal(recruitment.readRecruitment('mailbox').candidates[0].id, 'candidate');
    traces.saveTraces([{ trace_id: 'trace' }], 'mailbox');
    assert.equal(traces.readTraces('mailbox')[0].trace_id, 'trace');
    await storage.commitStorage();
  });
  assert.ok(queries.some(sql => /FOR SHARE/.test(sql)));
  assert.ok(queries.some(sql => /FOR UPDATE/.test(sql)));
  await storage.withStorageSnapshot({ pool, userId: 'owner' }, async () => {
    assert.equal(prompts.readPrompts().extractionSystem, 'synthetic shared prompt');
    reports.upsertReportPreset({ id: 'second', name: 'Second preset' });
    await storage.commitStorage();
  });
  const persistedReports = structuredClone(rowsByDocument.get('app_settings:report-prompts'));
  await assert.rejects(storage.withStorageSnapshot({ pool, userId: 'owner' }, async () => {
    reports.upsertReportPreset({ id: 'rejected', name: 'Stale input' });
    // Another writer changes a read-only input after this snapshot was loaded.
    rowsByDocument.get('app_settings:default').version++;
    await storage.commitStorage();
  }), { code: 'STORAGE_VERSION_CONFLICT' });
  assert.deepEqual(rowsByDocument.get('app_settings:report-prompts'), persistedReports);
  assert.ok(queries.includes('ROLLBACK'));
  assert.deepEqual(fs.readdirSync(directory), []);
});
