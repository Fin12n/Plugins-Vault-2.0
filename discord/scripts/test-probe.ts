import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config/env.js';

function parseEnv(path: string): Record<string, string> {
  const content = readFileSync(path, 'utf8');
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return result;
}

const raw = parseEnv('.env');
const env = loadEnv(raw);
console.log('--- ENV CHECK ---');
console.log('CLOAKBROWSER_HEADLESS:', env.CLOAKBROWSER_HEADLESS, typeof env.CLOAKBROWSER_HEADLESS);
console.log('CHROME_SHOW_WINDOW:', env.CHROME_SHOW_WINDOW);
console.log('CLOAKBROWSER_LICENSE_KEY:', env.CLOAKBROWSER_LICENSE_KEY ? 'Present' : 'Missing');
console.log('SESSION_SECRET length:', env.SESSION_SECRET.length);
