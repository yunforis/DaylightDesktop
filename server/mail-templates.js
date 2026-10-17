/**
 * 系统发信模板：注册 / 找回密码 / 通知 / 功能更新。
 * 持久化在 data/mail-templates.json，变量用 {{name}}。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const filePath = path.join(dataDir, 'mail-templates.json');

export const TEMPLATE_META = [
  {
    id: 'register',
    label: '注册验证码',
    vars: ['code', 'email', 'username', 'minutes'],
    description: '用户注册时发送邮箱验证码',
  },
  {
    id: 'resetPassword',
    label: '找回密码',
    vars: ['email', 'username', 'resetUrl', 'minutes'],
    description: '找回密码链接邮件',
  },
  {
    id: 'notification',
    label: '通用通知',
    vars: ['title', 'body', 'username', 'email'],
    description: '系统通知（同步失败、冲突提醒等）',
  },
  {
    id: 'featureUpdate',
    label: '功能更新',
    vars: ['title', 'body', 'version', 'username'],
    description: '产品功能更新说明',
  },
];

const DEFAULTS = {
  register: {
    subject: 'Daylight 注册验证码',
    text: '你的 Daylight 注册验证码是 {{code}}，{{minutes}} 分钟内有效。如非本人操作请忽略。',
    html: '<p>你的 Daylight 注册验证码是 <strong style="font-size:18px;letter-spacing:2px">{{code}}</strong>。</p><p>{{minutes}} 分钟内有效。如非本人操作请忽略。</p>',
  },
  resetPassword: {
    subject: 'Daylight 找回密码',
    text: '你好 {{username}}，请在 {{minutes}} 分钟内打开链接重置密码：{{resetUrl}}。如非本人操作请忽略。',
    html: '<p>你好 {{username}}，</p><p>请在 <strong>{{minutes}}</strong> 分钟内点击下方链接重置密码：</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p><p>如非本人操作请忽略。</p>',
  },
  notification: {
    subject: 'Daylight 通知：{{title}}',
    text: '{{title}}\n\n{{body}}',
    html: '<h2 style="margin:0 0 12px;font-size:18px">{{title}}</h2><div style="line-height:1.6;white-space:pre-wrap">{{body}}</div>',
  },
  featureUpdate: {
    subject: 'Daylight 功能更新{{#version}} · {{version}}{{/version}}',
    text: '{{title}}\n版本：{{version}}\n\n{{body}}',
    html: '<h2 style="margin:0 0 8px;font-size:18px">{{title}}</h2><p style="color:#666;margin:0 0 12px">版本 {{version}}</p><div style="line-height:1.6;white-space:pre-wrap">{{body}}</div>',
  },
};

function ensureFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  }
}

export function defaultMailTemplates() {
  return structuredClone(DEFAULTS);
}

export function readMailTemplates() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      register: { ...DEFAULTS.register, ...(raw.register || {}) },
      resetPassword: { ...DEFAULTS.resetPassword, ...(raw.resetPassword || {}) },
      notification: { ...DEFAULTS.notification, ...(raw.notification || {}) },
      featureUpdate: { ...DEFAULTS.featureUpdate, ...(raw.featureUpdate || {}) },
    };
  } catch {
    return defaultMailTemplates();
  }
}

export function saveMailTemplates(incoming = {}) {
  const current = readMailTemplates();
  const next = {
    register: { ...current.register, ...(incoming.register || {}) },
    resetPassword: { ...current.resetPassword, ...(incoming.resetPassword || {}) },
    notification: { ...current.notification, ...(incoming.notification || {}) },
    featureUpdate: { ...current.featureUpdate, ...(incoming.featureUpdate || {}) },
  };
  for (const key of Object.keys(next)) {
    next[key].subject = String(next[key].subject || '').trim();
    next[key].text = String(next[key].text || '');
    next[key].html = String(next[key].html || '');
    if (!next[key].subject) throw Object.assign(new Error(`${key} 模板缺少主题`), { status: 400 });
  }
  ensureFile();
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function resetMailTemplates() {
  ensureFile();
  fs.writeFileSync(filePath, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  return defaultMailTemplates();
}

/** 简易 Mustache 子集：{{var}} 与 {{#var}}...{{/var}}（真值才输出）。 */
export function renderTemplate(source = '', vars = {}) {
  let out = String(source);
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, block) => (
    vars[key] ? renderTemplate(block, vars) : ''
  ));
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => (
    vars[key] == null ? '' : String(vars[key])
  ));
  return out;
}

export function renderMailTemplate(id, vars = {}) {
  const templates = readMailTemplates();
  const tpl = templates[id];
  if (!tpl) throw Object.assign(new Error(`未知邮件模板：${id}`), { status: 404 });
  return {
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.text, vars),
    html: renderTemplate(tpl.html, vars),
  };
}
