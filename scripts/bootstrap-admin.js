#!/usr/bin/env node
/**
 * 引导首个（或追加）管理员账号：写入用户库 + 加入 auth.adminEmails。
 * 用法：
 *   node scripts/bootstrap-admin.js --email admin@example.com --username admin --password '至少8位'
 * 环境变量（可选）：DAYLIGHT_DATA_DIR、DAYLIGHT_ADMIN_EMAIL、DAYLIGHT_ADMIN_USERNAME、DAYLIGHT_ADMIN_PASSWORD
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { initPostgres, closePostgres, findUserByEmail, findUserByUsername, createUser, updateUser } from '../server/infra/postgres.js';
import { readInfraConfig, saveInfraConfig } from '../server/infra/config.js';
import { isProductionRuntime } from '../server/runtime-mode.js';

function arg(name, envKey) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return String(process.argv[idx + 1]).trim();
  if (envKey && process.env[envKey]) return String(process.env[envKey]).trim();
  return '';
}

function usage() {
  console.log(`用法:
  node scripts/bootstrap-admin.js --email <邮箱> --username <用户名> --password <密码>

环境变量可代替参数：DAYLIGHT_ADMIN_EMAIL / DAYLIGHT_ADMIN_USERNAME / DAYLIGHT_ADMIN_PASSWORD
数据目录：DAYLIGHT_DATA_DIR（默认 ./data）`);
}

async function main() {
  const email = arg('email', 'DAYLIGHT_ADMIN_EMAIL').toLowerCase();
  const username = arg('username', 'DAYLIGHT_ADMIN_USERNAME');
  const password = arg('password', 'DAYLIGHT_ADMIN_PASSWORD');
  if (!email || !username || !password) {
    usage();
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('邮箱格式无效');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(username)) {
    console.error('用户名需为 2–24 位字母、数字、下划线或中文');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('密码至少 8 位');
    process.exit(1);
  }

  const pg = await initPostgres();
  console.log(`存储：${pg.mode}${pg.error ? `（PG 失败已回退：${pg.error}）` : ''}`);

  const passwordHash = await bcrypt.hash(password, 10);
  let user = await findUserByEmail(email);
  if (user) {
    await updateUser(user.id, { username, role: 'admin', passwordHash });
    user = await findUserByEmail(email);
    console.log(`已提升现有用户为管理员：${user.email} / ${user.username}`);
  } else {
    const byName = await findUserByUsername(username);
    if (byName) {
      console.error(`用户名已被占用：${username}`);
      process.exit(1);
    }
    user = await createUser({
      id: randomUUID(),
      email,
      username,
      passwordHash,
      role: 'admin',
      workspaceMode: 'hr',
    });
    console.log(`已创建管理员：${user.email} / ${user.username}`);
  }

  if (isProductionRuntime()) {
    console.log('已在 PostgreSQL 创建或提升管理员；生产认证配置继续由环境变量管理，无本地配置写入。');
    console.log('使用该邮箱/用户名与密码登录 /login 或 /admin/login。');
    return;
  }

  const infra = readInfraConfig({ force: true });
  const emails = new Set(
    (infra.auth.adminEmails || []).map((item) => String(item).trim().toLowerCase()).filter(Boolean),
  );
  emails.add(email);
  saveInfraConfig({
    ...infra,
    auth: {
      ...infra.auth,
      adminEmails: [...emails],
      allowLocalDemoLogin: false,
      requireAuth: true,
      jwtSecret: infra.auth.jwtSecret || randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    },
  });

  console.log('已写入 auth.adminEmails，并关闭 allowLocalDemoLogin（若尚未设 jwtSecret 则已生成）。');
  console.log('登录：http://<主机>:3000/login 或管理端 http://<主机>:3000/admin/login');
  console.log('账号即上面的邮箱/用户名与密码（请自行保管，不会打印明文密码）。');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => closePostgres());
