/**
 * Optional IMAP IDLE watcher for the active mailbox.
 * When the server supports IDLE, keep a connection and trigger sync on new mail.
 * Falls back silently; the poll interval remains the safety net.
 */
import { ImapFlow } from 'imapflow';
import { normalizeMailbox, publicSettings, readSettings } from './store.js';

let watcher = null;
let restartTimer = null;

export function stopIdleWatcher() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const current = watcher;
  watcher = null;
  if (!current) return;
  current.stopped = true;
  Promise.resolve()
    .then(async () => {
      try { current.lock?.release(); } catch { /* ignore */ }
      try { await current.client?.logout(); } catch { /* ignore */ }
    })
    .catch(() => {});
}

export function refreshIdleWatcher(runSync) {
  stopIdleWatcher();
  const settings = readSettings();
  const mailbox = normalizeMailbox(settings);
  const publicView = publicSettings(settings);
  if (mailbox.syncStrategy !== 'idle' || !publicView.mailboxReady || !publicView.modelReady) return;
  startIdle(settings, runSync);
}

async function startIdle(settings, runSync) {
  const mailbox = normalizeMailbox(settings);
  const client = new ImapFlow({
    host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.imapSecure,
    ...(!mailbox.imapSecure ? { doSTARTTLS: true } : {}),
    auth: { user: settings.email, pass: settings.authorizationCode }, logger: false,
    clientInfo: { name: 'Daylight', version: '0.1.0', vendor: 'Local demo' },
  });
  const state = { client, lock: null, stopped: false, mailboxId: settings.activeMailboxId };
  watcher = state;
  try {
    await client.connect();
    if (state.stopped) return;
    state.lock = await client.getMailboxLock('INBOX');
    let debounce;
    client.on('exists', () => {
      if (state.stopped || state.mailboxId !== readSettings().activeMailboxId) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        runSync('qq', readSettings(), 'idle').catch(() => {});
      }, 1500);
    });
    // Stay connected; imapflow auto-IDLE while inactive.
    while (!state.stopped && watcher === state) {
      await new Promise((resolve) => { restartTimer = setTimeout(resolve, 55_000); });
      if (state.stopped || watcher !== state) break;
      if (readSettings().activeMailboxId !== state.mailboxId) break;
      try { await client.noop(); } catch { break; }
    }
  } catch {
    // IDLE unsupported or connection failed — poll interval continues.
  } finally {
    if (watcher === state) watcher = null;
    try { state.lock?.release(); } catch { /* ignore */ }
    try { await client.logout(); } catch { /* ignore */ }
    if (!state.stopped && readSettings().mailboxes.find((item) => item.id === state.mailboxId)?.syncStrategy === 'idle') {
      restartTimer = setTimeout(() => refreshIdleWatcher(runSync), 15_000);
    }
  }
}

export function idleStatus() {
  return {
    active: Boolean(watcher && !watcher.stopped),
    mailboxId: watcher?.mailboxId || null,
  };
}
