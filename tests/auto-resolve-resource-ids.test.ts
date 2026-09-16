import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/db/migrate.js';
import { createPlugin, findPluginById } from '../src/repositories/plugins.js';
import { seedSettings, setSetting } from '../src/db/settings-store.js';
import { autoResolveMissingResourceIds } from '../src/services/upstream/auto-resolve-resource-ids.js';
import { buildServer } from '../src/http/server.js';
import { envSchema, type Env } from '../src/config/env.js';

const PASSWORD = 'owner-password-123';

function makeEnv(root: string): Env {
  return envSchema.parse({
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
    VAULT_DIR: join(root, 'vault'),
    TMP_DIR: join(root, 'tmp'),
    DB_PATH: join(root, 'db.sqlite'),
    SPIGOT_CREDENTIALS_FILE: join(root, 'spigot-credentials.json'),
    SPIGOT_ACCOUNTS_FILE: join(root, 'spigot-accounts.json'),
  });
}

describe('autoResolveMissingResourceIds', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves missing resource id from Spiget search mock and updates external_link', async () => {
    const plugin = createPlugin(db, {
      slug: 'itemedit',
      displayName: 'ItemEdit',
      descriptorName: 'ItemEdit',
      platform: 'spigot',
      resourceId: null,
      externalLink: undefined,
    });

    const mockFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('ItemEdit')) {
        return new Response(
          JSON.stringify([
            { id: 40954, name: 'ItemEdit', tag: 'A great item editor' },
            { id: 99999, name: 'Unrelated Plugin', tag: 'Something else' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await autoResolveMissingResourceIds(db, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      delayMs: 0,
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      pluginId: plugin.id,
      displayName: 'ItemEdit',
      resourceId: 40954,
    });

    const updated = findPluginById(db, plugin.id);
    expect(updated?.resourceId).toBe(40954);
    expect(updated?.externalLink).toBe('https://www.spigotmc.org/resources/40954/');
  });

  it('skips plugins that already have a resourceId', async () => {
    const plugin = createPlugin(db, {
      slug: 'existing',
      displayName: 'ExistingPlugin',
      descriptorName: 'ExistingPlugin',
      platform: 'spigot',
      resourceId: 12345,
      externalLink: 'https://example.com',
    });

    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return new Response('[]', { status: 200 });
    };

    const result = await autoResolveMissingResourceIds(db, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      delayMs: 0,
    });

    expect(result.resolved).toHaveLength(0);
    expect(fetchCalled).toBe(false);
    expect(findPluginById(db, plugin.id)?.resourceId).toBe(12345);
  });

  it('marks as unresolved when no match is found', async () => {
    const plugin = createPlugin(db, {
      slug: 'unknownplugin',
      displayName: 'SuperUniquePluginThatDoesNotExist999',
      descriptorName: 'SuperUniquePluginThatDoesNotExist999',
      platform: 'spigot',
      resourceId: null,
      externalLink: undefined,
    });

    const mockFetch = async () =>
      new Response(JSON.stringify([{ id: 111, name: 'Completely Different Name' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await autoResolveMissingResourceIds(db, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      delayMs: 0,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.pluginId).toBe(plugin.id);
    expect(findPluginById(db, plugin.id)?.resourceId).toBeNull();
  });
});

describe('POST /api/spigot-downloads/run-all', () => {
  let root: string;
  let db: Database.Database;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-all-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const env = makeEnv(root);
    seedSettings(db, env);
    setSetting(db, 'dashboard_password', PASSWORD);
    setSetting(db, 'auto_download_enabled', 'true');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('triggers full batch download and returns 202', async () => {
    let triggeredWith: { autoResolveIds?: boolean } | undefined;
    const env = makeEnv(root);
    const app = await buildServer({
      db,
      env,
      maintenance: {
        triggerUpdateCheck: () => true,
        triggerFullBatchDownload: (options) => {
          triggeredWith = options;
          return true;
        },
        getUpdateStatus: () => ({ running: true, lastStartedAt: Date.now(), lastFinishedAt: null }),
        isReady: () => true,
      },
    });

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'] as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/spigot-downloads/run-all',
      payload: { autoResolveIds: true },
      headers: { cookie },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ running: true });
    expect(triggeredWith).toEqual({ autoResolveIds: true });

    await app.close();
  });

  it('returns 409 when batch download is already in flight', async () => {
    const env = makeEnv(root);
    const app = await buildServer({
      db,
      env,
      maintenance: {
        triggerUpdateCheck: () => false,
        triggerFullBatchDownload: () => false,
        getUpdateStatus: () => ({ running: true, lastStartedAt: Date.now(), lastFinishedAt: null }),
        isReady: () => true,
      },
    });

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'] as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/spigot-downloads/run-all',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('đang chạy') });

    await app.close();
  });
});
