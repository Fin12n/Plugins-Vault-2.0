import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envSchema, type Env } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { createOrder, markOrderStatus } from '../src/repositories/orders.js';
import { createPlugin, updatePlugin } from '../src/repositories/plugins.js';
import { findScanState, recordScan } from '../src/repositories/account-scan-state.js';
import { seedSettings, setSetting } from '../src/db/settings-store.js';
import { buildServer } from '../src/http/server.js';
import { buildZip } from './helpers/jar-fixture-builder.js';

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

/** Multipart body with one or more jar files. */
function multipartBody(files: { field: string; filename: string; content: Buffer }[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----vaulttestboundary1234567890';
  const parts: Buffer[] = [];

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: application/java-archive\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function pluginJar(name: string, version: string): Buffer {
  return buildZip([
    { name: 'plugin.yml', data: Buffer.from(`name: ${name}\nversion: ${version}\nmain: a.B\n`, 'utf8') },
  ]);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('dashboard API', () => {
  let app: FastifyInstance;
  let root: string;
  let db: Database.Database;
  let cookie: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-http-'));
    const env = makeEnv(root);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    seedSettings(db, env);
    app = await buildServer({ db, env });

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    cookie = login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const auth = () => ({ cookie });

  describe('authentication', () => {
    it('refuses every API route without a session', async () => {
      for (const url of ['/api/plugins', '/api/pending', '/api/settings', '/api/log', '/api/stats/monthly']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    });

    it('refuses upload without a session', async () => {
      const body = multipartBody([{ field: 'files', filename: 'x.jar', content: pluginJar('X', '1.0.0') }]);
      const res = await app.inject({ method: 'POST', url: '/api/upload', payload: body.payload, headers: body.headers });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a wrong password', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a forged session cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/plugins',
        headers: { cookie: 'vault_session=eyJleHBpcmVzQXQiOjk5OTk5OTk5OTl9.forgedsignature' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rate-limits repeated login failures', async () => {
      let sawLimit = false;
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
        if (res.statusCode === 429) {
          expect(res.headers['retry-after']).toBeDefined();
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit).toBe(true);
    });

    it('accepts the session after logout only until the cookie is cleared', async () => {
      const out = await app.inject({ method: 'POST', url: '/api/logout', headers: auth() });
      expect(out.statusCode).toBe(200);
      expect(out.headers['set-cookie']).toContain('vault_session=');
    });

    it('returns a valid, non-empty displayName from /api/session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/session', headers: auth() });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.user.displayName).toBeDefined();
      expect(typeof json.user.displayName).toBe('string');
      expect(json.user.displayName.trim().length).toBeGreaterThan(0);
    });
  });

  describe('upload', () => {
    it('ingests a batch and reports per-file outcomes', async () => {
      const body = multipartBody([
        { field: 'files', filename: 'Alpha-1.0.0.jar', content: pluginJar('Alpha', '1.0.0') },
        { field: 'files', filename: 'Beta-2.0.0.jar', content: pluginJar('Beta', '2.0.0') },
        { field: 'files', filename: 'broken.jar', content: Buffer.from('not a zip at all') },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json() as { results: { status: string }[]; summary: Record<string, number> };
      expect(json.results.map((r) => r.status)).toEqual(['added', 'added', 'pending']);
      expect(json.summary).toMatchObject({ added: 2, pending: 1 });
    });

    it('reports a duplicate on re-upload without creating a second version', async () => {
      const jar = pluginJar('Dup', '1.0.0');
      const first = multipartBody([{ field: 'files', filename: 'dup.jar', content: jar }]);
      await app.inject({ method: 'POST', url: '/api/upload', payload: first.payload, headers: { ...first.headers, ...auth() } });

      const second = multipartBody([{ field: 'files', filename: 'dup-again.jar', content: jar }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: second.payload,
        headers: { ...second.headers, ...auth() },
      });

      expect((res.json() as { results: { status: string }[] }).results[0]?.status).toBe('duplicate');
      expect((db.prepare('SELECT count(*) AS c FROM versions').get() as { c: number }).c).toBe(1);
    });

    it('rejects a request with no files', async () => {
      const body = multipartBody([]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('plugins and versions', () => {
    async function upload(name: string, version: string) {
      const body = multipartBody([{ field: 'files', filename: `${name}.jar`, content: pluginJar(name, version) }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });
      return (res.json() as { results: { pluginId: number; versionId: number }[] }).results[0]!;
    }

    it('paginates the plugin list', async () => {
      for (let i = 0; i < 5; i++) await upload(`Plug${i}`, '1.0.0');

      const res = await app.inject({ method: 'GET', url: '/api/plugins?page=1&pageSize=2', headers: auth() });
      const json = res.json() as { items: unknown[]; total: number; totalPages: number };
      expect(json.items).toHaveLength(2);
      expect(json.total).toBe(5);
      expect(json.totalPages).toBe(3);
    });

    it('searches plugins by name', async () => {
      await upload('MythicMobs', '5.0.0');
      await upload('WorldEdit', '7.0.0');

      const res = await app.inject({ method: 'GET', url: '/api/plugins?q=mythic', headers: auth() });
      const json = res.json() as { items: { displayName: string }[] };
      expect(json.items).toHaveLength(1);
      expect(json.items[0]?.displayName).toBe('MythicMobs');
    });

    it('sets a deposit price per plugin', async () => {
      const added = await upload('Priced', '1.0.0');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${added.pluginId}`,
        payload: { depositPrice: 25000 },
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { depositPrice: number }).depositPrice).toBe(25000);
    });

    it('rejects a negative deposit price', async () => {
      const added = await upload('Negative', '1.0.0');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${added.pluginId}`,
        payload: { depositPrice: -1 },
        headers: auth(),
      });
      // 400 kèm câu tiếng Việt, không phải 500: một giá trị nhập sai là lỗi của người
      // gửi, và trước đây dashboard in ra đúng chữ "Internal Server Error".
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('không hợp lệ');
    });

    it('auto-populates externalLink when creating plugin with resourceId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins',
        payload: { displayName: 'SpigotAutoLink', resourceId: 83626 },
        headers: auth(),
      });
      expect(res.statusCode).toBe(201);
      const json = res.json() as { externalLink: string; resourceId: number };
      expect(json.resourceId).toBe(83626);
      expect(json.externalLink).toBe('https://www.spigotmc.org/resources/83626/');
    });

    it('auto-populates externalLink when patching plugin with resourceId', async () => {
      const added = await upload('PatchSpigotLink', '1.0.0');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${added.pluginId}`,
        payload: { resourceId: 99999 },
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { externalLink: string; resourceId: number };
      expect(json.resourceId).toBe(99999);
      expect(json.externalLink).toBe('https://www.spigotmc.org/resources/99999/');
    });

    it('deletes a plugin and all associated version blobs', async () => {
      const added = await upload('PluginToDelete', '1.0.0');
      const row = db.prepare('SELECT rel_path FROM versions WHERE id = ?').get(added.versionId) as { rel_path: string };
      const blob = join(root, 'vault', row.rel_path);
      expect(existsSync(blob)).toBe(true);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/plugins/${added.pluginId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deleted: true, removedVersions: 1 });
      expect(existsSync(blob)).toBe(false);
      expect(db.prepare('SELECT * FROM plugins WHERE id = ?').get(added.pluginId)).toBeUndefined();
    });

    it('bulk deletes selected plugins by id', async () => {
      const p1 = await upload('BulkDelA', '1.0.0');
      const p2 = await upload('BulkDelB', '1.0.0');

      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/bulk-delete',
        payload: { ids: [p1.pluginId, p2.pluginId] },
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deletedCount: 2, removedVersions: 2 });
      expect(db.prepare('SELECT * FROM plugins WHERE id IN (?, ?)').all(p1.pluginId, p2.pluginId)).toHaveLength(0);
    });

    it('corrects a version string and marks it stable', async () => {
      const added = await upload('Fixable', '1.0.0');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/versions/${added.versionId}`,
        payload: { version: '1.0.1', isStable: true },
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);

      const row = db.prepare('SELECT version, is_stable, version_flag FROM versions WHERE id = ?').get(added.versionId);
      expect(row).toMatchObject({ version: '1.0.1', is_stable: 1, version_flag: 'manual' });
    });

    it('deletes a version and removes its now-unreferenced blob', async () => {
      const added = await upload('Deletable', '1.0.0');
      const row = db.prepare('SELECT rel_path FROM versions WHERE id = ?').get(added.versionId) as { rel_path: string };
      const blob = join(root, 'vault', row.rel_path);
      expect(existsSync(blob)).toBe(true);

      const res = await app.inject({ method: 'DELETE', url: `/api/versions/${added.versionId}`, headers: auth() });
      expect(res.json()).toMatchObject({ deleted: true, blobRemoved: true });
      expect(existsSync(blob)).toBe(false);
    });

    it('returns 404 deleting a version that does not exist', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/versions/9999', headers: auth() });
      expect(res.statusCode).toBe(404);
    });

    it('adds an alias so a differently-named jar files under the same plugin', async () => {
      const added = await upload('Aliasable', '1.0.0');
      await app.inject({
        method: 'POST',
        url: `/api/plugins/${added.pluginId}/aliases`,
        payload: { alias: 'AliasableRenamed' },
        headers: auth(),
      });

      const body = multipartBody([
        { field: 'files', filename: 'renamed.jar', content: pluginJar('AliasableRenamed', '2.0.0') },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });

      const result = (res.json() as { results: { pluginId: number; createdPlugin: boolean }[] }).results[0];
      expect(result).toMatchObject({ pluginId: added.pluginId, createdPlugin: false });
    });
  });

  describe('pending queue', () => {
    async function park(): Promise<number> {
      const body = multipartBody([{ field: 'files', filename: 'mystery.jar', content: Buffer.from('garbage') }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });
      return (res.json() as { results: { pendingId: number }[] }).results[0]!.pendingId;
    }

    it('lists pending jars with their reason', async () => {
      await park();
      const res = await app.inject({ method: 'GET', url: '/api/pending', headers: auth() });
      const json = res.json() as { items: { reason: string; originalFilename: string }[] };
      expect(json.items[0]).toMatchObject({ reason: 'unreadable-zip', originalFilename: 'mystery.jar' });
    });

    it('assigns a pending jar to a plugin', async () => {
      const pendingId = await park();
      const upload = multipartBody([{ field: 'files', filename: 'host.jar', content: pluginJar('HostPlugin', '1.0.0') }]);
      const hostRes = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: upload.payload,
        headers: { ...upload.headers, ...auth() },
      });
      const pluginId = (hostRes.json() as { results: { pluginId: number }[] }).results[0]!.pluginId;

      const res = await app.inject({
        method: 'POST',
        url: `/api/pending/${pendingId}/assign`,
        payload: { pluginId, version: '3.3.3' },
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect((res.json() as { version: { version: string } }).version.version).toBe('3.3.3');
      expect((db.prepare('SELECT count(*) AS c FROM pending_ingest').get() as { c: number }).c).toBe(0);
    });

    it('returns 404 assigning to a plugin that does not exist', async () => {
      const pendingId = await park();
      const res = await app.inject({
        method: 'POST',
        url: `/api/pending/${pendingId}/assign`,
        payload: { pluginId: 9999, version: '1.0.0' },
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('discards a pending jar', async () => {
      const pendingId = await park();
      const res = await app.inject({ method: 'DELETE', url: `/api/pending/${pendingId}`, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect((db.prepare('SELECT count(*) AS c FROM pending_ingest').get() as { c: number }).c).toBe(0);
    });
  });

  describe('stats and log', () => {
    beforeEach(() => {
      // Two deliveries in 2026-03, one in 2026-04.
      const insert = db.prepare(
        `INSERT INTO audit_log (discord_user_id, plugin_name, version_label, amount, delivery_method, delivered_at)
         VALUES (?, ?, ?, ?, 'link', ?)`,
      );
      insert.run('111', 'MythicMobs', '5.0.0', 20000, Date.UTC(2026, 2, 5) / 1000);
      insert.run('222', 'MythicMobs', '5.0.1', 20000, Date.UTC(2026, 2, 20) / 1000);
      insert.run('111', 'WorldEdit', '7.0.0', 15000, Date.UTC(2026, 3, 2) / 1000);
    });

    it('totals only the requested month', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats/monthly?month=2026-03', headers: auth() });
      const json = res.json() as { totalDownloads: number; totalAmount: number };
      expect(json).toMatchObject({ totalDownloads: 2, totalAmount: 40000 });
    });

    it('matches the sum of delivered amounts for that month', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats/monthly?month=2026-03', headers: auth() });
      const bounds = { from: Date.UTC(2026, 2, 1) / 1000, to: Date.UTC(2026, 3, 1) / 1000 };
      const expected = db
        .prepare('SELECT coalesce(sum(amount),0) AS s FROM audit_log WHERE delivered_at >= ? AND delivered_at < ?')
        .get(bounds.from, bounds.to) as { s: number };
      expect((res.json() as { totalAmount: number }).totalAmount).toBe(expected.s);
    });

    it('breaks the month down per plugin and per admin', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats/monthly?month=2026-03', headers: auth() });
      const json = res.json() as {
        perPlugin: { pluginName: string; downloads: number }[];
        perUser: { discordUserId: string; amount: number }[];
      };
      expect(json.perPlugin).toEqual([{ pluginName: 'MythicMobs', downloads: 2, amount: 40000 }]);
      expect(json.perUser.map((u) => u.discordUserId).sort()).toEqual(['111', '222']);
    });

    it('rejects a malformed month', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats/monthly?month=nonsense', headers: auth() });
      expect(res.statusCode).toBe(400);
    });

    it('filters the log by month and by user', async () => {
      const byMonth = await app.inject({ method: 'GET', url: '/api/log?month=2026-04', headers: auth() });
      expect((byMonth.json() as { total: number }).total).toBe(1);

      const byUser = await app.inject({ method: 'GET', url: '/api/log?userId=111', headers: auth() });
      expect((byUser.json() as { total: number }).total).toBe(2);
    });

    it('paginates the log newest first', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/log?page=1&pageSize=2', headers: auth() });
      const json = res.json() as { items: { deliveredAt: number }[]; total: number };
      expect(json.total).toBe(3);
      expect(json.items).toHaveLength(2);
      expect(json.items[0]!.deliveredAt).toBeGreaterThan(json.items[1]!.deliveredAt);
    });
  });

  describe('settings', () => {
    it('returns settings seeded from env on first boot', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/settings', headers: auth() });
      expect(res.json()).toMatchObject({ adminRoleIds: ['100000000000000003'], pruneKeepCount: 10 });
    });

    it('persists an added admin role so the bot sees it without a restart', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { adminRoleIds: ['100000000000000003', '999000000000000009'] },
        headers: auth(),
      });
      expect((res.json() as { adminRoleIds: string[] }).adminRoleIds).toHaveLength(2);

      const stored = db.prepare("SELECT value FROM config WHERE key = 'admin_role_ids'").get() as { value: string };
      expect(stored.value).toContain('999000000000000009');
    });

    it('rejects a role id that is not a snowflake', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { adminRoleIds: ['not-a-snowflake'] },
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });

    it('changes the prune keep count', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { pruneKeepCount: 25 },
        headers: auth(),
      });
      expect((res.json() as { pruneKeepCount: number }).pruneKeepCount).toBe(25);
    });
  });

  describe('Spigot credential import', () => {
    const sample = `
User: A
Password: secret-a
Plugins found: 1
Status: success
Purchased resources:
Vault+
-----
User: B
Password: secret-b
Plugins found: 2
Status: success
Purchased resources:
Vault+
Enchant
-----`;

    it('requires a dashboard session', async () => {
      const preview = await app.inject({ method: 'POST', url: '/api/spigot-credentials/preview', payload: { text: sample } });
      const save = await app.inject({ method: 'PUT', url: '/api/spigot-credentials', payload: { text: sample } });
      expect(preview.statusCode).toBe(401);
      expect(save.statusCode).toBe(401);
    });

    it('previews labels and filtering without returning passwords', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/spigot-credentials/preview', headers: auth(), payload: { text: sample } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ summary: { total: 2, enabled: 1, excluded: 1, resources: 2 } });
      expect(res.body).not.toContain('secret-a');
      expect(res.body).not.toContain('secret-b');
    });

    it('saves credentials and reports credential-only mode as configured', async () => {
      recordScan(db, 'A', 99);
      const save = await app.inject({ method: 'PUT', url: '/api/spigot-credentials', headers: auth(), payload: { text: sample } });
      expect(save.statusCode).toBe(200);
      expect(findScanState(db, 'A')).toBeNull();

      const list = await app.inject({ method: 'GET', url: '/api/spigot-accounts', headers: auth() });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        configured: true,
        accounts: [
          { label: 'A', enabled: false, liveScan: { status: 'never', lastScanAt: null, resourceCount: null, error: null } },
          { label: 'B', enabled: true, liveScan: { status: 'never', lastScanAt: null, resourceCount: null, error: null } },
        ],
      });
      expect(list.body).not.toContain('secret-a');
      expect(list.body).not.toContain('secret-b');

      // Assert accounts are persisted in SQLite spigot_accounts table
      const sqliteAccounts = db.prepare('SELECT label, username, is_enabled FROM spigot_accounts ORDER BY label ASC').all();
      expect(sqliteAccounts).toEqual([
        { label: 'A', username: 'A', is_enabled: 0 },
        { label: 'B', username: 'B', is_enabled: 1 },
      ]);
    });

    it('keeps imported report data separate from successful and failed live scans', async () => {
      await app.inject({ method: 'PUT', url: '/api/spigot-credentials', headers: auth(), payload: { text: sample } });
      recordScan(db, 'A', 4);
      recordScan(db, 'B', 0, 'Cloudflare blocked');

      const list = await app.inject({ method: 'GET', url: '/api/spigot-accounts', headers: auth() });
      expect(list.json()).toMatchObject({
        accounts: [
          { label: 'A', importedStatus: 'success', purchasedResources: ['Vault+'], liveScan: { status: 'ok', resourceCount: 4, error: null } },
          { label: 'B', importedStatus: 'success', purchasedResources: ['Vault+', 'Enchant'], liveScan: { status: 'error', resourceCount: 0, error: 'Cloudflare blocked' } },
        ],
      });
      for (const account of list.json().accounts) expect(account.liveScan.lastScanAt).toEqual(expect.any(Number));
    });

    it('seeds ownership from an unambiguous imported resource name', async () => {
      const plugin = createPlugin(db, { slug: 'vault', displayName: 'Vault+', descriptorName: 'VaultPlus', platform: 'spigot' });
      updatePlugin(db, plugin.id, { resourceId: 12345 });

      const save = await app.inject({ method: 'PUT', url: '/api/spigot-credentials', headers: auth(), payload: { text: sample } });
      expect(save.statusCode).toBe(200);
      expect(save.json()).toMatchObject({ linkedOwnerships: 2 });
      expect(db.prepare("SELECT count(*) AS c FROM resource_ownership WHERE resource_id = 12345 AND state = 'owned'").get()).toEqual({ c: 2 });

      const repeated = await app.inject({ method: 'PUT', url: '/api/spigot-credentials', headers: auth(), payload: { text: sample } });
      expect(repeated.json()).toMatchObject({ linkedOwnerships: 0 });
      expect(db.prepare("SELECT count(*) AS c FROM resource_ownership WHERE resource_id = 12345 AND state = 'owned'").get()).toEqual({ c: 2 });
    });

    it('creates visible vault rows from imported purchased resources', async () => {
      const save = await app.inject({ method: 'PUT', url: '/api/spigot-credentials', headers: auth(), payload: { text: sample } });

      expect(save.statusCode).toBe(200);
      expect(save.json()).toMatchObject({ createdPlugins: 2 });
      const plugins = await app.inject({ method: 'GET', url: '/api/plugins?pageSize=200', headers: auth() });
      expect(plugins.json().items.map((plugin: { displayName: string }) => plugin.displayName).sort()).toEqual(['Enchant', 'Vault+']);
    });

    it('starts a manual sweep asynchronously and rejects overlap', async () => {
      let running = false;
      setSetting(db, 'auto_download_enabled', 'true');
      await app.close();
      const env = makeEnv(root);
      app = await buildServer({
        db,
        env,
        maintenance: {
          triggerUpdateCheck: () => {
            if (running) return false;
            running = true;
            return true;
          },
          getUpdateStatus: () => ({ running, lastStartedAt: running ? 123 : null, lastFinishedAt: null }),
        },
      });
      const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      cookie = login.headers['set-cookie'] as string;

      const first = await app.inject({ method: 'POST', url: '/api/spigot-downloads/run', headers: auth() });
      const second = await app.inject({ method: 'POST', url: '/api/spigot-downloads/run', headers: auth() });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(409);
    });

    it('rejects a manual sweep while automatic download is disabled', async () => {
      await app.close();
      const env = makeEnv(root);
      app = await buildServer({
        db,
        env,
        maintenance: {
          triggerUpdateCheck: () => true,
          getUpdateStatus: () => ({ running: false, lastStartedAt: null, lastFinishedAt: null }),
        },
      });
      const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      cookie = login.headers['set-cookie'] as string;

      const res = await app.inject({ method: 'POST', url: '/api/spigot-downloads/run', headers: auth() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('bật tự động tải') });
    });

    it('reports maintenance startup as unavailable, not already running', async () => {
      setSetting(db, 'auto_download_enabled', 'true');
      await app.close();
      const env = makeEnv(root);
      app = await buildServer({
        db,
        env,
        maintenance: {
          triggerUpdateCheck: () => false,
          getUpdateStatus: () => ({ running: false, lastStartedAt: null, lastFinishedAt: null }),
          isReady: () => false,
        },
      });
      const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      cookie = login.headers['set-cookie'] as string;

      const res = await app.inject({ method: 'POST', url: '/api/spigot-downloads/run', headers: auth() });
      expect(res.statusCode).toBe(503);
    });

    it('triggers scan-now independently from download sweep', async () => {
      let scanOnlyCalled = false;
      await app.close();
      const env = makeEnv(root);
      app = await buildServer({
        db,
        env,
        maintenance: {
          triggerUpdateCheck: () => false,
          triggerScanOnly: () => {
            scanOnlyCalled = true;
            return true;
          },
          getUpdateStatus: () => ({ running: true, lastStartedAt: Date.now(), lastFinishedAt: null }),
          isReady: () => true,
        },
      });
      const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      cookie = login.headers['set-cookie'] as string;

      const res = await app.inject({ method: 'POST', url: '/api/spigot-accounts/scan-now', headers: auth() });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true });
      expect(scanOnlyCalled).toBe(true);
    });

    it('triggers run-download-now to download plugins sequentially', async () => {
      let downloadNowCalled = false;
      setSetting(db, 'auto_download_enabled', 'true');
      await app.close();
      const env = makeEnv(root);
      app = await buildServer({
        db,
        env,
        maintenance: {
          triggerUpdateCheck: () => false,
          triggerOrderedDownload: () => {
            downloadNowCalled = true;
            return true;
          },
          getUpdateStatus: () => ({ running: true, lastStartedAt: Date.now(), lastFinishedAt: null }),
          isReady: () => true,
        },
      });
      const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
      cookie = login.headers['set-cookie'] as string;

      const res = await app.inject({ method: 'POST', url: '/api/spigot-downloads/run-download-now', headers: auth() });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ running: true });
      expect(downloadNowCalled).toBe(true);
    });
  });

  describe('reconcile', () => {
    /** Seeds a plugin+version, then an order in the given state. */
    async function seedOrder(status: 'pending' | 'paid' | 'delivered' | 'dm_blocked', code: string) {
      const body = multipartBody([
        { field: 'files', filename: 'Recon.jar', content: pluginJar('Recon', '1.0.0') },
      ]);
      const upload = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: body.payload,
        headers: { ...body.headers, ...auth() },
      });
      const versionId = (upload.json() as { results: { versionId: number }[] }).results[0]!.versionId;

      const order = createOrder(db, {
        code,
        discordUserId: '424242424242424242',
        versionId,
        pluginName: 'Recon',
        versionLabel: '1.0.0',
        amount: 20000,
        ttlMinutes: 30,
      });
      if (status !== 'pending') markOrderStatus(db, order.id, status);
      return order;
    }

    it('lists only orders that were paid but never delivered', async () => {
      await seedOrder('pending', 'VN0000P1');
      const paid = await seedOrder('paid', 'VN0000P2');
      const blocked = await seedOrder('dm_blocked', 'VN0000P3');
      await seedOrder('delivered', 'VN0000P4');

      const res = await app.inject({ method: 'GET', url: '/api/orders/undelivered', headers: auth() });
      const codes = (res.json() as { items: { id: number; code: string }[] }).items.map((o) => o.code);

      // A pending order has taken no money yet and a delivered one needs nothing;
      // both would be noise in a view whose whole purpose is money-without-a-file.
      expect(codes.sort()).toEqual([paid.code, blocked.code].sort());
    });

    it('carries the denormalized labels the view renders', async () => {
      await seedOrder('paid', 'VN0000P5');

      const res = await app.inject({ method: 'GET', url: '/api/orders/undelivered', headers: auth() });
      expect((res.json() as { items: unknown[] }).items[0]).toMatchObject({
        pluginName: 'Recon',
        versionLabel: '1.0.0',
        amount: 20000,
        discordUserId: '424242424242424242',
        status: 'paid',
      });
    });

    it('hoàn coin cho một đơn rồi đóng nó lại', async () => {
      // The deliberate "give up on this order" action. Automatic refunding on a
      // delivery failure would hand back the coins while the order stayed
      // releasable, which gives away the coins and then the file.
      const order = await seedOrder('paid', 'VN0000W1');
      db.prepare('UPDATE orders SET wallet_paid = 20000, bank_due = 0 WHERE id = ?').run(order.id);
      db.prepare(
        `INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES (?, 0, 1, 1)`,
      ).run(order.discordUserId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ refunded: 20000, revokedLinks: 0 });
      expect(db.prepare('SELECT balance FROM wallets WHERE discord_user_id = ?').get(order.discordUserId))
        .toEqual({ balance: 20000 });
      // Closed out, so it cannot then be released for coins no longer held.
      expect(db.prepare('SELECT status, wallet_paid FROM orders WHERE id = ?').get(order.id))
        .toMatchObject({ status: 'expired', wallet_paid: 0 });
    });

    it('thu hồi liên kết tải chưa dùng khi hoàn coin, để không tặng không tệp jar', async () => {
      // Một đơn dm_blocked GIỮ liên kết tải còn hiệu lực (cố ý, vì Discord có thể báo
      // lỗi 50007 dù tin đã tới). Hoàn coin mà để liên kết sống thì khách vừa lấy lại
      // tiền vừa tải được tệp.
      const order = await seedOrder('dm_blocked', 'VN0000W3');
      db.prepare('UPDATE orders SET wallet_paid = 20000, bank_due = 0 WHERE id = ?').run(order.id);
      db.prepare(
        `INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES (?, 0, 1, 1)`,
      ).run(order.discordUserId);
      const version = db.prepare('SELECT id FROM versions LIMIT 1').get() as { id: number };
      db.prepare(
        `INSERT INTO download_tokens (token_hash, version_id, discord_user_id, order_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(Buffer.alloc(32, 7), version.id, order.discordUserId, order.id, 9_999_999_999, 1);

      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ refunded: 20000, revokedLinks: 1 });
      expect(db.prepare('SELECT count(*) AS c FROM download_tokens WHERE order_id = ?').get(order.id))
        .toEqual({ c: 0 });
    });

    it('giữ lại liên kết ĐÃ dùng khi hoàn coin, vì đó là dấu vết một lần giao', async () => {
      const order = await seedOrder('dm_blocked', 'VN0000W4');
      db.prepare('UPDATE orders SET wallet_paid = 20000, bank_due = 0 WHERE id = ?').run(order.id);
      db.prepare(
        `INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES (?, 0, 1, 1)`,
      ).run(order.discordUserId);
      const version = db.prepare('SELECT id FROM versions LIMIT 1').get() as { id: number };
      db.prepare(
        `INSERT INTO download_tokens (token_hash, version_id, discord_user_id, order_id, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(Buffer.alloc(32, 9), version.id, order.discordUserId, order.id, 9_999_999_999, 1_700_000_000, 1);

      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });

      expect(res.json()).toEqual({ refunded: 20000, revokedLinks: 0 });
      expect(db.prepare('SELECT count(*) AS c FROM download_tokens WHERE order_id = ?').get(order.id))
        .toEqual({ c: 1 });
    });

    it('hoàn lần hai bị từ chối', async () => {
      const order = await seedOrder('paid', 'VN0000W2');
      db.prepare('UPDATE orders SET wallet_paid = 20000 WHERE id = ?').run(order.id);
      db.prepare(
        `INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES (?, 0, 1, 1)`,
      ).run(order.discordUserId);

      const first = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });
      expect(second.statusCode).toBe(409);
      expect(db.prepare('SELECT balance FROM wallets WHERE discord_user_id = ?').get(order.discordUserId))
        .toEqual({ balance: 20000 });
    });

    it('từ chối hoàn khi đơn không giữ coin nào', async () => {
      const order = await seedOrder('paid', 'VN0000W3');
      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.id}/refund-wallet`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
    });

    it('đơn trả trọn bằng ví cũng hiện trong đối soát', async () => {
      // No webhook is coming for a wallet-paid order, so if delivery failed this
      // view is the only place it can ever be seen again.
      const order = await seedOrder('wallet_paid', 'VN0000W4');
      db.prepare('UPDATE orders SET wallet_paid = 20000, bank_due = 0 WHERE id = ?').run(order.id);

      const res = await app.inject({ method: 'GET', url: '/api/orders/undelivered', headers: auth() });

      expect(res.json().items.map((o: { id: number }) => o.id)).toContain(order.id);
    });

    it('refuses the reconcile routes without a session', async () => {
      const order = await seedOrder('paid', 'VN0000P6');
      const list = await app.inject({ method: 'GET', url: '/api/orders/undelivered' });
      const release = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/release` });
      expect(list.statusCode).toBe(401);
      expect(release.statusCode).toBe(401);
    });

    it('answers 503 for a manual release when no bot is attached', async () => {
      const order = await seedOrder('paid', 'VN0000P7');
      // This server was built without delivery deps, standing in for a bot whose
      // Discord login was rejected — the route must say so rather than 500.
      const res = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/release`, headers: auth() });
      expect(res.statusCode).toBe(503);
      expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).toMatchObject({ status: 'paid' });
    });

    it('rejects a non-numeric order id', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/orders/abc/release', headers: auth() });
      expect(res.statusCode).toBe(400);
    });
  });
  describe('wallet', () => {
    const USER = '424242424242424242';

    it('refuses the wallet routes without a session', async () => {
      for (const url of ['/api/wallets', '/api/cards', `/api/wallets/${USER}/ledger`]) {
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      }
      const adjust = await app.inject({ method: 'POST', url: '/api/wallets/adjust' });
      expect(adjust.statusCode).toBe(401);
    });

    it('lists wallets with no drift on a clean database', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/wallets', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ items: [], drift: [], total: 0 });
    });

    it('adjusts a balance and records the reason', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/wallets/adjust',
        headers: auth(),
        payload: { discordUserId: USER, delta: 50000, note: 'bù cho lần lỗi' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ balance: 50000 });

      const ledger = await app.inject({ method: 'GET', url: `/api/wallets/${USER}/ledger`, headers: auth() });
      expect(ledger.json().items[0]).toMatchObject({ delta: 50000, kind: 'manual', note: 'bù cho lần lỗi' });
    });

    it('refuses an adjustment without a note', async () => {
      // An unexplained adjustment is indistinguishable from a bug months later.
      const res = await app.inject({
        method: 'POST',
        url: '/api/wallets/adjust',
        headers: auth(),
        payload: { discordUserId: USER, delta: 1000, note: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses to overdraw a balance', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/wallets/adjust',
        headers: auth(),
        payload: { discordUserId: USER, delta: -1000, note: 'trừ thử' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('reports the card fee the owner absorbs', async () => {
      db.prepare(
        `INSERT INTO card_topups (request_id, discord_user_id, telco, serial, declared_value,
                                  actual_value, net_amount, status, credited_at, created_at)
         VALUES ('r1', ?, 'VIETTEL', 'S1', 50000, 50000, 40000, 'success', ?, ?)`,
      ).run(USER, nowSeconds(), nowSeconds());

      const res = await app.inject({ method: 'GET', url: '/api/cards', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().cost).toEqual({ credited: 50000, received: 40000, cost: 10000 });
    });

    it('credits a card the poll could not settle, once', async () => {
      db.prepare(
        `INSERT INTO card_topups (request_id, discord_user_id, telco, serial, declared_value,
                                  status, created_at)
         VALUES ('r2', ?, 'VIETTEL', 'S2', 50000, 'timeout', ?)`,
      ).run(USER, nowSeconds());
      const id = db.prepare("SELECT id FROM card_topups WHERE request_id = 'r2'").get().id;

      const first = await app.inject({
        method: 'POST',
        url: `/api/cards/${id}/resolve`,
        headers: auth(),
        payload: { credit: true, amount: 50000 },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ credited: true, amount: 50000 });

      // Now settled, so a second release must not pay again.
      const second = await app.inject({
        method: 'POST',
        url: `/api/cards/${id}/resolve`,
        headers: auth(),
        payload: { credit: true, amount: 50000 },
      });
      expect(second.statusCode).toBe(409);

      const ledger = await app.inject({ method: 'GET', url: `/api/wallets/${USER}/ledger`, headers: auth() });
      expect(ledger.json().balance).toBe(50000);
    });

    it('closes a reviewed card without paying', async () => {
      db.prepare(
        `INSERT INTO card_topups (request_id, discord_user_id, telco, serial, code, declared_value,
                                  status, created_at)
         VALUES ('r3', ?, 'VIETTEL', 'S3', 'PIN123', 50000, 'needs_review', ?)`,
      ).run(USER, nowSeconds());
      const id = db.prepare("SELECT id FROM card_topups WHERE request_id = 'r3'").get().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/cards/${id}/resolve`,
        headers: auth(),
        payload: { credit: false },
      });

      expect(res.statusCode).toBe(200);
      const row = db.prepare('SELECT status, code FROM card_topups WHERE id = ?').get(id);
      // PIN kept: not crediting usually means the card was never consumed, and
      // the person will want it back.
      expect(row).toMatchObject({ status: 'failed', code: 'PIN123' });
    });

    it('refuses to resolve a card that already settled on its own', async () => {
      db.prepare(
        `INSERT INTO card_topups (request_id, discord_user_id, telco, serial, declared_value,
                                  status, created_at)
         VALUES ('r4', ?, 'VIETTEL', 'S4', 50000, 'success', ?)`,
      ).run(USER, nowSeconds());
      const id = db.prepare("SELECT id FROM card_topups WHERE request_id = 'r4'").get().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/cards/${id}/resolve`,
        headers: auth(),
        payload: { credit: true, amount: 50000 },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('staff management & session routes', () => {
    it('returns session profile on GET /api/session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.user.role).toBe('owner');
      expect(data.user.authMethod).toBe('password');
    });

    it('manages staff members on /api/staff with owner session', async () => {
      // 1. GET initial list
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/staff',
        headers: auth(),
      });
      expect(getRes.statusCode).toBe(200);
      const getData = JSON.parse(getRes.body);
      expect(getData.ownerId).toBe('100000000000000004');
      expect(getData.items).toEqual([]);

      // 2. Reject invalid snowflake
      const badAdd = await app.inject({
        method: 'POST',
        url: '/api/staff',
        headers: auth(),
        payload: { discordUserId: 'abc12345' },
      });
      expect(badAdd.statusCode).toBe(400);

      // 3. Add staff with valid snowflake
      const addRes = await app.inject({
        method: 'POST',
        url: '/api/staff',
        headers: auth(),
        payload: { discordUserId: '123456789012345678' },
      });
      expect(addRes.statusCode).toBe(200);
      const added = JSON.parse(addRes.body);
      expect(added.staff.discordUserId).toBe('123456789012345678');

      // 4. Verify listed
      const listAfter = await app.inject({
        method: 'GET',
        url: '/api/staff',
        headers: auth(),
      });
      const listData = JSON.parse(listAfter.body);
      expect(listData.items.length).toBe(1);

      // 5. Delete staff
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/staff/123456789012345678',
        headers: auth(),
      });
      expect(delRes.statusCode).toBe(200);
    });

    it('toggles spigot proxy enabled state and updates logs response', async () => {
      // 1. Check initial logs endpoint returns proxyEnabled: true
      const initialLogs = await app.inject({
        method: 'GET',
        url: '/api/spigot-downloads/logs',
        headers: auth(),
      });
      expect(initialLogs.statusCode).toBe(200);
      const initialData = JSON.parse(initialLogs.body);
      expect(initialData.proxyEnabled).toBe(true);

      // 2. Toggle proxy to false
      const toggleOff = await app.inject({
        method: 'POST',
        url: '/api/spigot-proxy/toggle',
        headers: auth(),
        payload: { enabled: false },
      });
      expect(toggleOff.statusCode).toBe(200);
      const offData = JSON.parse(toggleOff.body);
      expect(offData.ok).toBe(true);
      expect(offData.proxyEnabled).toBe(false);

      // 3. Verify logs endpoint reflects proxyEnabled: false and Direct IP
      const offLogs = await app.inject({
        method: 'GET',
        url: '/api/spigot-downloads/logs',
        headers: auth(),
      });
      expect(offLogs.statusCode).toBe(200);
      const offLogsData = JSON.parse(offLogs.body);
      expect(offLogsData.proxyEnabled).toBe(false);
      expect(offLogsData.currentProxyIp).toBe('Direct (IP máy chủ)');

      // 4. Toggle back without payload (should invert to true)
      const toggleOn = await app.inject({
        method: 'POST',
        url: '/api/spigot-proxy/toggle',
        headers: auth(),
        payload: {},
      });
      expect(toggleOn.statusCode).toBe(200);
      const onData = JSON.parse(toggleOn.body);
      expect(onData.ok).toBe(true);
      expect(onData.proxyEnabled).toBe(true);
    });
  });
});
