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
  DATABASE_URL: z.string().min(1, 'DATABASE_URL là bắt buộc (kết nối Neon PostgreSQL)'),
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
    console.error('❌ Cấu hình môi trường dashboard không hợp lệ:', result.error.format());
    // Trả về fallback với DATABASE_URL rỗng nếu chưa có, để dev có thể nhìn thấy log hướng dẫn
    return {
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://placeholder:placeholder@ep-placeholder.us-east-2.aws.neon.tech/neondb?sslmode=require',
      SESSION_SECRET: process.env.SESSION_SECRET || 'vault-dashboard-session-secret-salt-key-2026',
      DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'admin123',
      PORT: Number(process.env.PORT || 3000),
      HOST: process.env.HOST || '0.0.0.0',
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
      TRUST_PROXY: true,
      UPLOAD_MAX_FILE_BYTES: 250 * 1024 * 1024,
      UPLOAD_MAX_FILES: 50,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '01234567890123456789012345678901',
      DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
      DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
      DISCORD_OWNER_ID: process.env.DISCORD_OWNER_ID || '0',
      STORAGE_DIR: process.env.STORAGE_DIR || './data/plugins',
    };
  }
  return result.data;
}

export const env = loadEnv();
