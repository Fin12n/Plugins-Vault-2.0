import { Pool, neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

/**
 * Khởi tạo kết nối Drizzle Client với Neon Connection Pooling qua WebSockets/TCP.
 * Phù hợp cho Discord Bot và các tiến trình cần interactive transactions.
 *
 * @param connectionString - Connection string PostgreSQL từ Neon.tech
 */
export function createDatabaseConnection(connectionString: string) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to establish database connection");
  }

  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

/**
 * Khởi tạo kết nối Drizzle HTTP Client cho Neon.tech.
 * Tối ưu tốc độ cho REST API stateless queries.
 *
 * @param connectionString - Connection string PostgreSQL từ Neon.tech
 */
export function createHttpDatabaseConnection(connectionString: string) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to establish database connection");
  }

  const sql = neon(connectionString);
  return drizzleHttp(sql, { schema });
}

export type Database = ReturnType<typeof createDatabaseConnection>;
export type HttpDatabase = ReturnType<typeof createHttpDatabaseConnection>;
