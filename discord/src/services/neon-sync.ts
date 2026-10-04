import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/neon.js';

/**
 * @deprecated
 * Per Phase 1 Plan v10 (Section 15), automatic SQLite->Neon synchronization at runtime
 * has been replaced by the explicit, transactional migration script:
 * `discord/scripts/migrate-sqlite-to-neon-full.ts`.
 *
 * This function is now a no-op to prevent unintended runtime data mutations.
 */
export async function autoSyncSqliteToNeonIfEmpty(
  _sqlite: BetterSqlite3.Database,
  _neonDb: Database,
): Promise<number> {
  // No-op per Plan v10
  return 0;
}
