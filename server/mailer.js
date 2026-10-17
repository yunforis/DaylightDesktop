/**
 * 系统发信（注册验证码等）。凭据来自 data/infra.json 的 systemMail，不写进源码。
 * 正文使用 data/mail-templates.json 中的可配置模板。
 */
import nodemailer from 'nodemailer';
import { readInfraConfig } from './infra/config.js';
import { renderMailTemplate } from './mail-templates.js';

export function systemMailReady(config = readInfraConfig()) {
  const mail = config.systemMail || {};
  return Boolean(mail.enabled && mail.host && mail.user && mail.pass);
}

export async function sendSystemMail({ to, subject, text, html }) {
  const config = readInfraConfig({ force: true });
  const mail = config.systemMail || {};
  if (!systemMailReady(config)) {
    throw Object.assign(new Error('系统发信邮箱尚未配置，请在管理后台填写 SMTP'), { status: 503 });
  }
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: Number(mail.port) || 465,
    secure: mail.secure !== false,
    auth: {
      user: mail.user,
      pass: mail.pass,
    },
  });
  const from = mail.from || `Daylight <${mail.user}>`;
  await transport.sendMail({
    from,
    to,
    subject,
    text,
    html: html || undefined,
  });
  return { ok: true };
}

/** 按模板 id 渲染并发送。vars 会替换 {{code}} 等占位符。 */
export async function sendTemplatedMail(templateId, { to, vars = {} } = {}) {
  const rendered = renderMailTemplate(templateId, vars);
  await sendSystemMail({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  return { ok: true, templateId, subject: rendered.subject };
}

export function publicBaseUrl(req) {
  const configured = readInfraConfig().systemMail?.publicBaseUrl;
  if (configured) return String(configured).replace(/\/$/, '');
  if (req) {
    const proto = req.get?.('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get?.('x-forwarded-host') || req.get?.('host');
    if (host) return `${proto}://${host}`;
  }
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}
