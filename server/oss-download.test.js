import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

Object.assign(process.env, {
  DAYLIGHT_RUNTIME: 'production', DAYLIGHT_METRICS: '0',
  DAYLIGHT_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/daylight',
  DAYLIGHT_REDIS_URL: 'redis://127.0.0.1:1', DAYLIGHT_AMQP_URL: 'amqp://127.0.0.1:1',
  DAYLIGHT_JWT_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'synthetic',
  DAYLIGHT_OSS_ACCESS_KEY: 'synthetic', DAYLIGHT_OSS_SECRET_KEY: 'synthetic',
  DAYLIGHT_OSS_ENDPOINT: 'http://127.0.0.1:1', DAYLIGHT_OSS_FORCE_PATH_STYLE: '1',
});
delete process.env.DAYLIGHT_REQUIRE_AUTH;
delete process.env.DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN;
const { S3Client } = await import('@aws-sdk/client-s3');
const oss = await import('./infra/oss.js');
// Mock transports have no open socket to keep the real unref'ed deadline alive.
const keepAlive = setInterval(() => {}, 1000);
after(() => { clearInterval(keepAlive); oss.closeOss(); });

async function mockDownload(t, download) {
  t.mock.method(S3Client.prototype, 'send', async (command, options) => {
    if (command.constructor.name === 'GetObjectCommand') return download(options);
    return {};
  });
  await oss.initOss();
  t.after(oss.closeOss);
}

const timeout = error => {
  assert.equal(error.status, 504);
  assert.equal(error.code, 'ATTACHMENT_DOWNLOAD_TIMEOUT');
  assert.match(error.message, /下载超时/);
  return true;
};

test('download has one hard deadline even when the transport ignores abort while waiting for headers', async t => {
  let signal;
  await mockDownload(t, options => { signal = options.abortSignal; return new Promise(() => {}); });
  await assert.rejects(oss.getAttachmentObject('synthetic-file', { timeoutMs: 25 }), timeout);
  assert.equal(signal.aborted, true);
});

test('the same download deadline covers a stalled response body and destroys its socket', async t => {
  let destroyed = 0;
  await mockDownload(t, () => ({ Body: { transformToByteArray: () => new Promise(() => {}), destroy() { destroyed++; } } }));
  await assert.rejects(oss.getAttachmentObject('synthetic-file', { timeoutMs: 25 }), timeout);
  assert.ok(destroyed > 0);
});

test('a body arriving after the deadline is destroyed without being read or becoming an unhandled rejection', async t => {
  let destroyed = 0, consumed = 0;
  await mockDownload(t, async () => {
    await delay(65);
    return { Body: { destroy() { destroyed++; }, transformToByteArray() { consumed++; return Buffer.from('late'); } } };
  });
  await assert.rejects(oss.getAttachmentObject('synthetic-file', { timeoutMs: 15 }), timeout);
  await delay(90);
  assert.equal(destroyed, 1);
  assert.equal(consumed, 0);
});

test('successful body collection cancels its deadline and preserves exact bytes', async t => {
  let destroyed = 0;
  const expected = Buffer.from('synthetic complete object');
  await mockDownload(t, () => ({ Body: { destroy() { destroyed++; }, transformToByteArray: async () => expected } }));
  const result = await oss.getAttachmentObject('synthetic-file', { timeoutMs: 15 });
  assert.deepEqual(result.buffer, expected);
  await delay(35);
  assert.equal(destroyed, 0);
});

test('only remote missing objects return null; permission, network and body failures use safe upstream status', async t => {
  let failure;
  await mockDownload(t, () => { throw failure; });
  for (failure of [Object.assign(new Error('private missing detail'), { name: 'NoSuchKey' }),
    Object.assign(new Error('private missing detail'), { $metadata: { httpStatusCode: 404 } })]) {
    assert.equal(await oss.getAttachmentObject('synthetic-file'), null);
  }
  for (failure of [Object.assign(new Error('private cloud authorization detail'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error('private network host'), { code: 'ECONNRESET' })]) {
    await assert.rejects(oss.getAttachmentObject('synthetic-file'), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ATTACHMENT_STORAGE_UNAVAILABLE');
      assert.doesNotMatch(error.message, /private/);
      assert.equal(error.cause, failure);
      return true;
    });
  }
  failure = Object.assign(new Error('private socket timeout detail'), { code: 'ETIMEDOUT' });
  await assert.rejects(oss.getAttachmentObject('synthetic-file'), timeout);
});

test('body consumption failures are upstream errors and release the partially read body', async t => {
  let destroyed = 0;
  await mockDownload(t, () => ({ Body: { destroy() { destroyed++; }, transformToByteArray: async () => { throw new Error('private body failure'); } } }));
  await assert.rejects(oss.getAttachmentObject('synthetic-file'), { status: 502, code: 'ATTACHMENT_STORAGE_UNAVAILABLE' });
  assert.equal(destroyed, 1);
});

test('real SDK over isolated HTTP maps missing/denied and bounds both header and streamed body waits', async t => {
  const slowSockets = new Set();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://synthetic.invalid').pathname;
    if (req.method === 'HEAD') return res.writeHead(200).end();
    if (pathname.endsWith('/slow-header')) { slowSockets.add(req.socket); return; }
    if (pathname.endsWith('/slow-body')) {
      slowSockets.add(req.socket);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 1000 });
      return res.write('partial');
    }
    const missing = pathname.endsWith('/missing');
    res.writeHead(missing ? 404 : 403, { 'Content-Type': 'application/xml' });
    res.end(`<Error><Code>${missing ? 'NoSuchKey' : 'AccessDenied'}</Code><Message>private synthetic detail</Message></Error>`);
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  process.env.DAYLIGHT_OSS_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  await oss.initOss();
  assert.equal(await oss.getAttachmentObject('missing'), null);
  await assert.rejects(oss.getAttachmentObject('denied'), { status: 502, code: 'ATTACHMENT_STORAGE_UNAVAILABLE' });
  await assert.rejects(oss.getAttachmentObject('slow-header', { timeoutMs: 60 }), timeout);
  await assert.rejects(oss.getAttachmentObject('slow-body', { timeoutMs: 60 }), timeout);
  await delay(30);
  assert.equal(slowSockets.size, 2);
  assert.equal([...slowSockets].filter(socket => !socket.destroyed).length, 0);
});
