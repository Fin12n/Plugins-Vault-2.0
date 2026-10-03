import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';

/**
 * Spigot session cookies, loaded from a file the owner maintains by hand.
 *
 * Cookies rather than passwords on the hot path: the download endpoint accepts an
 * authenticated GET, so nothing here needs a browser. Logging in is a separate,
 * optional script — Cloudflare's challenge requires a real browser on a real
 * display, which must not be a dependency of the running bot.
 */

/**
 * A cookie value that cannot be logged by accident.
 *
 * Both toJSON and the inspect hook redact, so `JSON.stringify(err)`,
 * `console.log(account)`, template interpolation into a Discord message, and a
 * Fastify error serializer all produce the placeholder instead of the secret.
 * `reveal()` is the single deliberate way out, named so a review notices it.
 */
export class Secret {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return '[redacted]';
  }
}

/**
 * How healthy an account's stored session is.
 *
 * `stale` is a warning, not a failure: the cookie still works but is old enough
 * that a refresh should be scheduled. `needs_login` means verification failed and
 * only a human-supplied password can fix it. `locked` is terminal until the owner
 * intervenes — XenForo locks after repeated failures and the only escape is a
 * password reset, which invalidates every remember token for that account.
 */
export type AccountStatus = 'ok' | 'stale' | 'needs_login' | 'locked';

export type SpigotAccount = {
  /** Owner-facing name. The only field safe to display or log. */
  label: string;
  xfUser: Secret;
  xfSession: Secret;
  /**
   * When the cookie was minted, ISO-8601, or null when unknown.
   *
   * Load-bearing rather than decorative: `xf_user` is capped at 30 days by
   * XenForo and that ceiling is not configurable. Without an age the system can
   * only discover expiry after every download has already failed; with one, the
   * refresh job re-logins at day 20 and the owner never sees a failure.
   */
  issuedAt: string | null;
  /** Last time a probe or in-browser check confirmed the session, ISO-8601. */
  lastVerifiedAt: string | null;
  status: AccountStatus;
};

export type AccountStoreLoad =
  | { ok: true; accounts: SpigotAccount[] }
  | { ok: false; reason: 'missing' | 'malformed'; detail: string };

type RawAccount = {
  label?: unknown;
  xfUser?: unknown;
  xfSession?: unknown;
  issuedAt?: unknown;
  lastVerifiedAt?: unknown;
  status?: unknown;
};

const STATUSES: readonly AccountStatus[] = ['ok', 'stale', 'needs_login', 'locked'];

/** Reads a status, defaulting anything unrecognised to `ok`. */
function toStatus(raw: unknown): AccountStatus {
  return typeof raw === 'string' && (STATUSES as readonly string[]).includes(raw)
    ? (raw as AccountStatus)
    : 'ok';
}

/** Reads an ISO timestamp, or null. Never throws on junk. */
function toTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * Reads the accounts file.
 *
 * A missing file means the feature is off, not an error — auto-download is
 * opt-in and the bot must boot fine without it. Malformed JSON, by contrast,
 * fails loudly: silently treating a typo as "no accounts" would look identical
 * to the feature working and finding nothing to do.
 */
export function loadSpigotAccounts(path: string): AccountStoreLoad {
  if (!existsSync(path)) {
    return { ok: false, reason: 'missing', detail: path };
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: err instanceof Error ? err.message : String(err) };
  }

  // Written by hand on Windows often enough that a BOM is likely; JSON.parse
  // rejects it.
  const cleaned = text.replace(/^﻿/, '').trim();
  if (cleaned === '') return { ok: false, reason: 'malformed', detail: 'tệp rỗng' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: err instanceof Error ? err.message : 'JSON không hợp lệ' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'phải là một mảng tài khoản' };
  }

  const accounts: SpigotAccount[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'malformed', detail: `phần tử ${index} không phải object` };
    }
    const raw = entry as RawAccount;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const xfUser = typeof raw.xfUser === 'string' ? raw.xfUser.trim() : '';
    const xfSession = typeof raw.xfSession === 'string' ? raw.xfSession.trim() : '';

    if (label === '') return { ok: false, reason: 'malformed', detail: `phần tử ${index} thiếu label` };
    // xf_session alone expires in an hour; xf_user is what makes a session
    // long-lived, so an entry without it would work briefly then fail
    // mysteriously. Reject it at load instead.
    if (xfUser === '') return { ok: false, reason: 'malformed', detail: `tài khoản "${label}" thiếu xfUser` };
    if (seen.has(label)) return { ok: false, reason: 'malformed', detail: `label "${label}" bị trùng` };
    seen.add(label);

    accounts.push({
      label,
      xfUser: new Secret(xfUser),
      xfSession: new Secret(xfSession),
      // Absent in files written by an earlier build. Defaulted rather than
      // rejected: an existing accounts file must keep loading, and "unknown age"
      // is exactly what the refresh job treats as due.
      issuedAt: toTimestamp(raw.issuedAt),
      lastVerifiedAt: toTimestamp(raw.lastVerifiedAt),
      status: toStatus(raw.status),
    });
  }

  return { ok: true, accounts };
}

/**
 * Warns when the file is group- or world-readable.
 *
 * POSIX only: Windows permissions do not map onto the mode bits, and a false
 * warning there would train the owner to ignore a real one.
 */
export function checkAccountsFilePermissions(path: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${path} có quyền ${mode.toString(8)} — nên đặt 0600 (chmod 600)`;
    }
  } catch {
    // Unreadable is the caller's problem, reported through loadSpigotAccounts.
  }
  return null;
}

/** Builds the Cookie header value for one account. */
export function cookieHeaderFor(account: SpigotAccount): string {
  // Sent exactly as copied from the browser. xf_user is URL-encoded there
  // (`1,abc` arrives as `1%2Cabc`) and decoding it breaks authentication.
  const parts = [`xf_user=${account.xfUser.reveal()}`];
  if (account.xfSession.length > 0) parts.push(`xf_session=${account.xfSession.reveal()}`);
  return parts.join('; ');
}

/**
 * Persists rotated cookies.
 *
 * Temp-then-rename, the same discipline the vault uses for blobs: a crash or
 * ENOSPC partway through an in-place write truncates the JSON, and since a
 * malformed file fails loudly, that would brick the feature until the owner
 * SSHes in and re-pastes secrets.
 *
 * The temp file is created with mode 0600 so the secrets are never briefly
 * world-readable, and it sits in the same directory so the rename stays on one
 * filesystem.
 */
export function saveSpigotAccounts(path: string, accounts: SpigotAccount[]): void {
  const payload = accounts.map((account) => ({
    label: account.label,
    xfUser: account.xfUser.reveal(),
    xfSession: account.xfSession.reveal(),
    issuedAt: account.issuedAt,
    lastVerifiedAt: account.lastVerifiedAt,
    status: account.status,
  }));

  const temp = join(dirname(path), `.${Date.now()}-accounts.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone, or never created.
    }
    throw err;
  }
}

/**
 * Merges cookies observed in a response back into an account.
 *
 * Returns null when nothing changed, so the caller can skip the file write.
 *
 * Two rules matter. Only xf_user/xf_session are adopted — anything else is
 * Cloudflare or analytics state that does not belong in this file. And an empty
 * value is never adopted over a non-empty one: XenForo deletes a cookie by
 * setting it empty with a past expiry, so honouring that would destroy the
 * session the bot just used successfully.
 */
export function mergeSetCookies(
  account: SpigotAccount,
  setCookieLines: string[],
): { account: SpigotAccount; loggedOut: boolean } | null {
  let xfUser = account.xfUser;
  let xfSession = account.xfSession;
  let changed = false;
  let loggedOut = false;

  for (const line of setCookieLines) {
    const [pair] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();

    if (name === 'xf_user') {
      // An explicit deletion is the server telling us the remembered session is
      // gone. Surfaced rather than adopted, so the caller can stop the sweep.
      if (value === '' || value === 'deleted') {
        loggedOut = true;
        continue;
      }
      if (value !== xfUser.reveal()) {
        xfUser = new Secret(value);
        changed = true;
      }
    } else if (name === 'xf_session') {
      if (value === '' || value === 'deleted') continue;
      if (value !== xfSession.reveal()) {
        xfSession = new Secret(value);
        changed = true;
      }
    }
  }

  if (!changed && !loggedOut) return null;
  // Spread the original so issuedAt / lastVerifiedAt / status survive: a rotation
  // replaces the cookie value, not the account's history.
  return { account: { ...account, xfUser, xfSession }, loggedOut };
}

/**
 * Records an account's session health, leaving every other account untouched.
 *
 * Read-modify-write through the same atomic 0600 path as `saveSpigotAccounts`,
 * because this runs while the bot is live and a partial write would leave the
 * file unloadable — and a file missing `xf_user` is rejected at load, which reads
 * as corruption rather than as the status update it was.
 *
 * Silently does nothing when the file is missing or the label is unknown: a
 * status update is bookkeeping, and failing the caller over it would cost a
 * download that already succeeded.
 */
export function markAccountStatus(
  path: string,
  label: string,
  status: AccountStatus,
  options: { verifiedNow?: boolean } = {},
): void {
  const load = loadSpigotAccounts(path);
  if (!load.ok) return;

  let found = false;
  const updated = load.accounts.map((account) => {
    if (account.label !== label) return account;
    found = true;
    return {
      ...account,
      status,
      lastVerifiedAt: options.verifiedNow === true ? new Date().toISOString() : account.lastVerifiedAt,
    };
  });

  if (!found) return;
  saveSpigotAccounts(path, updated);
}

/** True when a cookie is old enough to refresh before XenForo's 30-day ceiling. */
export function needsRefresh(account: SpigotAccount, maxAgeDays = 20, nowMs = Date.now()): boolean {
  if (account.status !== 'ok') return true;
  // Unknown age is treated as due. A cookie written by an older build carries no
  // timestamp, and assuming it is fresh would let it expire unnoticed.
  if (account.issuedAt === null) return true;

  const issued = Date.parse(account.issuedAt);
  if (Number.isNaN(issued)) return true;
  return nowMs - issued >= maxAgeDays * 24 * 60 * 60 * 1000;
}
