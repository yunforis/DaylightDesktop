import { createCalendarOAuthState, consumeCalendarOAuthState } from './calendar-oauth-state.js';
import { runWithRequestContext } from './request-context.js';
import { findUserById } from './infra/postgres.js';
/**
 * Push Daylight events to Google Calendar / Microsoft Outlook / CalDAV (iCloud 等).
 * Browser (Mac/iOS Safari) 通过本服务的 OAuth / CalDAV 写远端；本地 JSON/PG 仍是权威副本。
 */
import { randomUUID } from 'node:crypto';
import { readCalendarSync, saveCalendarSync, readSettings, readStore, saveStore } from './store.js';
import { usesStorageSnapshot, readSnapshotDocument, stageSnapshotDocument, settingsKey, mutateSnapshot } from './storage/index.js';
import { getRequestUserId } from './request-context.js';
import { counter, timer } from './metrics.js';

export const externalSyncKey = mailboxId => settingsKey(`external-sync:${mailboxId}`);

/** Stage only: the surrounding business storage commit owns durability. */
function stageExternalSync(jobs, mailboxId = readSettings().activeMailboxId) {
  const ownerId = getRequestUserId();
  const settings = readSettings();
  if (!ownerId || !settings.mailboxes.some(box => box.id === mailboxId && (box.ownerUserId || box.userId) === ownerId)) {
    throw Object.assign(new Error('External calendar mailbox owner required'), { status: 403 });
  }
  const key = externalSyncKey(mailboxId);
  const document = readSnapshotDocument(key);
  for (const job of jobs) document.intents.push({
    id: job.id || randomUUID(), ownerId, mailboxId, action: job.action,
    event: structuredClone(job.event), status: 'pending', queuedAt: new Date().toISOString(),
    connectionIds: (readSyncConfig().connections || []).filter(item => item.enabled !== false).map(item => item.id),
  });
  stageSnapshotDocument(key, document);
  return jobs.length;
}

// Only fields actually published to providers participate. Receipt IDs, tracing,
// workbench links and timestamps never generate a reverse synchronization intent.
const publishedEvent = event => JSON.stringify([
  event.title || '', event.start, event.end, Boolean(event.allDay),
  event.location || '', event.description || '', event.status === 'cancelled',
]);

/** Explicit business writer, not a global saveStore hook. Worker receipts keep
 * using raw saveStore. Staging and calendar writes roll back together on error.
 */
export function saveCalendarWithExternalSync(store, mailboxId = readSettings().activeMailboxId) {
  if (!usesStorageSnapshot()) return saveStore(store, mailboxId);
  return mutateSnapshot(() => {
    const previous = readStore(mailboxId);
    const before = new Map((previous.events || []).map(event => [event.id, event]));
    const after = new Map((store.events || []).map(event => [event.id, event]));
    for (const [id, event] of after) {
      const old = before.get(id);
      // Business payloads cannot erase provider receipts from the authoritative snapshot.
      if (old?.externalIds) event.externalIds = { ...event.externalIds, ...old.externalIds };
      if (old && publishedEvent(old) === publishedEvent(event)) continue;
      if (event.status === 'cancelled') {
        if (old && old.status !== 'cancelled') queueExternalSync(store, { ...event, externalIds: old.externalIds || event.externalIds }, 'delete', { mailboxId });
      } else queueExternalSync(store, event, old ? 'update' : 'create', { mailboxId });
    }
    for (const [id, event] of before) {
      if (!after.has(id) && event.status !== 'cancelled') queueExternalSync(store, event, 'delete', { mailboxId });
    }
    return saveStore(store, mailboxId);
  });
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars';
const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_GRAPH = 'https://graph.microsoft.com/v1.0';

export const CALENDAR_PROVIDERS = [
  { id: 'google', name: 'Google 日历', kind: 'oauth', hint: '适合 Gmail / Google Workspace；Mac 与 iOS 浏览器均可授权。' },
  { id: 'microsoft', name: 'Outlook / Microsoft 365', kind: 'oauth', hint: '适合 Outlook.com 与企业 Microsoft 365。' },
  { id: 'icloud', name: 'Apple iCloud（CalDAV）', kind: 'caldav', hint: '用 Apple ID + App 专用密码；可在 Mac「日历」与 iOS 同步。' },
  { id: 'caldav', name: '通用 CalDAV', kind: 'caldav', hint: 'Fastmail、Nextcloud、Zoho、自建 CalDAV 等。' },
];

function readSyncConfig() {
  return readCalendarSync() || { oauthApps: {}, connections: [] };
}

function writeSyncConfig(patch) {
  const current = readSyncConfig();
  return saveCalendarSync({
    oauthApps: { ...current.oauthApps, ...(patch.oauthApps || {}) },
    connections: patch.connections !== undefined ? patch.connections : current.connections,
    publicBaseUrl: patch.publicBaseUrl !== undefined ? patch.publicBaseUrl : current.publicBaseUrl,
    requireConfirm: patch.requireConfirm !== undefined ? Boolean(patch.requireConfirm) : Boolean(current.requireConfirm),
    pendingExternalSync: patch.pendingExternalSync !== undefined ? patch.pendingExternalSync : (current.pendingExternalSync || []),
  });
}

export function publicCalendarSync(settings = readSettings()) {
  const sync = readSyncConfig(settings);
  return {
    providers: CALENDAR_PROVIDERS,
    requireConfirm: Boolean(sync.requireConfirm),
    pendingExternalSync: (sync.pendingExternalSync || [])
      .filter(item => !usesStorageSnapshot() || item.mailboxId === readSettings().activeMailboxId).map((item) => ({
      id: item.id,
      action: item.action,
      eventId: item.eventId,
      title: item.title || '',
      start: item.start || '',
      end: item.end || '',
      queuedAt: item.queuedAt,
      mailboxId: item.mailboxId,
    })),
    oauthApps: {
      google: { clientId: sync.oauthApps?.google?.clientId || '', hasClientSecret: Boolean(sync.oauthApps?.google?.clientSecret) },
      microsoft: { clientId: sync.oauthApps?.microsoft?.clientId || '', hasClientSecret: Boolean(sync.oauthApps?.microsoft?.clientSecret) },
    },
    connections: (sync.connections || []).map((item) => ({
      id: item.id,
      provider: item.provider,
      label: item.label || item.accountEmail || item.username || item.provider,
      enabled: item.enabled !== false,
      accountEmail: item.accountEmail || '',
      calendarId: item.calendarId || 'primary',
      caldavUrl: item.caldavUrl || '',
      username: item.username || '',
      hasPassword: Boolean(item.password),
      hasTokens: Boolean(item.refreshToken || item.accessToken),
      lastError: item.lastError || '',
      lastSyncAt: item.lastSyncAt || null,
    })),
    icsPath: '/api/calendar.ics',
  };
}

export function setExternalSyncRequireConfirm(enabled) {
  writeSyncConfig({ requireConfirm: Boolean(enabled) });
  return publicCalendarSync();
}

export function listPendingExternalSync() {
  return publicCalendarSync().pendingExternalSync;
}

export function saveCalendarOAuthApps(body = {}) {
  const sync = readSyncConfig();
  const google = { ...(sync.oauthApps?.google || {}) };
  const microsoft = { ...(sync.oauthApps?.microsoft || {}) };
  if (body.google) {
    if (body.google.clientId !== undefined) google.clientId = String(body.google.clientId || '').trim();
    if (body.google.clientSecret) google.clientSecret = String(body.google.clientSecret).trim();
  }
  if (body.microsoft) {
    if (body.microsoft.clientId !== undefined) microsoft.clientId = String(body.microsoft.clientId || '').trim();
    if (body.microsoft.clientSecret) microsoft.clientSecret = String(body.microsoft.clientSecret).trim();
  }
  return writeSyncConfig({ oauthApps: { google, microsoft } });
}

export function upsertCalendarConnection(body = {}) {
  const sync = readSyncConfig();
  const connections = [...(sync.connections || [])];
  const id = body.id || randomUUID();
  const index = connections.findIndex((item) => item.id === id);
  const prev = index >= 0 ? connections[index] : {};
  const next = {
    ...prev,
    id,
    provider: body.provider || prev.provider || 'caldav',
    label: String(body.label ?? prev.label ?? '').trim(),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : (prev.enabled !== false),
    calendarId: String(body.calendarId ?? prev.calendarId ?? 'primary').trim() || 'primary',
    caldavUrl: String(body.caldavUrl ?? prev.caldavUrl ?? '').trim(),
    username: String(body.username ?? prev.username ?? '').trim(),
    password: body.password ? String(body.password) : (prev.password || ''),
    accountEmail: prev.accountEmail || '',
    accessToken: prev.accessToken || '',
    refreshToken: prev.refreshToken || '',
    expiresAt: prev.expiresAt || 0,
    lastError: '',
  };
  if (index >= 0) connections[index] = next;
  else connections.push(next);
  writeSyncConfig({ connections });
  return publicCalendarSync();
}

export function removeCalendarConnection(id) {
  const sync = readSyncConfig();
  writeSyncConfig({ connections: (sync.connections || []).filter((item) => item.id !== id) });
  return publicCalendarSync();
}

function publicBaseUrl(req) {
  const settings = readSettings();
  const configured = settings.calendarSync?.publicBaseUrl
    || settings.systemMail?.publicBaseUrl
    || process.env.DAYLIGHT_PUBLIC_URL
    || '';
  if (configured) return configured.replace(/\/$/, '');
  if (req) {
    const host = req.get?.('x-forwarded-host') || req.get?.('host') || '127.0.0.1:3000';
    const proto = req.get?.('x-forwarded-proto') || 'http';
    return `${proto}://${host}`;
  }
  return 'http://127.0.0.1:3000';
}

export async function buildOAuthStartUrl(provider, req) {
  const sync = readSyncConfig();
  const redirectUri = `${publicBaseUrl(req)}/api/calendar-sync/oauth/callback`;
  const state = await createCalendarOAuthState(provider,redirectUri,req?.query?.client==='ios');
  if (provider === 'google') {
    const clientId = sync.oauthApps?.google?.clientId;
    if (!clientId) throw Object.assign(new Error('请先填写 Google OAuth Client ID'), { status: 400 });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
      state,
    });
    return { url: `${GOOGLE_AUTH}?${params}`, state, redirectUri };
  }
  if (provider === 'microsoft') {
    const clientId = sync.oauthApps?.microsoft?.clientId;
    if (!clientId) throw Object.assign(new Error('请先填写 Microsoft OAuth Client ID'), { status: 400 });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'offline_access Calendars.ReadWrite User.Read',
      state,
    });
    return { url: `${MS_AUTH}?${params}`, state, redirectUri };
  }
  throw Object.assign(new Error('不支持的 OAuth 提供商'), { status: 400 });
}

export async function completeOAuthCallback({ code, state, req }) {
  const parsed=await consumeCalendarOAuthState(state);
  const user=parsed.userId ? await findUserById(parsed.userId) : null;
  if(parsed.userId && !user) throw Object.assign(new Error('账号已失效，请重新登录后连接。'),{status:401});
  return runWithRequestContext({userId:parsed.userId,user},async()=> {
  const provider = parsed.provider;
  const redirectUri = parsed.redirectUri;
  const sync = readSyncConfig();
  let tokens;
  let accountEmail = '';
  if (provider === 'google') {
    const app = sync.oauthApps?.google || {};
    if (!app.clientId || !app.clientSecret) throw Object.assign(new Error('缺少 Google Client Secret'), { status: 400 });
    tokens = await exchangeToken(GOOGLE_TOKEN, {
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    accountEmail = await fetchGoogleEmail(tokens.access_token);
  } else if (provider === 'microsoft') {
    const app = sync.oauthApps?.microsoft || {};
    if (!app.clientId || !app.clientSecret) throw Object.assign(new Error('缺少 Microsoft Client Secret'), { status: 400 });
    tokens = await exchangeToken(MS_TOKEN, {
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    accountEmail = await fetchMicrosoftEmail(tokens.access_token);
  } else {
    throw Object.assign(new Error('未知 OAuth 提供商'), { status: 400 });
  }

  const connections = [...(sync.connections || [])];
  const existing = connections.find((item) => item.provider === provider && item.accountEmail === accountEmail);
  const connection = existing || {
    id: randomUUID(),
    provider,
    label: accountEmail || provider,
    enabled: true,
    calendarId: provider === 'google' ? 'primary' : '',
  };
  Object.assign(connection, {
    accountEmail,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing?.refreshToken || '',
    expiresAt: Date.now() + (Number(tokens.expires_in || 3600) * 1000),
    lastError: '',
    lastSyncAt: new Date().toISOString(),
  });
  if (!existing) connections.push(connection);
  writeSyncConfig({ connections });
  return {...connection,native:parsed.native};
  }).catch(error=>{error.nativeOAuth=parsed.native;throw error;});
}

async function exchangeToken(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || 'OAuth 换取令牌失败');
  return data;
}

async function fetchGoogleEmail(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  return data.email || '';
}

async function fetchMicrosoftEmail(accessToken) {
  const response = await fetch(`${MS_GRAPH}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  return data.mail || data.userPrincipalName || '';
}

async function ensureAccessToken(connection, signal) {
  if (connection.accessToken && connection.expiresAt && Date.now() < connection.expiresAt - 60_000) {
    return connection.accessToken;
  }
  if (!connection.refreshToken) return connection.accessToken;
  const sync = readSyncConfig();
  if (connection.provider === 'google') {
    const app = sync.oauthApps?.google || {};
    const tokens = await exchangeToken(GOOGLE_TOKEN, {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: 'refresh_token',
    }, signal);
    connection.accessToken = tokens.access_token;
    connection.expiresAt = Date.now() + (Number(tokens.expires_in || 3600) * 1000);
  } else if (connection.provider === 'microsoft') {
    const app = sync.oauthApps?.microsoft || {};
    const tokens = await exchangeToken(MS_TOKEN, {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access Calendars.ReadWrite User.Read',
    }, signal);
    connection.accessToken = tokens.access_token;
    if (tokens.refresh_token) connection.refreshToken = tokens.refresh_token;
    connection.expiresAt = Date.now() + (Number(tokens.expires_in || 3600) * 1000);
  }
  persistConnection(connection);
  return connection.accessToken;
}

function persistConnection(connection) {
  const sync = readSyncConfig();
  const connections = (sync.connections || []).map((item) => (item.id === connection.id ? { ...item, ...connection } : item));
  writeSyncConfig({ connections });
}

function toUtcBasic(iso) {
  const date = new Date(iso);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export function eventToIcs(event, { prodId = '-//Daylight//EN' } = {}) {
  const uid = event.id || randomUUID();
  const stamp = toUtcBasic(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@daylight`,
    `DTSTAMP:${stamp}`,
  ];
  if (event.allDay) {
    const startDay = String(event.start).slice(0, 10).replace(/-/g, '');
    const endDay = String(event.end).slice(0, 10).replace(/-/g, '');
    lines.push(`DTSTART;VALUE=DATE:${startDay}`, `DTEND;VALUE=DATE:${endDay}`);
  } else {
    lines.push(`DTSTART:${toUtcBasic(event.start)}`, `DTEND:${toUtcBasic(event.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.title || '日程')}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.status === 'cancelled') lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function storeToIcs(store) {
  const events = (store.events || []).filter((event) => event.status !== 'cancelled');
  const vevents = events.map((event) => {
    const full = eventToIcs(event);
    const start = full.indexOf('BEGIN:VEVENT');
    const end = full.indexOf('END:VEVENT');
    return full.slice(start, end + 'END:VEVENT'.length);
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Daylight//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Daylight',
    ...vevents, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

function googlePayload(event) {
  const payload = {
    summary: event.title || '日程',
    description: event.description || '',
    location: event.location || '',
    status: event.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
  if (event.allDay) {
    payload.start = { date: String(event.start).slice(0, 10) };
    payload.end = { date: String(event.end).slice(0, 10) };
  } else {
    payload.start = { dateTime: event.start, timeZone: 'Asia/Shanghai' };
    payload.end = { dateTime: event.end, timeZone: 'Asia/Shanghai' };
  }
  return payload;
}

function microsoftPayload(event) {
  const payload = {
    subject: event.title || '日程',
    body: { contentType: 'text', content: event.description || '' },
    location: { displayName: event.location || '' },
    isAllDay: Boolean(event.allDay),
  };
  if (event.allDay) {
    payload.start = { dateTime: `${String(event.start).slice(0, 10)}T00:00:00`, timeZone: 'China Standard Time' };
    payload.end = { dateTime: `${String(event.end).slice(0, 10)}T00:00:00`, timeZone: 'China Standard Time' };
  } else {
    payload.start = { dateTime: new Date(event.start).toISOString().replace(/Z$/, ''), timeZone: 'China Standard Time' };
    payload.end = { dateTime: new Date(event.end).toISOString().replace(/Z$/, ''), timeZone: 'China Standard Time' };
  }
  return payload;
}

async function pushGoogle(connection, event, action, { signal } = {}) {
  const token = await ensureAccessToken(connection, signal);
  const calendarId = encodeURIComponent(connection.calendarId || 'primary');
  const externalId = event.externalIds?.[connection.id];
  if (action === 'delete' || event.status === 'cancelled') {
    if (!externalId) return null;
    const response = await fetch(`${GOOGLE_EVENTS}/${calendarId}/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && ![404, 410].includes(response.status)) {
      const text = await response.text();
      throw new Error(`Google 删除失败：${text.slice(0, 200)}`);
    }
    return null;
  }
  if (externalId) {
    const response = await fetch(`${GOOGLE_EVENTS}/${calendarId}/events/${encodeURIComponent(externalId)}`, {
      method: 'PATCH',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(googlePayload(event)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Google 更新失败');
    return data.id || externalId;
  }
  const response = await fetch(`${GOOGLE_EVENTS}/${calendarId}/events`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(googlePayload(event)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Google 创建失败');
  return data.id;
}

async function pushMicrosoft(connection, event, action, { signal } = {}) {
  const token = await ensureAccessToken(connection, signal);
  const externalId = event.externalIds?.[connection.id];
  if (action === 'delete' || event.status === 'cancelled') {
    if (!externalId) return null;
    const response = await fetch(`${MS_GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`Outlook 删除失败：${text.slice(0, 200)}`);
    }
    return null;
  }
  if (externalId) {
    const response = await fetch(`${MS_GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'PATCH',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(microsoftPayload(event)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Outlook 更新失败');
    return data.id || externalId;
  }
  const response = await fetch(`${MS_GRAPH}/me/events`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(microsoftPayload(event)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Outlook 创建失败');
  return data.id;
}

function caldavHref(connection, event) {
  const base = (connection.caldavUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('请填写 CalDAV 日历 URL');
  const name = `${encodeURIComponent(event.id || randomUUID())}.ics`;
  return `${base}/${name}`;
}

async function pushCaldav(connection, event, action, { signal } = {}) {
  if (!connection.username || !connection.password) throw new Error('请填写 CalDAV 用户名与密码（iCloud 用 App 专用密码）');
  const href = event.externalIds?.[connection.id] || caldavHref(connection, event);
  const auth = Buffer.from(`${connection.username}:${connection.password}`).toString('base64');
  if (action === 'delete' || event.status === 'cancelled') {
    const response = await fetch(href, {
      method: 'DELETE',
      signal,
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CalDAV 删除失败：HTTP ${response.status}`);
    }
    return null;
  }
  const body = eventToIcs({ ...event, id: event.id });
  const response = await fetch(href, {
    method: 'PUT',
    signal,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/calendar; charset=utf-8',
      ...(event.externalIds?.[connection.id] ? {} : { 'If-None-Match': '*' }),
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CalDAV 写入失败：HTTP ${response.status} ${text.slice(0, 160)}`);
  }
  return href;
}

/** One target only. Caller checkpoints before calling and persists the receipt afterwards.
 * No database transaction may span this call; token changes are staged in its snapshot.
 */
export async function pushExternalCalendarTarget(connection, event, action, { signal } = {}) {
  const stop = timer('calendar.push.ms', { provider: connection.provider, action });
  let outcome = 'ok';
  try {
    signal?.throwIfAborted();
    if (!['google', 'microsoft', 'icloud', 'caldav'].includes(connection.provider)) {
      throw Object.assign(new Error('Unsupported calendar provider'), { retryable: false });
    }
    const push = connection.provider === 'google' ? pushGoogle : connection.provider === 'microsoft' ? pushMicrosoft : pushCaldav;
    const remoteId = await push(connection, event, action, { signal });
    signal?.throwIfAborted();
    const deleting = action === 'delete' || event.status === 'cancelled';
    if (!deleting && !remoteId) throw new Error('Calendar create returned no remote identity');
    return remoteId;
  } catch (error) {
    outcome = error?.retryable === false ? 'permanent' : 'retryable';
    throw error;
  } finally {
    stop({ outcome });
    counter('calendar.push_total', { provider: connection.provider, action, outcome });
  }
}

/** Read-only verification. Never follow a caller-supplied CalDAV URL outside
 * the configured collection, or redirect credentials to another endpoint. */
export async function verifyExternalCalendarIdentity(connection, remoteId, { signal } = {}) {
  if (typeof remoteId !== 'string' || !remoteId.trim() || remoteId.length > 2048 || /[\r\n]/.test(remoteId)) {
    throw Object.assign(new Error('Invalid remote calendar identity'), { code: 'CALENDAR_REMOTE_ID_INVALID', status: 400 });
  }
  let url, headers;
  if (connection.provider === 'google' || connection.provider === 'microsoft') {
    const token = await ensureAccessToken(connection, signal);
    url = connection.provider === 'google'
      ? `${GOOGLE_EVENTS}/${encodeURIComponent(connection.calendarId || 'primary')}/events/${encodeURIComponent(remoteId)}`
      : `${MS_GRAPH}/me/events/${encodeURIComponent(remoteId)}`;
    headers = { Authorization: `Bearer ${token}` };
  } else if (['caldav', 'icloud'].includes(connection.provider)) {
    const base = new URL(`${(connection.caldavUrl || '').replace(/\/$/, '')}/`);
    const candidate = new URL(remoteId);
    if (candidate.origin !== base.origin || !candidate.pathname.startsWith(base.pathname)
      || candidate.username || candidate.password || candidate.search || candidate.hash) {
      throw Object.assign(new Error('Remote identity is outside the configured calendar'), { code: 'CALENDAR_REMOTE_ID_INVALID', status: 400 });
    }
    url = candidate.href;
    headers = { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}` };
  } else throw new Error('Unsupported calendar provider');
  const response = await fetch(url, { method: 'GET', headers, signal, redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('Remote calendar identity could not be verified'), { code: 'CALENDAR_VERIFICATION_FAILED', status: 409 });
  if (['google', 'microsoft'].includes(connection.provider)) {
    const body = await response.json();
    if (body.id !== remoteId || body.status === 'cancelled' || body.isCancelled) {
      throw Object.assign(new Error('Remote calendar identity mismatch or cancelled'), { code: 'CALENDAR_VERIFICATION_FAILED', status: 409 });
    }
  } else if (!(await response.text()).includes('BEGIN:VEVENT')) {
    throw Object.assign(new Error('Remote resource is not a calendar event'), { code: 'CALENDAR_VERIFICATION_FAILED', status: 409 });
  }
  return remoteId;
}

/**
 * @param {'create'|'update'|'delete'} action
 * @returns {Promise<{ results: Array, event: object }>}
 */
export async function syncEventExternal(event, action = 'create') {
  const sync = readSyncConfig();
  const connections = (sync.connections || []).filter((item) => item.enabled !== false);
  if (!connections.length) return { results: [], event };
  const externalIds = { ...(event.externalIds || {}) };
  const results = [];
  for (const connection of connections) {
    try {
      let remoteId = null;
      if (connection.provider === 'google') remoteId = await pushGoogle(connection, { ...event, externalIds }, action);
      else if (connection.provider === 'microsoft') remoteId = await pushMicrosoft(connection, { ...event, externalIds }, action);
      else if (connection.provider === 'icloud' || connection.provider === 'caldav') {
        remoteId = await pushCaldav(connection, { ...event, externalIds }, action);
      } else {
        continue;
      }
      if (remoteId) externalIds[connection.id] = remoteId;
      else delete externalIds[connection.id];
      connection.lastError = '';
      connection.lastSyncAt = new Date().toISOString();
      persistConnection(connection);
      results.push({ connectionId: connection.id, provider: connection.provider, ok: true, remoteId });
    } catch (error) {
      connection.lastError = error.message || String(error);
      persistConnection(connection);
      results.push({ connectionId: connection.id, provider: connection.provider, ok: false, error: connection.lastError });
    }
  }
  return { results, event: { ...event, externalIds } };
}

function runExternalSyncJobs(store, jobs, { save } = {}) {
  Promise.resolve().then(async () => {
    for (const job of jobs) {
      const event = job.event || store.events?.find((item) => item.id === job.eventId) || job;
      if (!event?.id && job.action !== 'delete') continue;
      const payload = job.action === 'delete'
        ? { ...(event || {}), id: job.eventId, externalIds: job.externalIds || event?.externalIds }
        : event;
      const { event: next, results } = await syncEventExternal(payload, job.action);
      if (!save || !next?.id) continue;
      const current = store.events?.find((item) => item.id === next.id);
      if (current) {
        current.externalIds = next.externalIds;
        current.externalSync = {
          at: new Date().toISOString(),
          results: results.map(({ provider, ok, error }) => ({ provider, ok, error })),
        };
      }
    }
    if (typeof save === 'function') save();
  }).catch(() => {});
}

/** After local save: either push immediately, or enqueue for user confirmation when requireConfirm. */
export function queueExternalSync(store, events, action, { save, force = false, mailboxId = readSettings().activeMailboxId } = {}) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  const sync = readSyncConfig();
  if (!list.length || !(sync.connections || []).some((item) => item.enabled !== false)) return;
  if (sync.requireConfirm && !force) {
    const pending = [...(sync.pendingExternalSync || [])];
    for (const event of list) {
      pending.push({
        id: randomUUID(),
        action,
        eventId: event.id,
        title: event.title || '',
        start: event.start || '',
        end: event.end || '',
        externalIds: event.externalIds || {},
        queuedAt: new Date().toISOString(),
        mailboxId: usesStorageSnapshot() ? mailboxId : undefined,
        event: usesStorageSnapshot() ? structuredClone(event) : undefined,
      });
    }
    writeSyncConfig({ pendingExternalSync: pending });
    return { queued: pending.length, requireConfirm: true };
  }
  if (usesStorageSnapshot()) {
    const queued = stageExternalSync(list.map(event => ({ event, action })), mailboxId);
    return { queued, requireConfirm: false, durable: true };
  }
  runExternalSyncJobs(store, list.map((event) => ({ event, action, eventId: event.id })), { save });
  return { queued: 0, requireConfirm: false };
}

export function confirmPendingExternalSync(store, { ids, all = false, save } = {}) {
  if (usesStorageSnapshot()) return mutateSnapshot(() => confirmPendingExternalSyncMutation(store, { ids, all, save }));
  return confirmPendingExternalSyncMutation(store, { ids, all, save });
}

function confirmPendingExternalSyncMutation(store, { ids, all = false, save } = {}) {
  const sync = readSyncConfig();
  const pending = sync.pendingExternalSync || [];
  const mailboxId = usesStorageSnapshot() ? readSettings().activeMailboxId : null;
  const selected = pending.filter(item => (!mailboxId || item.mailboxId === mailboxId)
    && (all || (ids || []).includes(item.id)));
  if (!selected.length) return { confirmed: 0, pending: pending.length };
  const remain = pending.filter((item) => !selected.some((pick) => pick.id === item.id));
  writeSyncConfig({ pendingExternalSync: remain });
  const jobs = selected.map((item) => ({
    action: item.action,
    eventId: item.eventId,
    externalIds: item.externalIds,
    event: store.events?.find((event) => event.id === item.eventId) || {
      id: item.eventId,
      title: item.title,
      start: item.start,
      end: item.end,
      externalIds: item.externalIds,
    },
  }));
  if (usesStorageSnapshot()) stageExternalSync(jobs.map((job, index) => ({ ...job, id: selected[index].id,
    event: job.action === 'delete' ? (selected[index].event || job.event) : job.event })));
  else runExternalSyncJobs(store, jobs, { save });
  return { confirmed: selected.length, pending: remain.length };
}

export function dismissPendingExternalSync({ ids, all = false } = {}) {
  const sync = readSyncConfig();
  const pending = sync.pendingExternalSync || [];
  const mailboxId = usesStorageSnapshot() ? readSettings().activeMailboxId : null;
  const remain = pending.filter(item => (mailboxId && item.mailboxId !== mailboxId) || (!all && !(ids || []).includes(item.id)));
  writeSyncConfig({ pendingExternalSync: remain });
  return { dismissed: pending.length - remain.length, pending: remain.length };
}
