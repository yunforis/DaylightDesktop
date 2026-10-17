import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'work', 'system-mail-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;

const { saveInfraConfig } = await import('./infra/config.js');
const { sendSystemMail, sendTemplatedMail } = await import('./mailer.js');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const mail = {
  enabled: true, host: 'smtp.qq.com', port: 465, secure: true,
  user: 'system-fixture@example.invalid', pass: 'invented-system-fixture-code',
};
const message = { to: 'recipient@example.invalid', subject: '合成测试邮件', text: '仅用于本地验证。' };

function configure(overrides = {}) {
  return saveInfraConfig({ systemMail: { ...mail, ...overrides } });
}

test('系统模板发信使用系统 DNS 地址，保留 QQ TLS 域名与完整验证码正文', async (t) => {
  configure();
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const lookup = mock.method(dns, 'lookup', async () => ({ address: '192.0.2.20', family: 4 }));
  let options;
  let parsed;
  const transport = mock.method(nodemailer, 'createTransport', (config) => {
    options = config;
    return { async sendMail(outgoing) {
      const info = await stream.sendMail(outgoing);
      parsed = await simpleParser(info.message);
      return info;
    } };
  });
  t.after(() => { lookup.mock.restore(); transport.mock.restore(); });

  const result = await sendTemplatedMail('register', {
    to: message.to, vars: { code: '654321', minutes: 10 },
  });
  assert.deepEqual(lookup.mock.calls[0].arguments, ['smtp.qq.com']);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(options.host, '192.0.2.20');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.deepEqual(options.tls, { servername: 'smtp.qq.com' });
  assert.notEqual(options.tls.rejectUnauthorized, false);
  assert.deepEqual(options.auth, { user: mail.user, pass: mail.pass });
  assert.equal(parsed.from.value[0].address, mail.user);
  assert.equal(parsed.to.value[0].address, message.to);
  assert.match(parsed.text, /654321.*10 分钟内有效/);
  assert.match(parsed.html, /654321/);
  assert.equal(result.ok, true);
  assert.equal(result.templateId, 'register');
});

test('系统 SMTP 配置热更新后重新解析新主机，非直接 TLS 使用 STARTTLS', async (t) => {
  const config = configure();
  const lookups = mock.method(dns, 'lookup', async () => ({ address: '192.0.2.21', family: 4 }));
  const outgoing = [];
  const transport = mock.method(nodemailer, 'createTransport', (options) => ({
    async sendMail(message) { outgoing.push({ options, message }); return {}; },
  }));
  t.after(() => { lookups.mock.restore(); transport.mock.restore(); });

  await sendSystemMail(message);
  // Simulate editing infra.json outside the running process.
  fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
    ...config, systemMail: { ...mail, host: 'smtp.example.invalid', port: 587, secure: false,
      from: '测试系统 <sender@example.invalid>' },
  }));
  await sendSystemMail(message);

  assert.deepEqual(lookups.mock.calls.map((call) => call.arguments[0]), ['smtp.qq.com', 'smtp.example.invalid']);
  assert.equal(outgoing[1].options.host, '192.0.2.21');
  assert.equal(outgoing[1].options.port, 587);
  assert.equal(outgoing[1].options.secure, false);
  assert.equal(outgoing[1].options.requireTLS, true);
  assert.deepEqual(outgoing[1].options.tls, { servername: 'smtp.example.invalid' });
  assert.equal(outgoing[1].message.from, '测试系统 <sender@example.invalid>');
});

test('系统 DNS 失败时不建立 SMTP 连接，保留错误供测试信或验证码入口处理', async (t) => {
  configure();
  const failure = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.qq.com'), { code: 'ENOTFOUND' });
  const lookup = mock.method(dns, 'lookup', async () => { throw failure; });
  const transport = mock.method(nodemailer, 'createTransport', () => assert.fail('DNS 失败后不应连接 SMTP'));
  t.after(() => { lookup.mock.restore(); transport.mock.restore(); });

  await assert.rejects(sendSystemMail(message), (error) => error === failure);
  assert.equal(transport.mock.callCount(), 0);
});

test('系统发信未启用或凭据不全时提示配置问题，不解析 DNS 或连接 SMTP', async (t) => {
  const lookup = mock.method(dns, 'lookup', () => assert.fail('未就绪时不应解析 DNS'));
  const transport = mock.method(nodemailer, 'createTransport', () => assert.fail('未就绪时不应连接 SMTP'));
  t.after(() => { lookup.mock.restore(); transport.mock.restore(); });

  for (const overrides of [{ enabled: false }, { host: '' }, { user: '' }, { pass: '' }]) {
    configure(overrides);
    await assert.rejects(sendSystemMail(message), { status: 503, message: /系统发信邮箱尚未配置/ });
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(transport.mock.callCount(), 0);
});
