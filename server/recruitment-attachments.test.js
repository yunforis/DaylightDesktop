import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const directory = fs.mkdtempSync(path.resolve('work/recruitment-attachments-'));
Object.assign(process.env, {
  DAYLIGHT_DATA_DIR: directory, DAYLIGHT_RUNTIME: 'production',
  DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/daylight',
  DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
  DAYLIGHT_JWT_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic',
  DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
});
const attachments = await import('./recruitment-store.js');
const storage = await import('./storage/index.js');
const oss = await import('./infra/oss.js');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const pool = { async connect() { return {
  async query(sql, values) {
    if (sql.includes('SELECT payload, version') && values[0] === 'default') return {
      rows: [{ payload: { mailboxes: [{ id: 'mailbox', ownerUserId: 'owner' }, { id: 'other', ownerUserId: 'owner' }] }, version: 1 }],
    };
    if (sql.includes('SELECT version')) return { rows: values[0] === 'default' ? [{ version: 1 }] : [] };
    if (/INSERT|UPDATE/.test(sql)) return { rows: [{ version: 1 }] };
    return { rows: [] };
  }, release() {},
}; } };

test('production upload refuses uninitialized local OSS without writing files', async () => {
  await storage.withStorageSnapshot({ pool, userId: 'owner' }, async () => {
    await assert.rejects(attachments.storeAttachmentAsync('mailbox', 'mail', {
      content: Buffer.from('synthetic'),
    }), /available shared object storage/);
    assert.equal(attachments.readRecruitment('mailbox').attachments.length, 0);
  });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('production recruitment OSS stores bytes before metadata, reads registered keys and propagates failures', async (t) => {
  const { S3Client } = await import('@aws-sdk/client-s3');
  const objects = new Map();
  const commands = [];
  let failUpload = false;
  let failRead = false;
  t.mock.method(S3Client.prototype, 'send', async function (command) {
    commands.push(command.constructor.name);
    if (command.constructor.name === 'PutObjectCommand') {
      if (failUpload) throw new Error('synthetic upload outage');
      objects.set(command.input.Key, Buffer.from(command.input.Body));
    }
    if (command.constructor.name === 'GetObjectCommand') {
      if (failRead) throw new Error('synthetic read outage');
      if (!objects.has(command.input.Key)) throw Object.assign(new Error('synthetic object missing'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => objects.get(command.input.Key) } };
    }
    return {};
  });
  assert.equal((await oss.initOss()).ok, true);
  await storage.withStorageSnapshot({ pool, userId: 'owner' }, async () => {
    const input = { filename: '../synthetic.pdf', content: Buffer.from('%PDF synthetic'), contentType: 'application/pdf' };
    const record = await attachments.storeAttachmentAsync('mailbox', 'mail', input);
    assert.equal(record.filename, 'synthetic.pdf');
    assert.equal(record.storage, 's3');
    assert.match(record.key, /^users\/owner\/mailboxes\/mailbox\//);
    assert.deepEqual(await attachments.readAttachmentBytes('mailbox', record.id), input.content);
    const count = commands.length;
    assert.equal(await attachments.readAttachmentBytes('other', record.id), null);
    assert.equal(await attachments.readAttachmentBytes('mailbox', '../unknown'), null);
    assert.equal(commands.length, count);
    assert.deepEqual(await attachments.storeAttachmentAsync('mailbox', 'mail', input), record);
    assert.equal(commands.length, count);
    failUpload = true;
    await assert.rejects(attachments.storeAttachmentAsync('mailbox', 'failed', input), /upload outage/);
    assert.equal(attachments.readRecruitment('mailbox').attachments.length, 1);
    failRead = true;
    await assert.rejects(attachments.readAttachmentBytes('mailbox', record.id), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ATTACHMENT_STORAGE_UNAVAILABLE');
      assert.doesNotMatch(error.message, /read outage/);
      assert.match(error.cause.message, /read outage/);
      return true;
    });
    failRead = false;
    attachments.updateRecruitment('mailbox', data => data.attachments.push({ id: 'missing-object', key: 'synthetic/missing.pdf', storage: 's3' }));
    assert.equal(await attachments.readAttachmentBytes('mailbox', 'missing-object'), null);
    attachments.updateRecruitment('mailbox', data => data.attachments.push({ id: 'legacy' }));
    await assert.rejects(attachments.readAttachmentBytes('mailbox', 'legacy'), /unavailable in production/);
    assert.throws(() => attachments.storeAttachment('mailbox', 'mail', input), /unavailable in production/);
    assert.throws(() => attachments.attachmentPath('mailbox', record.id), /unavailable in production/);
    await storage.commitStorage();
  });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('auxiliary migration exports required RAG schema without optional extensions', async () => {
  const { AUXILIARY_SCHEMA, migrateAuxiliary } = await import('./storage/aux-schema.js');
  const statements = [];
  await migrateAuxiliary({ async query(sql) { statements.push(sql); } });
  assert.deepEqual(statements, [AUXILIARY_SCHEMA]);
  assert.match(AUXILIARY_SCHEMA, /CREATE TABLE IF NOT EXISTS rag_chunks/);
  assert.match(AUXILIARY_SCHEMA, /embedding JSONB/);
  assert.doesNotMatch(AUXILIARY_SCHEMA, /CREATE EXTENSION/);
});
