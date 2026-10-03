import { createDatabaseConnection } from '@vault/db';
import { env } from '../config/env.js';

/**
 * Neon PostgreSQL Client dùng chung cho toàn bộ Dashboard Backend.
 * Kết nối Serverless Neon via Neon WebSocket Pooler để hỗ trợ transaction.
 */
export const db = createDatabaseConnection(env.DATABASE_URL);
export type DbInstance = typeof db;
