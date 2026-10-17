/** Explicit, offline-source migration. Never imports from files during application boot. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(`Production data migration refused (${code})`), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clouds = new Set(['aliyun', 'us3', 's3', 'qiniu', 'upyun']);
const idPattern = /^[A-Za-z0-9_-]+$/;
const emptyCalendar = () => ({ events: [], emails: [], tasks: [], lastSync: null });
const emptyRecruitment = () => ({ candidates: [], attachments: [], messages: [], interviews: [], traces: [] });

function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || /[\x00-\x1f\x7f?#%]/.test(relative) || /^[a-z]:/i.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH');
  return relative;
}

async function safeFile(root, relative) {
  const parts = safeRelative(relative).split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail('UNSAFE_PATH');
  }
  const resolved = await fs.realpath(current);
  if (!resolved.startsWith(`${root}${path.sep}`)) fail('UNSAFE_PATH');
  return resolved;
}

async function inventory(source) {
  const absolute = path.resolve(source);
  if ((await fs.lstat(absolute)).isSymbolicLink()) fail('UNSAFE_SOURCE');
  const root = await fs.realpath(absolute);
  if (!(await fs.stat(root)).isDirectory()) fail('UNSAFE_SOURCE');
  const files = new Map(), directories = new Set();
  async function walk(relative = '') {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      // Runtime artifacts may contain JSON secrets but never leave this process.
      if (entry.isSymbolicLink()) fail('SYMLINK_SOURCE');
      if (entry.name.endsWith('.postgres')) fail('POSTGRES_AUTHORITY_SOURCE');
      if (entry.isDirectory()) { directories.add(name); await walk(name); }
      else if (entry.isFile()) {
        const file = await safeFile(root, name);
        const bytes = await fs.readFile(file);
        files.set(name, { size: bytes.length, sha256: sha(bytes) });
      } else fail('UNSUPPORTED_SOURCE_ENTRY');
    }
  }
  await walk();
  const digest = sha([...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([relative, info]) => `${sha(relative)}:${info.size}:${info.sha256}`).join('\n'));
  return { root, files, directories, digest };
}

function iso(value, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const time = new Date(value);
  if (!value || !Number.isFinite(time.getTime())) fail('INVALID_TIMESTAMP');
  return time.toISOString();
}

function normalizeUser(user) {
  const allowed = ['id', 'email', 'username', 'password_hash', 'role', 'workspace_mode', 'workspace_mode_changes',
    'last_login_at', 'session_version', 'created_at', 'updated_at'];
  if (!object(user) || Object.keys(user).some(key => !allowed.includes(key))) fail('UNSUPPORTED_USER_FIELDS');
  for (const key of ['id', 'email', 'username', 'password_hash']) if (typeof user[key] !== 'string' || !user[key]) fail('INVALID_USER');
  const epoch = user.session_version ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Array.isArray(user.workspace_mode_changes ?? [])) fail('INVALID_USER');
  return { id: user.id, email: user.email, username: user.username, password_hash: user.password_hash,
    role: user.role ?? 'user', workspace_mode: user.workspace_mode ?? 'personal',
    workspace_mode_changes: user.workspace_mode_changes ?? [], last_login_at: iso(user.last_login_at, true),
    session_version: epoch, created_at: iso(user.created_at), updated_at: iso(user.updated_at) };
}

function normalizeChunk(chunk, mailboxId, fallbackTime) {
  if (!object(chunk)) fail('INVALID_RAG');
  const row = { id: chunk.id, mailbox_id: chunk.mailbox_id ?? chunk.mailboxId ?? mailboxId,
    owner_user_id: chunk.owner_user_id ?? chunk.ownerUserId ?? null,
    candidate_id: chunk.candidate_id ?? chunk.candidateId ?? null,
    attachment_id: chunk.attachment_id ?? chunk.attachmentId, filename: chunk.filename ?? '',
    page: chunk.page ?? 1, chunk_index: chunk.chunk_index ?? chunk.chunkIndex ?? 0,
    content: chunk.content, embedding: chunk.embedding ?? null,
    updated_at: iso(chunk.updated_at ?? chunk.updatedAt ?? fallbackTime) };
  if (row.mailbox_id !== mailboxId || !row.id || !row.attachment_id || typeof row.content !== 'string'
    || !Number.isSafeInteger(row.page) || !Number.isSafeInteger(row.chunk_index)) fail('INVALID_RAG');
  return row;
}

function visit(value, action, parent = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) visit(item, action, parent); return; }
  action(value, parent);
  for (const [key, item] of Object.entries(value)) visit(item, action, key);
}

/** Collects every supported local business store without opening a database or network. */
export async function collectProductionData(source) {
  const sourceInventory = await inventory(source);
  const { root, files, directories } = sourceInventory;
  const consumed = new Set();
  async function json(relative, fallback, required = false) {
    if (!files.has(relative)) {
      if (required) fail('MISSING_REQUIRED_SOURCE');
      return structuredClone(fallback);
    }
    consumed.add(relative);
    const bytes = await fs.readFile(await safeFile(root, relative));
    if (sha(bytes) !== files.get(relative).sha256) fail('SOURCE_CHANGED');
    try { return JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_SOURCE_JSON'); }
  }
  const settings = await json('settings.json', null, true);
  const userFile = await json('users.json', { users: [], resets: [] });
  if (!object(settings) || !object(userFile) || !Array.isArray(userFile.users) || !Array.isArray(userFile.resets ?? [])) fail('INVALID_SOURCE_SHAPE');
  const users = userFile.users.map(normalizeUser);
  const userIds = new Set(users.map(user => user.id));
  if (users.length !== userIds.size || new Set(users.map(user => user.email.toLowerCase())).size !== users.length
    || new Set(users.map(user => user.username.toLowerCase())).size !== users.length) fail('DUPLICATE_USER');
  const resets = (userFile.resets || []).map(reset => {
    if (!object(reset) || Object.keys(reset).some(key => !['token', 'user_id', 'expires_at', 'used_at'].includes(key))
      || typeof reset.token !== 'string' || !reset.token || !userIds.has(reset.user_id)) fail('INVALID_PASSWORD_RESET');
    return { token: reset.token, user_id: reset.user_id, expires_at: iso(reset.expires_at), used_at: iso(reset.used_at, true) };
  });
  if (new Set(resets.map(reset => reset.token)).size !== resets.length) fail('DUPLICATE_PASSWORD_RESET');
  const mailboxMap = new Map();
  for (const mailbox of settings.mailboxes ?? [{ id: 'default' }]) {
    if (!object(mailbox) || !idPattern.test(mailbox.id) || mailboxMap.has(mailbox.id)) fail('INVALID_MAILBOX');
    if (mailbox.ownerUserId && mailbox.userId && mailbox.ownerUserId !== mailbox.userId) fail('AMBIGUOUS_MAILBOX_OWNER');
    const owner = mailbox.ownerUserId || mailbox.userId || null;
    if (owner !== null && typeof owner !== 'string') fail('INVALID_MAILBOX_OWNER');
    mailboxMap.set(mailbox.id, { id: mailbox.id, owner, orphan: false });
  }
  if (!mailboxMap.has('default') && [...files].some(([name]) => /^(calendar|recruitment|traces|rag-chunks|assistant-[^/]+)\.json$/.test(name))) {
    mailboxMap.set('default', { id: 'default', owner: null, orphan: true });
  }
  for (const directory of directories) {
    const match = /^mailboxes\/([^/]+)$/.exec(directory);
    if (!match) continue;
    if (!idPattern.test(match[1]) || match[1] === 'default') fail('AMBIGUOUS_MAILBOX_DIRECTORY');
    if (!mailboxMap.has(match[1])) mailboxMap.set(match[1], { id: match[1], owner: null, orphan: true });
  }
  const documents = [], chunks = [];
  const add = (id, payload, mailboxId = null, table = 'app_settings') => {
    if (payload === null || typeof payload !== 'object') fail('INVALID_DOCUMENT');
    if (documents.some(doc => doc.id === id && doc.table === table)) fail('DUPLICATE_DOCUMENT');
    documents.push({ table, id, payload, mailboxId });
  };
  add('default', settings);
  for (const name of ['prompts', 'report-prompts', 'mail-templates']) add(name, await json(`${name}.json`, {}));
  if (files.has('onboarding-guide.json')) add('onboarding-guide', await json('onboarding-guide.json'));
  const mailboxes = [...mailboxMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const mailbox of mailboxes) {
    const prefix = mailbox.id === 'default' ? '' : `mailboxes/${mailbox.id}/`;
    add(mailbox.id, await json(`${prefix}calendar.json`, emptyCalendar()), mailbox.id, 'mailbox_calendars');
    add(`traces:${mailbox.id}`, await json(`${prefix}traces.json`, []), mailbox.id);
    add(`recruitment:${mailbox.id}`, await json(`${prefix}recruitment.json`, emptyRecruitment()), mailbox.id);
    add(`external-sync:${mailbox.id}`, await json(`${prefix}external-sync.json`, { intents: [], targets: {} }), mailbox.id);
    for (const namespace of ['drafts', 'requests', 'recruitment-effects', 'meetings']) {
      const file = `${prefix}assistant-${namespace}.json`;
      if (!files.has(file)) continue;
      const identity = sha(`${mailbox.owner || 'local'}\0${mailbox.id}`);
      add(namespace === 'meetings' ? `assistant-meetings:${mailbox.id}` : `assistant:${namespace}:${identity}`,
        await json(file), mailbox.id);
    }
    const rag = await json(`${prefix}rag-chunks.json`, { chunks: [] });
    if (!object(rag) || !Array.isArray(rag.chunks)) fail('INVALID_RAG');
    for (const chunk of rag.chunks) chunks.push(normalizeChunk(chunk, mailbox.id, rag.updatedAt));
  }
  if (new Set(chunks.map(chunk => chunk.id)).size !== chunks.length) fail('DUPLICATE_RAG');
  const scenarioOwners = new Map([...userIds, ...mailboxes.map(box => box.owner).filter(Boolean)].map(id => [sha(id), id]));
  let orphanScenarios = 0;
  for (const relative of files.keys()) {
    const match = /^scenarios\/([a-f0-9]{64})\.json$/.exec(relative);
    if (!match) continue;
    const owner = scenarioOwners.get(match[1]);
    if (!owner) orphanScenarios++;
    add(owner ? `scenarios:${owner}` : `migration-orphan-scenarios:${match[1]}`, await json(relative));
  }
  let revisions = [], kvCount = 0;
  if (files.has('daylight.sqlite')) {
    consumed.add('daylight.sqlite');
    const bytes = await fs.readFile(await safeFile(root, 'daylight.sqlite'));
    if (sha(bytes) !== files.get('daylight.sqlite').sha256) fail('SOURCE_CHANGED');
    const { default: initSqlJs } = await import('sql.js');
    const SQL = await initSqlJs(), db = new SQL.Database(bytes);
    try {
      const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).flat());
      const rows = sql => {
        const result = db.exec(sql)[0];
        return (result?.values || []).map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
      };
      if (tables.has('prompt_revisions')) revisions = rows('SELECT id,kind,body,created_at FROM prompt_revisions ORDER BY id')
        .map(row => ({ id: row.id, kind: row.kind, body: row.body, createdAt: row.created_at }));
      if (tables.has('kv')) for (const row of rows('SELECT key,value,updated_at FROM kv ORDER BY key')) {
        let value;
        try { value = JSON.parse(row.value); } catch { fail('INVALID_SQLITE_KV'); }
        add(`aux-kv:${row.key}`, { value }); kvCount++;
      }
      if ([...tables].some(table => !['kv', 'prompt_revisions', 'sqlite_sequence'].includes(table))) fail('UNSUPPORTED_SQLITE_TABLE');
    } finally { db.close(); }
  }
  add('aux-prompt-revisions', revisions);
  // Refuse unrecognized business JSON rather than silently omitting it. Operational
  // runtime/configuration/metrics artifacts stay in the immutable source backup.
  for (const relative of files.keys()) {
    if (!relative.endsWith('.json') || consumed.has(relative) || relative === 'infra.json'
      || /^(runtime|metrics|attachments)\//.test(relative) || /^mailboxes\/[^/]+\/attachments\//.test(relative)) continue;
    fail('UNSUPPORTED_SOURCE_JSON');
  }
  const plan = { sourceInventory, documents, users, resets, chunks, mailboxes, attachments: [], attachmentsVerified: false,
    warnings: { unownedMailboxes: mailboxes.filter(box => !box.owner && !box.orphan).length,
      orphanMailboxes: mailboxes.filter(box => box.orphan).length,
      missingOwnerUsers: mailboxes.filter(box => box.owner && !userIds.has(box.owner)).length, orphanScenarios },
    metadata: { promptRevisions: revisions.length, kvEntries: kvCount } };
  await collectAttachments(plan);
  plan.attachmentsVerified = plan.attachments.length === 0;
  return plan;
}

async function collectAttachments(plan) {
  const { files, root } = plan.sourceInventory;
  const descriptors = new Map(), legacy = new Map();
  const addLocal = (relative, node, mailboxId, legacyId = null) => {
    safeRelative(relative);
    if (!files.has(relative)) fail('MISSING_LOCAL_ATTACHMENT');
    let descriptor = descriptors.get(`file:${relative}`);
    if (!descriptor) {
      const info = files.get(relative);
      descriptor = { kind: 'local', sourcePath: relative, sha256: info.sha256, size: info.size, nodes: [], mailboxId,
        contentType: node?.contentType || node?.mimeType || contentType(relative), key: null, legacyId };
      descriptors.set(`file:${relative}`, descriptor);
    }
    if (node && !descriptor.nodes.includes(node)) descriptor.nodes.push(node);
    return descriptor;
  };
  for (const doc of plan.documents.filter(doc => doc.id.startsWith('recruitment:'))) {
    if (!Array.isArray(doc.payload.attachments)) fail('INVALID_RECRUITMENT');
    for (const attachment of doc.payload.attachments) {
      if (attachment.key) continue;
      if (!idPattern.test(attachment.id)) fail('INVALID_ATTACHMENT_ID');
      const relative = `${doc.mailboxId === 'default' ? '' : `mailboxes/${doc.mailboxId}/`}attachments/${attachment.id}.pdf`;
      const descriptor = addLocal(relative, attachment, doc.mailboxId, attachment.id);
      legacy.set(`${doc.mailboxId}\0${attachment.id}`, descriptor);
    }
  }
  for (const doc of plan.documents) visit(doc.payload, (node, parent) => {
    const key = node.key || node.storageKey;
    if (key && (node.storage === 'local' || clouds.has(node.storage) || node.storageKey
      || ['attachments', 'attachment'].includes(parent) || node.proxyUrl)) {
      safeRelative(key);
      if (node.key && node.storageKey && node.key !== node.storageKey) fail('AMBIGUOUS_ATTACHMENT_KEY');
      if (node.storage === 'local' || (!node.storage && files.has(`attachments/${key}`))) {
        const descriptor = addLocal(`attachments/${key}`, node, doc.mailboxId);
        descriptor.originalKey = key;
      } else {
        if (node.storage && !clouds.has(node.storage)) fail('UNSUPPORTED_ATTACHMENT_STORAGE');
        let descriptor = descriptors.get(`cloud:${key}`);
        if (!descriptor) {
          descriptor = { kind: 'cloud', key, storage: node.storage || null, nodes: [], mailboxId: doc.mailboxId };
          descriptors.set(`cloud:${key}`, descriptor);
        }
        if (!descriptor.nodes.includes(node)) descriptor.nodes.push(node);
      }
    } else if (node.id && node.filename && legacy.has(`${doc.mailboxId}\0${node.id}`)) {
      const descriptor = legacy.get(`${doc.mailboxId}\0${node.id}`);
      if (!descriptor.nodes.includes(node)) descriptor.nodes.push(node);
    }
  });
  // Keep unreferenced old binaries discoverable in a private PG migration manifest.
  for (const relative of files.keys()) if ((relative.startsWith('attachments/') || /^mailboxes\/[^/]+\/attachments\//.test(relative))
    && !descriptors.has(`file:${relative}`)) addLocal(relative, null, null);
  plan.attachments = [...descriptors.values()];
  for (const attachment of plan.attachments) if (attachment.kind === 'local') {
    await safeFile(root, attachment.sourcePath);
    const extension = path.extname(attachment.sourcePath).toLowerCase();
    attachment.key = `production-migration/v1/${sha(attachment.sourcePath)}/${attachment.sha256}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ''}`;
  }
}

function contentType(filename) {
  return ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })[path.extname(filename).toLowerCase()]
    || 'application/octet-stream';
}

/** Storage adapter must provide head/get/put without local fallback. */
export async function migrateProductionAttachments(plan, storage) {
  if (!clouds.has(storage?.mode)) fail('SHARED_OSS_REQUIRED');
  const replacements = new Map(), manifest = [];
  let uploaded = 0, verifiedCloud = 0, reused = 0;
  for (const item of plan.attachments) {
    if (item.kind === 'cloud' && item.storage && item.storage !== storage.mode) fail('CLOUD_PROVIDER_MISMATCH');
    let expected;
    if (item.kind === 'local') {
      expected = await fs.readFile(await safeFile(plan.sourceInventory.root, item.sourcePath));
      if (expected.length !== item.size || sha(expected) !== item.sha256) fail('SOURCE_CHANGED');
    }
    const present = await storage.head(item.key);
    if (!present) {
      if (item.kind === 'cloud') fail('MISSING_CLOUD_ATTACHMENT');
      await storage.put(item.key, expected, item.contentType); uploaded++;
    } else if (item.kind === 'local') reused++;
    const remote = await storage.get(item.key);
    const bytes = Buffer.isBuffer(remote) ? remote : remote?.buffer;
    if (!Buffer.isBuffer(bytes)) fail('CLOUD_READBACK_FAILED');
    if (expected && (bytes.length !== expected.length || sha(bytes) !== item.sha256)) fail('CLOUD_READBACK_MISMATCH');
    if (item.kind === 'cloud') verifiedCloud++;
    const proxyUrl = `/api/attachments/${encodeURIComponent(item.key)}`;
    const url = storage.publicUrl?.(item.key) || proxyUrl;
    for (const node of item.nodes) {
      const before = { key: node.key, storageKey: node.storageKey, url: node.url, proxyUrl: node.proxyUrl };
      if (Object.hasOwn(node, 'storageKey')) node.storageKey = item.key;
      if (Object.hasOwn(node, 'key') || !Object.hasOwn(node, 'storageKey')) node.key = item.key;
      node.storage = storage.mode;
      if (item.kind === 'local') { node.size = bytes.length; if (!node.contentType && !node.mimeType) node.contentType = item.contentType; }
      node.url = url; node.proxyUrl = proxyUrl;
      for (const field of ['key', 'storageKey']) if (before[field] && before[field] !== item.key) replacements.set(`${field}\0${before[field]}`, item.key);
      if (before.url) replacements.set(`url\0${before.url}`, url);
      if (before.proxyUrl) replacements.set(`proxyUrl\0${before.proxyUrl}`, proxyUrl);
    }
    if (item.originalKey) {
      for (const field of ['key', 'storageKey']) replacements.set(`${field}\0${item.originalKey}`, item.key);
      replacements.set(`url\0/api/attachments/${encodeURIComponent(item.originalKey)}`, url);
      replacements.set(`proxyUrl\0/api/attachments/${encodeURIComponent(item.originalKey)}`, proxyUrl);
    }
    manifest.push({ sourcePath: item.sourcePath || null, key: item.key, storage: storage.mode,
      size: bytes.length, sha256: sha(bytes), references: item.nodes.length });
  }
  for (const doc of plan.documents) visit(doc.payload, node => {
    let replaced = false;
    for (const field of ['key', 'storageKey', 'url', 'proxyUrl']) {
      const replacement = replacements.get(`${field}\0${node[field]}`);
      if (replacement !== undefined) { node[field] = replacement; replaced = true; }
    }
    if (replaced && node.storage === 'local') node.storage = storage.mode;
  });
  if (manifest.length) plan.documents.push({ table: 'app_settings', id: `migration-attachments:${plan.sourceInventory.digest}`,
    payload: { schemaVersion: 1, sourceDigest: plan.sourceInventory.digest, objects: manifest }, mailboxId: null });
  plan.attachmentsVerified = true;
  plan.attachmentResults = { uploaded, reused, verifiedCloud, verifiedObjects: manifest.length,
    verifiedBytes: manifest.reduce((sum, item) => sum + item.size, 0) };
  return plan.attachmentResults;
}

export async function verifyProductionSource(plan) {
  const current = await inventory(plan.sourceInventory.root);
  if (current.digest !== plan.sourceInventory.digest) fail('SOURCE_CHANGED');
}

const tableSpecs = [
  { table: 'users', key: 'id', fields: ['id', 'email', 'username', 'password_hash', 'role', 'workspace_mode', 'workspace_mode_changes',
    'last_login_at', 'session_version', 'created_at', 'updated_at'], json: ['workspace_mode_changes'], dates: ['last_login_at', 'created_at', 'updated_at'], source: plan => plan.users },
  { table: 'password_resets', key: 'token', fields: ['token', 'user_id', 'expires_at', 'used_at'], json: [], dates: ['expires_at', 'used_at'], source: plan => plan.resets },
  { table: 'app_settings', key: 'id', fields: ['id', 'payload'], json: ['payload'], dates: [], source: plan => plan.documents.filter(doc => doc.table === 'app_settings').map(({ id, payload }) => ({ id, payload })) },
  { table: 'mailbox_calendars', key: 'mailbox_id', fields: ['mailbox_id', 'payload'], json: ['payload'], dates: [], source: plan => plan.documents.filter(doc => doc.table === 'mailbox_calendars').map(({ id, payload }) => ({ mailbox_id: id, payload })) },
  { table: 'rag_chunks', key: 'id', fields: ['id', 'mailbox_id', 'owner_user_id', 'candidate_id', 'attachment_id', 'filename', 'page', 'chunk_index', 'content', 'embedding', 'updated_at'], json: ['embedding'], dates: ['updated_at'], source: plan => plan.chunks },
];

const normalizeRow = (spec, row) => Object.fromEntries(spec.fields.map(field => [field,
  spec.dates.includes(field) ? iso(row[field], true) : row[field]]));

async function verifyRows(client, spec, expected, allowMissing, lock = true) {
  const { rows } = await client.query(`SELECT ${spec.fields.join(',')} FROM ${spec.table} ORDER BY ${spec.key}${lock ? ' FOR UPDATE' : ''}`);
  const byKey = new Map(expected.map(row => [row[spec.key], row]));
  for (const row of rows) {
    const source = byKey.get(row[spec.key]);
    if (!source || !isDeepStrictEqual(normalizeRow(spec, row), source)) fail('TARGET_AUTHORITY_CONFLICT');
  }
  if (!allowMissing && rows.length !== expected.length) fail('TARGET_VERIFICATION_FAILED');
  return new Set(rows.map(row => row[spec.key]));
}

/** One transaction; existing records are accepted only when all business fields match. */
export async function applyProductionData(pool, plan) {
  if (!plan.attachmentsVerified) fail('ATTACHMENTS_NOT_VERIFIED');
  await verifyProductionSource(plan);
  const client = await pool.connect();
  let inserted = 0, reused = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(711804, 2)');
    await client.query('LOCK TABLE users,password_resets,app_settings,mailbox_calendars,rag_chunks IN SHARE ROW EXCLUSIVE MODE');
    const pending = [];
    for (const spec of tableSpecs) {
      const source = spec.source(plan), existing = await verifyRows(client, spec, source, true);
      reused += existing.size;
      for (const row of source) if (!existing.has(row[spec.key])) pending.push({ spec, row });
    }
    for (const { spec, row } of pending) {
      const fields = [...spec.fields];
      const values = fields.map(field => spec.json.includes(field) && row[field] !== null ? JSON.stringify(row[field]) : row[field]);
      const placeholders = fields.map((field, index) => `$${index + 1}${spec.json.includes(field) ? '::jsonb' : ''}`);
      if (['app_settings', 'mailbox_calendars'].includes(spec.table)) { fields.push('updated_at', 'version'); placeholders.push('clock_timestamp()', '1'); }
      await client.query(`INSERT INTO ${spec.table} (${fields.join(',')}) VALUES (${placeholders.join(',')})`, values);
      inserted++;
    }
    for (const spec of tableSpecs) await verifyRows(client, spec, spec.source(plan), false);
    await verifyProductionSource(plan);
    await client.query('COMMIT');
    return { inserted, reused, verifiedRows: inserted + reused };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Independent post-commit audit. PostgreSQL rejects writes in this transaction. */
export async function verifyProductionData(pool, plan) {
  if (!plan.attachmentsVerified) fail('ATTACHMENTS_NOT_VERIFIED');
  await verifyProductionSource(plan);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let verifiedRows = 0;
    for (const spec of tableSpecs) {
      const expected = spec.source(plan);
      await verifyRows(client, spec, expected, false, false);
      verifiedRows += expected.length;
    }
    await verifyProductionSource(plan);
    await client.query('COMMIT');
    return { verifiedRows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Public reports deliberately contain only bounded labels, counts and hashes. */
export function productionMigrationSummary(plan, mode = 'dry-run') {
  return { schemaVersion: 1, mode, sourceDigest: plan.sourceInventory.digest,
    counts: { sourceFiles: plan.sourceInventory.files.size, mailboxes: plan.mailboxes.length,
      documents: plan.documents.length, users: plan.users.length, passwordResets: plan.resets.length, ragChunks: plan.chunks.length,
      embeddedChunks: plan.chunks.filter(chunk => chunk.embedding !== null).length,
      promptRevisions: plan.metadata.promptRevisions, kvEntries: plan.metadata.kvEntries,
      localAttachmentObjects: plan.attachments.filter(item => item.kind === 'local').length,
      existingCloudObjects: plan.attachments.filter(item => item.kind === 'cloud').length,
      unreferencedLocalObjects: plan.attachments.filter(item => item.kind === 'local' && !item.nodes.length).length },
    warnings: plan.warnings, attachmentsVerified: plan.attachmentsVerified,
    ...(plan.attachmentResults ? { attachments: plan.attachmentResults } : {}),
    ...(plan.databaseResults ? { database: plan.databaseResults } : {}) };
}

function parseArgs(args) {
  const result = { apply: false, verify: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' || arg === '--verify') {
      const mode = arg.slice(2);
      if (result.apply || result.verify) fail('INVALID_ARGUMENTS'); result[mode] = true; continue;
    }
    const match = /^--(source|environment|output)(?:=(.*))?$/.exec(arg);
    if (!match || result[match[1]] !== undefined) fail('INVALID_ARGUMENTS');
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    result[match[1]] = value;
  }
  if (!result.source || !result.environment) fail('SOURCE_AND_ENVIRONMENT_REQUIRED');
  return result;
}

export function productionMigrationS3Options(config) {
  const endpoint = config.endpoint ? (/^https?:/.test(config.endpoint) ? config.endpoint : `https://${config.endpoint}`) : undefined;
  return { region: config.region, endpoint, forcePathStyle: config.forcePathStyle || config.provider === 'us3',
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } };
}

/** OSS uses its native conditional-write header; S3-compatible providers use If-None-Match. */
export function productionMigrationPutCommand(PutObjectCommand, config, key, bytes, mime) {
  const command = new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: mime,
    ...(config.provider === 'aliyun' ? {} : { IfNoneMatch: '*' }) });
  if (config.provider === 'aliyun') command.middlewareStack.add(next => async args => {
    args.request.headers['x-oss-forbid-overwrite'] = 'true';
    return next(args);
  }, { step: 'build', name: 'daylightMigrationForbidOverwrite', priority: 'high' });
  return command;
}

async function createCloudAdapter(config) {
  if (!['aliyun', 's3', 'us3'].includes(config.provider)) fail('MIGRATION_PROVIDER_REQUIRES_S3');
  const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client(productionMigrationS3Options(config));
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
  return { mode: config.provider,
    async head(key) {
      try { const result = await send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })); return { size: result.ContentLength }; }
      catch (error) { if (error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error.name)) return null; throw error; }
    },
    async get(key) {
      const response = await send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async put(key, bytes, mime) {
      try { await send(productionMigrationPutCommand(PutObjectCommand, config, key, bytes, mime)); }
      catch (error) {
        if (error.$metadata?.httpStatusCode !== 412
          && !(config.provider === 'aliyun' && error.$metadata?.httpStatusCode === 409 && error.Code === 'FileAlreadyExists')
          && !(config.provider === 'aliyun' && error.$metadata?.httpStatusCode === 409 && error.name === 'FileAlreadyExists')) throw error;
      }
    },
    publicUrl: key => config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}` : null,
    close: () => client.destroy() };
}

export async function runProductionMigration(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const environmentFile = path.resolve(options.environment);
  if ((await fs.lstat(environmentFile)).isSymbolicLink()) fail('UNSAFE_ENVIRONMENT');
  let environment;
  try { environment = JSON.parse(await fs.readFile(environmentFile, 'utf8')); } catch { fail('INVALID_ENVIRONMENT'); }
  if (!object(environment) || Object.entries(environment).some(([key, value]) => (!/^DAYLIGHT_[A-Z0-9_]+$/.test(key)
    && !['NODE_ENV', 'HOST', 'PORT', 'TZ'].includes(key)) || !['string', 'number', 'boolean'].includes(typeof value))) fail('INVALID_ENVIRONMENT');
  for (const [key, value] of Object.entries(environment)) if (key.startsWith('DAYLIGHT_')) process.env[key] = String(value);
  process.env.DAYLIGHT_RUNTIME = 'production';
  const { readInfraConfig } = await import('../server/infra/config.js');
  const config = readInfraConfig({ force: true });
  const plan = await collectProductionData(options.source);
  const reportMode = options.apply ? 'applied' : options.verify ? 'verified' : 'dry-run';
  const output = path.resolve(options.output || path.join('work', `production-data-migration-${reportMode}-${plan.sourceInventory.digest.slice(0, 16)}-${randomUUID().slice(0, 8)}.json`));
  const realParent = await fs.realpath(path.dirname(output)).catch(() => null);
  if (output === plan.sourceInventory.root || output.startsWith(`${plan.sourceInventory.root}${path.sep}`)
    || (realParent && (realParent === plan.sourceInventory.root || realParent.startsWith(`${plan.sourceInventory.root}${path.sep}`)))) fail('OUTPUT_INSIDE_SOURCE');
  if (await fs.lstat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) fail('OUTPUT_ALREADY_EXISTS');
  await fs.mkdir(path.dirname(output), { recursive: true });
  // Dry-run never initializes infrastructure, performs DDL, or uploads objects.
  if (options.apply || options.verify) {
    const [{ default: pg }, { SCHEMA }, { migrateJobs }, { STORAGE_SCHEMA }, { AUXILIARY_SCHEMA }, oss] = await Promise.all([
      import('pg'), import('../server/infra/postgres.js'), import('../server/jobs/schema.js'), import('../server/storage/schema.js'),
      import('../server/storage/aux-schema.js'), import('../server/infra/oss.js') ]);
    const pool = new pg.Pool({ connectionString: process.env.DAYLIGHT_DATABASE_URL, max: 2,
      connectionTimeoutMillis: 10000, ssl: process.env.DAYLIGHT_DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined });
    pool.on('error', () => {});
    let client, storage;
    try {
      const initialized = await oss.initOss();
      if (!initialized.ok || initialized.mode !== config.oss.provider) fail('OSS_INITIALIZATION_FAILED');
      storage = await createCloudAdapter(config.oss);
      if (options.apply) {
        client = await pool.connect();
        await client.query('SELECT pg_advisory_lock(711804, 0)');
        await client.query(SCHEMA);
        await migrateJobs(pool);
        await client.query(STORAGE_SCHEMA);
        await client.query(AUXILIARY_SCHEMA);
      } else {
        storage.put = async () => fail('VERIFY_MISSING_CLOUD_OBJECT');
      }
      await migrateProductionAttachments(plan, storage);
      plan.databaseResults = options.apply ? await applyProductionData(pool, plan) : await verifyProductionData(pool, plan);
    } finally {
      storage?.close(); oss.closeOss();
      if (client) { await client.query('SELECT pg_advisory_unlock(711804, 0)').catch(() => {}); client.release(); }
      await pool.end();
    }
  }
  const summary = productionMigrationSummary(plan, reportMode);
  // Do not follow existing report symlinks or overwrite an unrelated artifact.
  const handle = await fs.open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`); } finally { await handle.close(); }
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runProductionMigration().catch(error => {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED';
    console.error(`Production data migration refused (${code}); source backup is unchanged; no successful import was reported.`);
    process.exitCode = 1;
  });
}
