import { readSecureJson, writeSecureJson } from '../secure-json.js';
/**
 * Hot-reloadable infrastructure config.
 * Defaults are local (file / memory / process queue / local attachments).
 * Optional: local PostgreSQL/Redis, or US3 for object storage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const configPath = path.join(dataDir, 'infra.json');

const DEFAULTS = {
  postgres: {
    enabled: process.env.DAYLIGHT_DESKTOP !== '1',
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
    enabled: process.env.DAYLIGHT_DESKTOP !== '1',
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
    requireAuth: process.env.DAYLIGHT_DISABLE_AUTH !== '1',
    allowLocalDemoLogin: process.env.DAYLIGHT_DESKTOP !== '1',
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
  return structuredClone(DEFAULTS);
}

export function readInfraConfig({ force = false } = {}) {
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
