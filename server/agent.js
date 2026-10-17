import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { emailReference, sanitizeSnapshot, usageMetrics } from './traces.js';
import { emailLabels, inferDeadline, normalizeTask, normalizeTaskTitle, taskPriority, tasksForMode } from './tasks.js';
import { findConflicts, suggestTimeSlots } from './conflicts.js';
import { normalizeMailbox, readSettings } from './store.js';
import { ACTIVITY_EXTRACTION_RULES, readPrompts } from './prompts.js';
import { resolveFetchSince, resolveFetchUntil } from './fetch-policy.js';
import { putAttachment } from './infra/oss.js';
import { categoryPromptBlock, resolveEventCategory } from './calendar-categories.js';
import { findMatchingFilter } from './mail-filters.js';
import { enrichEmailWithAttachmentText } from './attachment-text.js';
import { modelFetch } from './model-fetch.js';
import { counter, counterAdd, timer } from './metrics.js';
import { INVOICE_EXTRACTION_RULES, normalizeInvoices } from './invoices.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function uploadParsedAttachments(parsed, {
  mailboxId = 'default',
  emailId = '',
  userId = '',
  username = '',
} = {}) {
  const list = parsed.attachments || [];
  const uploaded = [];
  for (const [index, file] of list.entries()) {
    const id = `attachment-${createHash('sha256').update(`${emailId}\0${index}`).digest('hex').slice(0, 24)}`;
    file.id = id;
    const filename = file.filename || file.cid || 'attachment.bin';
    const contentType = file.contentType || 'application/octet-stream';
    const buffer = file.content;
    if (!buffer || !Buffer.isBuffer(buffer)) continue;
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      uploaded.push({
        id,
        filename,
        contentType,
        size: buffer.length,
        skipped: true,
        reason: '附件超过 25MB，已跳过上传',
      });
      continue;
    }
    try {
      const stored = await putAttachment({
        buffer,
        filename,
        contentType,
        mailboxId,
        userId,
        username,
      });
      uploaded.push({
        id,
        filename: stored.filename || filename,
        contentType: stored.contentType || contentType,
        size: stored.size,
        key: stored.key,
        url: stored.url,
        proxyUrl: stored.proxyUrl,
        storage: stored.storage,
        userFolder: username || userId || 'workspace',
      });
    } catch (error) {
      uploaded.push({
        id,
        filename,
        contentType,
        size: buffer.length,
        skipped: true,
        reason: error.message || '附件上传失败',
      });
    }
  }
  return uploaded;
}

export function completionUrl(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** 把 Node fetch / undici 的底层网络错误译成可读中文（含中转站主机）。 */
export function formatModelFetchError(error, settings = {}) {
  const raw = String(error?.message || error || '').trim();
  const cause = error?.cause;
  const code = String(cause?.code || error?.code || '').toUpperCase();
  let host = '';
  try { host = new URL(completionUrl(settings.baseUrl || '')).hostname; } catch { /* ignore */ }

  if (error?.name === 'AbortError' || /aborted|timeout/i.test(raw)) {
    return '模型连通性测试超时。请检查网络或换一个中转地址后重试。';
  }
  if (/upstream stream ended abnormally|reason=eof|stream ended|incomplete chunked/i.test(raw)) {
    return `模型中转${host ? ` ${host}` : ''}在返回途中断开（上游 EOF）。请确认 Clash 等本地代理仍在 7897、中转站在线后重试；也可在设置里点「连通性测试」。这通常是瞬时网络/代理问题，不是日程数据损坏。`;
  }
  if (
    raw === 'fetch failed'
    || /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed/i.test(`${raw} ${code} ${cause?.message || ''}`)
  ) {
    return `无法连上模型中转${host ? ` ${host}` : ''}：TLS 握手后连接被对端断开（${code || raw}）。若你在终端里用 curl -x http://127.0.0.1:7897 能通，说明需要走本地代理——Daylight 会自动探测 7897 等端口，也可启动前设置 HTTPS_PROXY=http://127.0.0.1:7897。否则请换可用中转或检查中转站是否在线。这通常不是 API Key 填错。`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${raw} ${code}`)) {
    return `无法解析模型主机${host ? ` ${host}` : ''}（DNS）。请检查 Base URL 是否写对、本机网络是否正常。`;
  }
  if (/certificate|CERT_|SSL|TLS/i.test(`${raw} ${code}`)) {
    return `模型接口 TLS/证书校验失败${host ? `（${host}）` : ''}。请确认 Base URL 使用 https 且证书有效。`;
  }
  return raw || '模型接口请求失败。';
}

function mailboxErrorText(error) {
  // ImapFlow 认证失败时常带 authenticationFailed: true（布尔），绝不能优先于 message，否则会变成字面量「true」。
  const candidates = [
    error?.responseText,
    error?.response,
    error?.message,
    error?.authenticationFailed === true ? '' : error?.authenticationFailed,
    typeof error === 'string' ? error : '',
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim() && item.trim() !== 'true' && item.trim() !== 'false') {
      return item.trim();
    }
  }
  return '';
}

export function formatMailboxTestError(error, settings = {}) {
  const raw = mailboxErrorText(error);
  const lower = raw.toLowerCase();
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const details = `${raw} ${code} ${mailboxErrorText(error?.cause)}`;
  const host = settings.imapHost || '';
  const email = settings.email || '';
  const authFailed = error?.authenticationFailed === true
    || /authentication|auth|invalid credentials|login failed|incorrect|login is disabled/i.test(lower);

  if (/login is disabled/i.test(lower)) {
    return `微软返回「Login is disabled」：该 Outlook / Hotmail 账号已禁用「用户名+应用密码」登录 IMAP。Daylight 暂不支持 Outlook OAuth。请改用 QQ / 163 等支持授权码的邮箱做同步，或在微软账户中确认是否仍允许应用密码。当前主机 ${host || '未填'}（账号 ${email || '未填'}）。`;
  }
  if (/command failed/i.test(raw) || lower === 'command failed') {
    return `邮箱服务器拒绝了登录。请核对：① 邮箱类型是否与地址匹配（如 @outlook.com 应选 Outlook，不要选 QQ）；② 授权码/应用密码是否正确（不是网页登录密码）；③ IMAP 是否已开启。当前连接 ${host || '未填主机'}（账号 ${email || '未填'}）。`;
  }
  if (authFailed) {
    return `邮箱认证失败。请确认授权码/应用密码正确，且邮箱类型与地址匹配。当前主机 ${host || '未填'}（账号 ${email || '未填'}）。`;
  }
  if (/enotfound|eai_again|getaddrinfo|dns/i.test(details)) {
    return `无法解析邮件服务器 ${host || ''}（DNS）。请检查网络或 IMAP 主机名。`;
  }
  // ECONNRESET 的原文也可能包含 TLS；连接未收到证书时不能归为证书校验失败。
  if (/econnreset|epipe|socket hang up|other side closed|disconnected before secure tls/i.test(details)) {
    const campusHint = /^(?:imap|mail)\.shanghaitech\.edu\.cn\.?$/i.test(host) && Number(settings.imapPort) !== 143
      ? ' 上海科技大学邮箱可尝试 mail.shanghaitech.edu.cn:143，关闭「直接 TLS」后使用强制 STARTTLS。'
      : '';
    return `邮件服务器连接被中断（${host || '未填主机'}）。请检查网络、代理分流及服务器可达性。${campusHint}`;
  }
  if (/timeout|etimedout|econnrefused|greeting/i.test(details)) {
    return `连接邮件服务器超时或被拒绝（${host || '未填主机'}）。请检查网络、端口与防火墙。`;
  }
  if (/cert_has_expired|certificate has expired/i.test(details)) {
    return `邮件服务器证书已过期（${host || '未填主机'}）。请联系邮箱管理员更新证书，并确认本机日期与时间正确。`;
  }
  if (/cert_altname_invalid|hostname.*does not match|altnames/i.test(details)) {
    return `邮件服务器证书与主机名不匹配（${host || '未填主机'}）。请使用邮箱服务商提供且证书覆盖的 IMAP 主机名。`;
  }
  if (/certificate|cert_|self.signed|unable_to_verify|unable_to_get_issuer/i.test(details)) {
    return `邮件服务器证书校验失败（${host || '未填主机'}）。请检查服务器证书链与本机受信任证书；校内证书需由管理员提供可信 CA。`;
  }
  if (/ssl|tls|wrong version number/i.test(details)) {
    return `TLS 握手失败（${host || '未填主机'}）。请核对端口与连接方式：993 通常使用直接 TLS，143 通常使用 STARTTLS。`;
  }
  return raw || '邮箱连通性测试失败。';
}

function createImapClient(settings, mailbox, clientFactory) {
  return clientFactory({
    host: mailbox.imapHost,
    port: mailbox.imapPort,
    secure: mailbox.imapSecure,
    ...(!mailbox.imapSecure ? { doSTARTTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    clientInfo: { name: 'Daylight', version: '0.1.0', vendor: 'Local demo' },
  });
}

async function closeImapClient(client, connected) {
  if (!client) return;
  try {
    if (connected) await Promise.race([client.logout(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    else client.close?.();
  } catch { /* ignore */ }
}

/** Quick IMAP login probe — does not download mail. */
export async function testMailboxConnection(settings, { clientFactory = (options) => new ImapFlow(options) } = {}) {
  const { providerEmailMismatch } = await import('./providers.js');
  const mailbox = normalizeMailbox(settings);
  if (!settings.email || !settings.authorizationCode) {
    throw new Error('请先填写邮箱地址和授权码后再测试。');
  }
  if (!mailbox.imapHost) throw new Error('请填写 IMAP 主机。');

  const mismatch = providerEmailMismatch(settings.email, settings.provider || mailbox.provider);
  if (mismatch) {
    throw Object.assign(new Error(mismatch.message), { status: 400 });
  }

  const client = createImapClient(settings, mailbox, clientFactory);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox?.exists ?? 0;
      return { ok: true, message: `IMAP 连接成功，收件箱约 ${exists} 封。` };
    } finally {
      lock.release();
    }
  } catch (error) {
    throw Object.assign(new Error(formatMailboxTestError(error, {
      ...settings,
      imapHost: mailbox.imapHost,
    })), { status: 400, cause: error });
  } finally {
    await closeImapClient(client, connected);
  }
}

/** Minimal chat completion probe against OpenAI-compatible endpoint. */
export async function testModelConnection(settings, { timeoutMs = 20_000 } = {}) {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw new Error('请先填写 Base URL、API Key 和模型名称后再测试。');
  }
  const endpoint = completionUrl(settings.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 探测请求尽量简单：不少中转对 response_format=json_object 支持不完整
    const response = await modelFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new Error(`模型接口返回非 JSON（HTTP ${response.status}）。请确认 Base URL 指向 OpenAI 兼容的 /v1，且中转站在线。`);
    }
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `模型接口 HTTP ${response.status}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    return {
      ok: true,
      message: content ? `模型响应正常：${String(content).slice(0, 80)}` : '模型接口可连通。',
      model: settings.model,
    };
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(formatModelFetchError(error, settings)), { status: 400, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

// Legacy IDs already contain UIDVALIDITY. Resolve aliases only against this mailbox's
// stored IDs; never strip UIDVALIDITY or use a global cross-mailbox deduplication set.
export function mailboxMessageIdentity(settings, { uidValidity, uid, scope, processedIds = new Set() }) {
  const mailbox = normalizeMailbox(settings);
  const address = settings.email.toLowerCase();
  const legacy = `${mailbox.id === 'default' ? 'qq' : 'imap'}:${address}:${uidValidity}:${uid}`;
  if (!scope) return legacy;
  const scoped = `imap-v2:${encodeURIComponent(scope)}:${encodeURIComponent(address)}:INBOX:${uidValidity}:${uid}`;
  if (processedIds.has(scoped)) return scoped;
  // Preserve the original ID (and its event/attachment links) during migration.
  if (processedIds.has(legacy)) return legacy;
  for (const prefix of ['qq', 'imap']) {
    const alias = `${prefix}:${address}:${uidValidity}:${uid}`;
    if (processedIds.has(alias)) return alias;
  }
  return scoped;
}

// ── 写回真实邮箱 ──────────────────────────────────────────────
// 邮件记录里不单独存 IMAP uid，写回时必须从持久化的 id 还原定位信息（格式见 mailboxMessageIdentity）。
// 这一层只负责「定位」和「执行」，是否允许写由调用方按邮箱开关判断。

/** 归档 / 废纸篓的目标文件夹：先按 IMAP SPECIAL-USE 找，再按常见命名兜底。 */
const MAIL_FOLDER_CANDIDATES = {
  archive: { specialUse: '\\archive', names: ['archive', 'archives', '存档', '归档', '所有邮件', 'all mail'] },
  trash: { specialUse: '\\trash', names: ['trash', 'deleted', 'deleted messages', 'deleted items', '已删除', '废纸篓', '垃圾箱'] },
};

const folderFlags = (folder) => {
  if (folder?.flags instanceof Set) return [...folder.flags];
  return Array.isArray(folder?.flags) ? folder.flags : [];
};

/** IMAP flags → 本地镜像字段。真邮箱的已读 / 星标状态统一从这里翻译。 */
function messageFlagsOf(message) {
  const marks = folderFlags(message).map((flag) => String(flag).toLowerCase());
  return { seen: marks.includes('\\seen'), flagged: marks.includes('\\flagged') };
}

/**
 * 从邮件 id 还原 IMAP 定位信息。两种历史格式：
 *   imap-v2:<scope>:<address>:<folder>:<uidValidity>:<uid>
 *   qq|imap:<address>:<uidValidity>:<uid>      旧格式，只在 INBOX 里
 * 解析不出来返回 null；调用方必须当成失败，绝不猜 uid。
 */
export function parseMailboxMessageRef(id) {
  const parts = String(id || '').split(':');
  const numeric = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };
  if (parts.length === 6 && parts[0] === 'imap-v2') {
    const uidValidity = numeric(parts[4]);
    const uid = numeric(parts[5]);
    if (!uidValidity || !uid) return null;
    let address = parts[2];
    try { address = decodeURIComponent(address); } catch { /* 保留原样 */ }
    return { format: 'imap-v2', address, folder: parts[3] || 'INBOX', uidValidity, uid };
  }
  if (parts.length === 4 && (parts[0] === 'qq' || parts[0] === 'imap')) {
    const uidValidity = numeric(parts[2]);
    const uid = numeric(parts[3]);
    if (!uidValidity || !uid) return null;
    return { format: 'legacy', address: parts[1], folder: 'INBOX', uidValidity, uid };
  }
  return null;
}

/** 在一份 IMAP 文件夹列表里找归档 / 废纸篓。纯函数，便于单测。 */
export function resolveMailFolder(folders, kind) {
  const candidate = MAIL_FOLDER_CANDIDATES[kind];
  if (!candidate) return null;
  const list = (Array.isArray(folders) ? folders : []).filter((folder) => folder && folder.path);
  const special = list.find((folder) => {
    const marks = [folder.specialUse, ...folderFlags(folder)].filter(Boolean).map((value) => String(value).toLowerCase());
    return marks.includes(candidate.specialUse);
  });
  if (special) return special.path;
  const names = new Set(candidate.names);
  const byName = list.find((folder) => names.has(String(folder.path).toLowerCase()) || names.has(String(folder.name || '').toLowerCase()));
  return byName ? byName.path : null;
}

/**
 * 把「用户点了一个动作」翻译成 IMAP 写回指令 + 本地镜像补丁。
 * 纯函数（不连网、不读写），便于单测；真正的 IMAP 调用由 writeBackMailboxMessage 做。
 * 写回开关关闭时直接抛错——不允许静默降级成「只改本地」。
 */
export function resolveMailWriteBack({ action, folder, folders = [], reference, writeBack = {}, now = new Date() }) {
  if (writeBack?.enabled !== true) {
    throw Object.assign(new Error('这个邮箱还没开启「写回真实邮箱」。到设置 → 邮箱里打开后再试，本地记录不会先改。'), {
      status: 400, code: 'MAIL_WRITE_BACK_DISABLED',
    });
  }
  const at = now.toISOString();
  const move = (target) => ({ call: { ref: reference, action: 'move', target }, patch: { folder: target } });
  switch (action) {
    case 'read': return { call: { ref: reference, action: 'flags', add: ['\\Seen'] }, patch: { seen: true } };
    case 'unread': return { call: { ref: reference, action: 'flags', remove: ['\\Seen'] }, patch: { seen: false } };
    case 'flag': return { call: { ref: reference, action: 'flags', add: ['\\Flagged'] }, patch: { flagged: true } };
    case 'unflag': return { call: { ref: reference, action: 'flags', remove: ['\\Flagged'] }, patch: { flagged: false } };
    case 'archive': {
      const target = folder || writeBack.archiveFolder || resolveMailFolder(folders, 'archive');
      if (!target) throw Object.assign(new Error('没找到归档文件夹，请到设置 → 邮箱里指定一个。'), { status: 400, code: 'MAIL_FOLDER_NOT_FOUND' });
      return { ...move(target), patch: { folder: target, archivedAt: at } };
    }
    case 'trash': {
      const target = folder || writeBack.trashFolder || resolveMailFolder(folders, 'trash');
      if (!target) throw Object.assign(new Error('没找到废纸篓文件夹，请到设置 → 邮箱里指定一个。'), { status: 400, code: 'MAIL_FOLDER_NOT_FOUND' });
      return { ...move(target), patch: { folder: target, trashedAt: at } };
    }
    case 'move': {
      if (!folder) throw Object.assign(new Error('没有指定目标文件夹。'), { status: 400, code: 'MAIL_FOLDER_REQUIRED' });
      return move(folder);
    }
    default:
      throw Object.assign(new Error(`不支持的动作：${action}`), { status: 400, code: 'MAIL_ACTION_UNSUPPORTED' });
  }
}

function imapWriteError(error, settings, mailbox) {
  if (['MAIL_WRITE_BACK_DISABLED', 'MAIL_FOLDER_NOT_FOUND', 'MAIL_FOLDER_REQUIRED', 'MAIL_ACTION_UNSUPPORTED', 'MAIL_REF_UNKNOWN'].includes(error?.code)) return error;
  return Object.assign(new Error(`写回邮箱失败：${formatMailboxTestError(error, { ...settings, imapHost: mailbox.imapHost })}`), {
    status: error?.status || 400, code: error?.code || 'MAIL_WRITE_FAILED', cause: error,
  });
}

/** 读一次文件夹列表（IMAP LIST），给设置页选归档 / 废纸篓目录用。 */
export async function listMailboxFolders(settings, { clientFactory = (options) => new ImapFlow(options) } = {}) {
  const mailbox = normalizeMailbox(settings);
  const client = createImapClient(settings, mailbox, clientFactory);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const folders = [];
    for await (const item of client.list()) {
      if (!item?.path) continue;
      folders.push({
        path: item.path,
        name: item.name || item.path,
        specialUse: typeof item.specialUse === 'string' ? item.specialUse : (Array.isArray(item.specialUse) ? item.specialUse[0] : ''),
        flags: folderFlags(item),
      });
    }
    return folders;
  } catch (error) {
    throw Object.assign(new Error(formatMailboxTestError(error, { ...settings, imapHost: mailbox.imapHost })), { status: 400, cause: error });
  } finally {
    await closeImapClient(client, connected);
  }
}

/** 读一批 uid 的 flags（\Seen / \Flagged），把真邮箱的已读状态镜像回本地。 */
export async function readMailboxFlags(settings, uids, { clientFactory = (options) => new ImapFlow(options) } = {}) {
  const wanted = [...new Set((Array.isArray(uids) ? uids : []).map(Number)
    .filter((uid) => Number.isInteger(uid) && uid > 0))];
  if (!wanted.length) return new Map();
  const mailbox = normalizeMailbox(settings);
  const client = createImapClient(settings, mailbox, clientFactory);
  let connected = false;
  let lock;
  const result = new Map();
  try {
    await client.connect();
    connected = true;
    lock = await client.getMailboxLock('INBOX');
    if (client.mailbox.exists) {
      for await (const message of client.fetch(wanted.join(','), { uid: true, flags: true }, { uid: true })) {
        result.set(message.uid, messageFlagsOf(message));
      }
    }
    return result;
  } catch (error) {
    throw Object.assign(new Error(formatMailboxTestError(error, { ...settings, imapHost: mailbox.imapHost })), { status: 400, cause: error });
  } finally {
    try { lock?.release(); } catch { /* ignore */ }
    await closeImapClient(client, connected);
  }
}

/**
 * 写回真邮箱，只接受两种指令：
 *   flags：加 / 去 \Seen、\Flagged（随时能改回来）
 *   move ：移动到指定文件夹（归档、废纸篓、手动移动都是它）
 * 失败就抛错——调用方必须如实告诉用户，不能假装成功。
 */
export async function writeBackMailboxMessage(settings, { ref, action, target, add = [], remove = [] }, { clientFactory = (options) => new ImapFlow(options) } = {}) {
  if (!ref?.uid) {
    throw Object.assign(new Error('无法定位这封邮件在邮箱里的位置，已跳过写回。'), { status: 400, code: 'MAIL_REF_UNKNOWN' });
  }
  const mailbox = normalizeMailbox(settings);
  const client = createImapClient(settings, mailbox, clientFactory);
  let connected = false;
  let lock;
  try {
    await client.connect();
    connected = true;
    lock = await client.getMailboxLock(ref.folder || 'INBOX');
    if (action === 'move') {
      if (!target) throw Object.assign(new Error('没有指定目标文件夹。'), { status: 400, code: 'MAIL_FOLDER_REQUIRED' });
      await client.messageMove(String(ref.uid), target, { uid: true });
      return { ok: true, folder: target };
    }
    if (add.length) await client.messageFlagsAdd(String(ref.uid), add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(String(ref.uid), remove, { uid: true });
    return { ok: true, folder: ref.folder || 'INBOX' };
  } catch (error) {
    throw imapWriteError(error, settings, mailbox);
  } finally {
    try { lock?.release(); } catch { /* ignore */ }
    await closeImapClient(client, connected);
  }
}

export async function readMailboxEmails(settings, { onProgress = () => {}, recorder, processedIds = new Set(), identityScope,
  clientFactory = (options) => new ImapFlow(options), retryMode = 'manual' } = {}) {
  const mailbox = normalizeMailbox(settings);
  const sessionStart = Date.now();
  const provider = mailbox.provider || 'imap';
  const stopRead = timer('imap.read.ms', { provider });
  onProgress({ stage: '连接邮箱', received: 0, total: 0 });
  const client = createImapClient(settings, mailbox, clientFactory);
  let lock;
  let readFailed = false;
  let connected = false;
  const readContexts = [];
  try {
    try {
      const stopConnect = timer('imap.connect.ms', { provider });
      try { await client.connect(); connected = true; }
      finally { stopConnect(); }
    } catch (error) {
      throw Object.assign(new Error(formatMailboxTestError(error, {
        ...settings,
        imapHost: mailbox.imapHost,
      })), { status: 400, cause: error });
    }
    const connectionMs = Date.now() - sessionStart;
    onProgress({ stage: '打开收件箱', shared_connection_ms: connectionMs });
    lock = await client.getMailboxLock('INBOX');
    if (!client.mailbox.exists) return [];
    const since = resolveFetchSince(mailbox);
    const until = resolveFetchUntil(mailbox);
    const emails = [];
    const pendingUids = [];
    const messageId = (uid) => mailboxMessageIdentity(settings, { uidValidity: client.mailbox.uidValidity, uid,
      scope: identityScope, processedIds });
    let total = 0;
    let checked = 0;
    onProgress({ stage: '检查邮件 ID', received: 0, total: 0 });
    // Finish this command before fetching sources: commands inside a fetch iterator can deadlock IMAP.
    if (since) {
      const query = { since };
      if (until) query.before = until;
      onProgress({ stage: '按日期筛选邮件', received: 0, total: 0 });
      const candidateUids = await client.search(query, { uid: true });
      candidateUids.sort((a, b) => a - b);
      total = candidateUids.length;
      onProgress({ stage: '检查邮件 ID', received: 0, total });
      if (candidateUids.length) {
        for await (const message of client.fetch(candidateUids.join(','), { uid: true, internalDate: true, flags: true }, { uid: true })) {
          const id = messageId(message.uid);
          const marks = messageFlagsOf(message);
          if (processedIds.has(id)) emails.push({ id, receivedAt: message.internalDate.toISOString(), ...marks });
          else pendingUids.push(message.uid);
          onProgress({ stage: '检查邮件 ID', received: ++checked, total });
        }
      }
    } else {
      const limit = Math.max(1, Math.min(200, Number(settings.fetchLimit) || 15));
      const first = Math.max(1, client.mailbox.exists - limit + 1);
      total = client.mailbox.exists - first + 1;
      onProgress({ stage: '检查邮件 ID', received: 0, total });
      for await (const message of client.fetch(`${first}:*`, { uid: true, internalDate: true, flags: true })) {
        const id = messageId(message.uid);
        const marks = messageFlagsOf(message);
        if (processedIds.has(id)) emails.push({ id, receivedAt: message.internalDate.toISOString(), ...marks });
        else pendingUids.push(message.uid);
        onProgress({ stage: '检查邮件 ID', received: ++checked, total });
      }
    }
    if (!pendingUids.length) {
      onProgress({ stage: '邮件读取完成', received: emails.length, total, shared_read_ms: Date.now() - sessionStart });
      counterAdd('imap.messages_total', emails.length, { provider });
      return emails.reverse();
    }
    const sourceRange = pendingUids.join(',');
    const iterator = client.fetch(sourceRange, { source: true, uid: true, internalDate: true, flags: true }, { uid: true })[Symbol.asyncIterator]();
    while (true) {
      onProgress({ stage: '读取邮件原文', received: emails.length, total });
      const fetchStart = new Date().toISOString();
      const next = await iterator.next();
      if (next.done) break;
      const fetchEnd = new Date().toISOString();
      const message = next.value;
      // Keep the original prefix for legacy data; changing a provider preset does not reprocess the same mailbox.
      const id = messageId(message.uid);
      // Matching failures are checked against the latest calendar in processEmails first.
      const waitingForMatch = retryMode !== 'manual' && recorder?.traces.some((trace) =>
        trace.email_ref === emailReference(id) && trace.mode === 'qq' && trace.status === 'failed' && trace.match_retry);
      const context = !processedIds.has(id) && !waitingForMatch ? recorder?.beginEmail({ id }, 'qq') : null;
      if (context) {
        readContexts.push(context);
        const receive = context.startSpan('receive_email', '收取邮件', { started_at: fetchStart,
          thought: '最近邮件已按 ID 去重，只取得尚未成功处理的原始消息。',
          input_snapshot: { mailbox: 'INBOX', uid: message.uid, range: sourceRange },
          tool_calls: [{ name: 'imap.fetch', arguments: { mailbox: 'INBOX', uid: message.uid, source: true, uid_mode: true },
            result_summary: { raw_bytes: message.source?.length || 0, internal_date: message.internalDate?.toISOString(),
              shared_connection_ms: connectionMs,
              timing_scope: '等待此消息的实际时间；shared_connection_ms 属于本次同步共享开销，不分摊到单封。' } }] });
        context.finishSpan(receive, { ended_at: fetchEnd, observation: '已收到邮件源数据，开始解析。',
          output_snapshot: { raw_bytes: message.source?.length || 0 } });
      }
      onProgress({ stage: '解析邮件正文', received: emails.length, total });
      const parseStart = new Date().toISOString();
      const parseSpan = context?.startSpan('parse', '解析邮件', { started_at: parseStart,
        thought: '提取主题、发件人、发送时间和正文；纯文本优先，HTML 去标签作为备用。',
        input_snapshot: { raw_bytes: message.source?.length || 0 },
        tool_calls: [{ name: 'mailparser.simpleParser', arguments: { raw_bytes: message.source?.length || 0 }, result_summary: null }] });
      try {
        const parsed = await simpleParser(message.source);
        const attachments = await uploadParsedAttachments(parsed, {
          mailboxId: mailbox.id,
          emailId: id,
          userId: mailbox.ownerUserId || mailbox.userId || settings.ownerUserId || '',
          username: mailbox.ownerUsername || settings.ownerUsername || '',
        });
        const email = { id, subject: parsed.subject || '（无主题）', sender: parsed.from?.text || '',
          senderAddress: parsed.from?.value?.[0]?.address || '', replyTo: parsed.replyTo?.text || '',
          messageId: parsed.messageId || '', references: parsed.references || [], inReplyTo: parsed.inReplyTo || '',
          receivedAt: (parsed.date || message.internalDate).toISOString(),
          body: parsed.text || parsed.html?.replace(/<[^>]*>/g, ' ') || '',
          html: typeof parsed.html === 'string' ? parsed.html.slice(0, 200_000) : '',
          ...messageFlagsOf(message),
          attachments };
        Object.defineProperty(email, '_textAttachments', { value: parsed.attachments || [] });
        Object.defineProperty(email, '_pdfAttachments', { value: (parsed.attachments || []).filter((item) => item.contentType === 'application/pdf' || /\.pdf$/i.test(item.filename || '')) });
        const parsedSnapshot = emailSnapshot(email);
        if (context) {
          context.update({ subject: email.subject, received_at: email.receivedAt });
          context.finishSpan(parseSpan, { observation: '邮件字段解析完成，原文仅记录有限脱敏片段。', output_snapshot: parsedSnapshot,
            tool_calls: [{ name: 'mailparser.simpleParser', arguments: { raw_bytes: message.source?.length || 0 }, result_summary: parsedSnapshot }] });
          email.trace_id = context.trace.trace_id;
          Object.defineProperty(email, '_traceContext', { value: context });
        } else {
          // Not enumerable: raw timings never become part of stored mail text or the model request.
          Object.defineProperty(email, '_traceTimings', { value: { fetchStart, fetchEnd, parseStart, parseEnd: new Date().toISOString() } });
        }
        emails.push(email);
      } catch (error) {
        if (context) {
          context.finishSpan(parseSpan, { status: 'failed', error: error.message, observation: '邮件解析失败，此封未调用模型。' });
          context.finish('failed', { decision: '解析失败，可再次同步重试', error: error.message });
        }
        throw error;
      }
    }
    onProgress({ stage: '邮件读取完成', received: emails.length, total, shared_read_ms: Date.now() - sessionStart });
    counterAdd('imap.messages_total', emails.length, { provider });
    const batchReady = new Date().toISOString();
    for (const email of emails) {
      const context = email._traceContext;
      if (!context || context.trace.status !== 'running') continue;
      context.queue_span = context.startSpan('queue_wait', '等待顺序处理', {
        started_at: batchReady,
        thought: '本批邮件已读取完。按时间从早到晚处理，此封只等待更早的邮件，避免改期通知先于原邀请。',
        input_snapshot: { order: 'received_at_ascending' },
        tool_calls: [{ name: 'mail.chronological_queue', arguments: { order: 'received_at_ascending' }, result_summary: '等待处理' }] });
    }
    return emails.reverse();
  } catch (error) {
    readFailed = true;
    for (const context of readContexts.filter((item) => item.trace.status === 'running')) {
      if (context.queue_span) context.finishSpan(context.queue_span, { status: 'failed', error: error.message,
        observation: '批量读取中断，此封尚未调用模型，可再次同步。' });
      context.finish('failed', { decision: '批量读取中断，可再次同步重试', error: error.message });
    }
    throw error;
  } finally {
    lock?.release();
    stopRead({ outcome: readFailed ? 'failed' : 'ok' });
    counter('imap.read_total', { provider, outcome: readFailed ? 'failed' : 'ok' });
    await closeImapClient(client, connected && !readFailed);
  }
}

export async function sendMailboxReply(settings, email, draft) {
  const mailbox = normalizeMailbox(settings);
  const recipient = [email.replyTo, email.senderAddress, email.sender]
    .flatMap((source) => addressparser(source || '', { flatten: true }))
    .find((item) => item.address?.includes('@'))?.address;
  if (!recipient) throw new Error('原邮件没有可回复的发件人地址。');
  const references = Array.isArray(email.references) ? email.references : (email.references || '').split(/\s+/);
  return sendMailboxMessage(settings, { to: recipient,
    subject: /^\s*re\s*:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || '（无主题）'}`,
    text: draft, ...(email.messageId ? { inReplyTo: email.messageId } : {}),
    references: [...new Set([...references, email.messageId].filter(Boolean))] });
}

export async function sendMailboxMessage(settings, message) {
  const mailbox = normalizeMailbox(settings);
  const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((recipient) => String(recipient).trim().toLowerCase());
  // Use system DNS so local proxy/hosts rules apply; keep the configured TLS hostname.
  const { address } = await dns.lookup(mailbox.smtpHost);
  const transport = nodemailer.createTransport({
    host: address, port: mailbox.smtpPort, secure: mailbox.smtpSecure, tls: { servername: mailbox.smtpHost },
    ...(!mailbox.smtpSecure ? { requireTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode }, logger: false, debug: false,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  try {
    const info = await transport.sendMail({ ...message, from: settings.email });
    if (!info.accepted?.some((address) => recipients.includes(String(address?.address || address).toLowerCase()))) {
      throw Object.assign(new Error('邮箱未接受这封回复，请检查收件人后重试。'), {
        code: 'EENVELOPE', accepted: [], rejected: info.rejected || recipients,
      });
    }
    return info;
  } finally {
    transport.close?.();
  }
}

// Existing scripts and stored real-mail traces use the original QQ entry names.
export const readQQEmails = readMailboxEmails;
export const sendQQReply = sendMailboxReply;

function emailSnapshot(email) {
  return { subject: email.subject, sender: email.sender, sent_at: email.receivedAt,
    body_length: email.body?.length || 0 };
}

function taskContextSnapshot(tasks) {
  return tasks.map((task) => ({ ...task, sources: (task.sources || []).map(({ emailId, emailUrl, ...source }) =>
    ({ ...source, email_ref: emailReference(emailId), emailUrl: emailUrl?.split(/[?#]/)[0] || '/' })) }));
}

export function parseExtraction(content) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed.events)) throw new Error('模型返回格式不正确：缺少 events 数组。');
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) throw new Error('模型返回格式不正确：tasks 必须是数组。');
  if (parsed.invoices !== undefined && !Array.isArray(parsed.invoices)) throw new Error('模型返回格式不正确：invoices 必须是数组。');
  const invoiceMail = parsed.category === 'invoice' || parsed.intent === 'invoice' || parsed.invoices?.length > 0;
  return { summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '', ...emailLabels(parsed),
    // Receipt dates and reimbursement deadlines never become calendar/task actions.
    events: invoiceMail ? [] : parsed.events.map(normalizeAction),
    ...(parsed.tasks !== undefined ? { tasks: invoiceMail ? [] : parsed.tasks.map(normalizeTask) } : {}),
    ...(parsed.invoices !== undefined ? { invoices: parsed.invoices } : {}) };
}

function beijingIso(timestamp) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+08:00';
}

function eventFields(event, partial = false) {
  const fields = {};
  for (const name of ['title', 'start', 'end', 'allDay', 'category', 'location', 'description']) {
    if (partial && event[name] === undefined) continue;
    fields[name] = event[name];
  }
  if ('allDay' in fields) fields.allDay = Boolean(fields.allDay);
  if ('category' in fields) {
    fields.category = resolveEventCategory(fields.category, readSettings().calendarCategories);
  }
  if ('location' in fields) fields.location = fields.location || '';
  if ('description' in fields) fields.description = fields.description || '';
  if (!partial && !fields.allDay && !fields.end && Number.isFinite(Date.parse(fields.start))) {
    fields.end = beijingIso(Date.parse(fields.start) + 2 * 60 * 60 * 1000);
  }
  if (!partial && (!fields.title || !fields.start || !fields.end || !Number.isFinite(Date.parse(fields.start)) ||
      !Number.isFinite(Date.parse(fields.end)) || Date.parse(fields.end) <= Date.parse(fields.start))) {
    throw new Error('模型返回的日程缺少标题或有效的起止时间，请调整模型后重试。');
  }
  return fields;
}

function rescheduledFields(target, changes) {
  const fields = { ...target, ...changes };
  if (!changes.end) {
    fields.end = target.end;
    if (changes.start) {
      const duration = Date.parse(target.end) - Date.parse(target.start);
      if (Number.isFinite(Date.parse(changes.start)) && Number.isFinite(duration) && duration > 0) {
        fields.end = beijingIso(Date.parse(changes.start) + duration);
      }
    }
  }
  return eventFields(fields);
}

function normalizeAction(event) {
  const action = event.action ?? 'create';
  if (!['create', 'cancel', 'reschedule', 'keep'].includes(action)) throw new Error('模型返回了不支持的日程操作。');
  if (action === 'create') return eventFields(event);
  const reason = event.reason || '';
  const targetEventId = typeof event.targetEventId === 'string' ? event.targetEventId.trim() : '';
  if (!targetEventId) {
    // 省略 target：留给应用展示候选日程供人工点选，不再整封失败。
    return {
      action,
      reason,
      needsMatch: true,
      ...(action === 'reschedule' ? eventFields(event, true) : {}),
      ...(action === 'keep' ? {} : {}),
    };
  }
  return {
    ...(action === 'reschedule' ? eventFields(event, true) : {}),
    action,
    targetEventId,
    reason,
  };
}

function activeEventsForMode(events, mode) {
  // Declined invitations stay matchable: a later cancel/reschedule must still be able to
  // identify the original. Only its calendar time is freed, which conflicts.js enforces.
  return events.filter((event) => event.status !== 'cancelled' &&
    (mode === 'demo' ? event.source === 'demo' : event.source !== 'demo'));
}

export const EXTRACTION_VERSION = 'mail-calendar-tasks-invoices-v7';

export async function extractEvents(email, settings, existingEvents = [], traceContext, existingTasks = [], {
  timeoutMs = 60_000, peerTasks = [],
} = {}) {
  const endpoint = completionUrl(settings.baseUrl);
  const candidates = activeEventsForMode(existingEvents, 'qq').map((event) => ({
    id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay,
    category: event.category, location: event.location, description: event.description, source: event.source,
    emailSubject: event.emailSubject, emailSender: event.emailSender,
  }));
  const taskCandidates = tasksForMode(existingTasks, 'qq').map(({ id, title, description, dueAt, deadlineText, priority, status, sources, assignee }) =>
    ({ id, title, description, dueAt, deadlineText, priority, status, assignee: assignee || '', sources }));
  const peerTaskCandidates = (peerTasks || []).map(({ id, title, description, dueAt, deadlineText, priority, status, assignee, mailboxId, mailboxEmail }) =>
    ({ id, title, description, dueAt, deadlineText, priority, status, assignee: assignee || '', mailboxId, mailboxEmail }));
  const taskEvidence = taskContextSnapshot(taskCandidates);
  const currentTime = beijingIso(Date.now());
  const calendarCategories = settings.calendarCategories || readSettings().calendarCategories;
  const extractionPrompt = readPrompts().extractionSystem;
  const systemPrompt = [
    extractionPrompt,
    categoryPromptBlock(calendarCategories),
    // Keep current activity rules effective for previously saved prompts, too.
    extractionPrompt.includes(ACTIVITY_EXTRACTION_RULES) ? '' : ACTIVITY_EXTRACTION_RULES,
    extractionPrompt.includes(INVOICE_EXTRACTION_RULES) ? '' : INVOICE_EXTRACTION_RULES,
  ].filter(Boolean).join('\n\n');
  const request = { model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({
          sentAt: email.receivedAt, subject: email.subject, sender: email.sender, body: email.body,
          attachments: (email.attachments || email._textAttachments || email._pdfAttachments || []).map((item) => ({ id: item.id, filename: item.filename, contentType: item.contentType })),
          attachmentTexts: email.attachmentTexts || [],
          currentTime, existingEvents: candidates, existingTasks: taskCandidates,
          peerTasks: peerTaskCandidates,
        }) },
      ],
      response_format: { type: 'json_object' },
    };
  if (new URL(endpoint).hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model)) {
    request.thinking = { type: 'disabled' };
  }
  const ownsSpan = Boolean(traceContext && !traceContext.extract_span);
  const span = traceContext?.extract_span || traceContext?.startSpan('extract', '模型提取');
  const tool = { name: 'llm.chat_completions', arguments: { method: 'POST', endpoint,
    model: settings.model, response_format: request.response_format, prompt_version: EXTRACTION_VERSION,
    timeout_ms: timeoutMs, ...(request.thinking ? { thinking: request.thinking } : {}),
    system_prompt: request.messages[0].content, current_time: currentTime, email: emailSnapshot(email), existing_events: candidates,
    existing_tasks: taskEvidence }, result_summary: null };
  traceContext?.updateSpan(span, { thought: '调用配置的模型，一次提取分类、摘要、优先级、日程操作和待办，并与已有事项匹配。',
    input_snapshot: { model: settings.model, current_time: currentTime, email: emailSnapshot(email), existing_events: candidates, existing_tasks: taskEvidence,
      full_body_sent_to_model: true, snapshot_note: '模型接收完整正文；日志只保留脱敏、截断快照。' },
    tool_calls: [tool], llm_request: true });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await modelFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(request), signal: timeoutSignal,
    });
    const rawResponse = await response.text();
    let result;
    try { result = JSON.parse(rawResponse); }
    catch {
      tool.result_summary = { http_status: response.status, response_chars: rawResponse.length, error: '响应不是有效 JSON' };
      traceContext?.updateSpan(span, { ...usageMetrics(null, settings), output_snapshot: tool.result_summary, tool_calls: [tool] });
      throw new Error('模型响应不是有效 JSON，请检查接口地址或服务商返回格式。');
    }
    const content = result.choices?.[0]?.message?.content || '';
    const metrics = usageMetrics(result.usage, settings);
    // Only message.content and numeric usage are evidence. Provider reasoning_content is never recorded.
    tool.result_summary = { http_status: response.status, finish_reason: result.choices?.[0]?.finish_reason || null,
      usage: { prompt_tokens: metrics.llm_tokens_in, completion_tokens: metrics.llm_tokens_out, cached_tokens: metrics.llm_tokens_cached_in },
      content_length: content.length, content_preview: content,
      ...(response.ok ? {} : { error: result.error?.message || String(response.status) }) };
    traceContext?.updateSpan(span, { ...metrics, output_snapshot: tool.result_summary, tool_calls: [tool] });
    if (!response.ok) throw new Error(`模型请求失败：${result.error?.message || response.status}`);
    const extraction = parseExtraction(content);
    traceContext?.updateSpan(span, { output_snapshot: { ...tool.result_summary, parsed: extraction } });
    if (ownsSpan) traceContext.finishSpan(span, { observation: `模型返回 ${extraction.events.length} 项日程操作、${extraction.tasks?.length || 0} 项待办、${extraction.invoices?.length || 0} 张发票，内容摘要和邮件标签已解析。` });
    return extraction;
  } catch (error) {
    const raw = timeoutSignal.aborted
      ? `模型请求超过 ${timeoutMs / 1000} 秒，已停止等待；请再次同步重试。`
      : formatModelFetchError(error, settings);
    const safeMessage = sanitizeSnapshot(raw, [settings.apiKey, settings.authorizationCode]);
    if (span && !tool.result_summary) {
      tool.result_summary = { error: safeMessage, response_received: false };
      traceContext.updateSpan(span, { ...usageMetrics(null, settings), tool_calls: [tool], output_snapshot: tool.result_summary });
    }
    if (ownsSpan) traceContext.finishSpan(span, { status: 'failed', error: safeMessage, observation: safeMessage });
    throw new Error(safeMessage);
  }
}

function prepareTasks(store, email, extractedTasks, mode, priority, processedAt, peerTasks = []) {
  const candidates = tasksForMode(store.tasks || [], mode).map((task) => ({ ...task, sources: [...(task.sources || [])] }));
  const peers = (peerTasks || []).map((task) => ({ ...task }));
  const created = new Set();
  const merged = new Set();
  const reopened = new Set();
  const linked = new Set();
  const touched = new Set();
  const source = { emailId: email.id, emailSubject: email.subject, emailSender: email.sender,
    emailUrl: `/?email=${encodeURIComponent(email.id)}` };
  for (const raw of extractedTasks) {
    const fields = normalizeTask(raw);
    const dueAt = inferDeadline(fields.deadlineText, email.receivedAt, fields.dueAt);
    let task;
    if (fields.existingTaskId) {
      task = candidates.find((candidate) => candidate.id === fields.existingTaskId);
      if (!task) throw new Error('待办匹配目标不存在或来源不一致，请核对任务后重试。');
    } else {
      task = candidates.find((candidate) => normalizeTaskTitle(candidate.title) === normalizeTaskTitle(fields.title) &&
        (candidate.dueAt ? Date.parse(candidate.dueAt) : null) === (dueAt ? Date.parse(dueAt) : null));
    }
    let peerHit = null;
    if (!task) {
      peerHit = peers.find((candidate) => normalizeTaskTitle(candidate.title) === normalizeTaskTitle(fields.title) &&
        (candidate.dueAt ? Date.parse(candidate.dueAt) : null) === (dueAt ? Date.parse(dueAt) : null));
    }
    if (!task) {
      task = { id: randomUUID(), title: fields.title, description: fields.description, dueAt, deadlineText: fields.deadlineText,
        assignee: fields.assignee || '',
        priority: taskPriority(dueAt, priority, processedAt), status: 'pending', source: mode === 'demo' ? 'demo' : 'email',
        createdAt: processedAt, sources: [] };
      if (fields.requiresVerification) {
        task.requiresVerification = true;
        task.verification = {
          mode: fields.verificationMode || 'reply_sent',
          status: 'pending',
        };
      }
      if (peerHit?.mailboxId && peerHit?.id) {
        task.linkedTaskRef = { mailboxId: peerHit.mailboxId, taskId: peerHit.id, mailboxEmail: peerHit.mailboxEmail || '' };
        linked.add(task.id);
        if (!task.description) {
          task.description = `关联其他邮箱待办（${peerHit.mailboxEmail || peerHit.mailboxId}）`;
        }
      }
      candidates.push(task);
      created.add(task.id);
    } else {
      if (!created.has(task.id)) merged.add(task.id);
      if (dueAt) {
        task.dueAt = dueAt;
        task.deadlineText = fields.deadlineText || task.deadlineText;
      }
      if (fields.description) task.description = fields.description;
      if (fields.assignee) task.assignee = fields.assignee;
      if (fields.requiresVerification) {
        task.requiresVerification = true;
        task.verification = {
          ...(task.verification || {}),
          mode: fields.verificationMode || task.verification?.mode || 'reply_sent',
          status: task.verification?.status || 'pending',
        };
      }
      const nextPriority = taskPriority(task.dueAt, priority, processedAt);
      task.priority = nextPriority;
      // 提醒/变更邮件命中已完成任务时重新打开，避免「完成后再催」被忽略
      if (task.status === 'done') {
        task.status = 'pending';
        task.completedAt = null;
        task.reopenedAt = processedAt;
        task.reopenedByEmailId = email.id;
        if (task.verification) task.verification = { ...task.verification, status: 'pending', verifiedAt: null };
        reopened.add(task.id);
      }
    }
    if (!task.sources.some((item) => item.emailId === email.id)) task.sources.push(source);
    touched.add(task.id);
  }
  const drafts = candidates.filter((task) => touched.has(task.id));
  return { drafts, taskIds: [...touched], createdTaskIds: [...created], mergedTaskIds: [...merged], reopenedTaskIds: [...reopened],
    linkedTaskIds: [...linked],
    snapshots: drafts.map(({ id, title, description, dueAt, deadlineText, priority, status, assignee, linkedTaskRef, requiresVerification, verification }) =>
      ({ taskId: id, title, description, dueAt, deadlineText, priority, status, assignee: assignee || '',
        linkedTaskRef: linkedTaskRef || null,
        requiresVerification: Boolean(requiresVerification),
        verification: verification || null,
        action: created.has(id) ? (linked.has(id) ? 'link' : 'create') : reopened.has(id) ? 'reopen' : 'merge' })) };
}

function candidateSummaries(events) {
  return events.map(({ id, title, start, end, location, emailSubject, emailSender }) => ({
    id, title, start, end, location: location || '', emailSubject: emailSubject || '', emailSender: emailSender || '',
  }));
}

export function invoiceExtractionFields(email, rawInvoices) {
  const { invoices, errors } = normalizeInvoices(rawInvoices || [], email);
  const invoiceErrors = [...new Set([...(email.attachmentTextErrors || []), ...errors])];
  const invoiceStatus = invoices.length
    ? (invoiceErrors.length ? 'partial' : 'extracted')
    : (invoiceErrors.length ? 'failed' : 'empty');
  return { invoices, invoiceErrors, invoiceStatus };
}

export function importEmail(store, email, extracted, mode, { peerTasks = [] } = {}) {
  let extraction = Array.isArray(extracted) ? { summary: '', events: extracted } : { ...extracted };
  if (!Array.isArray(extraction?.events)) throw new Error('模型返回格式不正确：缺少 events 数组。');
  if (extraction.tasks !== undefined && !Array.isArray(extraction.tasks)) throw new Error('模型返回格式不正确：tasks 必须是数组。');
  if (extraction.invoices !== undefined && !Array.isArray(extraction.invoices)) throw new Error('模型返回格式不正确：invoices 必须是数组。');
  const labels = emailLabels(extraction);
  const invoiceMail = labels.category === 'invoice' || labels.intent === 'invoice' || extraction.invoices?.length > 0;
  const invoiceFields = invoiceMail ? invoiceExtractionFields(email, extraction.invoices) : null;
  if (invoiceMail) Object.assign(labels, { category: 'invoice', intent: 'invoice' });
  if (invoiceMail || labels.category === 'resume' || labels.category === 'irrelevant' || labels.intent === 'noise') {
    extraction = { ...extraction, events: [], tasks: [] };
  }
  const processedAt = new Date().toISOString();
  const candidates = activeEventsForMode(store.events, mode);
  const targets = new Set();
  const pendingMatchActions = [];
  const keptActions = [];
  // Validate the whole email first so a failed action cannot leave half-applied changes.
  const normalized = extraction.events.map((item) => (item?.action || item?.needsMatch ? item : normalizeAction(item)));
  const actions = [];
  for (const action of normalized) {
    if (!action.action) {
      actions.push({ action: 'create', event: eventFields(action), id: randomUUID() });
      continue;
    }
    if (action.needsMatch || !action.targetEventId) {
      pendingMatchActions.push({
        id: randomUUID(),
        action: action.action,
        reason: action.reason || '',
        partial: action.action === 'reschedule' ? eventFields(action, true) : undefined,
        candidates: candidateSummaries(candidates),
      });
      continue;
    }
    const matches = candidates.filter((event) => event.id === action.targetEventId);
    if (matches.length !== 1) {
      pendingMatchActions.push({
        id: randomUUID(),
        action: action.action,
        reason: action.reason || '目标不存在或不唯一',
        partial: action.action === 'reschedule' ? eventFields(action, true) : undefined,
        suggestedTargetId: action.targetEventId,
        candidates: candidateSummaries(candidates),
      });
      continue;
    }
    if (targets.has(action.targetEventId)) throw new Error('同一封邮件重复修改了同一个日程，请调整模型后重试。');
    targets.add(action.targetEventId);
    const target = matches[0];
    if (action.action === 'keep') {
      keptActions.push({ action: 'keep', target, reason: action.reason || '', id: randomUUID() });
      continue;
    }
    actions.push({
      ...action,
      target,
      ...(action.action === 'reschedule' ? { event: rescheduledFields(target, action), id: randomUUID() } : {}),
    });
  }
  // Compare the final arrangements: cancelled and replaced originals no longer occupy time.
  const pending = actions.filter((action) => action.event);
  const calendar = [...candidates.filter((event) => !targets.has(event.id)),
    ...pending.map((action) => ({ ...action.event, id: action.id, source: mode === 'demo' ? 'demo' : 'email' }))];
  for (const action of pending) {
    action.conflicts = findConflicts(action.event, calendar.filter((event) => event.id !== action.id));
  }
  const conflicts = actions.flatMap((action, actionIndex) => action.conflicts?.length ? [{
    actionIndex, action: action.action, eventId: action.id, event: { ...action.event },
    ...(action.target ? { targetEventId: action.target.id } : {}),
    existingEvents: action.conflicts.map((event) => ({ id: event.id, ...eventFields(event), source: event.source })),
    suggestedSlots: suggestTimeSlots(action.event, calendar, Date.parse(processedAt)),
  }] : []);
  // Keep processing-time fields independent from later calendar edits or deletions.
  const actionSnapshots = [
    ...actions.map((action) => ({
      ...eventFields(action.event || action.target), action: action.action,
      ...(action.target ? { targetEventId: action.target.id, reason: action.reason } : {}),
      ...(action.id ? { eventId: action.id } : {}),
      ...(action.conflicts?.length ? { outcome: 'conflict' } : {}),
    })),
    ...keptActions.map((action) => ({
      ...eventFields(action.target), action: 'keep', targetEventId: action.target.id, reason: action.reason,
      outcome: 'kept',
    })),
    ...pendingMatchActions.map((action) => ({
      action: action.action, reason: action.reason, outcome: 'needs_match',
      ...(action.partial || {}),
    })),
  ];
  // Draft merged tasks without touching the store so any invalid field fails the whole email.
  const taskInput = (labels.category === 'irrelevant' || labels.intent === 'noise') ? [] : (extraction.tasks || []);
  const tasks = prepareTasks(store, email, taskInput, mode, labels.priority, processedAt, peerTasks);
  if (labels.priority !== undefined && tasks.snapshots.length) {
    const pendingTasks = tasks.snapshots.filter((task) => task.status !== 'done');
    const imminentTask = pendingTasks.some((task) => task.priority === 'high');
    const imminentMeeting = actions.some((action) => action.event && taskPriority(action.event.start, 'normal', processedAt) === 'high');
    const undatedAction = pendingTasks.some((task) => !task.dueAt);
    if (imminentTask) labels.priority = 'high';
    else if (labels.priority === 'high' && !imminentMeeting && !undatedAction) labels.priority = 'normal';
    else if (labels.priority === 'low' && pendingTasks.length) labels.priority = 'normal';
  }
  const createdEventIds = [];
  const cancelledEventIds = [];
  const rescheduledEventIds = [];
  const keptEventIds = keptActions.map((action) => action.target.id);
  for (const action of actions) {
    if (action.target) {
      Object.assign(action.target, {
        status: 'cancelled', cancellationType: action.action, cancelReason: action.reason,
        cancelledAt: processedAt, cancelledByEmailId: email.id,
        changeEmailId: email.id, changeEmailSubject: email.subject, changeEmailSender: email.sender,
        ...(action.action === 'reschedule' ? { replacementEventId: action.id } : {}),
      });
      (action.action === 'cancel' ? cancelledEventIds : rescheduledEventIds).push(action.target.id);
    }
    if (action.event) {
      store.events.push({ ...action.event, id: action.id, status: 'active', source: mode === 'demo' ? 'demo' : 'email',
        emailId: email.id, emailSubject: email.subject, emailSender: email.sender,
        ...(action.conflicts?.length ? { hasConflict: true, conflictEventIds: action.conflicts.map((event) => event.id) } : {}),
        ...(action.target ? { previousEventId: action.target.id } : {}) });
      createdEventIds.push(action.id);
    }
  }
  if (extraction.tasks !== undefined || taskInput.length) store.tasks ||= [];
  for (const task of tasks.drafts) {
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index === -1) store.tasks.push(task);
    else Object.assign(store.tasks[index], task);
  }
  const affectedEventIds = [...cancelledEventIds, ...rescheduledEventIds];
  const summary = invoiceMail
    ? (invoiceFields.invoices.length
      ? `已提取 ${invoiceFields.invoices.length} 张发票${invoiceFields.invoiceErrors.length ? '，部分附件或字段需核对' : '，可在发票助手复制'}`
      : invoiceFields.invoiceErrors.length ? '发票附件提取未完成，可在发票助手重试' : '已归类为发票报销，附件中未提取到发票信息')
    : [
    createdEventIds.length > rescheduledEventIds.length ? `新增 ${createdEventIds.length - rescheduledEventIds.length} 项日程` : '',
    cancelledEventIds.length ? `取消 ${cancelledEventIds.length} 项日程` : '',
    rescheduledEventIds.length ? `调整 ${rescheduledEventIds.length} 项日程` : '',
    keptEventIds.length ? `确认保持 ${keptEventIds.length} 项日程` : '',
    pendingMatchActions.length ? `${pendingMatchActions.length} 项待人工选择原日程` : '',
    tasks.createdTaskIds.length ? `新增 ${tasks.createdTaskIds.length} 项待办` : '',
    tasks.mergedTaskIds.length ? `合并 ${tasks.mergedTaskIds.length} 项待办提醒` : '',
    tasks.linkedTaskIds?.length ? `跨邮箱关联 ${tasks.linkedTaskIds.length} 项待办` : '',
    tasks.reopenedTaskIds?.length ? `重开 ${tasks.reopenedTaskIds.length} 项已完成待办` : '',
    conflicts.length ? `${conflicts.length} 项日程冲突，已加入日历并标记，回复草稿待确认` : '',
  ].filter(Boolean).join('；')
    || (labels.category === 'irrelevant' || labels.intent === 'noise'
      ? '已标记为无关/噪声，未写入日程或待办'
      : (extraction.tasks !== undefined ? '已分类并保存摘要，无需新增日程或待办' : '未发现需要处理的日程'));
  let status = 'skipped';
  if (pendingMatchActions.length) status = 'needs_match';
  else if (conflicts.length) status = 'conflict';
  else if (invoiceMail || actions.length || keptActions.length || tasks.taskIds.length) status = 'imported';
  const record = {
    ...email, events: undefined, tasks: undefined, mode, ...labels,
    ...(Object.keys(labels).length ? { tags: [labels.category, labels.priority, labels.intent].filter(Boolean) } : {}),
    eventIds: [...affectedEventIds, ...createdEventIds], createdEventIds, cancelledEventIds, rescheduledEventIds, affectedEventIds,
    keptEventIds,
    taskIds: tasks.taskIds, createdTaskIds: tasks.createdTaskIds, mergedTaskIds: tasks.mergedTaskIds,
    pendingActions: pendingMatchActions,
    status, summary, processedAt, conflicts,
    ...(invoiceMail ? { invoiceStatus: invoiceFields.invoiceStatus, invoiceErrors: invoiceFields.invoiceErrors, invoiceAttemptedAt: processedAt } : {}),
    extraction: {
      summary: typeof extraction.summary === 'string' ? extraction.summary.trim() : '',
      ...labels,
      actions: actionSnapshots,
      ...(extraction.tasks !== undefined || taskInput.length ? { tasks: tasks.snapshots } : {}),
      ...(invoiceMail ? { invoices: invoiceFields.invoices } : {}),
    },
  };
  if (labels.category === 'resume') {
    Object.assign(record, { status: 'imported', recruitmentStatus: 'no_pdf', summary: '求职邮件已分类，未发现可提取的 PDF 简历。' });
  }
  if (record.category !== 'resume' && record.recruitmentStatus === 'partial') {
    record.recruitmentStatus = 'not_resume';
    record.resumeErrors = [];
  }
  const existingIndex = store.emails.findIndex((item) => item.id === record.id);
  if (existingIndex < 0) store.emails.unshift(record); else store.emails[existingIndex] = record;
  return record;
}

/** 用户为 needs_match 邮件点选目标后应用 cancel/reschedule/keep，或改为 create / dismiss。 */
export function resolveEmailMatch(store, emailId, {
  pendingActionId, targetEventId, resolution = 'apply', mode = 'qq',
} = {}) {
  const email = store.emails.find((item) => item.id === emailId);
  if (!email) {
    const error = new Error('邮件不存在。');
    error.status = 404;
    throw error;
  }
  const pending = (email.pendingActions || []).find((item) => item.id === pendingActionId);
  if (!pending) {
    const error = new Error('没有待确认的日程匹配项。');
    error.status = 400;
    throw error;
  }
  if (resolution === 'dismiss') {
    email.pendingActions = (email.pendingActions || []).filter((item) => item.id !== pendingActionId);
    if (!(email.pendingActions || []).length) {
      email.status = email.createdEventIds?.length || email.taskIds?.length ? 'imported' : 'skipped';
      email.summary = `${email.summary || ''}；已忽略待匹配项`.replace(/^；/, '');
    }
    return email;
  }
  if (resolution === 'create') {
    const fields = eventFields({
      title: pending.partial?.title || email.subject || '未命名安排',
      start: pending.partial?.start,
      end: pending.partial?.end,
      allDay: pending.partial?.allDay,
      category: pending.partial?.category,
      location: pending.partial?.location,
      description: pending.partial?.description || pending.reason || '',
    });
    const id = randomUUID();
    store.events.push({
      ...fields, id, status: 'active', source: mode === 'demo' ? 'demo' : 'email',
      emailId: email.id, emailSubject: email.subject, emailSender: email.sender,
    });
    email.createdEventIds = [...(email.createdEventIds || []), id];
    email.eventIds = [...(email.eventIds || []), id];
    email.pendingActions = (email.pendingActions || []).filter((item) => item.id !== pendingActionId);
    email.extraction = {
      ...(email.extraction || {}),
      actions: [...(email.extraction?.actions || []), { ...fields, action: 'create', eventId: id, outcome: 'resolved_create' }],
    };
  } else {
    const target = activeEventsForMode(store.events, mode).find((event) => event.id === targetEventId);
    if (!target) {
      const error = new Error('所选日程不存在或已取消。');
      error.status = 400;
      throw error;
    }
    const processedAt = new Date().toISOString();
    if (pending.action === 'keep') {
      email.keptEventIds = [...(email.keptEventIds || []), target.id];
      email.extraction = {
        ...(email.extraction || {}),
        actions: [...(email.extraction?.actions || []), {
          ...eventFields(target), action: 'keep', targetEventId: target.id, reason: pending.reason, outcome: 'resolved_keep',
        }],
      };
    } else if (pending.action === 'cancel') {
      Object.assign(target, {
        status: 'cancelled', cancellationType: 'cancel', cancelReason: pending.reason || '用户确认取消',
        cancelledAt: processedAt, cancelledByEmailId: email.id,
        changeEmailId: email.id, changeEmailSubject: email.subject, changeEmailSender: email.sender,
      });
      email.cancelledEventIds = [...(email.cancelledEventIds || []), target.id];
      email.affectedEventIds = [...(email.affectedEventIds || []), target.id];
      email.eventIds = [...(email.eventIds || []), target.id];
      email.extraction = {
        ...(email.extraction || {}),
        actions: [...(email.extraction?.actions || []), {
          ...eventFields(target), action: 'cancel', targetEventId: target.id, reason: pending.reason, outcome: 'resolved',
        }],
      };
    } else if (pending.action === 'reschedule') {
      const nextId = randomUUID();
      const next = rescheduledFields(target, pending.partial || {});
      Object.assign(target, {
        status: 'cancelled', cancellationType: 'reschedule', cancelReason: pending.reason || '用户确认调整',
        cancelledAt: processedAt, cancelledByEmailId: email.id, replacementEventId: nextId,
        changeEmailId: email.id, changeEmailSubject: email.subject, changeEmailSender: email.sender,
      });
      store.events.push({
        ...next, id: nextId, status: 'active', source: mode === 'demo' ? 'demo' : 'email',
        emailId: email.id, emailSubject: email.subject, emailSender: email.sender, previousEventId: target.id,
      });
      email.rescheduledEventIds = [...(email.rescheduledEventIds || []), target.id];
      email.createdEventIds = [...(email.createdEventIds || []), nextId];
      email.affectedEventIds = [...(email.affectedEventIds || []), target.id];
      email.eventIds = [...(email.eventIds || []), target.id, nextId];
      email.extraction = {
        ...(email.extraction || {}),
        actions: [...(email.extraction?.actions || []), {
          ...next, action: 'reschedule', targetEventId: target.id, eventId: nextId, reason: pending.reason, outcome: 'resolved',
        }],
      };
    } else {
      const error = new Error('不支持的待确认操作。');
      error.status = 400;
      throw error;
    }
    email.pendingActions = (email.pendingActions || []).filter((item) => item.id !== pendingActionId);
  }
  if (!(email.pendingActions || []).length) {
    email.status = email.conflicts?.length ? 'conflict'
      : (email.createdEventIds?.length || email.cancelledEventIds?.length || email.rescheduledEventIds?.length || email.taskIds?.length || email.keptEventIds?.length)
        ? 'imported' : 'skipped';
    email.summary = `${email.summary || '已处理'}；人工匹配已完成`.replace(/^；/, '');
  }
  email.processedAt = new Date().toISOString();
  return email;
}

function replyDate(value, allDay) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(value));
}

function replyTime(event) {
  const first = replyDate(event.start, event.allDay);
  const last = replyDate(event.allDay ? new Date(Date.parse(event.end) - 1).toISOString() : event.end, event.allDay);
  return `${first}${event.allDay ? `${last === first ? '' : ` 至 ${last}`}（全天）` : ` 至 ${last}`}（北京时间）`;
}

export function buildReplyDraft(record) {
  const actions = record.extraction.actions;
  const tasks = record.extraction.tasks || [];
  const pendingCount = (record.pendingActions || []).length
    || actions.filter((action) => action.outcome === 'needs_match').length;
  if (!actions.length && !tasks.length) return `已收到「${record.subject}」。本封邮件未识别出需要新增、取消或调整的日程，也没有需要完成的待办，我会保留邮件供查阅。`;
  const lines = actions.map((action, index) => {
    if (action.outcome === 'needs_match') {
      return `「${action.title || record.subject}」的${action.action === 'cancel' ? '取消' : action.action === 'reschedule' ? '调整' : '变更'}通知尚待确认原日程${action.reason ? `（${action.reason}）` : ''}，我先保留邮件，确认目标后再更新日历。`;
    }
    if (action.action === 'keep' || action.outcome === 'kept') {
      return `已核对「${action.title}」：日历已是最新安排${action.reason ? `（${action.reason}）` : ''}，无需改动。`;
    }
    const conflict = record.conflicts?.find((item) => item.eventId === action.eventId)
      || record.conflicts?.find((item) => item.actionIndex === index);
    if (conflict) {
      const occupied = conflict.existingEvents.map((event) => `- 「${event.title}」：${replyTime(event)}${event.location ? `，地点：${event.location}` : ''}`).join('\n');
      const alternatives = conflict.suggestedSlots.map((slot, slotIndex) => `${slotIndex + 1}. ${replyTime(slot)}`).join('\n');
      return `感谢${action.action === 'reschedule' ? '告知调整' : '邀请'}「${action.title}」。${action.action === 'reschedule' ? '调整后的' : '原定'} ${replyTime(action)} 与以下已有安排冲突：\n${occupied}\n\n这次${action.action === 'reschedule' ? '调整已按通知更新日历并标记冲突，原安排已取消' : '邀请已加入日历并标记冲突'}。根据我的当前日历，以下 3 个时段可供选择（保留原时长）：\n${alternatives}\n以上仅代表我当前的空闲时间，尚未预订，请确认你方便的时段。`;
    }
    if (action.action === 'cancel') return `已知悉「${action.title}」取消${action.reason ? `（${action.reason}）` : ''}，原日程已标记取消。`;
    if (!action.start || !action.end) {
      return `已收到关于「${action.title || record.subject}」的通知${action.reason ? `（${action.reason}）` : ''}，已登记处理。`;
    }
    const time = replyTime(action);
    const place = action.location ? `，地点：${action.location}` : '';
    return action.action === 'reschedule' ? `已知悉「${action.title}」调整为 ${time}${place}，已按新安排更新日历。`
      : `已收到「${action.title}」邀请，已记录 ${time}${place}。`;
  });
  if (pendingCount) {
    lines.push(`另有 ${pendingCount} 项日程变更需我在系统中确认原安排后再更新。`);
  }
  lines.push(...tasks.map((task) => {
    const who = task.assignee ? `（责任人：${task.assignee}）` : '';
    if (task.action === 'reopen') {
      return `「${task.title}」此前已完成，根据最新提醒已重新打开${who}${task.dueAt ? `，截止 ${replyDate(task.dueAt, false)}（北京时间）` : ''}。`;
    }
    return `已记录待办「${task.title}」${who}${task.dueAt ? `，截止 ${replyDate(task.dueAt, false)}（北京时间）` : '，邮件未指定截止时间'}。`;
  }));
  return `您好，\n\n${lines.join('\n')}\n\n谢谢。`;
}

function decisionFor(record) {
  if (record.pendingActions?.length) return '待人工选择原日程';
  if (record.conflicts.length) return '日程已保存并标记冲突 / 等待确认回复草稿';
  if (record.rescheduledEventIds.length) return '调整安排';
  if (record.cancelledEventIds.length) return '取消安排';
  if (record.keptEventIds?.length) return '确认保持原安排';
  if (record.createdEventIds.length) return '接受邀请 / 记录日程';
  if (record.createdTaskIds.length) return '记录待办';
  if (record.mergedTaskIds.length) return '合并待办提醒';
  return '仅保留通知';
}

function matchingContextKey(store, mode, modelContext) {
  // Hash only the fields the extractor sees. lastSync and trace history do not change a match.
  const events = activeEventsForMode(store.events, mode).map(({ id, title, start, end, allDay,
    category, location, description, source, emailSubject, emailSender }) =>
    ({ id, title, start, end, allDay, category, location, description, source, emailSubject, emailSender }));
  const tasks = tasksForMode(store.tasks || [], mode).map(({ id, title, description, dueAt,
    deadlineText, priority, status, sources }) => ({ id, title, description, dueAt, deadlineText, priority, status, sources }));
  events.sort((a, b) => a.id.localeCompare(b.id));
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ mode, modelContext, events, tasks })).digest('hex');
}

const matchingErrors = new Set([
  '取消或调整邮件未匹配到唯一日程，请补充原活动标题、时间或地点后重试。',
  '取消或调整目标不存在、已取消或不唯一，请核对原日程后重试。',
]);

function recordFilteredEmail(store, email, rule, mode) {
  const processedAt = new Date().toISOString();
  const record = {
    id: email.id,
    subject: email.subject,
    sender: email.sender,
    receivedAt: email.receivedAt,
    body: email.body,
    attachments: email.attachments || [],
    mode,
    status: 'filtered',
    summary: `已按规则「${rule.name}」跳过，未调用模型`,
    processedAt,
    conflicts: [],
    eventIds: [],
    createdEventIds: [],
    cancelledEventIds: [],
    rescheduledEventIds: [],
    taskIds: [],
    createdTaskIds: [],
    mergedTaskIds: [],
    filterRuleId: rule.id,
    filterRuleName: rule.name,
    extraction: {
      summary: `规则过滤：${rule.name}`,
      category: 'promo',
      priority: 'low',
      actions: [],
      tasks: [],
    },
  };
  store.emails = [record, ...(store.emails || [])];
  return record;
}

export async function processEmails(store, emails, extractor, mode, { recorder, onProcessed = () => {}, beforeImport = () => {},
  retryMode = 'manual', modelContext = '', handleSpecialEmail, mailFilters, peerTasks = [],
  enrichAttachments = mode === 'qq',
} = {}) {
  let added = 0;
  let cancelled = 0;
  let rescheduled = 0;
  let tasksAdded = 0;
  let tasksMerged = 0;
  let invoices = 0;
  let conflicts = 0;
  let skipped = 0;
  let filtered = 0;
  let duplicate = 0;
  let deferred = 0;
  const errors = [];
  const filters = mailFilters ?? readSettings().mailFilters;
  const processed = new Set(store.emails.filter((email) => email.recruitmentStatus !== 'partial').map((email) => email.id));
  const chronologicalEmails = [...emails].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  for (let email of chronologicalEmails) {
    if (!email.body && store.emails.some((item) => item.id === email.id && item.recruitmentStatus === 'partial')) email = { ...store.emails.find((item) => item.id === email.id) };
    if (processed.has(email.id)) { duplicate++; continue; }
    const matchedFilter = mode === 'qq' ? findMatchingFilter(email, filters) : null;
    if (matchedFilter) {
      const context = recorder?.beginEmail(email, mode);
      const record = recordFilteredEmail(store, email, matchedFilter, mode);
      if (context) {
        const span = context.startSpan('filter', '规则过滤', {
          thought: '用户配置的过滤规则命中，跳过模型提取。',
          input_snapshot: { ruleId: matchedFilter.id, ruleName: matchedFilter.name },
        });
        context.finishSpan(span, {
          observation: record.summary,
          output_snapshot: { filterRuleId: matchedFilter.id, filterRuleName: matchedFilter.name },
        });
        context.finish('skipped', {
          decision: record.summary,
          extraction_snapshot: record.extraction,
          calendar_summary: record.summary,
        });
        record.trace_id = context.trace.trace_id;
      }
      processed.add(email.id);
      filtered++;
      skipped++;
      await onProcessed(record, store);
      continue;
    }
    const previousTrace = recorder?.traces.find((trace) => trace.email_ref === emailReference(email.id) && trace.mode === mode);
    const contextKey = mode === 'qq' ? matchingContextKey(store, mode, modelContext) : null;
    if (retryMode !== 'manual' && previousTrace?.status === 'failed' && previousTrace.match_retry?.context_key === contextKey) {
      deferred++;
      errors.push({ subject: email.subject || previousTrace.subject, message: '未能唯一匹配原日程；日历未变化，本轮没有重复调用模型。补充或修正原日程后会自动重试，也可点击同步真实邮箱手动重试。', deferred: true });
      continue;
    }
    const reusedReadContext = email._traceContext?.attempt.status === 'running';
    const context = reusedReadContext ? email._traceContext : recorder?.beginEmail(email, mode);
    context?.update({ match_retry: null });
    let currentSpan;
    try {
      if (context?.queue_span) {
        context.finishSpan(context.queue_span, { observation: '轮到此邮件，开始检查当前日历和待办。',
          output_snapshot: { order: 'received_at_ascending' },
          tool_calls: [{ name: 'mail.chronological_queue', arguments: { order: 'received_at_ascending' }, result_summary: '已出队' }] });
        delete context.queue_span;
      }
      if (context && !reusedReadContext) {
        const timings = email._traceTimings;
        currentSpan = context.startSpan('receive_email', mode === 'demo' ? '读取预置示例' : '收取邮件', {
          ...(timings ? { started_at: timings.fetchStart } : {}),
          thought: mode === 'demo' ? '加载本地预置示例，未连接邮箱。' : '取得待处理邮件，邮件 ID 尚未成功处理。',
          input_snapshot: { source: mode === 'demo' ? 'preset_fixture' : timings ? 'imap' : 'provided_email' },
          tool_calls: [{ name: mode === 'demo' ? 'fixtures.load' : timings ? 'imap.fetch' : 'mail.received',
            arguments: { mode }, result_summary: { subject: email.subject, body_length: email.body?.length || 0 } }] });
        context.finishSpan(currentSpan, { ...(timings ? { ended_at: timings.fetchEnd } : {}), observation: '邮件已取得，进入字段解析。' });
        currentSpan = context.startSpan('parse', '解析邮件', { ...(timings ? { started_at: timings.parseStart } : {}),
          thought: mode === 'demo' ? '读取示例已有的主题、发件人、时间和正文。' : '读取邮件结构中的主题、发件人、时间和正文。',
          input_snapshot: { body_length: email.body?.length || 0 },
          tool_calls: [{ name: timings ? 'mailparser.simpleParser' : 'mail.read_fields', arguments: { mode }, result_summary: emailSnapshot(email) }] });
        context.finishSpan(currentSpan, { ...(timings ? { ended_at: timings.parseEnd } : {}),
          observation: '可用于提取的邮件字段已就绪。', output_snapshot: emailSnapshot(email) });
      }
      if (handleSpecialEmail) {
        const special = await handleSpecialEmail(email, context);
        if (special) {
          const index = store.emails.findIndex((item) => item.id === email.id);
          const record = { ...special, trace_id: context?.trace.trace_id || special.trace_id };
          if (index < 0) store.emails.unshift(record); else store.emails[index] = record;
          if (record.recruitmentStatus === 'partial') errors.push({ subject: email.subject, message: '部分简历附件提取失败，可在邮件详情或人才库重试。' });
          else processed.add(email.id);
          context?.finish(record.recruitmentStatus === 'partial' ? 'failed' : 'imported', { decision: record.summary,
            calendar_summary: '招聘处理未自动修改日历或待办。' });
          await onProcessed(record, store);
          continue;
        }
      }
      if (enrichAttachments) {
        await enrichEmailWithAttachmentText(email, { context, skipRecruitment: true });
      }
      currentSpan = context?.startSpan('check_calendar', '检查日历与待办', {
        thought: mode === 'demo' ? '选择有效示例日程和已有示例待办，待办包括已完成项用于去重。'
          : '选择当前有效真实/手动日程和已有真实待办，用于日程变更及任务去重，待办包含已完成项。',
        input_snapshot: { stored_event_count: store.events.length, stored_task_count: store.tasks?.length || 0, mode } });
      const candidates = activeEventsForMode(store.events, mode);
      const taskCandidates = tasksForMode(store.tasks || [], mode);
      const candidateSnapshot = candidates.map(({ id, title, start, end, location, source }) => ({ id, title, start, end, location, source }));
      const taskSnapshot = taskContextSnapshot(taskCandidates.map(({ id, title, dueAt, status, priority, sources }) => ({ id, title, dueAt, status, priority, sources })));
      if (context) context.finishSpan(currentSpan, {
        observation: `找到 ${candidates.length} 项有效日程、${taskCandidates.length} 项已有待办。`,
        output_snapshot: { count: candidates.length, candidates: candidateSnapshot, task_count: taskCandidates.length, tasks: taskSnapshot },
        tool_calls: [{ name: 'calendar.active_events', arguments: { mode, exclude_cancelled: true },
          result_summary: { count: candidates.length, candidates: candidateSnapshot } },
        { name: 'tasks.existing', arguments: { mode, include_done: true }, result_summary: { count: taskCandidates.length, tasks: taskSnapshot } }] });
      currentSpan = context?.startSpan('extract', mode === 'demo' ? '读取预置提取结果' : '模型提取', {
        thought: mode === 'demo' ? '使用预置邮件标签、摘要、日程和待办，本步骤没有调用真实模型。'
          : '将邮件、当前日程和已有待办交给模型，一次返回邮件标签、摘要及需处理事项。',
        input_snapshot: { email: emailSnapshot(email), candidate_count: candidates.length, task_candidate_count: taskCandidates.length },
        ...(mode === 'demo' ? { llm_request: false, llm_tokens_in: 0, llm_tokens_out: 0, llm_tokens_cached_in: 0,
          cost_cny: 0, cost_status: 'preset' } : { llm_request: true, cost_status: 'usage_missing' }) });
      if (context) context.extract_span = currentSpan;
      const extraction = await extractor(email, candidates, context, taskCandidates);
      if (context) {
        const extractionSnapshot = Array.isArray(extraction) ? { summary: '', events: extraction } : extraction;
        context.finishSpan(currentSpan, { observation: `已取得 ${extractionSnapshot.events?.length || 0} 项日程操作、${extractionSnapshot.tasks?.length || 0} 项待办，下一步验证后保存。`,
          ...(!currentSpan.output_snapshot ? { output_snapshot: extractionSnapshot } : {}),
          ...(mode === 'demo' ? { tool_calls: [{ name: 'fixtures.preset_extraction', arguments: { mode: 'demo' }, result_summary: extractionSnapshot }] } : {}) });
        delete context.extract_span;
      }
      await beforeImport(store);
      currentSpan = context?.startSpan('create_task', '检测冲突并保存日程与待办', {
        thought: '验证整封邮件并保存日程与待办；按更新后的日历标记时间冲突，并提供空闲候选供回复确认。', input_snapshot: extraction,
        tool_calls: [{ name: 'calendar.apply_actions', arguments: { mode,
          operation_count: (Array.isArray(extraction) ? extraction : extraction.events)?.length,
          task_count: extraction.tasks?.length || 0 }, result_summary: null }] });
      const record = importEmail(store, email, extraction, mode, { peerTasks });
      if (context) {
        record.trace_id = context.trace.trace_id;
        const changes = { summary: record.summary, event_ids: record.eventIds, created: record.createdEventIds.length,
          cancelled: record.cancelledEventIds.length, rescheduled: record.rescheduledEventIds.length,
          task_ids: record.taskIds, tasks_created: record.createdTaskIds.length, tasks_merged: record.mergedTaskIds.length,
          category: record.category, priority: record.priority, conflicts: record.conflicts, extraction: record.extraction };
        context.finishSpan(currentSpan, { observation: record.summary, output_snapshot: changes,
          tool_calls: [{ name: 'calendar.check_conflicts', arguments: { mode, exclude_cancelled: true, exclude_all_day: true, adjacent_is_conflict: false },
            result_summary: { conflict_count: record.conflicts.length, conflicts: record.conflicts } },
          { name: 'calendar.apply_actions', arguments: { mode, operation_count: record.extraction.actions.length,
            task_count: record.extraction.tasks?.length || 0 }, result_summary: changes }] });
      }
      if (!['resume', 'invoice'].includes(record.category)) {
      currentSpan = context?.startSpan('draft_reply', '生成回复草稿', { thought: '依据已验证的处理快照套用本地回复模板，供用户检查；不调用模型、不发送邮件。',
        input_snapshot: { subject: email.subject, actions: record.extraction.actions, tasks: record.extraction.tasks || [] },
        tool_calls: [{ name: 'reply.local_template', arguments: { template: record.conflicts.length ? 'calendar-conflict-v2' : 'calendar-tasks-confirmation-v2', sent: false }, result_summary: null }] });
      record.draftReply = buildReplyDraft(record);
      record.draftSource = 'local_template';
      if (context) {
        const draft = { source: 'local_template', body: record.draftReply, sent: false };
        context.finishSpan(currentSpan, { observation: '回复草稿已生成，等待用户采纳、修改或拒绝，尚未发送。', output_snapshot: draft,
          tool_calls: [{ name: 'reply.local_template', arguments: { template: record.conflicts.length ? 'calendar-conflict-v2' : 'calendar-tasks-confirmation-v2', sent: false }, result_summary: draft }] });
        context.finish(record.status, { decision: decisionFor(record), draft_reply: record.draftReply, draft_source: 'local_template',
          extraction_snapshot: record.extraction, calendar_summary: record.summary });
      }
      } else context?.finish('imported', { decision: record.summary, extraction_snapshot: record.extraction, calendar_summary: record.summary });
      processed.add(email.id);
      added += record.createdEventIds.length;
      cancelled += record.cancelledEventIds.length;
      rescheduled += record.rescheduledEventIds.length;
      tasksAdded += record.createdTaskIds.length;
      tasksMerged += record.mergedTaskIds.length;
      invoices += record.extraction.invoices?.length || 0;
      if (record.category === 'invoice' && record.invoiceErrors.length) {
        errors.push({ subject: email.subject, message: `发票附件需核对，可在发票助手重试：${context ? context.sanitize(record.invoiceErrors.join('；')) : record.invoiceErrors.join('；')}` });
      }
      conflicts += record.conflicts.length;
      if (record.status === 'skipped') skipped++;
      await onProcessed(record, store);
    } catch (error) {
      if (context) {
        if (currentSpan?.status === 'running') context.finishSpan(currentSpan, { status: 'failed', error: error.message, observation: error.message });
        const awaitingMatch = mode === 'qq' && matchingErrors.has(error.message);
        context.finish('failed', { decision: awaitingMatch ? '待匹配原日程；日历变化或手动同步时重试' : '处理失败，可再次同步重试', error: error.message,
          match_retry: awaitingMatch ? { context_key: contextKey, message: error.message } : null });
        delete context.extract_span;
      }
      errors.push({ subject: email.subject, message: context ? context.sanitize(error.message) : error.message });
    }
  }
  store.lastSync = new Date().toISOString();
  return { added, cancelled, rescheduled, tasksAdded, tasksMerged, invoices, conflicts, skipped, filtered, duplicate, deferred, errors, total: emails.length, mode };
}
