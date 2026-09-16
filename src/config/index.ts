import { existsSync } from 'node:fs';
import { loadEnv, type Env } from './env.js';

let cached: Env | undefined;

/**
 * Loads .env into process.env if present. Node 24 has this built in, so no
 * dotenv dependency. Real environment variables already set take precedence,
 * which is what a VPS with systemd-provided config needs.
 */
function loadEnvFileIfPresent(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * Validated environment, parsed once on first access.
 * Import this rather than reading process.env anywhere else.
 */
export function config(): Env {
  if (!cached) {
    loadEnvFileIfPresent();
    cached = loadEnv();
  }
  return cached;
}

export type { Env };
