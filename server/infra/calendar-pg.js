import { getPostgresPool, postgresMode } from './postgres.js';

export function calendarPgEnabled() {
  return postgresMode() === 'postgres' && Boolean(getPostgresPool());
}

export async function upsertMailboxCalendar(mailboxId, payload) {
  const pool = getPostgresPool();
  if (!pool) return false;
  const id = mailboxId || 'default';
  await pool.query(
    `insert into mailbox_calendars (mailbox_id, payload, updated_at)
     values ($1, $2::jsonb, $3)
     on conflict (mailbox_id) do update
       set payload = excluded.payload, updated_at = excluded.updated_at`,
    [id, JSON.stringify(payload), new Date().toISOString()],
  );
  return true;
}

export async function loadMailboxCalendar(mailboxId) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    'select payload from mailbox_calendars where mailbox_id = $1 limit 1',
    [mailboxId || 'default'],
  );
  return rows[0]?.payload || null;
}

export async function upsertAppSettings(payload) {
  const pool = getPostgresPool();
  if (!pool) return false;
  await pool.query(
    `insert into app_settings (id, payload, updated_at)
     values ('default', $1::jsonb, $2)
     on conflict (id) do update
       set payload = excluded.payload, updated_at = excluded.updated_at`,
    [JSON.stringify(payload), new Date().toISOString()],
  );
  return true;
}

export async function loadAppSettings() {
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    `select payload from app_settings where id = 'default' limit 1`,
  );
  return rows[0]?.payload || null;
}

export async function migrateLocalCalendarToPg(mailboxId, localPayload) {
  if (!calendarPgEnabled() || !localPayload) return { migrated: false };
  const existing = await loadMailboxCalendar(mailboxId);
  if (existing) return { migrated: false, reason: 'already-exists' };
  await upsertMailboxCalendar(mailboxId, localPayload);
  return { migrated: true };
}
