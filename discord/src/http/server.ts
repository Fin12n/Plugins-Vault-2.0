import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import rawBody from 'fastify-raw-body';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { Db } from '../db/connection.js';
import { makeLoginRateLimiter, makeRequireSession } from './auth/require-session.js';
import { COOKIE_NAME, createSessionCookie, passwordMatches } from './auth/session-cookie.js';
import { registerDashboardRoutes } from './routes/dashboard-api.js';
import { registerDownloadRoute } from './routes/download-version.js';
import { registerSepayWebhook } from './routes/sepay-webhook.js';
import { registerUploadRoute } from './routes/upload-jars.js';
import { addStaff, findStaffById, listStaff, removeStaff } from '../repositories/dashboard-staff.js';
import { resolveDiscordUserProfile } from '../services/discord/user-resolver.js';
import type { DeliveryDeps } from '../services/delivery/deliver-version.js';
import type { UpdateRunStatus } from '../services/maintenance/scheduler.js';
import type { SpigotChallengeSessionController } from '../services/upstream/spigot-challenge-session.js';

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const OAUTH_STATE_COOKIE = 'discord_oauth_state';

/**
 * Delivery is optional so tests can build a server without a Discord client.
 * When absent, the payment webhook and the manual-release route are not mounted.
 */
export type MaintenanceControl = {
  triggerUpdateCheck: (forcePurchasedScan?: boolean) => boolean;
  triggerFullBatchDownload?: (options?: { autoResolveIds?: boolean }) => boolean;
  triggerScanOnly?: () => boolean;
  triggerOrderedDownload?: () => boolean;
  getUpdateStatus: () => UpdateRunStatus;
  getCurrentOperation?: () => 'idle' | 'scanning' | 'downloading';
  isReady?: () => boolean;
  abortSweep?: () => Promise<boolean>;
  rotateProxy?: () => Promise<{ ok: boolean; currentProxyIp: string | null; error?: string }>;
};

import { pingNeon, type Database } from '../db/neon.js';

export type ServerDeps = {
  db: Db;
  neonDb?: Database;
  env: Env;
  delivery?: DeliveryDeps;
  maintenance?: MaintenanceControl;
  challengeSessions?: SpigotChallengeSessionController;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, env } = deps;

  const app = Fastify({
    // Without this, request.ip is the proxy's address behind a reverse proxy, so
    // the audit log would record one IP for every download and the login rate
    // limiter would key every attempt to a single bucket.
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Silent under vitest: request logs would drown the test reporter's output.
    logger: process.env.NODE_ENV === 'test' || process.env.VITEST ? false : { level: 'info' },
  });

  await app.register(cookie);

  /**
   * Lỗi xác thực dữ liệu là lỗi của người gửi, không phải lỗi máy chủ.
   *
   * Không có chỗ này thì mọi `schema.parse` thất bại nổi lên thành HTTP 500 với thân
   * `{"error":"Internal Server Error"}` — dashboard in đúng câu tiếng Anh đó ra cho
   * chủ kho, và một giá trị nhập sai trông y như máy chủ hỏng. Đo được: nhập giá cọc
   * có dấu phẩy, hoặc gõ tay một tháng không đúng dạng, đều đi vào nhánh này.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof z.ZodError) {
      const field = error.issues[0]?.path.join('.') ?? '';
      const detail = error.issues[0]?.message ?? 'không hợp lệ';
      return reply.code(400).send({ error: field ? `Giá trị "${field}" không hợp lệ: ${detail}` : `Dữ liệu gửi lên không hợp lệ: ${detail}` });
    }
    // Giữ nguyên mã lỗi Fastify đã đặt (413 tệp quá lớn, 429 quá nhiều lần...).
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'Lỗi không xử lý được');
      return reply.code(status).send({ error: 'Máy chủ gặp lỗi khi xử lý yêu cầu' });
    }
    return reply.code(status).send({ error: error instanceof Error ? error.message : 'Yêu cầu không hợp lệ' });
  });

  // Health check có kiểm tra kết nối Neon
  app.get('/api/health', async (_request, reply) => {
    try {
      if (deps.neonDb) {
        await pingNeon(deps.neonDb);
      }
      return reply.code(200).send({
        status: 'ok',
        service: 'vault-discord-bot',
        database: deps.neonDb ? 'connected' : 'local_only',
        discordReady: deps.delivery?.client?.isReady() ?? false,
        timestamp: Date.now(),
      });
    } catch (err) {
      return reply.code(503).send({
        status: 'unhealthy',
        service: 'vault-discord-bot',
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
  });

  app.get('/health', async (_request, reply) => {
    return reply.redirect('/api/health');
  });

  // routeSpecific keeps the raw-body capture on the webhook route only, so normal
  // JSON routes are unaffected.
  await app.register(rawBody, { field: 'rawBody', global: false, runFirst: true, encoding: false });

  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      // Per FILE, not per request. Left unset it inherits bodyLimit (1 MB) and
      // every real plugin jar would be rejected.
      fileSize: env.UPLOAD_MAX_FILE_BYTES,
      files: env.UPLOAD_MAX_FILES,
      fields: 10,
      fieldSize: 1024,
      parts: env.UPLOAD_MAX_FILES + 10,
    },
  });

  const requireSession = makeRequireSession(env.SESSION_SECRET);
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
  // Valid for 10 minutes (600 seconds) with 60s clock skew tolerance
  if (now - timestamp > 600 || now < timestamp - 60) return false;
  const data = `${nonce}.${timestampStr}`;
  const expectedSig = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

  // Discord OAuth2 Login initiation
  app.get('/api/auth/discord/login', async (_request, reply) => {
    if (!env.DISCORD_CLIENT_SECRET) {
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

    const isHttps = env.PUBLIC_BASE_URL.startsWith('https://');
    return reply
      .setCookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60, // 10 minutes
        secure: isHttps,
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

    if (query.error || !code || !isStateValid) {
      return reply.redirect('/?error=invalid_state');
    }

    if (!env.DISCORD_CLIENT_SECRET) {
      return reply.redirect('/?error=missing_secret');
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

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        app.log.error({ status: tokenRes.status, errorBody, redirectUri }, 'Discord token exchange failed');
        return reply.redirect('/?error=token_exchange_failed');
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) {
        const errorBody = await userRes.text();
        app.log.error({ status: userRes.status, errorBody }, 'Discord user fetch failed');
        return reply.redirect('/?error=user_fetch_failed');
      }

      const discordUser = (await userRes.json()) as {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
      };

      const isOwner = discordUser.id === env.DISCORD_OWNER_ID;
      const staffMember = !isOwner ? findStaffById(deps.db, discordUser.id) : null;

      if (!isOwner && !staffMember) {
        return reply.redirect('/?error=unauthorized');
      }

      const role = isOwner ? 'owner' : 'staff';
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

  app.post('/api/login', async (request, reply) => {
    const limit = rateLimit(request.ip);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(limit.retryAfter))
        .send({ error: `Thử lại sau ${limit.retryAfter} giây` });
    }

    const body = z.object({ password: z.string() }).safeParse(request.body);
    if (!body.success || !passwordMatches(env.DASHBOARD_PASSWORD, body.data.password)) {
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
        // Cookies must not travel over plaintext in production; localhost dev
        // would never receive the cookie back if this were unconditional.
        secure: env.PUBLIC_BASE_URL.startsWith('https://'),
      })
      .send({ ok: true });
  });

  app.post('/api/logout', async (_request, reply) =>
    reply.clearCookie(COOKIE_NAME, { path: '/' }).send({ ok: true }),
  );

  // Everything under /api except login/logout requires the session. Registered in
  // a plugin scope so the hook cannot leak onto the static file routes.
  await app.register(async (scope) => {
    scope.addHook('preHandler', requireSession);
    scope.get('/api/session', async (request) => {
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

    // Staff Management
    scope.get('/api/staff', async () => {
      const items = listStaff(deps.db);
      return {
        ownerId: env.DISCORD_OWNER_ID,
        items,
      };
    });

    scope.post('/api/staff', async (request, reply) => {
      if (request.sessionUser?.role !== 'owner') {
        return reply.code(403).send({ error: 'Chỉ Chủ sở hữu mới có quyền quản lý Staff' });
      }

      const body = z
        .object({
          discordUserId: z.string().regex(/^\d{17,20}$/, 'ID Discord phải có 17-20 chữ số'),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'ID không hợp lệ' });
      }

      const { discordUserId } = body.data;
      if (discordUserId === env.DISCORD_OWNER_ID) {
        return reply.code(400).send({ error: 'Tài khoản này là Chủ sở hữu, không cần thêm làm Staff' });
      }

      const profile = await resolveDiscordUserProfile(deps.delivery?.client, discordUserId);
      const staff = addStaff(deps.db, {
        discordUserId,
        username: profile.username,
        displayName: profile.displayName,
        avatar: profile.avatarUrl,
        addedBy: request.sessionUser?.displayName || request.sessionUser?.username || 'Owner',
      });

      return { staff };
    });

    scope.delete('/api/staff/:id', async (request, reply) => {
      if (request.sessionUser?.role !== 'owner') {
        return reply.code(403).send({ error: 'Chỉ Chủ sở hữu mới có quyền quản lý Staff' });
      }

      const params = z.object({ id: z.string().regex(/^\d{17,20}$/) }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'ID không hợp lệ' });
      }

      const removed = removeStaff(deps.db, params.data.id);
      return { ok: true, removed };
    });

    registerUploadRoute(scope, deps);
    registerDashboardRoutes(scope, deps);
  });

  // Outside the session scope on purpose: possession of the one-shot token is the
  // authorization, and the admin receiving it has no dashboard credentials.
  registerDownloadRoute(app, deps);

  // Also outside: SePay authenticates with an HMAC signature, not a session. Always
  // mounted, even without a bot — an unmounted route would answer a real transfer
  // with a 404 and have SePay retry for hours against an endpoint that can never
  // succeed. Without a bot the payment is still recorded for manual release.
  registerSepayWebhook(app, deps);

  await registerDashboard(app);
  return app;
}

/**
 * Serves the built dashboard, falling back to index.html so client-side routes
 * survive a refresh. Skipped when the build output is absent so the API can run
 * in development against Vite's dev server.
 */
async function registerDashboard(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'dashboard/dist'),
    resolve(here, '../../dashboard/dist'),
    resolve(here, '../../../dashboard/dist'),
  ];
  const root = candidates.find((path) => existsSync(join(path, 'index.html')));
  if (!root) {
    app.log.warn('Không tìm thấy dashboard/dist — chỉ phục vụ API');
    return;
  }

  app.log.info(`Đã mount dashboard tại: ${root}`);
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    setHeaders: (res, pathName) => {
      if (pathName.endsWith('.html')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');
      }
    },
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Không tìm thấy' });
    }
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return reply.sendFile('index.html');
  });
}

