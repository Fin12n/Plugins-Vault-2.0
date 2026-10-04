import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { seedSettings } from '../src/db/settings-store.js';
import { buildServer } from '../src/http/server.js';
import type { SpigotChallengeSessionController } from '../src/services/upstream/spigot-challenge-session.js';

const PASSWORD = 'owner-password-123';

describe('Spigot challenge dashboard API', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let cookie: string;
  let challenge: SpigotChallengeSessionController;

  beforeEach(async () => {
    const env = envSchema.parse({
      DISCORD_TOKEN: 'token',
      DISCORD_CLIENT_ID: '100000000000000001',
      DISCORD_GUILD_ID: '100000000000000002',
      DISCORD_ADMIN_ROLE_IDS: '100000000000000003',
      DISCORD_OWNER_ID: '100000000000000004',
      DISCORD_NOTIFY_CHANNEL_ID: '100000000000000005',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      DASHBOARD_PASSWORD: PASSWORD,
      SESSION_SECRET: 'k9Xq2mVt7bNr4aLp8sZw3eYc6uHd1oGf',
      SEPAY_WEBHOOK_SECRET: 'hmac-secret-value',
      SEPAY_ACCOUNT_NUMBER: '0010000000355',
      SEPAY_BANK_CODE: 'Vietcombank',
      SEPAY_CODE_PREFIX: 'vn',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mockdb',
    });
    db = new Database(':memory:');
    migrate(db);
    seedSettings(db, env);
    challenge = {
      getStatus: vi.fn(() => ({
        active: true,
        accountLabel: 'account-a',
        reason: 'Cloudflare challenge',
        startedAt: 100,
        expiresAt: 200,
      })),
      hasActive: vi.fn(() => true),
      captureFrame: vi.fn(async () => ({ image: Buffer.from('jpeg'), width: 1200, height: 800 })),
      movePointer: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
      typeText: vi.fn(async () => undefined),
      pressKey: vi.fn(async () => undefined),
      retryLogin: vi.fn(async () => ({ ok: true })),
      resolve: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    app = await buildServer({ db, env, challengeSessions: challenge });
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    cookie = login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const auth = () => ({ cookie });

  it('keeps browser frames and input behind the dashboard session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/spigot-challenge/frame' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/click', payload: { x: 0.5, y: 0.5 } })).statusCode).toBe(401);

    const status = await app.inject({ method: 'GET', url: '/api/spigot-challenge', headers: auth() });
    expect(status.json()).toMatchObject({ active: true, accountLabel: 'account-a' });
    expect(JSON.stringify(status.json())).not.toContain('password');

    const frame = await app.inject({ method: 'GET', url: '/api/spigot-challenge/frame', headers: auth() });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-type']).toContain('image/jpeg');
    expect(frame.headers['x-frame-width']).toBe('1200');
    expect(frame.rawPayload).toEqual(Buffer.from('jpeg'));
  });

  it('validates and forwards dashboard browser controls', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/click', headers: auth(), payload: { x: 2, y: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/pointer', headers: auth(), payload: { x: -1, y: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/key', headers: auth(), payload: { key: 'F12' } })).statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/pointer', headers: auth(), payload: { x: 0.1, y: 0.2 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/click', headers: auth(), payload: { x: 0.25, y: 0.75 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/type', headers: auth(), payload: { text: 'hello' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/spigot-challenge/key', headers: auth(), payload: { key: 'Enter' } })).statusCode).toBe(200);

    expect(challenge.movePointer).toHaveBeenCalledWith(0.1, 0.2);
    expect(challenge.click).toHaveBeenCalledWith(0.25, 0.75);
    expect(challenge.typeText).toHaveBeenCalledWith('hello');
    expect(challenge.pressKey).toHaveBeenCalledWith('Enter');
  });

  it('resumes the queue only after a successful login retry', async () => {
    const retry = await app.inject({ method: 'POST', url: '/api/spigot-challenge/retry', headers: auth() });
    expect(retry.statusCode).toBe(200);
    expect(challenge.retryLogin).toHaveBeenCalledOnce();
    expect(challenge.resolve).toHaveBeenCalledOnce();

    const close = await app.inject({ method: 'DELETE', url: '/api/spigot-challenge', headers: auth() });
    expect(close.statusCode).toBe(200);
    expect(challenge.close).toHaveBeenCalledOnce();
  });
});
