import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const COOKIE_NAME = 'vault_session';

export type SessionRole = 'owner' | 'admin' | 'moderator' | 'support' | 'staff';

export type SessionPayload = {
  userId?: string;
  role: SessionRole;
  username: string;
  displayName: string;
  avatar?: string | null;
  authMethod: 'password' | 'discord';
  exp: number; // Unix timestamp seconds
};

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionPayload;
  }
}

/**
 * Tạo Cookie phiên có chữ ký HMAC-SHA256
 */
export function createSessionCookie(
  secret: string,
  ttlSeconds: number,
  user: Omit<SessionPayload, 'exp'>
): { name: string; value: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: SessionPayload = { ...user, exp };
  const jsonStr = JSON.stringify(payload);
  const data = Buffer.from(jsonStr, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return {
    name: COOKIE_NAME,
    value: `${data}.${sig}`,
    maxAge: ttlSeconds,
  };
}

/**
 * Xác thực Cookie phiên và trả về payload nếu hợp lệ
 */
export function verifySessionCookie(secret: string, cookieValue: string): SessionPayload | null {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expectedSig = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const jsonStr = Buffer.from(data, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * So sánh mật khẩu an toàn theo timing-safe
 */
export function passwordMatches(configuredPass: string, providedPass: string): boolean {
  try {
    const a = Buffer.from(configuredPass, 'utf8');
    const b = Buffer.from(providedPass, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Bộ giới hạn tần suất đăng nhập (In-memory Rate Limiter)
 */
export function makeLoginRateLimiter(maxAttempts: number, windowSeconds: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return function checkLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Math.floor(Date.now() / 1000);
    const record = attempts.get(ip);

    if (!record || record.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + windowSeconds });
      return { allowed: true, retryAfter: 0 };
    }

    if (record.count >= maxAttempts) {
      return { allowed: false, retryAfter: record.resetAt - now };
    }

    record.count++;
    return { allowed: true, retryAfter: 0 };
  };
}

/**
 * Pre-handler kiểm tra session người dùng
 */
export function makeRequireSession(secret: string) {
  return async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    const cookie = request.cookies[COOKIE_NAME];
    if (!cookie) {
      return reply.code(401).send({ error: 'Chưa đăng nhập' });
    }

    const session = verifySessionCookie(secret, cookie);
    if (!session) {
      return reply.code(401).send({ error: 'Phiên đã hết hạn hoặc không hợp lệ' });
    }

    request.sessionUser = session;
  };
}
