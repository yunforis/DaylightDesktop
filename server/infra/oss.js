import fs from 'node:fs';
import path from 'node:path';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readInfraConfig } from './config.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');

let s3 = null;
let mode = 'local';
let lastError = '';

/** 已实现 / 预留厂商。ready=false 表示管理端可选但连通仍提示「即将支持」。 */
export const OSS_PROVIDERS = [
  { id: 'local', label: '本地 attachments', ready: true },
  { id: 'aliyun', label: '阿里云 OSS', ready: true },
  { id: 'qiniu', label: '七牛云 Kodo', ready: true },
  { id: 'upyun', label: '又拍云 USS', ready: true },
  { id: 'us3', label: 'UCloud US3', ready: true },
  { id: 's3', label: 'AWS S3 / 兼容', ready: true },
  { id: 'tencent', label: '腾讯云 COS', ready: false },
  { id: 'huawei', label: '华为云 OBS', ready: false },
  { id: 'baidu', label: '百度云 BOS', ready: false },
  { id: 'volcengine', label: '火山引擎 TOS', ready: false },
  { id: 'minio', label: 'MinIO', ready: false },
  { id: 'cloudflare', label: 'Cloudflare R2', ready: false },
];

const CLOUD_PROVIDERS = new Set(OSS_PROVIDERS.filter((item) => item.id !== 'local').map((item) => item.id));
const READY_PROVIDERS = new Set(OSS_PROVIDERS.filter((item) => item.ready && item.id !== 'local').map((item) => item.id));

function localRoot(config = readInfraConfig().oss) {
  const dir = path.isAbsolute(config.localDir)
    ? config.localDir
    : path.join(dataDir, config.localDir || 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveCredentials(config) {
  return {
    accessKeyId: config.accessKey || process.env.DAYLIGHT_OSS_ACCESS_KEY || process.env.OSS_ACCESS_KEY_ID || '',
    secretAccessKey: config.secretKey || process.env.DAYLIGHT_OSS_SECRET_KEY || process.env.OSS_ACCESS_KEY_SECRET || '',
  };
}

function sanitizeSegment(value, fallback = 'shared') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^\w.\-@\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

/** users/{userFolder}/mailboxes/{mailboxId}/{date}/{uuid}-{filename} */
export function buildAttachmentKey({
  filename,
  userId,
  username,
  mailboxId = 'default',
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const userFolder = sanitizeSegment(username || userId || 'workspace', 'workspace');
  const box = sanitizeSegment(mailboxId, 'default');
  const safeName = sanitizeSegment(filename || 'file', 'file');
  return `users/${userFolder}/mailboxes/${box}/${date}/${randomUUID()}-${safeName}`;
}

function publicObjectUrl(config, key) {
  if (config.publicBaseUrl) {
    return `${String(config.publicBaseUrl).replace(/\/$/, '')}/${key}`;
  }
  if (config.provider === 'aliyun' && config.bucket && config.endpoint) {
    const host = String(config.endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${config.bucket}.${host}/${key}`;
  }
  return null;
}

function encodePath(key) {
  return String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function ossMode() {
  return mode;
}

export async function initOss() {
  const config = readInfraConfig({ force: true }).oss;
  s3 = null;
  mode = 'local';
  lastError = '';
  localRoot(config);

  if (!config.enabled || config.provider === 'local' || !CLOUD_PROVIDERS.has(config.provider)) {
    return { ok: true, mode };
  }

  if (!READY_PROVIDERS.has(config.provider)) {
    lastError = `${config.provider} 已列入选项，适配即将支持`;
    return { ok: false, mode: 'local', error: lastError };
  }

  const credentials = resolveCredentials(config);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    lastError = '对象存储已启用但缺少 AccessKey / SecretKey';
    return { ok: false, mode: 'local', error: lastError };
  }

  try {
    if (config.provider === 'aliyun' || config.provider === 'us3' || config.provider === 's3') {
      const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const endpoint = config.endpoint
        ? (String(config.endpoint).startsWith('http') ? config.endpoint : `https://${config.endpoint}`)
        : undefined;
      const client = new S3Client({
        region: config.region || 'oss-cn-beijing',
        endpoint,
        forcePathStyle: config.provider === 'us3',
        credentials,
      });
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      s3 = client;
      mode = config.provider;
      return { ok: true, mode };
    }

    if (config.provider === 'qiniu' || config.provider === 'upyun') {
      // 延迟到 put/get/test 时用 REST；init 时做一次连通探测。
      const probe = await testOssConnection(config);
      if (!probe.ok) throw new Error(probe.message || '连通失败');
      mode = config.provider;
      return { ok: true, mode };
    }

    return { ok: true, mode: 'local' };
  } catch (error) {
    s3 = null;
    mode = 'local';
    lastError = error.message;
    return { ok: false, mode, error: error.message };
  }
}

export async function ossStatus() {
  if (CLOUD_PROVIDERS.has(mode) && (s3 || mode === 'qiniu' || mode === 'upyun')) {
    return { ok: true, mode };
  }
  return {
    ok: true,
    mode: 'local',
    note: lastError || '未启用云对象存储时附件落在 data/attachments',
  };
}

function qiniuSign(secretKey, data) {
  return createHmac('sha1', secretKey).update(data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

function qiniuUploadToken(config, key) {
  const { accessKeyId, secretAccessKey } = resolveCredentials(config);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const policy = Buffer.from(JSON.stringify({
    scope: `${config.bucket}:${key}`,
    deadline,
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const sign = qiniuSign(secretAccessKey, policy);
  return `${accessKeyId}:${sign}:${policy}`;
}

async function putQiniu({ config, key, buffer, contentType }) {
  const token = qiniuUploadToken(config, key);
  const endpoint = (config.endpoint || 'https://upload.qiniup.com').replace(/\/$/, '');
  const form = new FormData();
  form.append('token', token);
  form.append('key', key);
  form.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), path.basename(key));
  const resp = await fetch(endpoint, { method: 'POST', body: form });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`七牛上传失败：${text || resp.status}`);
  return JSON.parse(text || '{}');
}

async function getQiniu({ config, key }) {
  const url = publicObjectUrl(config, key);
  if (!url) throw new Error('七牛需要配置 publicBaseUrl（CDN/下载域名）');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`七牛下载失败：${resp.status}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  return { buffer: bytes, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
}

function upyunSign({ method, date, uri, passwordMd5, operator }) {
  const raw = `${method}&${uri}&${date}`;
  const signature = createHmac('sha1', passwordMd5).update(raw).digest('base64');
  return `UPYUN ${operator}:${signature}`;
}

async function putUpyun({ config, key, buffer, contentType }) {
  const { accessKeyId: operator, secretAccessKey: password } = resolveCredentials(config);
  const passwordMd5 = createHash('md5').update(password).digest('hex');
  const uri = `/${config.bucket}/${key}`;
  const date = new Date().toUTCString();
  const host = (config.endpoint || 'https://v0.api.upyun.com').replace(/\/$/, '');
  const authorization = upyunSign({ method: 'PUT', date, uri, passwordMd5, operator });
  const resp = await fetch(`${host}${uri}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      Date: date,
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`又拍云上传失败：${text || resp.status}`);
  }
}

async function getUpyun({ config, key }) {
  const url = publicObjectUrl(config, key);
  if (url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`又拍云下载失败：${resp.status}`);
    return {
      buffer: Buffer.from(await resp.arrayBuffer()),
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
    };
  }
  const { accessKeyId: operator, secretAccessKey: password } = resolveCredentials(config);
  const passwordMd5 = createHash('md5').update(password).digest('hex');
  const uri = `/${config.bucket}/${key}`;
  const date = new Date().toUTCString();
  const host = (config.endpoint || 'https://v0.api.upyun.com').replace(/\/$/, '');
  const authorization = upyunSign({ method: 'GET', date, uri, passwordMd5, operator });
  const resp = await fetch(`${host}${uri}`, {
    method: 'GET',
    headers: { Authorization: authorization, Date: date },
  });
  if (!resp.ok) throw new Error(`又拍云下载失败：${resp.status}`);
  return {
    buffer: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function putAttachment({
  buffer,
  filename,
  contentType,
  userId,
  username,
  mailboxId = 'default',
  prefix,
} = {}) {
  const config = readInfraConfig().oss;
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const key = prefix
    ? `${String(prefix).replace(/\/$/, '')}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${sanitizeSegment(filename || 'file')}`
    : buildAttachmentKey({ filename, userId, username, mailboxId });

  const resultBase = {
    key,
    storage: mode,
    size: body.length,
    contentType: contentType || 'application/octet-stream',
    filename: path.basename(key).replace(/^[0-9a-f-]{36}-/i, '') || filename,
  };

  if (mode === 'aliyun' || mode === 'us3' || mode === 's3') {
    if (!s3) throw new Error('对象存储未就绪');
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }));
    const publicUrl = publicObjectUrl(config, key);
    return {
      ...resultBase,
      url: publicUrl || `/api/attachments/${encodeURIComponent(key)}`,
      proxyUrl: `/api/attachments/${encodeURIComponent(key)}`,
    };
  }

  if (mode === 'qiniu') {
    await putQiniu({ config, key, buffer: body, contentType });
    const publicUrl = publicObjectUrl(config, key);
    return {
      ...resultBase,
      url: publicUrl || `/api/attachments/${encodeURIComponent(key)}`,
      proxyUrl: `/api/attachments/${encodeURIComponent(key)}`,
    };
  }

  if (mode === 'upyun') {
    await putUpyun({ config, key, buffer: body, contentType });
    const publicUrl = publicObjectUrl(config, key);
    return {
      ...resultBase,
      url: publicUrl || `/api/attachments/${encodeURIComponent(key)}`,
      proxyUrl: `/api/attachments/${encodeURIComponent(key)}`,
    };
  }

  const full = path.join(localRoot(config), key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return {
    ...resultBase,
    storage: 'local',
    url: `/api/attachments/${encodeURIComponent(key)}`,
    proxyUrl: `/api/attachments/${encodeURIComponent(key)}`,
  };
}

export async function getAttachmentObject(key) {
  const config = readInfraConfig().oss;
  if ((mode === 'aliyun' || mode === 'us3' || mode === 's3') && s3) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const bytes = await result.Body.transformToByteArray();
    return {
      buffer: Buffer.from(bytes),
      contentType: result.ContentType || 'application/octet-stream',
      storage: mode,
      publicUrl: publicObjectUrl(config, key),
    };
  }
  if (mode === 'qiniu') {
    const got = await getQiniu({ config, key });
    return { ...got, storage: 'qiniu', publicUrl: publicObjectUrl(config, key) };
  }
  if (mode === 'upyun') {
    const got = await getUpyun({ config, key });
    return { ...got, storage: 'upyun', publicUrl: publicObjectUrl(config, key) };
  }
  const full = resolveLocalAttachment(key);
  if (!full) return null;
  return {
    buffer: fs.readFileSync(full),
    contentType: undefined,
    storage: 'local',
    publicUrl: null,
  };
}

export function resolveLocalAttachment(key) {
  const rootDir = localRoot();
  const full = path.join(rootDir, key);
  if (!full.startsWith(rootDir) || !fs.existsSync(full)) return null;
  return full;
}

export function attachmentPublicUrl(key) {
  return publicObjectUrl(readInfraConfig().oss, key);
}

export async function testOssConnection(incoming) {
  const config = { ...readInfraConfig().oss, ...(incoming || {}) };
  const provider = config.provider || 'local';
  if (!config.enabled || provider === 'local') {
    const dir = localRoot(config);
    const probe = path.join(dir, `.probe-${Date.now()}.txt`);
    fs.writeFileSync(probe, 'daylight-oss-ok');
    fs.unlinkSync(probe);
    return { ok: true, mode: 'local', message: `本地目录可写：${dir}` };
  }

  if (!READY_PROVIDERS.has(provider)) {
    return {
      ok: false,
      mode: provider,
      message: `${provider} 已预留，适配即将支持；当前请选用阿里云 / 七牛 / 又拍云 / US3 / S3`,
    };
  }

  const credentials = resolveCredentials(config);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    return { ok: false, mode: provider, message: '请填写 AccessKey / SecretKey' };
  }
  if (!config.bucket) return { ok: false, mode: provider, message: '请填写 bucket / 服务名' };

  const probeKey = `users/_system/probes/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-probe.txt`;
  const body = Buffer.from(`daylight probe ${new Date().toISOString()}`);

  if (provider === 'aliyun' || provider === 'us3' || provider === 's3') {
    const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    const endpoint = config.endpoint
      ? (String(config.endpoint).startsWith('http') ? config.endpoint : `https://${config.endpoint}`)
      : undefined;
    const client = new S3Client({
      region: config.region || 'oss-cn-beijing',
      endpoint,
      forcePathStyle: provider === 'us3',
      credentials,
    });
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: probeKey,
      Body: body,
      ContentType: 'text/plain',
    }));
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: probeKey }));
    return { ok: true, mode: provider, message: `${provider} 连通成功（已写入并删除探测对象）` };
  }

  if (provider === 'qiniu') {
    if (!config.publicBaseUrl) {
      return { ok: false, mode: 'qiniu', message: '七牛需要 publicBaseUrl（绑定的下载/CDN 域名）' };
    }
    await putQiniu({ config, key: probeKey, buffer: body, contentType: 'text/plain' });
    return { ok: true, mode: 'qiniu', message: '七牛连通成功（已上传探测对象，可稍后手动清理）' };
  }

  if (provider === 'upyun') {
    await putUpyun({ config, key: probeKey, buffer: body, contentType: 'text/plain' });
    return { ok: true, mode: 'upyun', message: '又拍云连通成功（已上传探测对象）' };
  }

  return { ok: false, mode: provider, message: `暂不支持探测 ${provider}` };
}

export function encodeAttachmentPath(key) {
  return encodePath(key);
}
