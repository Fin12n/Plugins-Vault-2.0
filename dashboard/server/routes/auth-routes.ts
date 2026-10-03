import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { staffs } from '@vault/db';
import { db } from '../db/neon.js';
import { env } from '../config/env.js';
import {
  COOKIE_NAME,
  createSessionCookie,
  makeLoginRateLimiter,
  passwordMatches,
} from '../auth/session.js';

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const OAUTH_STATE_COOKIE = 'discord_oauth_state';

const rateLimit = makeLoginRateLimiter(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);

function createSignedOAuthState(secret: string): string {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${nonce}.${timestamp}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySignedOAuthState(secret: string, state: string): boolean {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, timestampStr, sig] = parts;
  if (!nonce || !timestampStr || !sig) return false;
  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > 600 || now < timestamp - 60) return false;
  const data = `${nonce}.${timestampStr}`;
  const expectedSig = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function registerAuthRoutes(app: FastifyInstance) {
  // Đăng nhập mật khẩu chủ kho
  app.post('/api/login', async (request, reply) => {
    const limit = rateLimit(request.ip);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(limit.retryAfter))
        .send({ error: `Thử lại sau ${limit.retryAfter} giây` });
    }

    const bodySchema = z.object({ password: z.string() });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success || !passwordMatches(env.DASHBOARD_PASSWORD, parsed.data.password)) {
      return reply.code(401).send({ error: 'Mật khẩu không đúng' });
    }

    const session = createSessionCookie(env.SESSION_SECRET, SESSION_TTL_SECONDS, {
      userId: env.DISCORD_OWNER_ID,
      role: 'owner',
      username: 'Owner',
      displayName: 'Chủ sở hữu (Mật khẩu)',
      authMethod: 'password',
    });

    return reply
      .setCookie(session.name, session.value, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: session.maxAge,
        secure: env.PUBLIC_BASE_URL.startsWith('https://'),
      })
      .send({ ok: true });
  });

  // Đăng xuất
  app.post('/api/logout', async (_request, reply) => {
    return reply.clearCookie(COOKIE_NAME, { path: '/' }).send({ ok: true });
  });

  // Discord OAuth2 Login
  app.get('/api/auth/discord/login', async (_request, reply) => {
    if (!env.DISCORD_CLIENT_SECRET || !env.DISCORD_CLIENT_ID) {
      return reply.redirect('/?error=missing_secret');
    }

    const state = createSignedOAuthState(env.SESSION_SECRET);
    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const redirectUri = `${baseUrl}/api/auth/discord/callback`;
    const params = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'identify',
      state,
      prompt: 'consent',
    });

    return reply
      .setCookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60,
        secure: env.PUBLIC_BASE_URL.startsWith('https://'),
      })
      .redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  // Discord OAuth2 Callback
  app.get('/api/auth/discord/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const code = query.code;
    const state = query.state;
    const cookieState = request.cookies[OAUTH_STATE_COOKIE];

    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    const isStateValid =
      Boolean(state) &&
      ((cookieState && state === cookieState) || verifySignedOAuthState(env.SESSION_SECRET, state!));

    if (query.error || !code || !isStateValid || !env.DISCORD_CLIENT_SECRET) {
      return reply.redirect('/?error=invalid_state');
    }

    try {
      const baseUrl = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
      const redirectUri = `${baseUrl}/api/auth/discord/callback`;
      const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) return reply.redirect('/?error=token_exchange_failed');
      const tokenData = (await tokenRes.json()) as { access_token: string };

      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) return reply.redirect('/?error=user_fetch_failed');

      const discordUser = (await userRes.json()) as {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
      };

      const isOwner = discordUser.id === env.DISCORD_OWNER_ID;
      const staffRows = await db
        .select()
        .from(staffs)
        .where(eq(staffs.discordUserId, discordUser.id))
        .limit(1);
      const staffMember = staffRows[0];

      if (!isOwner && (!staffMember || !staffMember.isActive)) {
        return reply.redirect('/?error=unauthorized');
      }

      const role: 'owner' | 'staff' = isOwner || staffMember?.role === 'owner' ? 'owner' : 'staff';
      const displayName = discordUser.global_name || discordUser.username;
      const avatarUrl = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null;

      const session = createSessionCookie(env.SESSION_SECRET, SESSION_TTL_SECONDS, {
        userId: discordUser.id,
        role,
        username: discordUser.username,
        displayName,
        avatar: avatarUrl,
        authMethod: 'discord',
      });

      return reply
        .setCookie(session.name, session.value, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: session.maxAge,
          secure: env.PUBLIC_BASE_URL.startsWith('https://'),
        })
        .redirect('/');
    } catch {
      return reply.redirect('/?error=oauth_error');
    }
  });
}

/**
 * Các route yêu cầu quyền đăng nhập (Protected Routes)
 */
export function registerProtectedAuthRoutes(app: FastifyInstance) {
  // Lấy thông tin phiên hiện tại
  app.get('/api/session', async (request) => {
    const u = request.sessionUser;
    const role = u?.role ?? 'owner';
    const displayName = u?.displayName?.trim() || u?.username?.trim() || (role === 'owner' ? 'Chủ sở hữu' : 'Staff');
    return {
      ok: true,
      user: {
        role,
        displayName,
        authMethod: u?.authMethod ?? 'password',
        username: u?.username ?? (role === 'owner' ? 'Owner' : 'Staff'),
        userId: u?.userId,
        avatar: u?.avatar ?? null,
      },
    };
  });

  // Danh sách nhân viên
  app.get('/api/staff', async () => {
    const rows = await db.select().from(staffs).where(eq(staffs.isActive, true));
    return {
      ownerId: env.DISCORD_OWNER_ID,
      items: rows.map((s) => ({
        id: s.id,
        discordUserId: s.discordUserId,
        email: s.email,
        role: s.role,
        username: s.username,
        displayName: s.displayName,
        avatar: s.avatarUrl,
        addedBy: s.addedBy,
        createdAt: s.createdAt.getTime(),
      })),
    };
  });

  // Thêm nhân viên
  app.post('/api/staff', async (request, reply) => {
    if (request.sessionUser?.role !== 'owner') {
      return reply.code(403).send({ error: 'Chỉ Chủ sở hữu mới có quyền quản lý Staff' });
    }

    const schema = z.object({
      discordUserId: z.string().regex(/^\d{17,20}$/, 'ID Discord phải có 17-20 chữ số'),
      role: z.enum(['admin', 'moderator', 'support']).default('support'),
      email: z.string().email().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'ID không hợp lệ' });
    }

    const { discordUserId, role, email } = parsed.data;
    if (discordUserId === env.DISCORD_OWNER_ID) {
      return reply.code(400).send({ error: 'Tài khoản này là Chủ sở hữu, không cần thêm làm Staff' });
    }

    const [staff] = await db
      .insert(staffs)
      .values({
        discordUserId,
        email,
        username: `user_${discordUserId}`,
        displayName: `Staff ${discordUserId.slice(-4)}`,
        role,
        addedBy: request.sessionUser?.displayName || 'Owner',
        isActive: true,
      })
      .onConflictDoNothing()
      .returning();

    return { staff };
  });

  // Xóa nhân viên
  app.delete('/api/staff/:id', async (request, reply) => {
    if (request.sessionUser?.role !== 'owner') {
      return reply.code(403).send({ error: 'Chỉ Chủ sở hữu mới có quyền quản lý Staff' });
    }

    const params = z.object({ id: z.string().regex(/^\d{17,20}$/) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'ID không hợp lệ' });
    }

    await db.update(staffs).set({ isActive: false }).where(eq(staffs.discordUserId, params.data.id));
    return { ok: true, removed: true };
  });
}

