import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSpigotCredentialText, type ImportedCredential } from './spigot-credential-import.js';

/** Credentials are plaintext because the browser must type them into Spigot. */
export type Credential = ImportedCredential;

export type CredentialLoad =
  | { ok: true; credentials: Credential[] }
  | { ok: false; reason: 'missing' | 'malformed'; detail: string };

export function loadSpigotCredentials(path: string): CredentialLoad {
  if (!existsSync(path)) return { ok: false, reason: 'missing', detail: path };

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: err instanceof Error ? err.message : String(err) };
  }

  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  return parseSpigotCredentialText(text);
}

/** Atomically replaces the credential file and keeps it private on POSIX. */
export function saveSpigotCredentials(path: string, credentials: Credential[]): void {
  const temp = join(dirname(path), `.${Date.now()}-credentials.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not have been created.
    }
    throw err;
  }
}

export function enabledSpigotCredentials(credentials: Credential[]): Credential[] {
  return credentials.filter((credential) => credential.enabled !== false);
}

export function checkCredentialsFilePermissions(path: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${path} có quyền ${mode.toString(8)} — nên đặt 0600, tệp này chứa mật khẩu`;
    }
  } catch {
    // Unreadable is reported through loadSpigotCredentials instead.
  }
  return null;
}
