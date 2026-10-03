import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { config } from '../src/config/index.js';
import { loadSpigotCredentials } from '../src/services/upstream/spigot-credential-store.js';

/**
 * Rewrites the whitespace-separated Spigot accounts file as JSON.
 *
 * The text format is convenient to paste but fragile: a password with a space,
 * a pasted smart quote, or a two-column line where three were meant all move a
 * value into the wrong field while still parsing. JSON removes the whitespace
 * ambiguity — a password can hold spaces, and each field is named — which is
 * what makes the parse deterministic.
 *
 * Reuses loadSpigotCredentials so the JSON written is exactly what the bot would
 * read back: converting through the same parser means the output cannot disagree
 * with the loader.
 *
 * Values are written verbatim, so the file stays a secret store — the mode is
 * set to 0600 after writing, same as the bot expects.
 *
 * Usage: npm run accounts-to-json
 */
function main(): void {
  const env = config();
  const path = env.SPIGOT_CREDENTIALS_FILE;

  if (!existsSync(path)) {
    console.error(`Không thấy tệp: ${path}`);
    process.exit(1);
  }

  const raw = readFileSync(path);
  const head = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  if (head.replace(/^﻿/, '').trimStart().startsWith('[')) {
    console.log('Tệp đã ở dạng JSON, không cần chuyển.');
    return;
  }

  const loaded = loadSpigotCredentials(path);
  if (!loaded.ok) {
    console.error(`Không đọc được tệp (${loaded.reason}): ${loaded.detail}`);
    process.exit(1);
  }

  // Two-space indent, one account per block — readable enough to hand-edit later
  // without turning back into the fragile format.
  const json = JSON.stringify(
    loaded.credentials.map((c) => ({ label: c.label, username: c.username, password: c.password })),
    null,
    2,
  );

  writeFileSync(path, `${json}\n`, { encoding: 'utf8' });
  if (process.platform !== 'win32') chmodSync(path, 0o600);

  console.log(`Đã chuyển ${loaded.credentials.length} tài khoản sang JSON: ${path}`);
}

main();
