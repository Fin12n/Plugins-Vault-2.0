import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from './config/env.js';
import { makeRequireSession } from './auth/session.js';
import { registerAuthRoutes, registerProtectedAuthRoutes } from './routes/auth-routes.js';
import { registerPluginsRoutes } from './routes/plugins-routes.js';
import { registerOrdersRoutes } from './routes/orders-routes.js';
import { registerDiscountsRoutes } from './routes/discounts-routes.js';
import { registerWalletsRoutes } from './routes/wallets-routes.js';
import { registerSpigotRoutes } from './routes/spigot-routes.js';
import { registerStatsRoutes } from './routes/stats-routes.js';
import { registerSettingsRoutes } from './routes/settings-routes.js';
import { registerUploadRoutes } from './routes/upload-routes.js';
import { registerLogRoutes } from './routes/log-routes.js';
import { registerLeaderboardRoutes } from './routes/leaderboard-routes.js';
import { db, pingNeon } from './db/neon.js';

export async function buildDashboardServer() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // CORS cho Vite dev server
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie);

  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      fileSize: env.UPLOAD_MAX_FILE_BYTES,
      files: env.UPLOAD_MAX_FILES,
      fields: 10,
      fieldSize: 1024,
      parts: env.UPLOAD_MAX_FILES + 10,
    },
  });

  // Error Handler tập trung
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof z.ZodError) {
      const field = error.issues[0]?.path.join('.') ?? '';
      const detail = error.issues[0]?.message ?? 'không hợp lệ';
      return reply
        .code(400)
        .send({ error: field ? `Giá trị "${field}" không hợp lệ: ${detail}` : `Dữ liệu không hợp lệ: ${detail}` });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'Lỗi máy chủ không xử lý được');
      return reply.code(status).send({ error: 'Máy chủ gặp lỗi khi xử lý yêu cầu' });
    }
    return reply.code(status).send({ error: error instanceof Error ? error.message : 'Yêu cầu không hợp lệ' });
  });

  // Health check có ping thực tế cơ sở dữ liệu Neon
  app.get('/api/health', async (_request, reply) => {
    try {
      await pingNeon(db);
      return reply.code(200).send({
        status: 'ok',
        service: 'plugin-vault-dashboard',
        database: 'connected',
        timestamp: Date.now(),
      });
    } catch (err) {
      return reply.code(503).send({
        status: 'unhealthy',
        service: 'plugin-vault-dashboard',
        database: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
  });

  // Public Auth Routes (Login, Logout, Discord OAuth)
  registerAuthRoutes(app);

  // Protected Routes (Yêu cầu đăng nhập)
  const requireSession = makeRequireSession(env.SESSION_SECRET);

  await app.register(async (scope) => {
    scope.addHook('preHandler', requireSession);

    registerProtectedAuthRoutes(scope);
    registerPluginsRoutes(scope);
    registerOrdersRoutes(scope);
    registerDiscountsRoutes(scope);
    registerWalletsRoutes(scope);
    registerSpigotRoutes(scope);
    registerStatsRoutes(scope);
    registerSettingsRoutes(scope);
    registerUploadRoutes(scope);
    registerLogRoutes(scope);
    registerLeaderboardRoutes(scope);
  });

  // Phục vụ Static Files SPA Dashboard nếu có dist/
  await registerStaticDashboard(app);

  return app;
}

async function registerStaticDashboard(app: ReturnType<typeof Fastify>) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'dist'),
    resolve(process.cwd(), 'dashboard/dist'),
    resolve(here, '../dist'),
    resolve(here, '../../dist'),
  ];

  const root = candidates.find((p) => existsSync(join(p, 'index.html')));

  if (!root) {
    app.log.warn('⚠️ Không tìm thấy dist/index.html — Chỉ phục vụ API endpoints.');
    return;
  }

  app.log.info(`🚀 Đã mount Single Page Application từ thư mục: ${root}`);

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    setHeaders: (res: any, pathName: string) => {
      if (pathName.endsWith('.html')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  });

  app.setNotFoundHandler(async (request: any, reply: any) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Endpoint API không tìm thấy' });
    }
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return reply.sendFile('index.html');
  });

}

// Chạy trực tiếp nếu là entrypoint
const isMain = process.argv[1] && (
  process.argv[1].endsWith('server/index.ts') || 
  process.argv[1].endsWith('server/index.js') ||
  process.argv[1].endsWith('server\\index.ts') ||
  process.argv[1].endsWith('server\\index.js')
);

if (isMain) {
  try {
    const server = await buildDashboardServer();
    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`\n=================================================`);
    console.log(`✨ VAULT ADMIN DASHBOARD ĐANG CHẠY TẠI:`);
    console.log(`👉 http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`);
    console.log(`=================================================\n`);

    let shuttingDown = false;
    const handleShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nNhận tín hiệu ${signal}, đang dừng Dashboard Server...`);

      const forceExitTimer = setTimeout(() => {
        console.error('⚠️ Quá thời gian chờ shutdown (30s) — Buộc thoát khẩn cấp');
        process.exit(1);
      }, 30_000);
      forceExitTimer.unref();

      try {
        await server.close();
        console.log('✅ Dashboard Server đã dừng an toàn');
        process.exit(0);
      } catch (err) {
        console.error('Lỗi khi dừng server:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => void handleShutdown('SIGINT'));
    process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  } catch (err) {
    console.error('❌ Khởi động Dashboard Server thất bại:', err);
    process.exit(1);
  }
}

