import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const directory = path.join(data, 'runtime');
const environmentFile = path.join(directory, 'environment.json');
const dependenciesFile = path.join(directory, 'dependencies.env');
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Use configure-production.mjs [--apply]');
const saved = JSON.parse(fs.readFileSync(path.join(data, 'infra.json'), 'utf8'));
if (!saved.oss?.enabled || !saved.oss.accessKey || !saved.oss.secretKey || !saved.oss.bucket) throw new Error('Saved shared object storage must be configured first');
if ((saved.auth?.jwtSecret || '').length < 32) throw new Error('Saved JWT secret must contain at least 32 characters');
if (saved.postgres.connectionString || saved.redis.url || saved.mq.url
  || !['127.0.0.1', 'localhost'].includes(saved.postgres.host)
  || !['127.0.0.1', 'localhost'].includes(saved.redis.host)
  || !['127.0.0.1', 'localhost'].includes(saved.mq.host)) {
  throw new Error('This dependency installer requires the saved loopback endpoints; configure remote services separately');
}
const summary = { runtime: 'production', dataPreserved: true,
  postgres: { host: saved.postgres.host, port: saved.postgres.port, database: saved.postgres.database },
  redis: { host: saved.redis.host, port: saved.redis.port, persistence: 'AOF', authentication: true },
  rabbitmq: { host: saved.mq.host, port: saved.mq.port, persistentVolume: true },
  objectStorage: { provider: saved.oss.provider, reuseSaved: true },
  existingEnvironmentPreserved: fs.existsSync(environmentFile), mode: apply ? 'apply' : 'dry-run' };
if (apply) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(environmentFile) || fs.existsSync(dependenciesFile)) {
    if (!fs.existsSync(environmentFile) || !fs.existsSync(dependenciesFile)) throw new Error('Incomplete runtime configuration; inspect existing files before changing them');
  } else {
    if (saved.postgres.ssl) throw new Error('The local PostgreSQL container does not provide TLS by default; configure verified container TLS before creating this runtime environment');
    const redisPassword = saved.redis.password || randomBytes(32).toString('hex');
    const pgPassword = saved.postgres.password || randomBytes(32).toString('hex');
    const mqPassword = saved.mq.password || randomBytes(32).toString('hex');
    // Double-quoted dotenv values preserve backslashes/quotes; escape dollar
    // signs explicitly so Compose cannot expand saved credentials as variables.
    const literal = value => JSON.stringify(String(value)).replaceAll('$', '\\$');
    const dependencies = { POSTGRES_DB: saved.postgres.database, POSTGRES_USER: saved.postgres.user,
      POSTGRES_PASSWORD: pgPassword, POSTGRES_PORT: String(saved.postgres.port || 5432),
      REDIS_PASSWORD: redisPassword, REDIS_PORT: String(saved.redis.port || 6379),
      RABBITMQ_USER: saved.mq.user, RABBITMQ_PASSWORD: mqPassword,
      RABBITMQ_PORT: String(saved.mq.port || 5672), RABBITMQ_VHOST: saved.mq.vhost || '/' };
    const makeUrl = (protocol, host, port, username, password, pathname) => {
      const url = new URL(`${protocol}://${host}:${port}`);
      if (username) url.username = username;
      if (password) url.password = password;
      url.pathname = pathname;
      return url.href;
    };
    const environment = {
      DAYLIGHT_RUNTIME: 'production', NODE_ENV: 'production', DAYLIGHT_DATA_DIR: data,
      HOST: '127.0.0.1', PORT: '3000', DAYLIGHT_WORKER_HEALTH_PORT: '3001', DAYLIGHT_SCHEDULER_HEALTH_PORT: '3002',
      DAYLIGHT_DATABASE_URL: makeUrl('postgresql', '127.0.0.1', saved.postgres.port || 5432, saved.postgres.user, pgPassword, `/${saved.postgres.database}`),
      DAYLIGHT_DATABASE_SSL: saved.postgres.ssl ? '1' : '0',
      DAYLIGHT_REDIS_URL: makeUrl('redis', '127.0.0.1', saved.redis.port || 6379, '', redisPassword, `/${saved.redis.db || 0}`),
      DAYLIGHT_AMQP_URL: makeUrl('amqp', '127.0.0.1', saved.mq.port || 5672, saved.mq.user, mqPassword, `/${encodeURIComponent(saved.mq.vhost || '/')}`),
      DAYLIGHT_JWT_SECRET: saved.auth.jwtSecret, DAYLIGHT_REQUIRE_AUTH: '1', DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN: '0',
      DAYLIGHT_ADMIN_EMAILS: (saved.auth.adminEmails || []).join(','),
      DAYLIGHT_OSS_PROVIDER: saved.oss.provider,
      DAYLIGHT_OSS_ENDPOINT: saved.oss.endpoint ? (saved.oss.endpoint.startsWith('http') ? saved.oss.endpoint : `https://${saved.oss.endpoint}`) : '',
      DAYLIGHT_OSS_BUCKET: saved.oss.bucket, DAYLIGHT_OSS_REGION: saved.oss.region || '',
      DAYLIGHT_OSS_ACCESS_KEY: saved.oss.accessKey, DAYLIGHT_OSS_SECRET_KEY: saved.oss.secretKey,
      DAYLIGHT_OSS_PUBLIC_BASE_URL: saved.oss.publicBaseUrl || '', DAYLIGHT_OSS_FORCE_PATH_STYLE: saved.oss.forcePathStyle ? '1' : '0',
      DAYLIGHT_SYSTEM_MAIL_ENABLED: saved.systemMail?.enabled ? '1' : '0',
      DAYLIGHT_SYSTEM_MAIL_HOST: saved.systemMail?.host || '', DAYLIGHT_SYSTEM_MAIL_PORT: String(saved.systemMail?.port || 465),
      DAYLIGHT_SYSTEM_MAIL_SECURE: saved.systemMail?.secure === false ? '0' : '1',
      DAYLIGHT_SYSTEM_MAIL_USER: saved.systemMail?.user || '', DAYLIGHT_SYSTEM_MAIL_PASS: saved.systemMail?.pass || '',
      DAYLIGHT_SYSTEM_MAIL_FROM: saved.systemMail?.from || '',
      DAYLIGHT_PUBLIC_BASE_URL: saved.systemMail?.publicBaseUrl || 'http://127.0.0.1:3000',
      DAYLIGHT_METRICS: '1', DAYLIGHT_METRICS_DIR: path.join(directory, 'metrics'),
      DAYLIGHT_RUN_ID: `windows-production-${new Date().toISOString().slice(0, 10)}`,
    };
    fs.writeFileSync(environmentFile, `${JSON.stringify(environment, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(dependenciesFile, `${Object.entries(dependencies).map(([key, value]) => `${key}=${literal(value)}`).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  }
}
console.log(JSON.stringify(summary, null, 2));
