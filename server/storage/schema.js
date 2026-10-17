/** Deployment migration only. Never run DDL or import files on a request path. */
export const STORAGE_SCHEMA = `
ALTER TABLE mailbox_calendars ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
`;
