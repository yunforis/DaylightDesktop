import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mailboxDirectory } from '../store.js';
import { getPostgresPool } from '../infra/postgres.js';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';
import { AUXILIARY_SCHEMA } from '../storage/aux-schema.js';
import { parseMailRef } from './mail-ref.js';

const empty = () => ({ chunks: [], updatedAt: null });

function filePath(mailboxId) {
  return path.join(mailboxDirectory(mailboxId), 'rag-chunks.json');
}

function chunkId(parts) {
  return createHash('sha256').update(parts.filter(Boolean).join('\0')).digest('hex').slice(0, 28);
}

export function makeChunkId({ mailboxId, attachmentId, page, chunkIndex }) {
  return chunkId(['rag', mailboxId, attachmentId, String(page), String(chunkIndex)]);
}

function readFileStore(mailboxId) {
  requireLocalRuntime('File-backed RAG');
  const file = filePath(mailboxId);
  if (!fs.existsSync(file)) return empty();
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return empty();
  }
}

function writeFileStore(mailboxId, data) {
  requireLocalRuntime('File-backed RAG');
  const file = filePath(mailboxId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...data, updatedAt: new Date().toISOString() };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return next;
}

const readyPools = new WeakSet();

async function ensurePgTable() {
  const pool = getPostgresPool();
  if (!pool) {
    requireLocalRuntime('File-backed RAG');
    return false;
  }
  // Production schema is installed by migrations, never by a request.
  if (isProductionRuntime() || readyPools.has(pool)) return true;
  await pool.query(AUXILIARY_SCHEMA);
  // pgvector 可选：存在扩展时再加向量列（失败则仅用 JSONB embedding）
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`
      ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);
    `);
  } catch {
    // 无超级用户或未装 pgvector 时忽略，关键词 + JSON embedding 仍可用
  }
  readyPools.add(pool);
  return true;
}

// Every writer of an attachment participates in the same short transaction.
// The advisory lock also serializes replacements when the attachment has no rows yet.
async function mutateAttachment(pool, mailboxId, attachmentId, mutate) {
  await ensurePgTable();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify(['rag', mailboxId, attachmentId]),
    ]);
    const result = await mutate(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the write failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function rowToChunk(row) {
  const ref = parseMailRef(row.attachment_id);
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    ownerUserId: row.owner_user_id || null,
    candidateId: row.candidate_id || null,
    attachmentId: row.attachment_id,
    emailId: ref.emailId,
    source: ref.source,
    filename: row.filename || '',
    page: Number(row.page) || 1,
    chunkIndex: Number(row.chunk_index) || 0,
    content: row.content || '',
    embedding: Array.isArray(row.embedding) ? row.embedding : (row.embedding?.values || null),
    updatedAt: row.updated_at || null,
  };
}

/**
 * Both backends must expose the same chunk shape. `rowToChunk` restores the mail reference
 * from `attachment_id`; the file backend used to read back exactly what the writer stored,
 * so the same chunk lost `emailId`/`source` locally and anything that locates the original
 * mail from a chunk (citation cards, `listChunks` consumers) behaved differently per backend.
 */
function fileToChunk(chunk) {
  const ref = parseMailRef(chunk.attachmentId);
  return { ...chunk, emailId: ref.emailId, source: ref.source };
}

export async function listChunks(mailboxId, { attachmentId, candidateId } = {}) {
  const pool = getPostgresPool();
  if (pool) {
    await ensurePgTable();
    const clauses = ['mailbox_id = $1'];
    const values = [mailboxId];
    if (attachmentId) {
      values.push(attachmentId);
      clauses.push(`attachment_id = $${values.length}`);
    }
    if (candidateId) {
      values.push(candidateId);
      clauses.push(`candidate_id = $${values.length}`);
    }
    const { rows } = await pool.query(
      `select * from rag_chunks where ${clauses.join(' and ')} order by page, chunk_index`,
      values,
    );
    return rows.map(rowToChunk);
  }
  let chunks = (readFileStore(mailboxId).chunks || []).map(fileToChunk);
  if (attachmentId) chunks = chunks.filter((item) => item.attachmentId === attachmentId);
  if (candidateId) chunks = chunks.filter((item) => item.candidateId === candidateId);
  return chunks;
}

export async function deleteChunksByAttachment(mailboxId, attachmentId) {
  const pool = getPostgresPool();
  if (pool) {
    await mutateAttachment(pool, mailboxId, attachmentId, (client) => client.query(
      'delete from rag_chunks where mailbox_id = $1 and attachment_id = $2', [mailboxId, attachmentId],
    ));
    return;
  }
  const data = readFileStore(mailboxId);
  writeFileStore(mailboxId, {
    chunks: (data.chunks || []).filter((item) => item.attachmentId !== attachmentId),
  });
}

export async function replaceChunks(mailboxId, attachmentId, chunks) {
  chunks = chunks || [];
  const ids = new Set();
  for (const chunk of chunks) {
    if (!chunk.id || ids.has(chunk.id)
      || (chunk.mailboxId && chunk.mailboxId !== mailboxId)
      || (chunk.attachmentId && chunk.attachmentId !== attachmentId)) {
      throw Object.assign(new Error('Invalid RAG chunk identity or scope'), { status: 400 });
    }
    ids.add(chunk.id);
  }
  const pool = getPostgresPool();
  if (pool) {
    return mutateAttachment(pool, mailboxId, attachmentId, async (client) => {
    await client.query('delete from rag_chunks where mailbox_id = $1 and attachment_id = $2', [mailboxId, attachmentId]);
    for (const chunk of chunks) {
      await client.query(
        `insert into rag_chunks
          (id, mailbox_id, owner_user_id, candidate_id, attachment_id, filename, page, chunk_index, content, embedding, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
          `,
        [
          chunk.id,
          mailboxId,
          chunk.ownerUserId || null,
          chunk.candidateId || null,
          attachmentId,
          chunk.filename || '',
          chunk.page,
          chunk.chunkIndex,
          chunk.content,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        ],
      );
    }
    const { rows } = await client.query(
      'select * from rag_chunks where mailbox_id = $1 and attachment_id = $2 order by page, chunk_index',
      [mailboxId, attachmentId],
    );
    return rows.map(rowToChunk);
    });
  }
  const data = readFileStore(mailboxId);
  const others = (data.chunks || []).filter((item) => item.attachmentId !== attachmentId);
  const stored = chunks.map(fileToChunk);
  writeFileStore(mailboxId, { chunks: [...others, ...stored] });
  return stored;
}

export async function reassignCandidate(mailboxId, attachmentId, candidateId) {
  const pool = getPostgresPool();
  if (pool) {
    await mutateAttachment(pool, mailboxId, attachmentId, (client) => client.query(
      'update rag_chunks set candidate_id = $3, updated_at = NOW() where mailbox_id = $1 and attachment_id = $2',
      [mailboxId, attachmentId, candidateId || null],
    ));
    return;
  }
  const data = readFileStore(mailboxId);
  writeFileStore(mailboxId, {
    chunks: (data.chunks || []).map((item) => (
      item.attachmentId === attachmentId ? { ...item, candidateId: candidateId || null } : item
    )),
  });
}
