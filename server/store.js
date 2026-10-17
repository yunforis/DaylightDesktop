import { readSecureJson, writeSecureJson } from './secure-json.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mailboxProviders, modelProviders, FIELD_HELP } from './providers.js';
import { FETCH_RANGE_OPTIONS, SYNC_STRATEGY_OPTIONS } from './fetch-policy.js';
import {
  DEFAULT_CALENDAR_CATEGORIES, normalizeCalendarCategories,
} from './calendar-categories.js';
import {
  DEFAULT_MAIL_FILTERS, FILTER_FIELDS, FILTER_OPS, ensureMailFilters, normalizeMailFilters,
} from './mail-filters.js';
import { getRequestUserId } from './request-context.js';

export { mailboxProviders, modelProviders, FIELD_HELP, FETCH_RANGE_OPTIONS, SYNC_STRATEGY_OPTIONS };
export { DEFAULT_CALENDAR_CATEGORIES, normalizeCalendarCategories };
export { DEFAULT_MAIL_FILTERS, FILTER_FIELDS, FILTER_OPS, ensureMailFilters, normalizeMailFilters };

const USER_PREF_KEYS = [
  'baseUrl', 'apiKey', 'model', 'tokenPriceIn', 'tokenPriceOut', 'tokenPriceCachedIn',
  'calendarCategories', 'mailFilters',
];

function readRawSettings() {
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
  };
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(directory, { recursive: true });

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
  return name === 'settings' ? readSecureJson(filename) : JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function write(name, data, targetDirectory = directory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const filename = path.join(targetDirectory, `${name}.json`);
  if (name === 'settings') writeSecureJson(filename, data);
  else { fs.writeFileSync(`${filename}.tmp`, JSON.stringify(data, null, 2)); fs.renameSync(`${filename}.tmp`, filename); }
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
  };
}

export function readSettings() {
  const stored = readRawSettings();
  const mailboxes = stored.mailboxes?.length ? stored.mailboxes.map(normalizeMailbox) : [normalizeMailbox({
    id: 'default', email: stored.email || '', authorizationCode: stored.authorizationCode || '',
    fetchLimit: stored.fetchLimit || 15, provider: stored.provider || 'qq',
  })];
  const activeMailboxId = mailboxes.some((mailbox) => mailbox.id === stored.activeMailboxId) ? stored.activeMailboxId : mailboxes[0].id;
  const current = mailboxes.find((mailbox) => mailbox.id === activeMailboxId);
  const userId = getRequestUserId();
  const userPref = userId && stored.userPrefs?.[userId] ? normalizeUserPref(stored.userPrefs[userId]) : null;
  const source = userPref ? { ...stored, ...userPref } : stored;
  const calendarCategories = normalizeCalendarCategories(
    source.calendarCategories?.length ? source.calendarCategories : DEFAULT_CALENDAR_CATEGORIES,
  );
  const mailFilters = ensureMailFilters(
    Object.prototype.hasOwnProperty.call(source, 'mailFilters') && source.mailFilters != null
      ? source.mailFilters
      : DEFAULT_MAIL_FILTERS,
  );
  return {
    tokenPriceIn: null, tokenPriceOut: null, tokenPriceCachedIn: null, ...stored, ...current, ...userPref,
    mailboxes, activeMailboxId, calendarCategories, mailFilters,
    userPrefs: stored.userPrefs || {},
    modelScope: userPref ? 'user' : 'shared',
    prefsUserId: userId || null,
  };
}

export function saveSettings(settings) {
  const stored = readRawSettings();
  const userId = getRequestUserId();
  const {
    baseUrl, apiKey, model, tokenPriceIn, tokenPriceOut, tokenPriceCachedIn, activeMailboxId, mailboxes,
    calendarCategories, mailFilters, feishu,
  } = settings;

  const shared = {
    ...stored,
    activeMailboxId,
    mailboxes,
    ...(feishu ? { feishu } : (stored.feishu ? { feishu: stored.feishu } : {})),
  };

  const modelFields = {
    baseUrl, apiKey, model, tokenPriceIn, tokenPriceOut, tokenPriceCachedIn,
    calendarCategories: normalizeCalendarCategories(calendarCategories),
    mailFilters: normalizeMailFilters(mailFilters),
  };

  let payload;
  if (userId) {
    const prevPref = normalizeUserPref(stored.userPrefs?.[userId] || {});
    const nextPref = {
      ...prevPref,
      ...modelFields,
      apiKey: apiKey || prevPref.apiKey || '',
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

  write('settings', payload);
  import('./infra/calendar-pg.js').then(({ calendarPgEnabled, upsertAppSettings }) => {
    if (!calendarPgEnabled()) return;
    upsertAppSettings(payload).catch(() => {});
  }).catch(() => {});
}

// The existing mailbox keeps its original files. New accounts start with empty data.
export function mailboxDirectory(mailboxId = readSettings().activeMailboxId) {
  return mailboxId === 'default' ? directory : path.join(directory, 'mailboxes', mailboxId);
}

export function readStore(mailboxId = readSettings().activeMailboxId) {
  return { tasks: [], ...read('calendar', mailboxId === 'default' ? seed() : { events: [], emails: [], tasks: [], lastSync: null }, mailboxDirectory(mailboxId)) };
}

export function saveStore(data, mailboxId = readSettings().activeMailboxId) {
  const payload = { ...data, updatedAt: new Date().toISOString() };
  write('calendar', payload, mailboxDirectory(mailboxId));
  // 启用 PostgreSQL 时双写：库为权威副本，本地 JSON 作缓存与离线回退。
  import('./infra/calendar-pg.js').then(({ calendarPgEnabled, upsertMailboxCalendar }) => {
    if (!calendarPgEnabled()) return;
    upsertMailboxCalendar(mailboxId, payload).catch(() => {});
  }).catch(() => {});
}

/** 外部日历 OAuth / CalDAV 连接（写在 settings.json，不经 userPrefs 裁剪）。 */
export function readCalendarSync() {
  return readRawSettings().calendarSync || { oauthApps: {}, connections: [] };
}

export function saveCalendarSync(calendarSync) {
  const stored = readRawSettings();
  const payload = { ...stored, calendarSync };
  write('settings', payload);
  import('./infra/calendar-pg.js').then(({ calendarPgEnabled, upsertAppSettings }) => {
    if (!calendarPgEnabled()) return;
    upsertAppSettings(payload).catch(() => {});
  }).catch(() => {});
  return calendarSync;
}

export function calendarStorageInfo() {
  let configured = false;
  let connected = false;
  try {
    const infraPath = path.join(directory, 'infra.json');
    if (fs.existsSync(infraPath)) {
      const infra = readSecureJson(infraPath);
      configured = infra?.postgres?.enabled === true;
    }
  } catch { /* ignore */ }
  // 运行时是否真正连上池（enabled 但连不上时仍回退 JSON）
  try {
    // lazy require via dynamic path avoided; probe file flag from last boot note is enough for UI
    connected = configured;
  } catch { /* ignore */ }
  const primary = configured && connected ? 'postgres' : 'json';
  return {
    primary,
    configured,
    cache: 'json',
    note: primary === 'postgres'
      ? '默认已启用 PostgreSQL：日程/邮件/待办写入数据库，本地 JSON 为缓存与离线回退；启动时取较新一侧回填。连不上库时自动回退 JSON。'
      : (configured
        ? 'PostgreSQL 已配置但当前未连通，已回退本地 JSON；请检查本机数据库后重启服务。'
        : '当前使用本地 JSON。默认配置会尝试启用 PostgreSQL（连不上则自动回退）。'),
  };
}

export async function hydrateStoreFromPostgres(mailboxId = readSettings().activeMailboxId) {
  const {
    calendarPgEnabled, loadMailboxCalendar, upsertMailboxCalendar,
    loadAppSettings, upsertAppSettings,
  } = await import('./infra/calendar-pg.js');
  if (!calendarPgEnabled()) return { ok: false, reason: 'postgres-disabled' };

  const remoteSettings = await loadAppSettings();
  const settingsPath = path.join(directory, 'settings.json');
  let settingsSource = 'noop';
  if (remoteSettings && !fs.existsSync(settingsPath)) {
    write('settings', remoteSettings);
    settingsSource = 'postgres';
  } else if (fs.existsSync(settingsPath)) {
    await upsertAppSettings(read('settings', {}));
    settingsSource = 'local-migrated';
  }

  const id = mailboxId || readSettings().activeMailboxId;
  const remote = await loadMailboxCalendar(id);
  const localPath = path.join(mailboxDirectory(id), 'calendar.json');
  const hasLocal = fs.existsSync(localPath);
  const local = hasLocal ? readStore(id) : null;
  if (remote && (!hasLocal || isSparseCalendar(local) || isRemoteNewer(remote, local))) {
    write('calendar', remote, mailboxDirectory(id));
    return { ok: true, source: 'postgres', settingsSource };
  }
  if (hasLocal) {
    await upsertMailboxCalendar(id, readStore(id));
    return { ok: true, source: 'local-migrated', settingsSource };
  }
  return { ok: true, source: 'noop', settingsSource };
}

function isSparseCalendar(store) {
  return !(store.events?.length || store.emails?.length || store.tasks?.length);
}

function isRemoteNewer(remote, local) {
  const remoteAt = Date.parse(remote?.updatedAt || remote?.lastSync || 0) || 0;
  const localAt = Date.parse(local?.updatedAt || local?.lastSync || 0) || 0;
  return remoteAt > localAt;
}

function publicMailbox(mailbox) {
  const {
    id, provider, email, fetchLimit, fetchMode, fetchRange, fetchSince, fetchUntil,
    syncStrategy, pollIntervalSec, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure,
    tag, tagCustom, authorizationCode,
  } = mailbox;
  const visible = {
    id, provider, email, fetchLimit, fetchMode, fetchRange, fetchSince, fetchUntil,
    syncStrategy, pollIntervalSec, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure,
    tag, tagCustom, tagLabel: mailboxTagLabel(mailbox),
  };
  return { ...visible, hasAuthorizationCode: Boolean(authorizationCode),
    mailboxReady: Boolean(mailbox.email && authorizationCode && mailbox.imapHost && mailbox.smtpHost) };
}

export function publicSettings(settings = readSettings()) {
  const { authorizationCode, apiKey, mailboxes, userPrefs, feishu, calendarSync, ...visible } = settings;
  return { ...visible, ...publicMailbox(settings.mailboxes?.find((mailbox) => mailbox.id === settings.activeMailboxId) || normalizeMailbox(settings)),
    mailboxes: (mailboxes || [normalizeMailbox(settings)]).map(publicMailbox), mailboxProviders, modelProviders, fieldHelp: FIELD_HELP,
    mailboxTagOptions: MAILBOX_TAG_OPTIONS,
    fetchRangeOptions: FETCH_RANGE_OPTIONS, syncStrategyOptions: SYNC_STRATEGY_OPTIONS,
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
    hasApiKey: Boolean(apiKey), modelReady: Boolean(settings.baseUrl && apiKey && settings.model) };
}
