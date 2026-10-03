import { createDatabaseConnection, type Database } from "@vault/db";

let drizzleInstance: Database | undefined;
let currentUrl: string | undefined;

/**
 * Khởi tạo kết nối Drizzle Client với Neon.tech PostgreSQL.
 *
 * @param connectionString - URL kết nối Neon.tech PostgreSQL
 */
export function initNeonDb(connectionString: string): Database {
  if (drizzleInstance && currentUrl === connectionString) return drizzleInstance;
  currentUrl = connectionString;
  drizzleInstance = createDatabaseConnection(connectionString);
  return drizzleInstance;
}

/**
 * Lấy thể hiện Drizzle Database Client cho Neon.tech.
 */
export function getNeonDb(): Database {
  const url = process.env.DATABASE_URL;
  if (url && url !== currentUrl) {
    return initNeonDb(url);
  }
  if (!drizzleInstance) {
    if (url && url.trim().length > 0) {
      return initNeonDb(url);
    }
    throw new Error(
      "DATABASE_URL chưa được cấu hình. Vui lòng điền connection string Neon.tech vào file .env"
    );
  }
  return drizzleInstance;
}

export type { Database };
