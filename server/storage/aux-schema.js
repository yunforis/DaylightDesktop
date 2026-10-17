// Required auxiliary schema, installed by deployment migrations, not requests.
export const AUXILIARY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    owner_user_id TEXT,
    candidate_id TEXT,
    attachment_id TEXT NOT NULL,
    filename TEXT,
    page INTEGER NOT NULL DEFAULT 1,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    embedding JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS rag_chunks_mailbox_idx ON rag_chunks (mailbox_id);
  CREATE INDEX IF NOT EXISTS rag_chunks_attachment_idx ON rag_chunks (attachment_id);
  CREATE INDEX IF NOT EXISTS rag_chunks_candidate_idx ON rag_chunks (candidate_id);
`;

// Accept a pool or a migration transaction client. No optional extension or
// runtime initialization is needed for keyword/JSONB embedding retrieval.
export async function migrateAuxiliary(client) {
  await client.query(AUXILIARY_SCHEMA);
}
