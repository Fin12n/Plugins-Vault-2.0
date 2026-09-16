import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPlugin, updatePlugin } from '../src/repositories/plugins.js';
import { createVersion, setVersionStable, listVersionsByPlugin } from '../src/repositories/versions.js';
import { findUpstreamState } from '../src/repositories/upstream-state.js';
import { checkPluginUpdates, formatUpdateNotice } from '../src/services/upstream/check-plugin-updates.js';
import { SpigetClient } from '../src/services/upstream/spiget-client.js';
import { pruneOldVersions } from '../src/services/maintenance/prune-old-versions.js';
import { startMaintenance } from '../src/services/maintenance/scheduler.js';
import { seedSettings, setSetting } from '../src/db/settings-store.js';
import { deferDownload, enqueueDownload, listAllPendingDownloads } from '../src/repositories/pending-download.js';
import { saveUpstreamState } from '../src/repositories/upstream-state.js';
import { envSchema, type Env } from '../src/config/env.js';
import { Secret, saveSpigotAccounts } from '../src/services/upstream/spigot-account-store.js';
import * as browserLauncherModule from '../src/services/upstream/browser-launcher.js';
import * as browserFlowModule from '../src/services/upstream/download-via-browser.js';
import type { BrowserSession } from '../src/services/upstream/download-via-browser.js';
import { SpigotChallengeSessionManager } from '../src/services/upstream/spigot-challenge-session.js';
import { buildSpigotProxyPool } from '../src/services/upstream/spigot-proxy-pool.js';
import { listOwnership } from '../src/repositories/resource-ownership.js';
import { recordScan } from '../src/repositories/account-scan-state.js';

/** Stub fetch returning canned Spiget responses, recording requested URLs. */
function stubFetch(handler: (url: string) => { status?: number; body?: unknown }): {
  impl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body = {} } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const LATEST = { uuid: 'uuid-4-0-17', name: '4.0.17', releaseDate: 1_780_000_000, downloads: 500 };

describe('SpigetClient', () => {
  it('reads the latest version and converts seconds to milliseconds', async () => {
    const { impl } = stubFetch(() => ({ body: LATEST }));
    const client = new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 });

    const latest = await client.getLatestVersion(73355);
    expect(latest).toMatchObject({ uuid: 'uuid-4-0-17', name: '4.0.17' });
    // Passing the raw seconds to a Date would land in 1970.
    expect(latest!.releaseDateMs).toBe(1_780_000_000 * 1000);
    expect(new Date(latest!.releaseDateMs).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('falls back to the numeric id when a resource returns no uuid', async () => {
    // Real shape of resource 32430: every version row omits uuid entirely. The
    // identity is written to two NOT NULL columns, so trusting the field aborts
    // the whole update sweep and no plugin downloads anything.
    const noUuid = { id: 99997674, name: '5.7.6 - Legacy', releaseDate: 1_551_838_692, downloads: 1 };
    const { impl } = stubFetch(() => ({ body: noUuid }));

    const latest = await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).getLatestVersion(32430);
    expect(latest).toMatchObject({ uuid: '99997674', name: '5.7.6 - Legacy' });
  });

  it('keeps every uuid-less row in a version list, keyed by id', async () => {
    const rows = [
      { id: 99997674, name: '5.7.6 - Legacy', releaseDate: 1_551_838_692, downloads: 1 },
      { id: 99997100, name: '5.7.5 - Legacy', releaseDate: 1_540_000_000, downloads: 3 },
    ];
    const { impl } = stubFetch(() => ({ body: rows }));

    const versions = await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).listVersions(32430);
    expect(versions.map((v) => v.uuid)).toEqual(['99997674', '99997100']);
  });

  it('drops a row carrying neither uuid nor id instead of yielding a blank identity', async () => {
    // A blank identity would collide with every other blank one and overwrite a
    // real queue row, which is worse than never seeing the version.
    const { impl } = stubFetch(() => ({
      body: [LATEST, { name: 'ghost', releaseDate: 1_550_000_000, downloads: 0 }],
    }));

    const versions = await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).listVersions(32430);
    expect(versions.map((v) => v.uuid)).toEqual(['uuid-4-0-17']);
  });

  it('calls the versions/latest endpoint, never the resource object', async () => {
    // A premium resource's own version pointer is stale by years, so reading it
    // would report a build from several years ago as current.
    const { impl, urls } = stubFetch(() => ({ body: LATEST }));
    await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).getLatestVersion(73355);

    expect(urls[0]).toContain('/resources/73355/versions/latest');
    expect(urls.some((u) => /\/resources\/73355(\?|$)/.test(u))).toBe(false);
  });

  it('always sorts version history by release date, not internal id', async () => {
    // The default order is ascending id, and premium ids are not chronological, so
    // the last page can be a years-old build.
    const { impl, urls } = stubFetch(() => ({ body: [LATEST] }));
    await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).listVersions(73355);
    expect(urls[0]).toContain('sort=-releaseDate');
  });

  it('adds a cache-buster, since edge caches have served far staler responses than advertised', async () => {
    const { impl, urls } = stubFetch(() => ({ body: LATEST }));
    await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).getLatestVersion(1);
    expect(urls[0]).toMatch(/[?&]_ts=\d+/);
  });

  it('returns null for an unknown resource instead of throwing', async () => {
    const { impl } = stubFetch(() => ({ status: 404 }));
    expect(await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }).getLatestVersion(999999)).toBeNull();
  });

  it('retries a server error and then gives up quietly', async () => {
    let calls = 0;
    const { impl } = stubFetch(() => {
      calls++;
      return { status: 503 };
    });
    const client = new SpigetClient({ fetchImpl: impl, minIntervalMs: 0, maxRetries: 2 });

    // Backoff is real time, so keep retries low; this asserts it does not throw.
    expect(await client.getLatestVersion(1)).toBeNull();
    expect(calls).toBe(3);
  }, 20_000);

  it('sends a descriptive user agent', async () => {
    const seen: string[] = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)['user-agent']));
      return new Response(JSON.stringify(LATEST), { status: 200 });
    }) as unknown as typeof fetch;

    await new SpigetClient({ fetchImpl: impl, minIntervalMs: 0, userAgent: 'my-vault/1.0' }).getLatestVersion(1);
    expect(seen[0]).toBe('my-vault/1.0');
  });
});

describe('checkPluginUpdates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => db.close());

  function seedTracked(name: string, resourceId: number, archivedVersion: string | null, isPremium = false) {
    const plugin = createPlugin(db, {
      slug: name.toLowerCase(),
      displayName: name,
      descriptorName: name,
      platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId, isPremium });
    if (archivedVersion) {
      const sha = name.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/gi, 'a').toLowerCase();
      createVersion(db, {
        pluginId: plugin.id,
        version: archivedVersion,
        rawVersion: archivedVersion,
        sha256: sha,
        relPath: `${sha.slice(0, 2)}/${sha}`,
        bytes: 10,
        originalName: `${name}.jar`,
        descriptorKind: 'spigot',
        versionFlag: 'ok',
      });
    }
    return plugin;
  }

  const clientFor = (body: unknown) =>
    new SpigetClient({ fetchImpl: stubFetch(() => ({ body })).impl, minIntervalMs: 0 });

  it('reports a plugin whose upstream version is newer than the archive', async () => {
    const plugin = seedTracked('ItemsAdder', 73355, '4.0.15', true);
    const outcome = await checkPluginUpdates(db, clientFor(LATEST));

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      pluginId: plugin.id,
      archivedVersion: '4.0.15',
      isPremium: true,
    });
    expect(outcome.findings[0]!.upstream.name).toBe('4.0.17');
  });

  it('notifies once per upstream version, not once per poll', async () => {
    seedTracked('Repeat', 100, '1.0.0');
    const client = clientFor(LATEST);

    expect((await checkPluginUpdates(db, client)).findings).toHaveLength(1);
    expect((await checkPluginUpdates(db, client)).findings).toHaveLength(0);
    expect((await checkPluginUpdates(db, client)).findings).toHaveLength(0);
  });

  it('persists what it saw so a restart does not re-announce', async () => {
    const plugin = seedTracked('Persisted', 101, '1.0.0');
    await checkPluginUpdates(db, clientFor(LATEST));

    const state = findUpstreamState(db, plugin.id);
    expect(state).toMatchObject({ versionUuid: 'uuid-4-0-17', versionName: '4.0.17' });
    expect(state!.releaseDateMs).toBe(1_780_000_000 * 1000);
  });

  it('announces again when the upstream uuid changes', async () => {
    seedTracked('Changing', 102, '1.0.0');
    await checkPluginUpdates(db, clientFor(LATEST));

    const nextRelease = { uuid: 'uuid-4-0-18', name: '4.0.18', releaseDate: 1_781_000_000, downloads: 1 };
    const outcome = await checkPluginUpdates(db, clientFor(nextRelease));
    expect(outcome.findings[0]!.upstream.name).toBe('4.0.18');
  });

  it('keys identity on the uuid, so a repeated version name still counts as new', async () => {
    // One real resource ships two distinct releases both named 4.0.15.
    seedTracked('SameName', 103, '4.0.15');
    await checkPluginUpdates(db, clientFor({ uuid: 'first', name: '4.0.15', releaseDate: 1_700_000_000, downloads: 1 }));

    const outcome = await checkPluginUpdates(
      db,
      clientFor({ uuid: 'second', name: '4.0.15', releaseDate: 1_780_000_000, downloads: 1 }),
    );
    expect(outcome.findings).toHaveLength(1);
  });

  it('stays quiet on first sight when the archive already holds that version', async () => {
    seedTracked('UpToDate', 104, '4.0.17');
    expect((await checkPluginUpdates(db, clientFor(LATEST))).findings).toHaveLength(0);
  });

  it('skips plugins with no resource id', async () => {
    createPlugin(db, { slug: 'untracked', displayName: 'Untracked', descriptorName: 'Untracked', platform: 'spigot' });
    const outcome = await checkPluginUpdates(db, clientFor(LATEST));
    expect(outcome.checked).toBe(0);
  });

  it('keeps checking the rest when one resource fails', async () => {
    seedTracked('Broken', 500, '1.0.0');
    seedTracked('Working', 501, '1.0.0');

    const client = new SpigetClient({
      fetchImpl: stubFetch((url) => (url.includes('/500/') ? { status: 404 } : { body: LATEST })).impl,
      minIntervalMs: 0,
    });

    const outcome = await checkPluginUpdates(db, client);
    expect(outcome.findings.map((f) => f.pluginName)).toEqual(['Working']);
    expect(outcome.checked).toBe(2);
  });

  it('flags premium data as potentially lagging in the notice', () => {
    const notice = formatUpdateNotice({
      pluginId: 1,
      pluginName: 'ItemsAdder',
      resourceId: 73355,
      isPremium: true,
      upstream: { uuid: 'u', name: '4.0.17', releaseDateMs: 1_780_000_000_000, downloads: 1 },
      archivedVersion: '4.0.15',
    });
    expect(notice).toContain('ItemsAdder');
    expect(notice).toContain('4.0.17');
    expect(notice).toContain('4.0.15');
    expect(notice).toContain('premium');
    expect(notice).toContain('73355');
  });
});

describe('pruneOldVersions', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prune-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Creates `count` versions with distinct blobs, oldest first. */
  async function seedVersions(count: number): Promise<{ pluginId: number; ids: number[] }> {
    const plugin = createPlugin(db, {
      slug: 'many',
      displayName: 'Many Versions',
      descriptorName: 'Many',
      platform: 'spigot',
    });
    const ids: number[] = [];

    for (let i = 0; i < count; i++) {
      const sha = i.toString(16).padStart(64, '0');
      const version = createVersion(db, {
        pluginId: plugin.id,
        version: `1.0.${i}`,
        rawVersion: `1.0.${i}`,
        sha256: sha,
        relPath: `${sha.slice(0, 2)}/${sha}`,
        bytes: 1024,
        originalName: `v${i}.jar`,
        descriptorKind: 'spigot',
        versionFlag: 'ok',
      });
      db.prepare('UPDATE versions SET uploaded_at = ? WHERE id = ?').run(1000 + i, version.id);
      await mkdir(join(root, sha.slice(0, 2)), { recursive: true });
      await writeFile(join(root, sha.slice(0, 2), sha), 'x'.repeat(10));
      ids.push(version.id);
    }
    return { pluginId: plugin.id, ids };
  }

  it('keeps the newest N and removes the rest', async () => {
    const { pluginId } = await seedVersions(15);
    const outcome = await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });

    expect(outcome.pruned).toHaveLength(5);
    expect(listVersionsByPlugin(db, pluginId)).toHaveLength(10);
  });

  it('keeps stable versions even when they fall outside the window', async () => {
    const { pluginId, ids } = await seedVersions(15);
    // Two of the oldest, which the keep window would otherwise drop.
    setVersionStable(db, ids[0]!, true);
    setVersionStable(db, ids[1]!, true);

    const outcome = await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });

    expect(outcome.pruned).toHaveLength(3);
    const remaining = listVersionsByPlugin(db, pluginId);
    expect(remaining).toHaveLength(12);
    expect(remaining.filter((v) => v.isStable)).toHaveLength(2);
  });

  it('deletes the blob along with the row', async () => {
    await seedVersions(12);
    const doomed = db.prepare('SELECT rel_path FROM versions ORDER BY uploaded_at ASC LIMIT 1').get() as {
      rel_path: string;
    };
    expect(existsSync(join(root, doomed.rel_path))).toBe(true);

    await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });
    expect(existsSync(join(root, doomed.rel_path))).toBe(false);
  });

  it('reports what it would remove without touching anything in dry-run mode', async () => {
    const { pluginId } = await seedVersions(15);
    const outcome = await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10, dryRun: true });

    expect(outcome.pruned).toHaveLength(5);
    expect(outcome.bytesFreed).toBe(5 * 1024);
    expect(listVersionsByPlugin(db, pluginId)).toHaveLength(15);
  });

  it('does nothing when a plugin has fewer versions than the keep count', async () => {
    await seedVersions(3);
    expect((await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 })).pruned).toEqual([]);
  });

  it('names every removed version so a mistaken prune is diagnosable', async () => {
    await seedVersions(12);
    const outcome = await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });
    expect(outcome.pruned.every((entry) => entry.version !== null && entry.pluginName === 'Many Versions')).toBe(true);
  });

  it('prunes each plugin independently', async () => {
    await seedVersions(12);
    const other = createPlugin(db, {
      slug: 'small',
      displayName: 'Small',
      descriptorName: 'Small',
      platform: 'spigot',
    });
    const sha = 'f'.repeat(64);
    createVersion(db, {
      pluginId: other.id,
      version: '1.0.0',
      rawVersion: '1.0.0',
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: 1,
      originalName: 's.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });

    await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });
    expect(listVersionsByPlugin(db, other.id)).toHaveLength(1);
  });

  it('leaves paid orders intact when their version is pruned', async () => {
    const { ids } = await seedVersions(12);
    const oldest = ids[0]!;
    db.prepare(
      `INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label, amount, status,
                           created_at, expires_at, paid_at)
       VALUES ('VNPRUNE001', '9', ?, 'Many Versions', '1.0.0', 20000, 'delivered', 1, 2, 3)`,
    ).run(oldest);

    await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });

    const order = db.prepare("SELECT version_id, amount, plugin_name, status FROM orders WHERE code = 'VNPRUNE001'").get();
    expect(order).toMatchObject({ version_id: null, amount: 20000, plugin_name: 'Many Versions', status: 'delivered' });
  });

  it('leaves the audit trail intact when its version is pruned', async () => {
    const { ids } = await seedVersions(12);
    db.prepare(
      `INSERT INTO audit_log (discord_user_id, version_id, plugin_name, version_label, amount, delivery_method, delivered_at)
       VALUES ('9', ?, 'Many Versions', '1.0.0', 20000, 'link', 1)`,
    ).run(ids[0]!);

    await pruneOldVersions({ db, vaultDir: root }, { keepCount: 10 });

    const row = db.prepare('SELECT version_id, amount FROM audit_log').get();
    expect(row).toMatchObject({ version_id: null, amount: 20000 });
  });
});

describe('maintenance startup behaviour', () => {
  /** Minimum valid env; only the fields the scheduler reads matter here. */
  const schedulerEnv = (dir: string): Env =>
    envSchema.parse({
      DISCORD_TOKEN: 't',
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
      SEPAY_BANK_CODE: 'MBBANK',
      SEPAY_CODE_PREFIX: 'VN',
      VAULT_DIR: join(dir, 'vault'),
      TMP_DIR: join(dir, 'tmp'),
      DB_PATH: join(dir, 'db.sqlite'),
      SPIGOT_CREDENTIALS_FILE: join(dir, 'creds.json'),
      SPIGOT_ACCOUNTS_FILE: join(dir, 'cookies.json'),
    });

  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sched-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });
  afterEach(async () => {
    db.close();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  /** Counts update checks by counting Spiget calls, with no plugin to fetch. */
  const countingSpiget = (): { spiget: SpigetClient; calls: () => number } => {
    let calls = 0;
    const { impl } = stubFetch(() => {
      calls++;
      return { body: [] };
    });
    return { spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }), calls: () => calls };
  };

  it('runs one update check shortly after boot instead of waiting a full hour', async () => {
    // Without a delayed first run, a restart tells the owner nothing about
    // whether their setup works — they would wait an hour to learn a password
    // was mistyped.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });
    const { spiget, calls } = countingSpiget();

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      // Not immediate: the Discord client must finish connecting first, or
      // results would only reach the console.
      expect(calls()).toBe(0);

      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    } finally {
      handle.stop();
    }
  });

  it('attempts purchased-resource discovery even when no plugin has an id yet', async () => {
    // The deadlock this guards: discovery used to live inside the download sweep,
    // which runs only after the update check finds something. With no id anywhere
    // the check found nothing and returned, so discovery never ran and the ids
    // were never learned. A fresh vault could therefore never bootstrap itself.
    const env = schedulerEnv(dir);
    env.CHROME_PATH = join(dir, 'missing-chrome');
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    // Credentials must exist or discovery returns before it needs a browser.
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, 'acc  user  pass\n', 'utf8');
    // A plugin with NO resource id: exactly the state a fresh vault is in.
    createPlugin(db, { slug: 'v', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot' });

    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void logs.push(args.join(' '));

    const { spiget } = countingSpiget();
    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(
        () =>
          expect(
            // Discovery got far enough to need a browser and said so. Before the
            // fix it was never reached at all, so nothing mentioned the list.
            logs.some((l) => l.includes('danh sách đã mua') || l.includes('puppeteer-real-browser')),
          ).toBe(true),
        { timeout: 3_000 },
      );
    } finally {
      handle.stop();
      console.error = originalError;
    }
  });

  it('does not attempt discovery while the toggle is off', async () => {
    // The feature violates SpigotMC's terms, so nothing may reach out until the
    // owner has deliberately enabled it.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    createPlugin(db, { slug: 'v', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot' });

    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void logs.push(args.join(' '));

    const { spiget } = countingSpiget();
    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      expect(logs.some((l) => l.includes('danh sách đã mua'))).toBe(false);
    } finally {
      handle.stop();
      console.error = originalError;
    }
  });

  it('re-offers a version owed from a failed sweep even when the check finds nothing new', async () => {
    // The bug this pins: check-plugin-updates saves upstream_state BEFORE any
    // download runs, so a failed download leaves the state recorded. The next
    // sweep then sees uuid == latest, reports "already newest", and the version is
    // lost forever. pending_download existed for exactly this, but nothing ever
    // read from it.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, {
      slug: 'v',
      displayName: 'Vulcan',
      descriptorName: 'Vulcan',
      platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });

    // State already recorded, exactly as a failed sweep leaves it.
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-2-9-7-23',
      versionName: '2.9.7.23',
      releaseDateMs: 1_780_000_000_000,
    });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-2-9-7-23', versionName: '2.9.7.23' });

    // Spiget reports the same uuid: nothing new, so without the queue replay the
    // sweep would report "all current" and stop.
    const version = { uuid: 'uuid-2-9-7-23', name: '2.9.7.23', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(' '));

    vi.useFakeTimers();
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(
        () => expect(logs.some((l) => l.includes('bản cần tải') || l.includes('nợ từ lượt trước'))).toBe(true),
        { timeout: 3_000 },
      );
      // Still owed: nothing downloaded it, so it must remain queued rather than
      // being silently dropped.
      expect(listAllPendingDownloads(db)).toHaveLength(1);
    } finally {
      handle.stop();
      console.log = originalLog;
    }
  });

  it('queues the recent version history when the vault has nothing for a plugin', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, {
      slug: 'v',
      displayName: 'Vulcan',
      descriptorName: 'Vulcan',
      platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });

    // Ten versions available upstream, vault empty.
    const versions = Array.from({ length: 10 }, (_, i) => ({
      uuid: `uuid-${i}`,
      name: `2.9.${i}`,
      releaseDate: 1_780_000_000 - i * 1000,
      downloads: 5,
    }));
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? versions[0] : versions }));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(' '));

    vi.useFakeTimers();
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(() => expect(logs.some((l) => l.includes('kho trống'))).toBe(true), { timeout: 3_000 });
    } finally {
      handle.stop();
      console.log = originalLog;
    }
  });

  it('queues exact versions before auto-download when credentials and browser are unavailable', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    const plugin = createPlugin(db, {
      slug: 'v',
      displayName: 'Vulcan',
      descriptorName: 'Vulcan',
      platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });

    const version = { uuid: 'uuid-exact-2-9-7', name: '2.9.7', releaseDate: 1_780_000_000, downloads: 5 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });

    try {
      // No credential/cookie file exists, so neither discovery nor browser
      // download can run. The external worker must still receive the exact job.
      await handle.runUpdateCheck();
      expect(listAllPendingDownloads(db)).toEqual([
        expect.objectContaining({
          pluginId: plugin.id,
          versionUuid: 'uuid-exact-2-9-7',
          versionName: '2.9.7',
          attempts: 0,
        }),
      ]);
    } finally {
      await handle.stop();
    }
  });

  it('does not reset pending-download backoff when the same finding is rediscovered', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password', enabled: true,
      importedStatus: 'success', purchasedResources: ['Vulcan'],
    }]));
    const plugin = createPlugin(db, {
      slug: 'v',
      displayName: 'Vulcan',
      descriptorName: 'Vulcan',
      platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-retry', versionName: '2.9.8' });
    deferDownload(db, plugin.id, 'uuid-retry', 'Cloudflare blocked', 3_600);
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-retry',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });
    const before = listAllPendingDownloads(db)[0]!;

    const version = { uuid: 'uuid-retry', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 5 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });

    try {
      await handle.runUpdateCheck();
      const after = listAllPendingDownloads(db)[0]!;
      expect(after).toMatchObject({
        pluginId: plugin.id,
        versionUuid: 'uuid-retry',
        attempts: before.attempts,
        lastError: before.lastError,
        nextAttemptAt: before.nextAttemptAt,
        createdAt: before.createdAt,
      });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
    }
  });

  it('drains a pending download before opening Purchased Resources discovery', async () => {
    const env = schedulerEnv(dir);
    env.CHROME_PATH = join(dir, 'missing-chrome');
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password', enabled: true,
      importedStatus: 'success', purchasedResources: ['Vulcan'],
    }]));
    const plugin = createPlugin(db, {
      slug: 'v', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-backlog', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-backlog',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });

    const version = { uuid: 'uuid-backlog', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 5 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });

    try {
      await handle.runUpdateCheck();
      expect(errors.some((line) => line.includes('danh sÃ¡ch Ä‘Ã£ mua'))).toBe(false);
      expect(listAllPendingDownloads(db)).toHaveLength(1);
    } finally {
      console.error = originalError;
      await handle.stop();
    }
  });

  it('ends the sweep without launching another account while a challenge browser is held', async () => {
    const env = schedulerEnv(dir);
    env.SPIGOT_INTERACTIVE_CHALLENGE = true;
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([
      {
        label: 'account-a', username: 'account-a', password: 'password-a', enabled: true,
        importedStatus: 'success', purchasedResources: ['Vulcan'],
      },
      {
        label: 'account-b', username: 'account-b', password: 'password-b', enabled: true,
        importedStatus: 'success', purchasedResources: ['AnotherPlugin'],
      },
    ]));

    const plugin = createPlugin(db, {
      slug: 'vulcan', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-challenge', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-challenge',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });

    const page = {} as BrowserSession['page'];
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ page, close } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({
      ok: false,
      reason: 'challenged',
      detail: 'Cloudflare challenge',
    });
    const version = { uuid: 'uuid-challenge', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const challenges = new SpigotChallengeSessionManager();
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      challengeSessions: challenges,
    });

    try {
      await handle.runUpdateCheck();

      expect(handle.getUpdateStatus().running).toBe(false);
      expect(launch).toHaveBeenCalledOnce();
      expect(challenges.hasActive()).toBe(true);
      expect(listAllPendingDownloads(db)).toEqual([
        expect.objectContaining({ attempts: 0, lastError: 'Cloudflare challenge' }),
      ]);
      expect(listOwnership(db)).toEqual([
        expect.objectContaining({ resourceId: 83626, accountLabel: 'account-a', state: 'owned' }),
      ]);
    } finally {
      await challenges.close();
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
    }
  });

  it('clears the account cooldown after an interactive challenge login succeeds', async () => {
    const env = schedulerEnv(dir);
    env.SPIGOT_INTERACTIVE_CHALLENGE = true;
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password-a', enabled: true,
      importedStatus: 'success', purchasedResources: ['Vulcan'],
    }]));

    const plugin = createPlugin(db, {
      slug: 'vulcan', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-resume', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-resume',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });

    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot')
      .mockResolvedValueOnce({ ok: false, reason: 'challenged', detail: 'Cloudflare challenge' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-resume', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const challenges = new SpigotChallengeSessionManager();
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      challengeSessions: challenges,
    });

    try {
      await handle.runUpdateCheck();
      expect(challenges.hasActive()).toBe(true);

      await expect(challenges.retryLogin()).resolves.toEqual({ ok: true });
      await challenges.resolve();
      await handle.runUpdateCheck();

      expect(launch).toHaveBeenCalledTimes(2);
      expect(loginSpy).toHaveBeenCalledTimes(3);
      expect(downloadSpy).toHaveBeenCalledOnce();
    } finally {
      await challenges.close();
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  /** Seeds one enabled account plus one queued download, the shortest path to a sweep. */
  async function seedOneQueuedDownload(env: Env): Promise<void> {
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password-a', enabled: true,
      importedStatus: 'success', purchasedResources: ['Vulcan'],
    }]));
    const plugin = createPlugin(db, {
      slug: 'vulcan', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-proxy', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-proxy',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });
  }

  it('thử proxy khác khi proxy đầu không mở được, thay vì phạt tài khoản', async () => {
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000,2.2.2.2:8000' });
    const proxies: (string | undefined)[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => {
      proxies.push(options?.proxyServer);
      // Exit node chết: Chrome báo đúng lỗi này, và trước đây nó nổi lên thành
      // "Cloudflare chặn" nên tài khoản bị nghỉ vì lỗi của proxy.
      if (proxies.length === 1) throw new Error('net::ERR_PROXY_CONNECTION_FAILED at chrome-error://chromewebdata/');
      return { page: {} as BrowserSession['page'], close: vi.fn(async () => undefined) } satisfies BrowserSession;
    });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();

      expect(launch).toHaveBeenCalledTimes(2);
      expect(proxies[0]).toBeDefined();
      expect(proxies[1]).toBeDefined();
      expect(proxies[1]).not.toBe(proxies[0]);
      // Lượt quét vẫn chạy tới bước tải: tài khoản không bị loại vì lỗi proxy.
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(pool.describe()).toContain('đang nghỉ');
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('đổi IP rồi đăng nhập lại khi Cloudflare chặn, thay vì cho tài khoản nghỉ ngay', async () => {
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000,2.2.2.2:8000' });
    const proxies: (string | undefined)[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => {
      proxies.push(options?.proxyServer);
      return { page: {} as BrowserSession['page'], close: vi.fn(async () => undefined) } satisfies BrowserSession;
    });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot')
      .mockResolvedValueOnce({ ok: false, reason: 'challenged', detail: 'Cloudflare chặn trang đăng nhập' })
      .mockResolvedValueOnce({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();

      expect(loginSpy).toHaveBeenCalledTimes(2);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(proxies[1]).not.toBe(proxies[0]);
      expect(downloadSpy).toHaveBeenCalledOnce();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('đổi IP khi proxy chết làm điều hướng đầu tiên thất bại, và đóng browser cũ', async () => {
    // Chrome KHỞI ĐỘNG được với proxy đã chết: lỗi chỉ hiện ra ở lần goto đầu, tức
    // bên trong bước đăng nhập. Bắt ở lần mở browser là bắt sai chỗ.
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000,2.2.2.2:8000' });
    const proxies: (string | undefined)[] = [];
    const closes: number[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => {
      proxies.push(options?.proxyServer);
      const index = proxies.length;
      return {
        page: {} as BrowserSession['page'],
        close: vi.fn(async () => void closes.push(index)),
      } satisfies BrowserSession;
    });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot')
      .mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED at https://www.spigotmc.org/login'))
      .mockResolvedValueOnce({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();

      expect(launch).toHaveBeenCalledTimes(2);
      expect(proxies[1]).not.toBe(proxies[0]);
      // Phiên chạy qua proxy chết phải được đóng, không bỏ lại Chrome treo.
      expect(closes).toContain(1);
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(pool.describe()).toContain('đang nghỉ');
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('cho proxy nghỉ kể cả ở lượt thử cuối, để danh sách một proxy vẫn tích được nghỉ', async () => {
    // markBad nằm trong nhánh "còn đổi được" thì một proxy đã chứng minh là chết ở
    // lượt cuối không bao giờ bị cho nghỉ, và lượt quét sau lại đi vào đúng nó.
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000', cooldownMs: 60_000 });
    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot')
      .mockRejectedValue(new Error('net::ERR_PROXY_CONNECTION_FAILED at https://www.spigotmc.org/login'));
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();
      expect(pool.describe()).toContain('đang nghỉ');
      expect(await pool.next()).toBeNull();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
    }
  });

  it('cho proxy nghỉ khi nó chết GIỮA lượt tải, và bản đó vẫn còn nợ', async () => {
    // Proxy chết sau khi đã đăng nhập: page.goto bị từ chối nên đường tải trả
    // 'error', không phải 'challenged'. Không đọc ra thì lượt quét nã tiếp vào đúng
    // exit node đã chết và ghi lỗi cho từng plugin như thể plugin có vấn đề.
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000,2.2.2.2:8000', cooldownMs: 60_000 });
    const closes: string[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => void closes.push(options?.proxyServer ?? 'direct')),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({
      status: 'error',
      detail: 'net::ERR_PROXY_CONNECTION_FAILED at https://www.spigotmc.org/resources/83626/',
    });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();

      expect(downloadSpy).toHaveBeenCalled();
      expect(pool.describe()).toContain('đang nghỉ');
      // Phiên đi qua proxy chết bị đóng, không giữ lại để tải bản kế tiếp.
      expect(closes.length).toBeGreaterThan(0);
      // Bản này vẫn còn nợ và sẽ được thử lại, không bị coi là lỗi của plugin.
      const owed = listAllPendingDownloads(db)[0]!;
      expect(owed.versionUuid).toBe('uuid-proxy');
      expect(owed.lastError).toContain('proxy');
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('hết proxy rảnh thì mở thẳng chứ không bỏ tài khoản', async () => {
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000', cooldownMs: 60_000 });
    // Cho proxy duy nhất nghỉ trước khi lượt quét bắt đầu.
    const lease = (await pool.next())!;
    pool.markBad(lease.endpoint.id);

    const proxies: (string | undefined)[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => {
      proxies.push(options?.proxyServer);
      return { page: {} as BrowserSession['page'], close: vi.fn(async () => undefined) } satisfies BrowserSession;
    });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();
      expect(launch).toHaveBeenCalled();
      expect(proxies[0]).toBeUndefined();
      expect(downloadSpy).toHaveBeenCalledOnce();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('không dùng fetch thẳng khi phiên đi qua proxy, để một account chỉ có một IP', async () => {
    // fetch trong tiến trình Node đi từ IP máy chủ, còn trình duyệt lúc đó ở IP proxy.
    // Hai danh tính cho cùng một account trong cùng một phút là thứ đã bỏ tiền mua proxy
    // để tránh.
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({ list: '1.1.1.1:8000' });
    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(downloadSpy.mock.calls[0]?.[0].fetchImpl).toBeUndefined();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('vẫn dùng fetch thẳng khi chạy IP máy chủ, vì đó là đường nhanh hơn', async () => {
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: buildSpigotProxyPool({}).pool,
    });

    try {
      await handle.runUpdateCheck();
      expect(downloadSpy.mock.calls[0]?.[0].fetchImpl).toBeDefined();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('không xoay gì khi chưa cấu hình proxy: mở thẳng một lần', async () => {
    const env = schedulerEnv(dir);
    await seedOneQueuedDownload(env);

    const { pool } = buildSpigotProxyPool({});
    const proxies: (string | undefined)[] = [];
    const launch = vi.fn(async (options?: browserFlowModule.BrowserLaunchOptions) => {
      proxies.push(options?.proxyServer);
      return { page: {} as BrowserSession['page'], close: vi.fn(async () => undefined) } satisfies BrowserSession;
    });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot').mockResolvedValue({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-proxy', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      proxyPool: pool,
    });

    try {
      await handle.runUpdateCheck();
      expect(launch).toHaveBeenCalledOnce();
      expect(proxies[0]).toBeUndefined();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('keeps a challenged account on cooldown after a maintenance restart', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password-a', enabled: true,
      importedStatus: 'success', purchasedResources: ['Vulcan'],
    }]));

    const plugin = createPlugin(db, {
      slug: 'vulcan', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-persisted', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-persisted',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });

    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi.spyOn(browserFlowModule, 'loginToSpigot')
      .mockResolvedValueOnce({ ok: false, reason: 'challenged', detail: 'Cloudflare challenge' })
      .mockResolvedValue({ ok: true });
    const version = { uuid: 'uuid-persisted', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));

    const first = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });
    await first.runUpdateCheck();
    await first.stop();

    const second = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
    });
    try {
      await second.runUpdateCheck();
      expect(launch).toHaveBeenCalledOnce();
      expect(loginSpy).toHaveBeenCalledOnce();
      expect(listAllPendingDownloads(db)).toEqual([
        expect.objectContaining({ versionUuid: 'uuid-persisted', lastError: 'Cloudflare challenge' }),
      ]);
    } finally {
      await second.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
    }
  });

  it('closes a challenged browser and continues with another account in unattended mode', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([
      {
        label: 'account-a', username: 'account-a', password: 'password-a', enabled: true,
        importedStatus: 'success', purchasedResources: ['Vulcan', 'Account A Only'],
      },
      {
        label: 'account-b', username: 'account-b', password: 'password-b', enabled: true,
        importedStatus: 'success', purchasedResources: ['Vulcan', 'Account B Only'],
      },
    ]));

    const plugin = createPlugin(db, {
      slug: 'vulcan', displayName: 'Vulcan', descriptorName: 'Vulcan', platform: 'spigot',
    });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'uuid-unattended', versionName: '2.9.8' });
    saveUpstreamState(db, {
      pluginId: plugin.id,
      versionUuid: 'uuid-unattended',
      versionName: '2.9.8',
      releaseDateMs: 1_780_000_000_000,
    });

    const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    const launch = vi
      .fn()
      .mockResolvedValueOnce({ page: {} as BrowserSession['page'], close: closes[0] })
      .mockResolvedValueOnce({ page: {} as BrowserSession['page'], close: closes[1] });
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });
    const loginSpy = vi
      .spyOn(browserFlowModule, 'loginToSpigot')
      .mockResolvedValueOnce({ ok: false, reason: 'challenged', detail: 'Cloudflare challenge' })
      .mockResolvedValueOnce({ ok: true });
    const downloadSpy = vi.spyOn(browserFlowModule, 'downloadViaBrowser').mockResolvedValue({ status: 'gone' });
    const version = { uuid: 'uuid-unattended', name: '2.9.8', releaseDate: 1_780_000_000, downloads: 1 };
    const { impl } = stubFetch((url) => ({ body: url.includes('/latest') ? version : [version] }));
    const challenges = new SpigotChallengeSessionManager();
    const handle = startMaintenance({
      db,
      env,
      vaultDir: env.VAULT_DIR,
      spiget: new SpigetClient({ fetchImpl: impl, minIntervalMs: 0 }),
      challengeSessions: challenges,
    });

    try {
      await handle.runUpdateCheck();

      expect(handle.getUpdateStatus().running).toBe(false);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(loginSpy).toHaveBeenCalledTimes(2);
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(challenges.hasActive()).toBe(false);
      expect(closes[0]).toHaveBeenCalledOnce();
      expect(listAllPendingDownloads(db)).toHaveLength(0);
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
      loginSpy.mockRestore();
      downloadSpy.mockRestore();
    }
  });

  it('does not run the boot check after stop()', async () => {
    // A timer firing post-shutdown would touch a closed database.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });
    const { spiget, calls } = countingSpiget();

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    await handle.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(0);
  });

  it('waits for an in-flight sweep instead of leaving the browser to be killed', async () => {
    // A sweep holds Chrome open for minutes. If stop() returns before it finishes,
    // process.exit kills Chrome mid-write and the profile loses its Cloudflare
    // clearance, so every later sweep starts cold. The await is what lets the
    // sweep's own finally close the browser.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });

    let released = false;
    let sweepStarted = false;
    const spiget = {
      getLatestVersion: async () => {
        sweepStarted = true;
        // Stands in for a long download: resolves only once stop() is waiting.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        released = true;
        return null;
      },
      listVersions: async () => [],
    } as unknown as SpigetClient;

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });

    await vi.advanceTimersByTimeAsync(31_000);
    expect(sweepStarted).toBe(true);
    expect(released).toBe(false);

    const stopped = handle.stop();
    // Nothing advances the clock while stop() is pending, so the only way this
    // resolves is by awaiting the sweep. A stop() that returned immediately would
    // let the assertion below run with released still false.
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await stopped;

    expect(released).toBe(true);
  });

  it('gives up on a sweep that never releases, rather than wedging the process', async () => {
    // The opposite failure: a browser close that never resolves must not keep a
    // daemon alive forever. A lost profile beats a stuck process.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });

    const spiget = {
      getLatestVersion: () => new Promise(() => undefined),
      listVersions: async () => [],
    } as unknown as SpigetClient;

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    await vi.advanceTimersByTimeAsync(31_000);

    const stopped = handle.stop();
    await vi.advanceTimersByTimeAsync(20_000);

    // Resolves on the grace timeout even though the sweep is still hanging.
    await expect(stopped).resolves.toBeUndefined();
  });

  it('re-sweeps in minutes while versions are owed, not after the hourly tick', async () => {
    // The hour matches the upstream cache lifetime for CHECKING updates, which is
    // the wrong cadence for draining a backlog: a fresh vault owes dozens of
    // historical versions, and one batch per hour takes weeks to fill an archive.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });
    // An owed version: the sweep should come back for it well before the hour.
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'u-owed', versionName: '1.0' });

    const { spiget, calls } = countingSpiget();

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
      const afterFirst = calls();

      // Well short of the hourly interval.
      await vi.advanceTimersByTimeAsync(env.SPIGOT_BACKLOG_RESWEEP_MS + 5_000);
      await vi.waitFor(() => expect(calls()).toBeGreaterThan(afterFirst), { timeout: 2_000 });
    } finally {
      await handle.stop();
    }
  });

  it('re-sweeps in minutes while an account cooldown is still active', async () => {
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    await writeFile(env.SPIGOT_CREDENTIALS_FILE, JSON.stringify([{
      label: 'account-a', username: 'account-a', password: 'password', enabled: true,
      importedStatus: 'success', purchasedResources: [],
    }]));
    recordScan(db, 'account-a', 0, 'Cloudflare challenge', {
      retryAfterMs: env.SPIGOT_CHALLENGE_COOLDOWN_MS,
      intervalMs: 24 * 60 * 60 * 1000,
    });

    const launch = vi.fn(async () => ({
      page: {} as BrowserSession['page'],
      close: vi.fn(async () => undefined),
    } satisfies BrowserSession));
    const probeSpy = vi.spyOn(browserLauncherModule, 'probeBrowserLauncher').mockResolvedValue({
      available: true,
      launch,
    });

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(probeSpy).toHaveBeenCalledOnce(), { timeout: 2_000 });

      await vi.advanceTimersByTimeAsync(env.SPIGOT_BACKLOG_RESWEEP_MS + 5_000);
      await vi.waitFor(() => expect(probeSpy).toHaveBeenCalledTimes(2), { timeout: 2_000 });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
      probeSpy.mockRestore();
    }
  });

  it('waits the full interval when nothing is owed', async () => {
    // The fast cadence is for draining a backlog only. Keeping it on when the
    // queue is empty would poll upstream every few minutes for no reason.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 12345 });

    const { spiget, calls } = countingSpiget();

    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
      const afterFirst = calls();

      await vi.advanceTimersByTimeAsync(env.SPIGOT_BACKLOG_RESWEEP_MS + 5_000);
      expect(calls()).toBe(afterFirst);
    } finally {
      await handle.stop();
    }
  });

  it('warns before the 30-day cookie cliff, not after', async () => {
    // XenForo caps xf_user at 30 days and nothing announces the lapse. In cookie
    // mode the system therefore works for a month and then every download fails at
    // once — the failure nobody plans for. The warning has to arrive early enough
    // to be a chore rather than an outage.
    const env = schedulerEnv(dir);
    seedSettings(db, env);
    setSetting(db, 'auto_download_enabled', 'true');
    const plugin = createPlugin(db, { slug: 'mm', displayName: 'M', descriptorName: 'M', platform: 'spigot' });
    updatePlugin(db, plugin.id, { resourceId: 83626 });
    // Something to download, or the sweep returns before reading the cookie file.
    enqueueDownload(db, { pluginId: plugin.id, versionUuid: 'u-1', versionName: '1.0' });

    const day = 24 * 60 * 60 * 1000;
    saveSpigotAccounts(env.SPIGOT_ACCOUNTS_FILE, [
      {
        label: 'acc-fresh',
        xfUser: new Secret('u1'),
        xfSession: new Secret('s1'),
        issuedAt: new Date(Date.now() - 2 * day).toISOString(),
        lastVerifiedAt: null,
        status: 'ok',
      },
      {
        label: 'acc-old',
        xfUser: new Secret('u2'),
        xfSession: new Secret('s2'),
        issuedAt: new Date(Date.now() - 25 * day).toISOString(),
        lastVerifiedAt: null,
        status: 'ok',
      },
    ]);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

    const { spiget } = countingSpiget();
    vi.useFakeTimers();
    const handle = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, spiget });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(() => expect(warnings.some((w) => w.includes('acc-old'))).toBe(true), { timeout: 3_000 });
      // The fresh account must not be named, or the warning becomes noise the
      // owner learns to ignore.
      expect(warnings.some((w) => w.includes('acc-fresh'))).toBe(false);
      expect(warnings.some((w) => w.includes('spigot-refresh'))).toBe(true);
    } finally {
      await handle.stop();
      console.warn = originalWarn;
    }
  });
});
