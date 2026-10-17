import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';

fs.mkdirSync(path.resolve('work'), { recursive: true });
const dir = fs.mkdtempSync(path.resolve('work/auth-concurrency-'));
process.env.DAYLIGHT_DATA_DIR = dir;
process.env.DAYLIGHT_RUNTIME = 'local';
const { saveInfraConfig } = await import('./infra/config.js');
saveInfraConfig({ postgres: { enabled: false }, redis: { enabled: false }, systemMail: { enabled: false } });
const pg = await import('./infra/postgres.js');
const redis = await import('./infra/redis.js');
const sessions = await import('./infra/sessions.js');
const auth = await import('./auth.js');
after(async () => {
  saveInfraConfig({ postgres: { enabled: false }, redis: { enabled: false } });
  await redis.initRedis();
  await pg.initPostgres();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function exerciseConcurrency(label) {
  // The check is meant to be re-runnable against a shared database: drop the synthetic
  // identity (and its password resets via cascade) before recreating it.
  const admin = pg.getPostgresPool();
  if (admin) await admin.query('DELETE FROM users WHERE id = $1 OR email = $2', [label, `${label}@example.test`]);
  const user = await pg.createUser({ id: label, email: `${label}@example.test`, username: label, passwordHash: 'old-hash' });
  await redis.redisSet(`captcha:${label}`, 'abcd', 60);
  const attempts = await Promise.all(Array.from({ length: 32 }, () => auth.verifyCaptcha(label, 'ABCD')));
  assert.equal(attempts.filter(Boolean).length, 1, 'captcha may be consumed only once');

  await redis.redisSet(`email-code:register:${user.email}`, '123456', 60);
  assert.equal(await redis.redisConsumeIfEqual(`email-code:register:${user.email}`, 'wrong'), false);
  const codes = await Promise.all(Array.from({ length: 32 }, () => redis.redisConsumeIfEqual(`email-code:register:${user.email}`, '123456')));
  assert.equal(codes.filter(Boolean).length, 1);

  const session = await sessions.createUserSession(user);
  // Starting a touch first used to read the record, yield to DEL, then SET it
  // back. Exercise both command orders and ensure no later touch resurrects it.
  await Promise.all([sessions.touchUserSession(user.id, session.jti), sessions.revokeUserSession(user.id, session.jti)]);
  assert.equal(await sessions.touchUserSession(user.id, session.jti), null);
  assert.equal(await sessions.getUserSession(user.id, session.jti), null);
  const other = await sessions.createUserSession(user);
  await Promise.all([sessions.revokeUserSession(user.id, other.jti), sessions.touchUserSession(user.id, other.jti)]);
  assert.equal(await sessions.getUserSession(user.id, other.jti), null);

  await Promise.all(Array.from({ length: 24 }, () => pg.bumpSessionVersion(user.id)));
  assert.equal((await pg.findUserById(user.id)).session_version, 24);
  await pg.savePasswordReset({ token: label, userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const resets = await Promise.all(Array.from({ length: 16 }, (_, i) => pg.resetPasswordWithToken(label, `new-${i}`)));
  const winner = resets.filter(Boolean);
  assert.equal(winner.length, 1);
  const fresh = await pg.findUserById(user.id);
  assert.equal(fresh.password_hash, winner[0].password_hash);
  assert.equal(fresh.session_version, 25);
  await pg.updateUser(user.id, { sessionVersion: 0 });
  assert.equal((await pg.findUserById(user.id)).session_version, 25, 'stale updates cannot lower the session epoch');
  await pg.savePasswordReset({ token: `${label}-expired`, userId: user.id, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await pg.resetPasswordWithToken(`${label}-expired`, 'invalid'), null);
  assert.equal((await pg.findUserById(user.id)).password_hash, fresh.password_hash);

  // Run the complete auth path, including bcrypt, JWT issuance and old-token
  // rejection, against each backend rather than just checking helper results.
  await redis.redisSet(`captcha:${label}-reset`, 'abcd', 60);
  await pg.savePasswordReset({ token: `${label}-reset`, userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const result = await auth.resetPassword({ token: `${label}-reset`, password: 'synthetic-password', captchaId: `${label}-reset`, captchaText: 'abcd' });
  assert.ok(await bcrypt.compare('synthetic-password', (await pg.findUserById(user.id)).password_hash));
  assert.ok(await auth.currentUserFromAuthHeader(`Bearer ${result.token}`));
  await sessions.revokeUserSession(user.id, result.session.jti);
  assert.equal(await auth.currentUserFromAuthHeader(`Bearer ${result.token}`), null);
  const active = await sessions.createUserSession(await pg.findUserById(user.id));
  const jwt = (await import('jsonwebtoken')).default;
  const token = jwt.sign({ sub: user.id, jti: active.jti, sv: (await pg.findUserById(user.id)).session_version },
    (await import('./infra/config.js')).readInfraConfig().auth.jwtSecret || process.env.DAYLIGHT_JWT_SECRET || 'daylight-dev-secret-change-me');
  assert.ok(await auth.currentUserFromAuthHeader(`Bearer ${token}`));
  await pg.bumpSessionVersion(user.id);
  assert.equal(await auth.currentUserFromAuthHeader(`Bearer ${token}`), null);
  assert.ok(await sessions.getUserSession(user.id, active.jti), 'epoch revocation rejects even a still-stored session');
}

test('local auth concurrent consumption, password reset and session revoke/touch', async () => {
  await pg.initPostgres();
  await redis.initRedis();
  await exerciseConcurrency('local_auth');
});

test('real isolated PostgreSQL and Redis auth concurrency and transaction rollback', {
  skip: !process.env.DAYLIGHT_AUTH_TEST_PG_URL || !process.env.DAYLIGHT_AUTH_TEST_REDIS_URL,
}, async () => {
  saveInfraConfig({
    postgres: { enabled: true, connectionString: process.env.DAYLIGHT_AUTH_TEST_PG_URL },
    redis: { enabled: true, url: process.env.DAYLIGHT_AUTH_TEST_REDIS_URL },
  });
  assert.equal((await pg.initPostgres()).mode, 'postgres');
  assert.equal((await redis.initRedis()).mode, 'redis');
  await exerciseConcurrency('remote_auth');
  const pool = pg.getPostgresPool();
  const userId = 'remote_auth';
  const before = await pg.findUserById(userId);
  await pg.savePasswordReset({ token: 'rollback-reset', userId, expiresAt: new Date(Date.now() + 60000).toISOString() });
  // A real DB constraint fails after token claim. Both writes must roll back,
  // and retry with the same token must still succeed.
  await assert.rejects(pg.resetPasswordWithToken('rollback-reset', null), /not-null constraint/);
  assert.equal((await pg.findUserById(userId)).password_hash, before.password_hash);
  assert.equal((await pg.findUserById(userId)).session_version, before.session_version);
  assert.equal((await pool.query('select used_at from password_resets where token = $1', ['rollback-reset'])).rows[0].used_at, null);
  assert.ok(await pg.resetPasswordWithToken('rollback-reset', 'retried-hash'));
  const beforeUpdates = (await pg.findUserById(userId)).session_version;
  await Promise.all([
    ...Array.from({ length: 16 }, () => pg.bumpSessionVersion(userId)),
    ...Array.from({ length: 16 }, () => pg.updateUser(userId, { role: 'user' })),
  ]);
  assert.equal((await pg.findUserById(userId)).session_version, beforeUpdates + 16);
});
