import { createDatabaseConnection, sql } from '@vault/db';
import { env } from '../config/env.js';

/**
 * Neon PostgreSQL Client dùng chung cho toàn bộ Dashboard Backend.
 * Kết nối Serverless Neon via Neon WebSocket Pooler để hỗ trợ transaction.
 */
export const db = createDatabaseConnection(env.DATABASE_URL);
export type DbInstance = typeof db;

/**
 * Ping kiểm tra kết nối Neon PostgreSQL (fail-closed check).
 */
export async function pingNeon(dbInstance: DbInstance = db): Promise<void> {
  await dbInstance.execute(sql`SELECT 1`);
}
