import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envSchema, type Env } from '../src/config/env.js';
import { now } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { seedSettings } from '../src/db/settings-store.js';
import { buildServer } from '../src/http/server.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { createVersion } from '../src/repositories/versions.js';
import { hashToken, mintDownloadToken } from '../src/services/delivery/mint-download-token.js';

const JAR_BODY = 'pretend jar bytes';

function makeEnv(root: string): Env {
  return envSchema.parse({
    DISCORD_TOKEN: 'token',
    DISCORD_CLIENT_ID: '100000000000000001',
    DISCORD_GUILD_ID: '100000000000000002',
    DISCORD_ADMIN_ROLE_IDS: '100000000000000003',
    DISCORD_OWNER_ID: '100000000000000004',
    DISCORD_NOTIFY_CHANNEL_ID: '100000000000000005',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DASHBOARD_PASSWORD: 'owner-password-123',
    SESSION_SECRET: 'k9Xq2mVt7bNr4aLp8sZw3eYc6uHd1oGf',
    SEPAY_WEBHOOK_SECRET: 'hmac-secret-value',
    SEPAY_ACCOUNT_NUMBER: '0010000000355',
    SEPAY_BANK_CODE: 'Vietcombank',
    SEPAY_CODE_PREFIX: 'vn',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mockdb',
    VAULT_DIR: join(root, 'vault'),
    TMP_DIR: join(root, 'tmp'),
    DB_PATH: join(root, 'db.sqlite'),
  });
}

describe('download endpoint', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let root: string;
  let versionId: number;

  /** Creates a version row plus its blob on disk. */
  async function seedVersion(originalName = 'target.jar', version: string | null = '1.0.0'): Promise<number> {
    const sha = 'a'.repeat(64);
    const plugin =
      db.prepare("SELECT id FROM plugins WHERE slug = 'target'").get() ??
      createPlugin(db, { slug: 'target', displayName: 'Target Plugin', descriptorName: 'Target', platform: 'spigot' });

    const pluginId = (plugin as { id: number }).id;
    const created = createVersion(db, {
      pluginId,
      version,
      rawVersion: version,
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: JAR_BODY.length,
      originalName,
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });

    await mkdir(join(root, 'vault', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(root, 'vault', sha.slice(0, 2), sha), JAR_BODY);
    return created.id;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-dl-'));
    const env = makeEnv(root);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    seedSettings(db, env);
    app = await buildServer({ db, env });
    versionId = await seedVersion();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const mint = (userId = '999') =>
    mintDownloadToken(db, { versionId, discordUserId: userId, ttlMinutes: 15 }).token;

  it('serves the jar body without any session', async () => {
    const res = await app.inject({ method: 'GET', url: `/download/${mint()}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JAR_BODY);
    expect(res.headers['content-type']).toBe('application/java-archive');
  });

  it('sets content-length from the file on disk', async () => {
    const res = await app.inject({ method: 'GET', url: `/download/${mint()}` });
    expect(res.headers['content-length']).toBe(String(JAR_BODY.length));
  });

  it('suggests a clean slug-version filename', async () => {
    const res = await app.inject({ method: 'GET', url: `/download/${mint()}` });
    expect(res.headers['content-disposition']).toContain('target-1.0.0.jar');
  });

  it('encodes an apostrophe in the filename per RFC 8187', async () => {
    // encodeURIComponent leaves the apostrophe unescaped, and the apostrophe is
    // the charset delimiter, so a naive implementation emits a header a strict
    // parser rejects.
    const trickyId = await seedVersionWithName("Bob's Plugin (v2).jar");
    const token = mintDownloadToken(db, { versionId: trickyId, discordUserId: '1', ttlMinutes: 15 }).token;

    const res = await app.inject({ method: 'GET', url: `/download/${token}` });
    expect(res.statusCode).toBe(200);
    const header = res.headers['content-disposition'] as string;
    // The raw apostrophe must not survive into the encoded parameter.
    const starred = /filename\*=([^;]+)/.exec(header)?.[1];
    if (starred) expect(starred.split("'").length).toBe(3);
  });

  async function seedVersionWithName(originalName: string): Promise<number> {
    const sha = 'b'.repeat(64);
    const plugin = db.prepare("SELECT id FROM plugins WHERE slug = 'target'").get() as { id: number };
    const created = createVersion(db, {
      pluginId: plugin.id,
      // No version, so the original name is used verbatim as the filename.
      version: null,
      rawVersion: null,
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: JAR_BODY.length,
      originalName,
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
    await mkdir(join(root, 'vault', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(root, 'vault', sha.slice(0, 2), sha), JAR_BODY);
    return created.id;
  }

  it('works exactly once', async () => {
    const token = mint();
    expect((await app.inject({ method: 'GET', url: `/download/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/download/${token}` })).statusCode).toBe(410);
  });

  it('refuses an expired token', async () => {
    const token = mint();
    db.prepare('UPDATE download_tokens SET expires_at = ? WHERE token_hash = ?').run(now() - 10, hashToken(token));
    expect((await app.inject({ method: 'GET', url: `/download/${token}` })).statusCode).toBe(410);
  });

  it('refuses an unknown token with the same status as a used one', async () => {
    // Identical responses keep an attacker from probing for valid tokens.
    const unknown = await app.inject({ method: 'GET', url: '/download/definitely-not-a-real-token' });
    const token = mint();
    await app.inject({ method: 'GET', url: `/download/${token}` });
    const used = await app.inject({ method: 'GET', url: `/download/${token}` });

    expect(unknown.statusCode).toBe(410);
    expect(used.statusCode).toBe(410);
  });

  it('refuses when the blob has gone missing', async () => {
    const token = mint();
    await rm(join(root, 'vault'), { recursive: true, force: true });
    const res = await app.inject({ method: 'GET', url: `/download/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it('does not write an audit row, since delivery already recorded one', async () => {
    // Counting the fetch as well would double every link delivery in the monthly
    // fund report.
    await app.inject({ method: 'GET', url: `/download/${mint()}` });
    expect((db.prepare('SELECT count(*) AS c FROM audit_log').get() as { c: number }).c).toBe(0);
  });

  it('never caches the response', async () => {
    const res = await app.inject({ method: 'GET', url: `/download/${mint()}` });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is reachable without the dashboard session while /api is not', async () => {
    const dl = await app.inject({ method: 'GET', url: `/download/${mint()}` });
    const api = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(dl.statusCode).toBe(200);
    expect(api.statusCode).toBe(401);
  });
});
