import { normalizeInvitationPreferences } from './invitations-preferences.js';
import { readSecureJson, writeSecureJson } from './secure-json.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mailboxProviders, modelProviders, FIELD_HELP, guessMailboxProvider } from './providers.js';
import { FETCH_RANGE_OPTIONS, SYNC_STRATEGY_OPTIONS } from './fetch-policy.js';
import {
  DEFAULT_CALENDAR_CATEGORIES, normalizeCalendarCategories,
} from './calendar-categories.js';
import {
  DEFAULT_MAIL_FILTERS, FILTER_FIELDS, FILTER_OPS, ensureMailFilters, normalizeMailFilters,
} from './mail-filters.js';
import { getRequestUser, getRequestUserId, getRequestContext } from './request-context.js';
import { isProductionRuntime } from './runtime-mode.js';
import { pendingMailboxId } from './mailbox-identity.js';
import {
  usesStorageSnapshot, readSnapshotDocument, stageSnapshotDocument,
  calendarKey, settingsKey, storageStatus, registerSnapshotMailboxes,
} from './storage/index.js';

export { createStorageSnapshot, runStorageSnapshot, withStorageSnapshot, withStorageCommit, withStorageTransaction, commitStorage, flushStorage, discardStorage } from './storage/index.js';

export { mailboxProviders, modelProviders, FIELD_HELP, FETCH_RANGE_OPTIONS, SYNC_STRATEGY_OPTIONS, guessMailboxProvider };
export { DEFAULT_CALENDAR_CATEGORIES, normalizeCalendarCategories };
export { DEFAULT_MAIL_FILTERS, FILTER_FIELDS, FILTER_OPS, ensureMailFilters, normalizeMailFilters };

const USER_PREF_KEYS = [
  'baseUrl', 'apiKey', 'model', 'tokenPriceIn', 'tokenPriceOut', 'tokenPriceCachedIn',
  'calendarCategories', 'mailFilters', 'invitationPreferences', 'calendarSync', 'activeMailboxId',
];

function readRawSettings() {
  if (usesStorageSnapshot()) return readSnapshotDocument(settingsKey('default'));
  return read('settings', {
    email: '', authorizationCode: '', baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '', model: 'deepseek-chat', fetchLimit: 15, userPrefs: {},
  });
}

function normalizeUserPref(pref = {}) {
  return {
    baseUrl: pref.baseUrl,
    apiKey: pref.apiKey,
    model: pref.model,
    tokenPriceIn: pref.tokenPriceIn ?? null,
    tokenPriceOut: pref.tokenPriceOut ?? null,
    tokenPriceCachedIn: pref.tokenPriceCachedIn ?? null,
    calendarCategories: pref.calendarCategories,
    mailFilters: pref.mailFilters,
    calendarSync: pref.calendarSync,
    invitationPreferences: normalizeInvitationPreferences(pref.invitationPreferences),
    activeMailboxId: pref.activeMailboxId || null,
  };
}

/** 登录用户只看见自己的邮箱；无 ownerUserId 的旧数据留给未登录/测试。 */
function mailboxOwnerId(mailbox) {
  return mailbox?.ownerUserId || mailbox?.userId || null;
}

function emptyOwnedMailbox(userId) {
  const short = String(userId || 'user').replace(/-/g, '').slice(0, 10);
  const accountEmail = String(getRequestUser()?.email || '').trim().toLowerCase();
  const providerId = guessMailboxProvider(accountEmail);
  const provider = mailboxProviders.find((item) => item.id === providerId) || mailboxProviders[0];
  const pending = usesStorageSnapshot();
  return normalizeMailbox({
    id: pending ? pendingMailboxId(userId) : `mb-${short}`,
    ...(pending ? { pendingSetup: true } : {}),
    ownerUserId: userId,
    email: accountEmail,
    authorizationCode: '',
    provider: provider.id,
    imapHost: provider.imapHost,
    imapPort: provider.imapPort,
    imapSecure: provider.imapSecure,
    smtpHost: provider.smtpHost,
    smtpPort: provider.smtpPort,
    smtpSecure: provider.smtpSecure,
  });
}

function mailboxesForUser(allMailboxes, userId) {
  const all = (allMailboxes || []).map(normalizeMailbox);
  if (!userId) return all.length ? all : [normalizeMailbox({ id: 'default' })];
  const owned = all.filter((mailbox) => mailboxOwnerId(mailbox) === userId);
  if (owned.length) return owned.map((mailbox) => ({ ...mailbox, ownerUserId: userId }));
  return [emptyOwnedMailbox(userId)];
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');

export function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export function dateOffset(days) {
  const date = new Date(`${today()}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

function seed() {
  const definitions = [
    [-3, '产品灵感整理', '10:00', '11:00', 'work', 'Notion · 个人工作区'],
    [-1, '周末读书时间', '15:00', '16:00', 'personal', '家中'],
    [0, '新一周，轻轻出发', '09:30', '10:00', 'work', '工作台'],
    [0, '去公园走一走', '17:00', '18:00', 'personal', '滨江公园'],
    [2, '设计进度对齐', '14:00', '15:00', 'work', '线上会议'],
    [4, '和朋友吃晚餐', '18:30', '20:00', 'personal', '街角小馆'],
    [7, '留一点时间给自己', '10:00', '11:30', 'personal', '周末计划'],
    [9, '十月项目复盘', '15:00', '16:00', 'work', '会议室 A'],
  ];
  return { events: definitions.map(([offset, title, start, end, category, location]) => ({
    id: randomUUID(), title, start: `${dateOffset(offset)}T${start}:00+08:00`,
    end: `${dateOffset(offset)}T${end}:00+08:00`, allDay: false, category, location,
    description: '这是一条示例日程。你可以编辑它，也可以在设置中清除全部示例。', source: 'demo',
  })), emails: [], tasks: [], lastSync: null };
}

function read(name, initial, targetDirectory = directory) {
  const filename = path.join(targetDirectory, `${name}.json`);
  if (!fs.existsSync(filename)) write(name, initial, targetDirectory);
  // [desktop patch] settings 含邮箱授权码与模型 API Key，落盘加密；其余 JSON 保持明文。
  return name === 'settings' ? readSecureJson(filename) : JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function write(name, data, targetDirectory = directory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const filename = path.join(targetDirectory, `${name}.json`);
  if (name === 'settings') { writeSecureJson(filename, data); return; }
  // [desktop patch] 非 settings 走临时文件 + rename，避免崩溃时留下半截 JSON。
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${filename}.tmp`, filename);
}

export const MAILBOX_TAG_OPTIONS = [
  { id: 'work', label: '工作' },
  { id: 'personal', label: '个人' },
  { id: 'life', label: '生活' },
  { id: 'custom', label: '自定义' },
];

export function normalizeMailboxTag(tag, tagCustom = '') {
  const allowed = new Set(MAILBOX_TAG_OPTIONS.map((item) => item.id));
  const next = allowed.has(tag) ? tag : 'work';
  return {
    tag: next,
    tagCustom: next === 'custom' ? String(tagCustom || '').trim().slice(0, 24) : '',
  };
}

export function mailboxTagLabel(mailbox) {
  if (!mailbox) return '工作';
  if (mailbox.tag === 'custom') return mailbox.tagCustom || '自定义';
  return MAILBOX_TAG_OPTIONS.find((item) => item.id === mailbox.tag)?.label || '工作';
}

/**
 * 写回真实邮箱是显式开关：默认关闭，且必须按邮箱单独打开。
 * 现网已有数据没有这个字段，因此缺省值必须稳定为「关闭」，不能因为读一次设置就被打开。
 */
export function normalizeMailboxWriteBack(value) {
  const source = value && typeof value === 'object' ? value : {};
  const folder = (input) => (typeof input === 'string' ? input.trim().slice(0, 200) : '');
  return {
    enabled: source.enabled === true,
    archiveFolder: folder(source.archiveFolder),
    trashFolder: folder(source.trashFolder),
  };
}

export function normalizeMailbox(mailbox) {
  const provider = mailboxProviders.find((item) => item.id === (mailbox.provider || 'qq')) || mailboxProviders.at(-1);
  const tagged = normalizeMailboxTag(mailbox.tag, mailbox.tagCustom);
  return {
    id: mailbox.id || 'default', provider: provider.id, email: '', authorizationCode: '',
    fetchLimit: 15, fetchMode: 'recent', fetchRange: 'week', fetchSince: '', fetchUntil: '',
    syncStrategy: 'poll', pollIntervalSec: 60,
    imapHost: provider.imapHost, imapPort: provider.imapPort, imapSecure: provider.imapSecure,
    smtpHost: provider.smtpHost, smtpPort: provider.smtpPort, smtpSecure: provider.smtpSecure,
    ...mailbox,
    ...tagged,
    writeBack: normalizeMailboxWriteBack(mailbox.writeBack),
  };
}

export function readSettings() {
  const stored = readRawSettings();
  const userId = getRequestUserId();
  const legacyMailboxes = stored.mailboxes?.length ? stored.mailboxes.map(normalizeMailbox) : [normalizeMailbox({
    id: 'default', email: stored.email || '', authorizationCode: stored.authorizationCode || '',
    fetchLimit: stored.fetchLimit || 15, provider: stored.provider || 'qq',
  })];
  const mailboxes = mailboxesForUser(legacyMailboxes, userId);
  const userPref = userId && stored.userPrefs?.[userId] ? normalizeUserPref(stored.userPrefs[userId]) : null;
  const explicitMailboxId = getRequestContext().mailboxId;
  if (explicitMailboxId !== undefined && !mailboxes.some(box => box.id === explicitMailboxId && (!userId || mailboxOwnerId(box) === userId))) {
    throw Object.assign(new Error('Mailbox does not belong to this owner'), { status: 403, code: 'STORAGE_MAILBOX_FORBIDDEN' });
  }
  const preferredActive = explicitMailboxId ?? (userPref?.activeMailboxId || stored.activeMailboxId);
  const activeMailboxId = mailboxes.some((mailbox) => mailbox.id === preferredActive)
    ? preferredActive
    : mailboxes[0].id;
  const current = mailboxes.find((mailbox) => mailbox.id === activeMailboxId);
  const source = userPref ? { ...stored, ...userPref } : stored;
  const calendarCategories = normalizeCalendarCategories(
    source.calendarCategories?.length ? source.calendarCategories : DEFAULT_CALENDAR_CATEGORIES,
  );
  const mailFilters = ensureMailFilters(
    Object.prototype.hasOwnProperty.call(source, 'mailFilters') && source.mailFilters != null
      ? source.mailFilters
      : DEFAULT_MAIL_FILTERS,
  );
  const merged = {
    tokenPriceIn: null, tokenPriceOut: null, tokenPriceCachedIn: null, ...stored, ...current, ...userPref,
    mailboxes, activeMailboxId, calendarCategories, mailFilters,
    calendarSync: userId ? stored.userPrefs?.[userId]?.calendarSync || stored.calendarSync || {oauthApps:{},connections:[]} : stored.calendarSync,
    invitationPreferences: normalizeInvitationPreferences(source.invitationPreferences),
    userPrefs: stored.userPrefs || {},
    modelScope: userPref ? 'user' : 'shared',
    prefsUserId: userId || null,
  };
  // 用户偏好里空的 apiKey 不要盖掉共享演示 Key
  if (userPref && !merged.apiKey && stored.apiKey) merged.apiKey = stored.apiKey;
  if (userPref && !merged.baseUrl && stored.baseUrl) merged.baseUrl = stored.baseUrl;
  if (userPref && !merged.model && stored.model) merged.model = stored.model;
  return merged;
}

export function saveSettings(settings, { registerMailboxIds = [] } = {}) {
  const stored = readRawSettings();
  const userId = getRequestUserId();
  const {
    baseUrl, apiKey, model, tokenPriceIn, tokenPriceOut, tokenPriceCachedIn, activeMailboxId, mailboxes,
    calendarCategories, mailFilters, invitationPreferences, feishu,
    ragEnabled, ragEmbeddings, embeddingModel,
  } = settings;

  // A placeholder is not an owned mailbox until the mailbox settings form saves
  // that exact profile. Other preferences can be saved without registering it.
  const register = new Set(registerMailboxIds);
  const incomingMailboxes = (mailboxes || []).map(normalizeMailbox)
    .filter(box => box.pendingSetup !== true || register.has(box.id))
    .map(({ pendingSetup, ...box }) => box);
  if (usesStorageSnapshot() && userId) {
    const others = new Set((stored.mailboxes || []).filter(box => mailboxOwnerId(box) !== userId).map(box => box.id));
    if (incomingMailboxes.some(box => others.has(box.id))) {
      throw Object.assign(new Error('Mailbox id belongs to another owner'), { status: 403, code: 'STORAGE_MAILBOX_FORBIDDEN' });
    }
  }
  let nextMailboxes;
  if (userId) {
    const others = (stored.mailboxes || [])
      .map(normalizeMailbox)
      .filter((mailbox) => mailboxOwnerId(mailbox) !== userId);
    const owned = incomingMailboxes.map((mailbox) => ({ ...mailbox, ownerUserId: userId }));
    nextMailboxes = [...others, ...owned];
  } else {
    nextMailboxes = incomingMailboxes.length ? incomingMailboxes : (stored.mailboxes || []);
  }

  const shared = {
    ...stored,
    activeMailboxId: userId ? stored.activeMailboxId : activeMailboxId,
    mailboxes: nextMailboxes,
    ...(feishu ? { feishu } : (stored.feishu ? { feishu: stored.feishu } : {})),
    ragEnabled: ragEnabled === undefined ? (stored.ragEnabled !== false) : Boolean(ragEnabled),
    // 向量检索默认开启：模型可自动发现，挑不到就退回关键词，不需要用户先手动打开开关。
    ragEmbeddings: ragEmbeddings === undefined ? (stored.ragEmbeddings !== false) : Boolean(ragEmbeddings),
    embeddingModel: embeddingModel === undefined
      ? (stored.embeddingModel || '')
      : String(embeddingModel || '').trim(),
  };

  const modelFields = {
    baseUrl, apiKey, model, tokenPriceIn, tokenPriceOut, tokenPriceCachedIn,
    calendarCategories: normalizeCalendarCategories(calendarCategories),
    mailFilters: normalizeMailFilters(mailFilters),
    invitationPreferences: normalizeInvitationPreferences(invitationPreferences),
  };

  let payload;
  if (userId) {
    const prevPref = normalizeUserPref(stored.userPrefs?.[userId] || {});
    const nextPref = {
      ...prevPref,
      ...modelFields,
      apiKey: apiKey || prevPref.apiKey || '',
      activeMailboxId: activeMailboxId || prevPref.activeMailboxId || null,
    };
    payload = {
      ...shared,
      baseUrl: stored.baseUrl,
      apiKey: stored.apiKey,
      model: stored.model,
      tokenPriceIn: stored.tokenPriceIn ?? null,
      tokenPriceOut: stored.tokenPriceOut ?? null,
      tokenPriceCachedIn: stored.tokenPriceCachedIn ?? null,
      calendarCategories: stored.calendarCategories,
      mailFilters: stored.mailFilters,
      invitationPreferences: stored.invitationPreferences,
      userPrefs: {
        ...(stored.userPrefs || {}),
        [userId]: nextPref,
      },
    };
  } else {
    payload = {
      ...shared,
      ...modelFields,
      userPrefs: stored.userPrefs || {},
    };
  }

  if (usesStorageSnapshot()) {
    const knownIds = new Set((stored.mailboxes || []).map(box => box.id));
    registerSnapshotMailboxes(incomingMailboxes.filter(box => !knownIds.has(box.id)).map(box => box.id));
    stageSnapshotDocument(settingsKey('default'), payload);
  }
  else write('settings', payload);
}

// The existing mailbox keeps its original files. New accounts start with empty data.
export function mailboxDirectory(mailboxId = readSettings().activeMailboxId) {
  return mailboxId === 'default' ? directory : path.join(directory, 'mailboxes', mailboxId);
}

export function readStore(mailboxId = readSettings().activeMailboxId) {
  if (usesStorageSnapshot()) return { tasks: [], ...readSnapshotDocument(calendarKey(mailboxId)) };
  return { tasks: [], ...read('calendar', mailboxId === 'default' ? seed() : { events: [], emails: [], tasks: [], lastSync: null }, mailboxDirectory(mailboxId)) };
}

export function saveStore(data, mailboxId = readSettings().activeMailboxId) {
  const payload = { ...data, updatedAt: new Date().toISOString() };
  if (usesStorageSnapshot()) stageSnapshotDocument(calendarKey(mailboxId), payload);
  else write('calendar', payload, mailboxDirectory(mailboxId));
}

/**
 * 就地更新一封已存邮件（写回真邮箱后同步本地镜像：已读/星标/所在文件夹）。
 * 找不到这封邮件时返回 null——调用方必须当成失败处理，不能凭空新建记录。
 */
export function updateStoredEmail(mailboxId, id, patch) {
  const data = readStore(mailboxId);
  const index = (data.emails || []).findIndex((email) => email.id === id);
  if (index < 0) return null;
  const current = data.emails[index];
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  if (!next || next === current) return current;
  data.emails[index] = next;
  saveStore(data, mailboxId);
  return next;
}

/** 外部日历 OAuth / CalDAV 连接（写在 settings.json，不经 userPrefs 裁剪）。 */
export function readCalendarSync() {
  const stored=readRawSettings(), userId=getRequestUserId();
  if(userId) return stored.userPrefs?.[userId]?.calendarSync || stored.calendarSync || {oauthApps:{},connections:[]};
  return stored.calendarSync || { oauthApps: {}, connections: [] };
}

export function saveCalendarSync(calendarSync) {
  const stored = readRawSettings();
  const userId=getRequestUserId();
  const payload = userId ? {...stored,userPrefs:{...stored.userPrefs,[userId]:{...stored.userPrefs?.[userId],calendarSync}}} : { ...stored, calendarSync };
  if (usesStorageSnapshot()) stageSnapshotDocument(settingsKey('default'), payload);
  else write('settings', payload);
  return calendarSync;
}

export function calendarStorageInfo() {
  const status = storageStatus();
  const configured = usesStorageSnapshot();
  const connected = configured && status.connected;
  const primary = configured ? 'postgres' : 'json';
  return {
    primary,
    configured,
    connected,
    cache: configured ? 'snapshot' : 'json',
    note: configured ? 'PostgreSQL 快照读取；修改需显式提交，版本冲突拒绝覆盖，无文件回退。' : '本地 JSON 开发模式。',
  };
}

export async function hydrateStoreFromPostgres() {
  // Kept for legacy boot callers. Import/export belongs to the deployment migration task.
  return { ok: false, reason: isProductionRuntime() ? 'explicit-migration-required' : 'local-json-mode' };
}

function publicMailbox(mailbox) {
  const {
    id, provider, email, fetchLimit, fetchMode, fetchRange, fetchSince, fetchUntil,
    syncStrategy, pollIntervalSec, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure,
    tag, tagCustom, authorizationCode, writeBack,
  } = mailbox;
  const visible = {
    id, provider, email, fetchLimit, fetchMode, fetchRange, fetchSince, fetchUntil,
    syncStrategy, pollIntervalSec, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure,
    tag, tagCustom, tagLabel: mailboxTagLabel(mailbox),
    writeBack: normalizeMailboxWriteBack(writeBack),
  };
  return { ...visible, hasAuthorizationCode: Boolean(authorizationCode),
    mailboxReady: Boolean(mailbox.email && authorizationCode && mailbox.imapHost && mailbox.smtpHost) };
}

export function publicSettings(settings = readSettings()) {
  const { authorizationCode, apiKey, mailboxes, userPrefs, feishu, calendarSync, ...visible } = settings;
  const active = publicMailbox(
    settings.mailboxes?.find((mailbox) => mailbox.id === settings.activeMailboxId) || normalizeMailbox(settings),
  );
  const accountEmail = String(getRequestUser()?.email || '').trim().toLowerCase();
  const needsMailboxSetup = Boolean(getRequestUserId() && !active.mailboxReady && (accountEmail || active.email));
  return {
    ...visible,
    ...active,
    mailboxes: (mailboxes || [normalizeMailbox(settings)]).map(publicMailbox),
    mailboxProviders,
    modelProviders,
    fieldHelp: FIELD_HELP,
    mailboxTagOptions: MAILBOX_TAG_OPTIONS,
    fetchRangeOptions: FETCH_RANGE_OPTIONS,
    syncStrategyOptions: SYNC_STRATEGY_OPTIONS,
    accountEmail,
    needsMailboxSetup,
    feishu: {
      appId: feishu?.appId || '',
      ownerId: feishu?.ownerId || '',
      hasAppSecret: Boolean(feishu?.appSecret),
      configured: Boolean(feishu?.appId && feishu?.appSecret && feishu?.ownerId),
    },
    calendarCategories: normalizeCalendarCategories(settings.calendarCategories),
    mailFilters: normalizeMailFilters(settings.mailFilters),
    filterFieldOptions: FILTER_FIELDS,
    filterOpOptions: FILTER_OPS,
    modelScope: settings.modelScope || 'shared',
    prefsUserId: settings.prefsUserId || null,
    calendarStorage: calendarStorageInfo(),
    hasApiKey: Boolean(apiKey),
    modelReady: Boolean(settings.baseUrl && apiKey && settings.model),
    ragEnabled: settings.ragEnabled !== false,
    ragEmbeddings: settings.ragEmbeddings !== false,
    embeddingModel: settings.embeddingModel || '',
  };
}
