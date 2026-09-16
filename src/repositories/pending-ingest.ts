import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import type { IngestFailureReason, PendingIngest } from '../domain/ingest.js';

type PendingRow = {
  id: number;
  original_filename: string;
  sha256: string;
  tmp_path: string;
  bytes: number;
  reason: string;
  detail: string;
  created_at: number;
};

function toPending(row: PendingRow): PendingIngest {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    tmpPath: row.tmp_path,
    bytes: row.bytes,
    reason: row.reason as IngestFailureReason,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export type CreatePendingInput = {
  originalFilename: string;
  sha256: string;
  tmpPath: string;
  bytes: number;
  reason: IngestFailureReason;
  detail: string;
};

/** Parks an unidentifiable jar for manual assignment instead of guessing. */
export function createPendingIngest(db: Db, input: CreatePendingInput): number {
  const info = db
    .prepare(
      `INSERT INTO pending_ingest (original_filename, sha256, tmp_path, bytes, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.originalFilename, input.sha256, input.tmpPath, input.bytes, input.reason, input.detail, now());
  return Number(info.lastInsertRowid);
}

export function listPendingIngest(db: Db): PendingIngest[] {
  const rows = db.prepare('SELECT * FROM pending_ingest ORDER BY created_at DESC').all() as PendingRow[];
  return rows.map(toPending);
}

export function findPendingIngest(db: Db, id: number): PendingIngest | null {
  const row = db.prepare('SELECT * FROM pending_ingest WHERE id = ?').get(id) as PendingRow | undefined;
  return row ? toPending(row) : null;
}

/**
 * A pending row for this exact content, if one exists.
 *
 * Re-uploading an unreadable jar is a natural user reaction, and each attempt
 * would otherwise cost another full-size temp copy on disk.
 */
export function findPendingBySha(db: Db, sha256: string): PendingIngest | null {
  const row = db.prepare('SELECT * FROM pending_ingest WHERE sha256 = ? LIMIT 1').get(sha256) as
    | PendingRow
    | undefined;
  return row ? toPending(row) : null;
}

export function deletePendingIngest(db: Db, id: number): void {
  db.prepare('DELETE FROM pending_ingest WHERE id = ?').run(id);
}
