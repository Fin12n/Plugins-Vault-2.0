import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Owner session cookie: `<payloadBase64Url>.<hmacBase64Url>`.
 *
 * A signed stateless cookie rather than a session store — there is exactly one
 * user, so a store would be pure overhead. The payload carries only an issue and
 * expiry timestamp; there is nothing user-specific to leak.
 */
const COOKIE_NAME = 'vault_session';

export type SessionUserRole = 'owner' | 'staff';
export type SessionAuthMethod = 'password' | 'discord';

export type SessionPayload = {
  issuedAt: number;
  expiresAt: number;
  userId?: string;
  role?: SessionUserRole;
  username?: string;
  displayName?: string;
  avatar?: string | null;
  authMethod?: SessionAuthMethod;
};

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSessionCookie(
  secret: string,
  ttlSeconds: number,
  user?: {
    userId?: string;
    role?: SessionUserRole;
    username?: string;
    displayName?: string;
    avatar?: string | null;
    authMethod?: SessionAuthMethod;
  },
): { name: string; value: string; maxAge: number } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    userId: user?.userId,
    role: user?.role ?? 'owner',
    username: user?.username,
    displayName: user?.displayName,
    avatar: user?.avatar,
    authMethod: user?.authMethod ?? 'password',
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { name: COOKIE_NAME, value: `${encoded}.${sign(secret, encoded)}`, maxAge: ttlSeconds };
}

/** Returns the payload when the cookie is authentic and unexpired. */
export function verifySessionCookie(secret: string, raw: string | undefined): SessionPayload | null {
  if (!raw) return null;

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = sign(secret, encoded);

  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.expiresAt !== 'number') return null;
    if (payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (!payload.role) payload.role = 'owner';
    if (!payload.authMethod) payload.authMethod = 'password';
    if (!payload.displayName) {
      payload.displayName = payload.username || (payload.role === 'owner' ? 'Chủ sở hữu (Mật khẩu)' : 'Staff');
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Constant-time password comparison.
 *
 * Both sides are hashed first so the comparison length is fixed regardless of
 * input, which avoids leaking the password length and sidesteps
 * timingSafeEqual's equal-length precondition.
 */
export function passwordMatches(expected: string, provided: string): boolean {
  const a = createHmac('sha256', 'pw').update(expected).digest();
  const b = createHmac('sha256', 'pw').update(provided).digest();
  return timingSafeEqual(a, b);
}

export { COOKIE_NAME };

/** For tests and first-run setup guidance. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
