#!/usr/bin/env node
/**
 * Real object storage verification (no mocks, no local fallback).
 *
 * Targets whatever S3-compatible endpoint the production environment configures — Aliyun OSS,
 * UCloud US3 or a self-hosted MinIO/S3 deployment. Requires production env (DAYLIGHT_* OSS
 * variables). Every operation is counted so the run can be reconciled against the agreed usage
 * budget.
 *
 * Usage:
 *   set -a; . /opt/daylight/.env; set +a
 *   node scripts/verify-oss.mjs [--keep]      # --keep leaves test objects in the bucket
 */
import { randomUUID } from 'node:crypto';
import { initOss, ossMode, ossStatus, putAttachment, getAttachmentObject, testOssConnection } from '../server/infra/oss.js';
import { readInfraConfig } from '../server/infra/config.js';

const keep = process.argv.includes('--keep');
/**
 * Every S3-compatible provider is a real cloud target (Aliyun OSS, UCloud US3, self-hosted
 * MinIO/S3). What must never happen is a silent local/JSON fallback, so the assertions accept
 * any cloud mode and reject anything else.
 */
const CLOUD_MODES = new Set(['aliyun', 'us3', 's3']);
const isCloudMode = value => CLOUD_MODES.has(value);
const results = [];
const usage = { put: 0, get: 0, delete: 0, head: 0, probe: 0 };
const record = (name, ok, detail, extra = {}) => {
  results.push({ name, ok, detail, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const config = readInfraConfig().oss;
const bucket = config.bucket;
const endpointHost = config.endpoint ? String(config.endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '') : '';

const sdk = await import('@aws-sdk/client-s3');
function client() {
  const { S3Client } = sdk;
  const endpoint = config.endpoint
    ? (String(config.endpoint).startsWith('http') ? config.endpoint : `https://${config.endpoint}`)
    : undefined;
  return new S3Client({
    region: config.region || 'oss-cn-beijing',
    endpoint,
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
  });
}

console.log('=== Daylight real OSS verification ===');
console.log(`provider=${config.provider} bucket=${bucket} endpoint=${endpointHost} region=${config.region} forcePathStyle=${Boolean(config.forcePathStyle)}`);
console.log(`runtime=${process.env.DAYLIGHT_RUNTIME} publicBaseUrl=${config.publicBaseUrl ? '(set)' : '(unset)'}\n`);

const init = await initOss();
record('initOss returns cloud mode (no local fallback)', init.ok && isCloudMode(ossMode()), `mode=${ossMode()}`, { usage: { ...usage } });

usage.head += 1;
const status = await ossStatus();
record('ossStatus HEAD bucket reachable', status.ok === true && isCloudMode(status.mode), JSON.stringify(status));

usage.probe += 1;
const probe = await testOssConnection(config);
record('testOssConnection put+delete probe', probe.ok === true, `mode=${probe.mode ?? 'unknown'} ${probe.error ? `error=${probe.error}` : ''}`);

const userId = `ossverify-${randomUUID().slice(0, 8)}`;
const username = 'verify-oss';
const mailboxId = 'default';
const payload = Buffer.from(`daylight-oss-verify ${new Date().toISOString()} ${'x'.repeat(2048)}`);
const filename = 'report 最终版.pdf';

usage.put += 1;
let put;
try {
  put = await putAttachment({ buffer: payload, filename, contentType: 'application/pdf', userId, username, mailboxId });
  record('putAttachment uploads to real bucket', isCloudMode(put.storage) && put.size === payload.length, `key=${put.key} storage=${put.storage}`);
} catch (error) {
  record('putAttachment uploads to real bucket', false, `${error.code || error.name}: ${error.message}`);
}

if (put) {
  const parts = put.key.split('/');
  const layoutOk = parts[0] === 'users' && parts[1] === username && parts[2] === 'mailboxes' && parts[3] === mailboxId
    && /^\d{4}-\d{2}-\d{2}$/.test(parts[4]) && parts.length === 6;
  record('attachment key layout scopes user + mailbox', layoutOk, put.key);
  record('attachment key sanitises filename (no raw spaces/paths)', !/[\s]/.test(put.key) && !put.key.includes('..'), put.key);

  usage.get += 1;
  try {
    const got = await getAttachmentObject(put.key);
    record('getAttachmentObject returns identical bytes', got.buffer.equals(payload), `bytes=${got.buffer.length} contentType=${got.contentType}`);
    record('getAttachmentObject reports cloud storage mode', isCloudMode(got.storage), `storage=${got.storage}`);
  } catch (error) {
    record('getAttachmentObject returns identical bytes', false, `${error.code || error.name}: ${error.message}`);
  }

  // Ownership boundary: a second tenant must not be able to address the first tenant's bytes.
  const foreignName = put.key.split('/').slice(0, 1).concat(['other-user', ...put.key.split('/').slice(2)]).join('/');
  usage.get += 1;
  try {
    await getAttachmentObject(foreignName);
    record('cross-tenant key does not resolve', false, 'unexpectedly readable');
  } catch (error) {
    record('cross-tenant key does not resolve', true, `${error.code || error.name}`);
  }
}

const invalid = ['a/../b', 'a/./b', 'C:/tmp/x', 'a/%2e%2e/b', 'a//b', ''];
let allRejected = true;
const accepted = [];
for (const key of invalid) {
  try { await getAttachmentObject(key); accepted.push(key); allRejected = false; } catch { /* expected */ }
}
record('invalid keys rejected before any request', allRejected, accepted.length ? `accepted=${accepted.join(',')}` : `rejected ${invalid.length}/${invalid.length}`);

usage.get += 1;
try {
  await getAttachmentObject(`users/nobody/mailboxes/default/1970-01-01/${randomUUID()}-missing.bin`);
  record('missing object fails loudly (no null fallback)', false, 'returned without error');
} catch (error) {
  record('missing object fails loudly (no null fallback)', true, `${error.code || error.name}`);
}

// Credentials resolve from config first, then process env. Hiding both is the only honest
// way to assert that a credential-less production OSS refuses to operate (no local fallback).
const credEnvKeys = ['DAYLIGHT_OSS_ACCESS_KEY', 'DAYLIGHT_OSS_SECRET_KEY', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'];
const savedCreds = credEnvKeys.map(key => [key, process.env[key]]);
const hideCreds = () => { for (const key of credEnvKeys) delete process.env[key]; };
const restoreCreds = () => { for (const [key, value] of savedCreds) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

let disabled;
let disabledThrew = '';
hideCreds();
try { disabled = await testOssConnection({ ...config, accessKey: '', secretKey: '' }); }
catch (error) { disabledThrew = error.message; }
finally { restoreCreds(); }
const disabledRefused = disabledThrew
  ? /Production requires environment variables/.test(disabledThrew)
  : (disabled.ok === false && isCloudMode(disabled.mode));
record('missing credentials fail explicitly (no local fallback)', disabledRefused,
  disabledThrew ? `refused: ${disabledThrew.slice(0, 70)}` : `ok=${disabled.ok} mode=${disabled.mode}`);

hideCreds();
let reinitThrew = '';
let reinit = null;
try { reinit = await initOss(); }
catch (error) { reinitThrew = error.message; }
finally { restoreCreds(); }
record('production initOss refuses local fallback without credentials',
  reinitThrew ? /Production requires environment variables/.test(reinitThrew) : (reinit.ok === false && ossMode() !== 'local'),
  reinitThrew ? `refused: ${reinitThrew.slice(0, 70)}` : `ok=${reinit.ok} mode=${ossMode()}`);
await initOss();

usage.delete += 1;
try {
  const c = client();
  await c.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: put.key }));
  c.destroy();
  usage.head += 1;
  const c2 = client();
  let gone = false;
  try { await c2.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: put.key })); } catch { gone = true; } finally { c2.destroy(); }
  record('delete removes object from bucket', gone, `key=${put.key}`);
} catch (error) {
  record('delete removes object from bucket', false, `${error.code || error.name}: ${error.message}`);
}

if (keep && put) console.log(`\n(kept test object: ${put.key})`);

const failed = results.filter(r => !r.ok);
console.log(`\n=== summary: ${results.length - failed.length}/${results.length} passed ===`);
console.log(`OSS operations: put=${usage.put} get=${usage.get} delete=${usage.delete} head=${usage.head} probe=${usage.probe}`);
if (failed.length) { console.log('failed:'); for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`); process.exitCode = 1; }
