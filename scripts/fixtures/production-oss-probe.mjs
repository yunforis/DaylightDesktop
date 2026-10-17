import assert from 'node:assert/strict';
import { initOss, putAttachment, getAttachmentObject, closeOss } from '../../server/infra/oss.js';

try {
  assert.equal((await initOss()).mode, 's3');
  const saved = await putAttachment({ buffer: Buffer.from('synthetic attachment'), filename: 'probe.txt',
    contentType: 'text/plain', userId: 'alice', mailboxId: 'mail-alice' });
  assert.equal(saved.storage, 's3');
  const read = await getAttachmentObject(saved.key);
  assert.equal(read.buffer.toString(), 'synthetic attachment');
  console.log('Local synthetic S3 PUT/GET via production OSS adapter passed');
} finally { closeOss(); }
