import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import svgCaptcha from 'svg-captcha';
import { readInfraConfig } from './infra/config.js';
import { redisDel, redisGet, redisSet } from './infra/redis.js';
import {
  bumpSessionVersion,
  consumePasswordReset,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  listUsers,
  publicUser,
  savePasswordReset,
  touchUserLogin,
  updateUser,
  updateUserPassword,
} from './infra/postgres.js';
import {
  createUserSession,
  getUserSession,
  listUserSessions,
  revokeAllUserSessions,
  revokeUserSession,
  touchUserSession,
} from './infra/sessions.js';
import { publicBaseUrl, sendTemplatedMail, systemMailReady } from './mailer.js';

const CAPTCHA_TTL = 300;
const EMAIL_CODE_TTL = 600;
const RESET_TTL_MS = 30 * 60 * 1000;

function jwtSecret() {
  const config = readInfraConfig();
  if (config.auth.jwtSecret) return config.auth.jwtSecret;
  return process.env.DAYLIGHT_JWT_SECRET || 'daylight-dev-secret-change-me';
}

function adminEmailSet(config = readInfraConfig()) {
  return new Set(
    (config.auth.adminEmails || [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminUser(user, config = readInfraConfig()) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return adminEmailSet(config).has(String(user.email || '').toLowerCase());
}

export function createCaptcha() {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0oO1ilI',
    noise: 3,
    color: true,
    background: '#f4f4f5',
    width: 120,
    height: 40,
  });
  const id = randomUUID();
  const text = String(captcha.text || '').toLowerCase();
  return redisSet(`captcha:${id}`, text, CAPTCHA_TTL).then(() => {
    const payload = { id, svg: captcha.data };
    if (readInfraConfig().auth.allowLocalDemoLogin) payload.text = captcha.text;
    return payload;
  });
}

export async function verifyCaptcha(id, text) {
  if (!id || !text) return false;
  const key = `captcha:${id}`;
  const expected = await redisGet(key);
  await redisDel(key);
  if (!expected) return false;
  return String(text).trim().toLowerCase() === String(expected).toLowerCase();
}

function signToken(user, session) {
  const days = Number(readInfraConfig().auth.sessionDays) || 14;
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role || 'user',
      jti: session.jti,
      sv: Number(user.session_version) || 0,
    },
    jwtSecret(),
    { expiresIn: `${days}d` },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret());
  } catch {
    return null;
  }
}

async function issueAuth(user, meta = {}) {
  const session = await createUserSession(user, meta);
  return {
    user: enrichPublicUser(user),
    token: signToken(user, session),
    session,
  };
}

function resolveRole(email) {
  return adminEmailSet().has(String(email).toLowerCase()) ? 'admin' : 'user';
}

export async function sendRegisterEmailCode({ email, captchaId, captchaText }) {
  if (!(await verifyCaptcha(captchaId, captchaText))) {
    throw Object.assign(new Error('图形验证码错误或已过期'), { status: 400 });
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('请输入有效邮箱'), { status: 400 });
  }
  if (await findUserByEmail(cleanEmail)) {
    throw Object.assign(new Error('该邮箱已注册'), { status: 409 });
  }
  if (!systemMailReady()) {
    throw Object.assign(new Error('系统发信邮箱尚未配置，请联系管理员'), { status: 503 });
  }

  const code = String(randomInt(100000, 1000000));
  await redisSet(`email-code:register:${cleanEmail}`, code, EMAIL_CODE_TTL);
  await sendTemplatedMail('register', {
    to: cleanEmail,
    vars: {
      code,
      email: cleanEmail,
      username: cleanEmail.split('@')[0] || '用户',
      minutes: Math.round(EMAIL_CODE_TTL / 60),
    },
  });

  const payload = { ok: true, message: '验证码已发送，请查收邮箱' };
  if (readInfraConfig().auth.allowLocalDemoLogin) payload.debugCode = code;
  return payload;
}

async function consumeRegisterEmailCode(email, code) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const key = `email-code:register:${cleanEmail}`;
  const expected = await redisGet(key);
  if (!expected) return false;
  if (String(code || '').trim() !== String(expected)) return false;
  await redisDel(key);
  return true;
}

export async function registerUser({ email, username, password, captchaId, captchaText, emailCode }) {
  if (!(await verifyCaptcha(captchaId, captchaText))) {
    throw Object.assign(new Error('图形验证码错误或已过期'), { status: 400 });
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('请输入有效邮箱'), { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(cleanUsername)) {
    throw Object.assign(new Error('用户名需为 2–24 位字母、数字、下划线或中文'), { status: 400 });
  }
  if (cleanPassword.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { status: 400 });
  }
  if (!(await consumeRegisterEmailCode(cleanEmail, emailCode))) {
    throw Object.assign(new Error('邮箱验证码错误或已过期'), { status: 400 });
  }
  if (await findUserByEmail(cleanEmail)) {
    throw Object.assign(new Error('该邮箱已注册'), { status: 409 });
  }
  if (await findUserByUsername(cleanUsername)) {
    throw Object.assign(new Error('该用户名已被占用'), { status: 409 });
  }
  const passwordHash = await bcrypt.hash(cleanPassword, 10);
  const user = await createUser({
    id: randomUUID(),
    email: cleanEmail,
    username: cleanUsername,
    passwordHash,
    role: resolveRole(cleanEmail),
  });
  await touchUserLogin(user.id);
  user.last_login_at = new Date().toISOString();
  return issueAuth(user);
}

export async function loginUser({ account, password, captchaId, captchaText, userAgent, ip }) {
  if (!(await verifyCaptcha(captchaId, captchaText))) {
    throw Object.assign(new Error('图形验证码错误或已过期'), { status: 400 });
  }
  const value = String(account || '').trim();
  const user = value.includes('@')
    ? await findUserByEmail(value)
    : await findUserByUsername(value) || await findUserByEmail(value);
  if (!user) {
    throw Object.assign(new Error('账号或密码错误'), { status: 401 });
  }
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) {
    throw Object.assign(new Error('账号或密码错误'), { status: 401 });
  }
  // 管理员名单变更后登录时同步角色
  const desiredRole = resolveRole(user.email) === 'admin' || user.role === 'admin' ? 'admin' : 'user';
  if ((user.role || 'user') !== desiredRole && resolveRole(user.email) === 'admin') {
    await updateUser(user.id, { role: 'admin' });
    user.role = 'admin';
  }
  await touchUserLogin(user.id);
  user.last_login_at = new Date().toISOString();
  return issueAuth(user, { userAgent, ip });
}

export async function requestPasswordReset({ email, captchaId, captchaText, req }) {
  if (!(await verifyCaptcha(captchaId, captchaText))) {
    throw Object.assign(new Error('图形验证码错误或已过期'), { status: 400 });
  }
  const user = await findUserByEmail(email);
  if (!user) {
    return { ok: true, message: '若邮箱已注册，将收到重置指引。' };
  }
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  await savePasswordReset({ token, userId: user.id, expiresAt });
  const resetUrl = `${publicBaseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  if (systemMailReady()) {
    await sendTemplatedMail('resetPassword', {
      to: user.email,
      vars: {
        email: user.email,
        username: user.username || user.email,
        resetUrl,
        minutes: Math.round(RESET_TTL_MS / 60000),
      },
    });
  }
  return {
    ok: true,
    message: '若邮箱已注册，将收到重置指引。',
    resetToken: readInfraConfig().auth.allowLocalDemoLogin ? token : undefined,
    expiresAt: readInfraConfig().auth.allowLocalDemoLogin ? expiresAt : undefined,
  };
}

export async function resetPassword({ token, password, captchaId, captchaText }) {
  if (!(await verifyCaptcha(captchaId, captchaText))) {
    throw Object.assign(new Error('图形验证码错误或已过期'), { status: 400 });
  }
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { status: 400 });
  }
  const row = await consumePasswordReset(token);
  if (!row) {
    throw Object.assign(new Error('重置链接无效或已过期'), { status: 400 });
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  await updateUserPassword(row.user_id, passwordHash);
  const user = await findUserById(row.user_id);
  await bumpSessionVersion(user.id);
  await revokeAllUserSessions(user.id);
  const fresh = await findUserById(user.id);
  await touchUserLogin(fresh.id);
  fresh.last_login_at = new Date().toISOString();
  return issueAuth(fresh);
}

function enrichPublicUser(user) {
  const base = publicUser(user);
  if (!base) return null;
  return {
    ...base,
    role: isAdminUser(base) ? 'admin' : base.role,
    isAdmin: isAdminUser(base),
  };
}

export async function currentUserFromAuthHeader(header) {
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyToken(header.slice(7));
  if (!payload?.sub) return null;
  const user = await findUserById(payload.sub);
  if (!user) return null;
  const currentVersion = Number(user.session_version) || 0;
  const tokenVersion = Number(payload.sv) || 0;
  if (tokenVersion !== currentVersion) return null;
  if (payload.jti) {
    const session = await getUserSession(user.id, payload.jti);
    if (!session) return null;
    await touchUserSession(user.id, payload.jti);
  }
  return enrichPublicUser(user);
}

export async function requireAdminFromHeader(header) {
  const user = await currentUserFromAuthHeader(header);
  if (!user) throw Object.assign(new Error('请先登录'), { status: 401 });
  if (!isAdminUser(user)) throw Object.assign(new Error('需要管理员权限'), { status: 403 });
  return user;
}

export async function adminListUsers() {
  const rows = await listUsers();
  const enriched = [];
  for (const row of rows) {
    const sessions = await listUserSessions(row.id);
    enriched.push({
      ...enrichPublicUser(row),
      activeSessions: sessions.length,
      online: sessions.length > 0,
    });
  }
  return enriched;
}

export async function adminGetUser(userId) {
  const user = await findUserById(userId);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  const sessions = await listUserSessions(userId);
  return {
    user: {
      ...enrichPublicUser(user),
      activeSessions: sessions.length,
      online: sessions.length > 0,
    },
    sessions,
  };
}

export async function adminForceLogoutUser(userId, actorId) {
  if (!userId) throw Object.assign(new Error('缺少用户 id'), { status: 400 });
  const user = await findUserById(userId);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  await bumpSessionVersion(userId);
  const revoked = await revokeAllUserSessions(userId);
  return {
    ok: true,
    self: userId === actorId,
    revoked: revoked.revoked,
    user: enrichPublicUser(await findUserById(userId)),
  };
}

export async function adminRevokeUserSession(userId, jti) {
  await revokeUserSession(userId, jti);
  return { ok: true };
}

export async function adminCreateUser({ email, username, password, role }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('请输入有效邮箱'), { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(cleanUsername)) {
    throw Object.assign(new Error('用户名需为 2–24 位字母、数字、下划线或中文'), { status: 400 });
  }
  if (cleanPassword.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { status: 400 });
  }
  if (await findUserByEmail(cleanEmail)) {
    throw Object.assign(new Error('该邮箱已注册'), { status: 409 });
  }
  if (await findUserByUsername(cleanUsername)) {
    throw Object.assign(new Error('该用户名已被占用'), { status: 409 });
  }
  const passwordHash = await bcrypt.hash(cleanPassword, 10);
  const user = await createUser({
    id: randomUUID(),
    email: cleanEmail,
    username: cleanUsername,
    passwordHash,
    role: role === 'admin' || resolveRole(cleanEmail) === 'admin' ? 'admin' : 'user',
  });
  return enrichPublicUser(user);
}

export async function adminUpdateUser(userId, patch = {}) {
  const next = { ...patch };
  if (patch.password) {
    if (String(patch.password).length < 8) {
      throw Object.assign(new Error('密码至少 8 位'), { status: 400 });
    }
    next.passwordHash = await bcrypt.hash(String(patch.password), 10);
    delete next.password;
  }
  const user = await updateUser(userId, next);
  return enrichPublicUser(user);
}

export async function adminDeleteUser(userId, actorId) {
  if (userId === actorId) {
    throw Object.assign(new Error('不能删除当前登录的管理员账号'), { status: 400 });
  }
  await revokeAllUserSessions(userId);
  await deleteUser(userId);
  return { ok: true };
}

// Local owner is accessible only after the native shell's one-time HTTP bootstrap.
export async function issueDesktopAuth() {
  if (process.env.DAYLIGHT_DESKTOP !== '1') throw new Error('桌面会话不可用');
  const email = 'owner@daylight.local';
  let user = await findUserByEmail(email);
  if (!user) {
    await adminCreateUser({ email, username: '本地工作空间', password: randomBytes(32).toString('hex'), role: 'admin' });
    user = await findUserByEmail(email);
  }
  return issueAuth(user, { userAgent: 'Daylight Desktop', ip: '127.0.0.1' });
}
