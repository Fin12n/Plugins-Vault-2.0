import { existsSync, readFileSync } from 'node:fs';
import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { decryptSecret, encryptSecret } from '../utils/crypto-vault.js';
import { Secret, type AccountStatus } from '../services/upstream/spigot-account-store.js';

export type SpigotAccountRow = {
  id: number;
  label: string;
  username: string;
  password_encrypted: string;
  xf_user_encrypted: string;
  xf_session_encrypted: string;
  issued_at: string | null;
  last_verified_at: string | null;
  status: AccountStatus;
  is_enabled: number;
  created_at: number;
  updated_at: number;
};

export type SpigotAccountRecord = {
  id: number;
  label: string;
  username: string;
  password: Secret;
  xfUser: Secret;
  xfSession: Secret;
  issuedAt: string | null;
  lastVerifiedAt: string | null;
  status: AccountStatus;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export function toSpigotAccount(row: SpigotAccountRow): SpigotAccountRecord {
  const plainPassword = decryptSecret(row.password_encrypted);
  const plainXfUser = decryptSecret(row.xf_user_encrypted);
  const plainXfSession = decryptSecret(row.xf_session_encrypted);

  return {
    id: row.id,
    label: row.label,
    username: row.username,
    password: new Secret(plainPassword),
    xfUser: new Secret(plainXfUser),
    xfSession: new Secret(plainXfSession),
    issuedAt: row.issued_at,
    lastVerifiedAt: row.last_verified_at,
    status: row.status,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSpigotAccounts(db: Db): SpigotAccountRecord[] {
  const rows = db
    .prepare('SELECT * FROM spigot_accounts ORDER BY id ASC')
    .all() as SpigotAccountRow[];
  return rows.map(toSpigotAccount);
}

export function listEnabledSpigotAccounts(db: Db): SpigotAccountRecord[] {
  const rows = db
    .prepare('SELECT * FROM spigot_accounts WHERE is_enabled = 1 ORDER BY id ASC')
    .all() as SpigotAccountRow[];
  return rows.map(toSpigotAccount);
}

export function findSpigotAccountByLabel(db: Db, label: string): SpigotAccountRecord | null {
  const row = db
    .prepare('SELECT * FROM spigot_accounts WHERE label = ?')
    .get(label) as SpigotAccountRow | undefined;
  return row ? toSpigotAccount(row) : null;
}

export function upsertSpigotAccount(
  db: Db,
  input: {
    label: string;
    username: string;
    password: string;
    xfUser?: string;
    xfSession?: string;
    status?: AccountStatus;
    isEnabled?: boolean;
    issuedAt?: string | null;
    lastVerifiedAt?: string | null;
  },
): void {
  const currentTime = now();
  const existing = findSpigotAccountByLabel(db, input.label);

  const encPassword = encryptSecret(input.password);
  const encXfUser = input.xfUser ? encryptSecret(input.xfUser) : (existing ? encryptSecret(existing.xfUser.reveal()) : '');
  const encXfSession = input.xfSession ? encryptSecret(input.xfSession) : (existing ? encryptSecret(existing.xfSession.reveal()) : '');
  const status = input.status ?? existing?.status ?? 'ok';
  const isEnabled = input.isEnabled !== undefined ? (input.isEnabled ? 1 : 0) : (existing ? (existing.isEnabled ? 1 : 0) : 1);
  const issuedAt = input.issuedAt ?? existing?.issuedAt ?? null;
  const lastVerifiedAt = input.lastVerifiedAt ?? existing?.lastVerifiedAt ?? null;

  db.prepare(`
    INSERT INTO spigot_accounts (
      label, username, password_encrypted, xf_user_encrypted, xf_session_encrypted,
      issued_at, last_verified_at, status, is_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET
      username = excluded.username,
      password_encrypted = excluded.password_encrypted,
      xf_user_encrypted = CASE WHEN excluded.xf_user_encrypted != '' THEN excluded.xf_user_encrypted ELSE spigot_accounts.xf_user_encrypted END,
      xf_session_encrypted = CASE WHEN excluded.xf_session_encrypted != '' THEN excluded.xf_session_encrypted ELSE spigot_accounts.xf_session_encrypted END,
      issued_at = COALESCE(excluded.issued_at, spigot_accounts.issued_at),
      last_verified_at = COALESCE(excluded.last_verified_at, spigot_accounts.last_verified_at),
      status = excluded.status,
      is_enabled = excluded.is_enabled,
      updated_at = excluded.updated_at
  `).run(
    input.label,
    input.username,
    encPassword,
    encXfUser,
    encXfSession,
    issuedAt,
    lastVerifiedAt,
    status,
    isEnabled,
    currentTime,
    currentTime,
  );
}

export function updateSpigotAccountSession(
  db: Db,
  label: string,
  session: {
    xfUser?: string;
    xfSession?: string;
    issuedAt?: string | null;
    lastVerifiedAt?: string | null;
    status?: AccountStatus;
  },
): void {
  const existing = findSpigotAccountByLabel(db, label);
  if (!existing) return;

  const encXfUser = session.xfUser !== undefined ? encryptSecret(session.xfUser) : encryptSecret(existing.xfUser.reveal());
  const encXfSession = session.xfSession !== undefined ? encryptSecret(session.xfSession) : encryptSecret(existing.xfSession.reveal());
  const status = session.status ?? existing.status;
  const issuedAt = session.issuedAt !== undefined ? session.issuedAt : existing.issuedAt;
  const lastVerifiedAt = session.lastVerifiedAt !== undefined ? session.lastVerifiedAt : existing.lastVerifiedAt;
  const currentTime = now();

  db.prepare(`
    UPDATE spigot_accounts
    SET xf_user_encrypted = ?,
        xf_session_encrypted = ?,
        issued_at = ?,
        last_verified_at = ?,
        status = ?,
        updated_at = ?
    WHERE label = ?
  `).run(encXfUser, encXfSession, issuedAt, lastVerifiedAt, status, currentTime, label);
}

export function setSpigotAccountEnabled(db: Db, label: string, isEnabled: boolean): void {
  db.prepare('UPDATE spigot_accounts SET is_enabled = ?, updated_at = ? WHERE label = ?').run(
    isEnabled ? 1 : 0,
    now(),
    label,
  );
}

export function deleteSpigotAccount(db: Db, label: string): boolean {
  const result = db.prepare('DELETE FROM spigot_accounts WHERE label = ?').run(label);
  return result.changes > 0;
}

/**
 * Automatically imports and encrypts legacy JSON accounts/credentials into SQLite on startup.
 * Skips if spigot_accounts table already contains records.
 */
export function autoMigrateJsonAccountsToDb(
  db: Db,
  credentialsPath: string,
  accountsPath?: string,
): number {
  let migrated = 0;
  // 1. Read credentials
  if (existsSync(credentialsPath)) {
    try {
      const raw = readFileSync(credentialsPath);
      const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      
      let parsedCreds: Array<{ label: string; username: string; password: string; enabled?: boolean }> = [];
      if (text.trim().startsWith('[')) {
        parsedCreds = JSON.parse(text);
      } else {
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const [a, b, c] = parts;
            if (c) parsedCreds.push({ label: a!, username: b!, password: c });
            else parsedCreds.push({ label: a!, username: a!, password: b! });
          }
        }
      }

      // 2. Read accounts session cookies if available
      let accountsMap: Record<string, { xfUser?: string; xfSession?: string; issuedAt?: string; lastVerifiedAt?: string; status?: AccountStatus }> = {};
      if (accountsPath && existsSync(accountsPath)) {
        try {
          const rawAcc = readFileSync(accountsPath, 'utf8');
          const parsed = JSON.parse(rawAcc);
          if (Array.isArray(parsed)) {
            for (const acc of parsed) {
              if (acc.label) {
                accountsMap[acc.label] = {
                  xfUser: acc.xfUser,
                  xfSession: acc.xfSession,
                  issuedAt: acc.issuedAt,
                  lastVerifiedAt: acc.lastVerifiedAt,
                  status: acc.status,
                };
              }
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. Insert each into SQLite with AES-256-GCM encryption
      for (const cred of parsedCreds) {
        if (!cred.username || !cred.password) continue;
        const label = (cred.label || cred.username).trim();
        const existing = findSpigotAccountByLabel(db, label);
        if (existing) continue; // Already in DB, keep existing session cookies

        const session = accountsMap[label];

        upsertSpigotAccount(db, {
          label,
          username: cred.username.trim(),
          password: cred.password,
          xfUser: session?.xfUser,
          xfSession: session?.xfSession,
          status: session?.status ?? 'ok',
          isEnabled: cred.enabled !== false,
          issuedAt: session?.issuedAt,
          lastVerifiedAt: session?.lastVerifiedAt,
        });
        migrated++;
      }
    } catch (err) {
      console.error('Không thể auto-migrate accounts từ file json cũ:', err instanceof Error ? err.message : String(err));
    }
  }

  return migrated;
}
