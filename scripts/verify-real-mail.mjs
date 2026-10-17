#!/usr/bin/env node
/**
 * Real IMAP + real model verification against the configured mailbox.
 *
 * Read-only with respect to business data: it reads real mail through the production
 * reader and calls the production extractor, but never stages a storage commit, so the
 * calendar is not mutated. Attachment parsing still uploads to the real OSS bucket.
 *
 * Every real call is counted so the run can be reconciled against the agreed budget.
 *
 * Usage:
 *   set -a; . /opt/daylight/.env; set +a
 *   node scripts/verify-real-mail.mjs --mailbox=default --fetch=2 --model=1
 *
 *   --fetch N   recent INBOX messages read per pass (default 2, hard cap 20)
 *   --model M   how many of them go to the real model (default 1)
 *   --json      machine-readable output only
 */
import { initPostgres, getPostgresPool, closePostgres } from '../server/infra/postgres.js';
import { initOss, closeOss, ossMode } from '../server/infra/oss.js';
import { withStorageSnapshot, readSnapshotDocument, settingsKey, calendarKey } from '../server/storage/index.js';
import { readSettings } from '../server/store.js';
import { readMailboxEmails, extractEvents, EXTRACTION_VERSION } from '../server/agent.js';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const jsonOnly = process.argv.includes('--json');
const mailboxId = arg('mailbox', 'default');
const fetchLimit = Math.max(1, Math.min(20, Number(arg('fetch', 2)) || 2));
const modelCount = Math.max(1, Math.min(fetchLimit, Number(arg('model', 1)) || 1));

const usage = { imapConnects: 0, messagesRead: 0, attachmentObjects: 0, modelCalls: 0, modelFailures: 0 };
const checks = [];
const log = (...args) => { if (!jsonOnly) console.log(...args); };
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const redactAddress = value => String(value || '').replace(/^(.).*(@.*)$/, '$1***$2');
const hostOf = url => { try { return new URL(url).host; } catch { return '(invalid)'; } };

await initPostgres();
const { rows } = await getPostgresPool().query("SELECT payload FROM app_settings WHERE id='default'");
const mailbox = (rows[0].payload.mailboxes || []).find(box => box.id === mailboxId);
if (!mailbox) throw new Error(`mailbox ${mailboxId} is not configured`);
const ownerId = mailbox.ownerUserId || mailbox.userId;
if (!ownerId) throw new Error(`mailbox ${mailboxId} has no owner`);

await initOss();
log('=== Daylight real mailbox + model verification ===');
log(`mailbox=${mailboxId} address=${redactAddress(mailbox.email)} imap=${mailbox.imapHost}:${mailbox.imapPort} owner=${ownerId.slice(0, 8)}...`);
log(`runtime=${process.env.DAYLIGHT_RUNTIME} oss=${ossMode()} fetchLimit=${fetchLimit} modelEmails=${modelCount} promptVersion=${EXTRACTION_VERSION}\n`);

const started = Date.now();
const report = await withStorageSnapshot({ userId: ownerId, mailboxId, mailboxIds: [mailboxId] }, async () => {
  const settings = { ...readSettings(), fetchLimit };
  const calendar = readSnapshotDocument(calendarKey(mailboxId));
  const promptsDoc = readSnapshotDocument(settingsKey('prompts'));
  const knownIds = new Set((calendar.emails || []).map(e => e.id).filter(Boolean));
  log(`existing calendar: events=${(calendar.events || []).length} emails=${(calendar.emails || []).length} tasks=${(calendar.tasks || []).length}`);
  log(`model config: model=${settings.model} host=${hostOf(settings.baseUrl)} apiKey=${settings.apiKey ? 'set' : 'MISSING'}`);
  log(`extraction prompt: ${promptsDoc.extractionSystem ? `custom (${promptsDoc.extractionSystem.length} chars)` : 'default'}\n`);

  // ── Pass 1: production semantics. Already-processed IDs must come back as stubs.
  const t1 = Date.now();
  usage.imapConnects += 1;
  const dedupRun = await readMailboxEmails(settings, { processedIds: knownIds });
  const dedupMs = Date.now() - t1;
  usage.messagesRead += dedupRun.length;

  const ids = dedupRun.map(e => e.id);
  check('real IMAP returns messages', dedupRun.length > 0, `${dedupRun.length} messages in ${dedupMs}ms`);
  check('message ids are unique', new Set(ids).size === ids.length, `unique=${new Set(ids).size}/${ids.length}`);
  check('message ids embed mailbox identity', ids.every(id => /^(qq|imap|imap-v2):/.test(id)), `sample=${String(ids[0]).slice(0, 28)}…`);

  const times = dedupRun.map(e => new Date(e.receivedAt).getTime());
  // The reader returns mailbox order; chronological ordering is enforced downstream in
  // processEmails/runMailJob, so it is asserted there (job-layer test) instead of here.
  check('fetch is bounded by fetchLimit', dedupRun.length <= fetchLimit && dedupRun.length > 0,
    `${dedupRun.length} of limit ${fetchLimit}; raw reader order = ${dedupRun.map(e => e.receivedAt).join(' , ')}`);

  usage.imapConnects += 1;
  const repeat = await readMailboxEmails(settings, { processedIds: new Set(knownIds) });
  usage.messagesRead += repeat.length;
  const repeatIds = repeat.map(e => e.id);
  check('reader selection is deterministic for the same processed set',
    repeatIds.length === ids.length && repeatIds.every(id => ids.includes(id)),
    `pass1=${ids.length} pass2=${repeatIds.length}`);

  const knownHits = dedupRun.filter(e => knownIds.has(e.id));
  const stubs = knownHits.filter(e => e.subject === undefined || e.body === undefined);
  const fresh = dedupRun.filter(e => !knownIds.has(e.id));
  const freshParsed = fresh.filter(e => typeof e.body === 'string');
  check('already-processed mail is skipped without re-reading the body',
    knownHits.length === 0 || stubs.length === knownHits.length,
    `known=${knownHits.length} stubbed=${stubs.length} fresh=${fresh.length}`);
  check('unprocessed mail is parsed into subject and body',
    fresh.length === 0 || freshParsed.length === fresh.length,
    `parsed=${freshParsed.length}/${fresh.length}`);

  // ── Pass 2: read real content for the model. Empty processed set = newest messages in full.
  const t2 = Date.now();
  usage.imapConnects += 1;
  const contentRun = await readMailboxEmails(settings, { processedIds: new Set() });
  const readMs = Date.now() - t2;
  usage.messagesRead += contentRun.length;
  usage.attachmentObjects += contentRun.reduce((n, e) => n + (e.attachments || []).length, 0);

  const content = contentRun.filter(e => typeof e.body === 'string' && e.body.length > 0);
  check('newest messages read with full body', content.length === contentRun.length && content.length > 0,
    `bodies=${content.length}/${contentRun.length} in ${readMs}ms`);

  const modeled = [];
  for (const email of content.slice(-modelCount)) {
    const modelStart = Date.now();
    usage.modelCalls += 1;
    try {
      const extraction = await extractEvents(email, settings, calendar.events || [], undefined, calendar.tasks || [], { timeoutMs: 60_000 });
      const latencyMs = Date.now() - modelStart;
      const actions = (extraction.events || []).map(ev => ev.action);
      modeled.push({ id: email.id, latencyMs, ok: true, eventActions: actions,
        events: (extraction.events || []).length, tasks: (extraction.tasks || []).length,
        invoices: (extraction.invoices || []).length, summaryLength: String(extraction.summary || '').length });
      check(`real model extraction (${modeled.length}/${modelCount})`,
        Array.isArray(extraction.events) && Array.isArray(extraction.tasks),
        `latency=${latencyMs}ms actions=[${actions.join(',') || 'none'}] tasks=${(extraction.tasks || []).length} invoices=${(extraction.invoices || []).length}`);
    } catch (error) {
      usage.modelFailures += 1;
      modeled.push({ id: email.id, ok: false, error: `${error.name}: ${String(error.message).slice(0, 160)}` });
      check(`real model extraction (${modeled.length}/${modelCount})`, false, String(error.message).slice(0, 160));
    }
  }

  return { dedupMs, readMs, totalMs: Date.now() - started, dedupCount: dedupRun.length, contentCount: contentRun.length,
    receivedRange: times.length ? [new Date(times[0]).toISOString(), new Date(times.at(-1)).toISOString()] : [],
    calendarEvents: (calendar.events || []).length, modeled };
});

await closeOss();
await closePostgres();

const failed = checks.filter(c => !c.ok);
log(`\n=== summary: ${checks.length - failed.length}/${checks.length} passed ===`);
log(`usage: imapConnects=${usage.imapConnects} messagesRead=${usage.messagesRead} attachmentObjects=${usage.attachmentObjects} modelCalls=${usage.modelCalls} modelFailures=${usage.modelFailures}`);
if (jsonOnly) console.log(JSON.stringify({ usage, checks, report }, null, 2));
if (failed.length) { log('failed:'); for (const f of failed) log(`  - ${f.name}: ${f.detail}`); process.exitCode = 1; }
