import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Tự động load .env từ thư mục hiện tại hoặc root workspace
const here = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../.env'),
  resolve(here, '../../.env'),
];

for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL là bắt buộc (kết nối Neon PostgreSQL)')
    .url('DATABASE_URL phải là URL hợp lệ (kết nối Neon PostgreSQL)'),
  SESSION_SECRET: z.string().default('default-super-secret-key-32-chars-long!'),
  DASHBOARD_PASSWORD: z.string().default('admin123'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.boolean().default(true),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().default(250 * 1024 * 1024), // 250 MB
  UPLOAD_MAX_FILES: z.coerce.number().default(50),
  ENCRYPTION_KEY: z.string().default('01234567890123456789012345678901'), // 32 bytes hex or raw
  DISCORD_CLIENT_ID: z.string().optional().default(''),
  DISCORD_CLIENT_SECRET: z.string().optional().default(''),
  DISCORD_OWNER_ID: z.string().default('0'),
  STORAGE_DIR: z.string().default('./data/plugins'),
});

export type DashboardEnv = z.infer<typeof envSchema>;

function loadEnv(): DashboardEnv {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Cấu hình môi trường dashboard không hợp lệ (Fail-Closed):', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
