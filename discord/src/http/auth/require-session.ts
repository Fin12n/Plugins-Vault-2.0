import type { FastifyReply, FastifyRequest } from 'fastify';
import { COOKIE_NAME, verifySessionCookie, type SessionPayload } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionPayload;
  }
}

/**
 * Guard for every /api route except login.
 *
 * Returns JSON 401 rather than redirecting: the client is a single-page app and a
 * redirect would surface to fetch() as an opaque HTML response.
 */
export function makeRequireSession(secret: string) {
  return async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = request.cookies[COOKIE_NAME];
    const payload = verifySessionCookie(secret, raw);
    if (!payload) {
      await reply.code(401).send({ error: 'Chưa đăng nhập' });
      return;
    }
    request.sessionUser = payload;
  };
}

/**
 * Fixed-window rate limiter for the login route, keyed by client address.
 *
 * In-memory on purpose: one owner, one process, and a restart clearing the
 * counters is an acceptable trade for having no dependency. Note this is only
 * meaningful when TRUST_PROXY is set correctly behind a reverse proxy — otherwise
 * every request keys to the proxy address and one attacker locks out the owner.
 */
export function makeLoginRateLimiter(maxAttempts: number, windowSeconds: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return function check(key: string): { allowed: boolean; retryAfter: number } {
    const now = Math.floor(Date.now() / 1000);
    const entry = attempts.get(key);

    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowSeconds });
      return { allowed: true, retryAfter: 0 };
    }

    entry.count++;
    if (entry.count > maxAttempts) {
      return { allowed: false, retryAfter: entry.resetAt - now };
    }
    return { allowed: true, retryAfter: 0 };
  };
}
