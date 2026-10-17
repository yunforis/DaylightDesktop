/**
 * Hot-reloadable infrastructure config.
 * Defaults are local (file / memory / process queue / local attachments).
 * Optional: local PostgreSQL/Redis, or US3 for object storage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecureJson, writeSecureJson } from '../secure-json.js';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';

// [desktop patch] 桌面端是单用户本地应用：默认不连共享 PG/MQ，配置落盘加密。
const DESKTOP = process.env.DAYLIGHT_DESKTOP === '1';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const configPath = path.join(dataDir, 'infra.json');

const DEFAULTS = {
  postgres: {
    enabled: !DESKTOP,
    connectionString: '',
    host: '127.0.0.1',
    port: 5432,
    database: 'daylight',
    user: 'daylight',
    password: 'daylight',
    ssl: false,
  },
  redis: {
    enabled: false,
    url: '',
    host: '127.0.0.1',
    port: 6379,
    password: '',
    db: 0,
  },
  mq: {
    enabled: !DESKTOP,
    provider: 'rabbitmq', // local | rabbitmq | urocketmq | ukafka（连不上时自动回退进程内队列）
    url: '',
    host: '127.0.0.1',
    port: 5672,
    user: 'daylight',
    password: 'daylight',
    vhost: '/',
    endpoint: '',
    accessKey: '',
    secretKey: '',
    topicPrefix: 'daylight',
  },
  oss: {
    enabled: false,
    provider: 'aliyun', // local | aliyun | qiniu | upyun | us3
    endpoint: 'https://oss-cn-beijing.aliyuncs.com',
    bucket: 'lucky-yyf',
    accessKey: '',
    secretKey: '',
    region: 'oss-cn-beijing',
    publicBaseUrl: 'https://lucky-yyf.oss-cn-beijing.aliyuncs.com',
    localDir: 'attachments',
  },
  auth: {
    jwtSecret: '',
    sessionDays: 14,
    // 集成测试 worker 可设 DAYLIGHT_REQUIRE_AUTH=0；正式默认仍要求登录
    requireAuth: process.env.DAYLIGHT_REQUIRE_AUTH === '0' || process.env.DAYLIGHT_DISABLE_AUTH === '1' ? false : true,
    allowLocalDemoLogin: !DESKTOP,
    adminEmails: [],
  },
  systemMail: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
    publicBaseUrl: '',
  },
  updatedAt: null,
};

let cache = null;
let mtimeMs = 0;

function ensureDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function defaultInfraConfig() {
  if (isProductionRuntime()) return productionInfraConfig();
  return structuredClone(DEFAULTS);
}

function productionInfraConfig() {
  const env = process.env;
  const required = ['DAYLIGHT_DATABASE_URL', 'DAYLIGHT_REDIS_URL', 'DAYLIGHT_AMQP_URL', 'DAYLIGHT_JWT_SECRET',
    'DAYLIGHT_OSS_PROVIDER', 'DAYLIGHT_OSS_BUCKET', 'DAYLIGHT_OSS_ACCESS_KEY', 'DAYLIGHT_OSS_SECRET_KEY'];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Production requires environment variables: ${missing.join(', ')}`);
  if (env.DAYLIGHT_REQUIRE_AUTH === '0' || env.DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN === '1') {
    throw new Error('Production requires authentication and disables demo login');
  }
  if (env.DAYLIGHT_JWT_SECRET.length < 32) throw new Error('DAYLIGHT_JWT_SECRET must contain at least 32 characters');
  if (!['s3', 'aliyun', 'us3', 'qiniu', 'upyun'].includes(env.DAYLIGHT_OSS_PROVIDER)) throw new Error('Production requires a supported cloud OSS provider');
  for (const [key, protocols] of [['DAYLIGHT_DATABASE_URL', ['postgres:', 'postgresql:']], ['DAYLIGHT_REDIS_URL', ['redis:', 'rediss:']], ['DAYLIGHT_AMQP_URL', ['amqp:', 'amqps:']]]) {
    let url;
    try { url = new URL(env[key]); } catch { throw new Error(`Invalid ${key}`); }
    if (!protocols.includes(url.protocol) || !url.hostname) throw new Error(`Invalid ${key}`);
    if (key === 'DAYLIGHT_DATABASE_URL' && (url.searchParams.get('sslmode') === 'no-verify'
      || url.searchParams.get('ssl') === 'false' && env.DAYLIGHT_DATABASE_SSL === '1')) {
      throw new Error('Production PostgreSQL TLS must verify certificates');
    }
  }
  const config = structuredClone(DEFAULTS);
  config.runtime = 'production';
  config.managedBy = 'environment';
  config.postgres = { ...config.postgres, enabled: true, connectionString: env.DAYLIGHT_DATABASE_URL, password: '', ssl: env.DAYLIGHT_DATABASE_SSL === '1' };
  config.redis = { ...config.redis, enabled: true, url: env.DAYLIGHT_REDIS_URL };
  config.mq = { ...config.mq, enabled: true, provider: 'rabbitmq', url: env.DAYLIGHT_AMQP_URL, password: '' };
  config.oss = { enabled: true, provider: env.DAYLIGHT_OSS_PROVIDER, bucket: env.DAYLIGHT_OSS_BUCKET,
    endpoint: env.DAYLIGHT_OSS_ENDPOINT || '', region: env.DAYLIGHT_OSS_REGION || 'us-east-1',
    accessKey: env.DAYLIGHT_OSS_ACCESS_KEY, secretKey: env.DAYLIGHT_OSS_SECRET_KEY,
    publicBaseUrl: env.DAYLIGHT_OSS_PUBLIC_BASE_URL || '', forcePathStyle: env.DAYLIGHT_OSS_FORCE_PATH_STYLE === '1' };
  config.auth = { ...config.auth, jwtSecret: env.DAYLIGHT_JWT_SECRET, requireAuth: true, allowLocalDemoLogin: false,
    adminEmails: (env.DAYLIGHT_ADMIN_EMAILS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean) };
  config.systemMail = { ...config.systemMail, enabled: env.DAYLIGHT_SYSTEM_MAIL_ENABLED === '1',
    host: env.DAYLIGHT_SYSTEM_MAIL_HOST || '', port: Number(env.DAYLIGHT_SYSTEM_MAIL_PORT || 465),
    secure: env.DAYLIGHT_SYSTEM_MAIL_SECURE !== '0', user: env.DAYLIGHT_SYSTEM_MAIL_USER || '',
    pass: env.DAYLIGHT_SYSTEM_MAIL_PASS || '', from: env.DAYLIGHT_SYSTEM_MAIL_FROM || '',
    publicBaseUrl: env.DAYLIGHT_PUBLIC_BASE_URL || '' };
  return config;
}

export function readInfraConfig({ force = false } = {}) {
  if (isProductionRuntime()) return productionInfraConfig();
  ensureDir();
  if (!fs.existsSync(configPath)) {
    cache = defaultInfraConfig();
    return structuredClone(cache);
  }
  const stat = fs.statSync(configPath);
  if (!force && cache && stat.mtimeMs === mtimeMs) return structuredClone(cache);
  const raw = readSecureJson(configPath);
  cache = {
    ...defaultInfraConfig(),
    ...raw,
    postgres: { ...DEFAULTS.postgres, ...(raw.postgres || {}) },
    redis: { ...DEFAULTS.redis, ...(raw.redis || {}) },
    mq: {
      ...DEFAULTS.mq,
      ...(raw.mq || {}),
      provider: raw.mq?.provider === 'uroketmq' ? 'urocketmq' : (raw.mq?.provider || DEFAULTS.mq.provider),
      password: raw.mq?.password ?? DEFAULTS.mq.password,
    },
    oss: { ...DEFAULTS.oss, ...(raw.oss || {}) },
    auth: { ...DEFAULTS.auth, ...(raw.auth || {}) },
    systemMail: { ...DEFAULTS.systemMail, ...(raw.systemMail || {}) },
  };
  mtimeMs = stat.mtimeMs;
  return structuredClone(cache);
}

export function saveInfraConfig(next) {
  requireLocalRuntime('Saving local infrastructure settings');
  ensureDir();
  const merged = {
    ...defaultInfraConfig(),
    ...next,
    postgres: { ...DEFAULTS.postgres, ...(next.postgres || {}) },
    redis: { ...DEFAULTS.redis, ...(next.redis || {}) },
    mq: { ...DEFAULTS.mq, ...(next.mq || {}) },
    oss: { ...DEFAULTS.oss, ...(next.oss || {}) },
    auth: { ...DEFAULTS.auth, ...(next.auth || {}) },
    systemMail: { ...DEFAULTS.systemMail, ...(next.systemMail || {}) },
    updatedAt: new Date().toISOString(),
  };
  writeSecureJson(configPath, merged);
  cache = merged;
  mtimeMs = fs.statSync(configPath).mtimeMs;
  return structuredClone(merged);
}

export function publicInfraConfig(config = readInfraConfig()) {
  const mask = (value) => (value ? '••••已配置' : '');
  return {
    ...config,
    postgres: {
      ...config.postgres,
      password: mask(config.postgres.password),
      connectionString: mask(config.postgres.connectionString),
    },
    redis: {
      ...config.redis,
      password: mask(config.redis.password),
      url: mask(config.redis.url),
    },
    mq: {
      ...config.mq,
      accessKey: mask(config.mq.accessKey),
      secretKey: mask(config.mq.secretKey),
      password: mask(config.mq.password),
      url: mask(config.mq.url),
    },
    oss: {
      ...config.oss,
      accessKey: mask(config.oss.accessKey),
      secretKey: mask(config.oss.secretKey),
    },
    auth: {
      ...config.auth,
      jwtSecret: mask(config.auth.jwtSecret),
      adminEmails: Array.isArray(config.auth.adminEmails) ? config.auth.adminEmails : [],
    },
    systemMail: {
      ...config.systemMail,
      pass: mask(config.systemMail.pass),
      ready: Boolean(config.systemMail.enabled && config.systemMail.host && config.systemMail.user && config.systemMail.pass),
    },
  };
}

export function mergeInfraSecrets(incoming, current = readInfraConfig()) {
  const keep = (next, prev) => (next && !String(next).startsWith('••••') ? next : prev);
  return {
    ...current,
    ...incoming,
    postgres: {
      ...current.postgres,
      ...(incoming.postgres || {}),
      password: keep(incoming.postgres?.password, current.postgres.password),
      connectionString: keep(incoming.postgres?.connectionString, current.postgres.connectionString),
    },
    redis: {
      ...current.redis,
      ...(incoming.redis || {}),
      password: keep(incoming.redis?.password, current.redis.password),
      url: keep(incoming.redis?.url, current.redis.url),
    },
    mq: {
      ...current.mq,
      ...(incoming.mq || {}),
      accessKey: keep(incoming.mq?.accessKey, current.mq.accessKey),
      secretKey: keep(incoming.mq?.secretKey, current.mq.secretKey),
      password: keep(incoming.mq?.password, current.mq.password),
      url: keep(incoming.mq?.url, current.mq.url),
    },
    oss: {
      ...current.oss,
      ...(incoming.oss || {}),
      accessKey: keep(incoming.oss?.accessKey, current.oss.accessKey),
      secretKey: keep(incoming.oss?.secretKey, current.oss.secretKey),
    },
    auth: {
      ...current.auth,
      ...(incoming.auth || {}),
      jwtSecret: keep(incoming.auth?.jwtSecret, current.auth.jwtSecret),
      adminEmails: Array.isArray(incoming.auth?.adminEmails)
        ? incoming.auth.adminEmails.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
        : current.auth.adminEmails,
    },
    systemMail: {
      ...current.systemMail,
      ...(incoming.systemMail || {}),
      pass: keep(incoming.systemMail?.pass, current.systemMail.pass),
    },
  };
}

export function infraConfigPath() {
  return configPath;
}
