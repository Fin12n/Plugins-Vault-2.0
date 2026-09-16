import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import {
  assignPluginOwnership,
  findOwner,
  findOwners,
  findUnassignedPlugins,
  listAccountOwnedPlugins,
  listAllPluginOwnerships,
  recordOwnership,
  removePluginOwnership,
} from '../src/repositories/resource-ownership.js';
import { autoDownloadVersions } from '../src/services/upstream/auto-download-versions.js';
import type { UpdateFinding } from '../src/services/upstream/check-plugin-updates.js';
import { Secret } from '../src/services/upstream/spigot-account-store.js';
import { buildZip } from './helpers/jar-fixture-builder.js';

function makeJar(name: string, version: string): Buffer {
  return buildZip([
    { name: 'plugin.yml', data: Buffer.from(`name: ${name}\nversion: ${version}\nmain: a.B\n`, 'utf8') },
    { name: 'a/B.class', data: Buffer.alloc(1024) },
  ]);
}

describe('Strict Account Targeting & Ownership Management', () => {
  let db: Database.Database;
  let root: string;
  let accountsFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spigot-strict-'));
    await mkdir(join(root, 'vault'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    accountsFile = join(root, 'spigot-credentials.json');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);

    createPlugin(db, {
      slug: 'pro-eggwars',
      displayName: 'Pro EggWars',
      descriptorName: 'ProEggWars',
      platform: 'spigot',
      depositPrice: 0,
      isPremium: true,
      resourceId: 8888,
    });

    createPlugin(db, {
      slug: 'speedrun-minigame',
      displayName: 'SpeedRun Minigame',
      descriptorName: 'SpeedRun',
      platform: 'spigot',
      depositPrice: 0,
      isPremium: true,
      resourceId: 9999,
    });
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const stubAccount = (label: string) => ({
    label,
    xfUser: new Secret('u'),
    xfSession: new Secret('s'),
    issuedAt: null,
    lastVerifiedAt: null,
    status: 'ok' as const,
  });

  const makeFinding = (resourceId: number, pluginName: string): UpdateFinding => ({
    pluginId: 1,
    pluginName,
    resourceId,
    isPremium: true,
    upstream: { uuid: 'v-1', name: '1.0.0', releaseDateMs: Date.now(), downloads: 1 },
    archivedVersion: null,
  });

  describe('Repository ownership functions', () => {
    it('correctly assigns, lists and removes plugin ownership', () => {
      expect(findUnassignedPlugins(db)).toHaveLength(2);

      // Assign plugin 8888 to DavsonMC
      expect(assignPluginOwnership(db, 8888, 'DavsonMC')).toBe(true);
      expect(findOwner(db, 8888)).toBe('DavsonMC');
      expect(findOwners(db, 8888)).toEqual(['DavsonMC']);

      // List owned plugins for DavsonMC
      const davsonPlugins = listAccountOwnedPlugins(db, 'DavsonMC');
      expect(davsonPlugins).toHaveLength(1);
      expect(davsonPlugins[0]?.resourceId).toBe(8888);
      expect(davsonPlugins[0]?.displayName).toBe('Pro EggWars');

      // Unassigned plugins should now only have SpeedRun (9999)
      const unassigned = findUnassignedPlugins(db);
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0]?.resourceId).toBe(9999);

      // List all plugin ownerships
      const allMaps = listAllPluginOwnerships(db);
      const eggwarsMap = allMaps.find((m) => m.resourceId === 8888);
      expect(eggwarsMap?.owners).toEqual(['DavsonMC']);

      // Remove ownership
      expect(removePluginOwnership(db, 8888, 'DavsonMC')).toBe(true);
      expect(findOwner(db, 8888)).toBeNull();
      expect(listAccountOwnedPlugins(db, 'DavsonMC')).toHaveLength(0);
      expect(findUnassignedPlugins(db)).toHaveLength(2);
    });
  });

  describe('autoDownloadVersions strict targeting', () => {
    it('refuses to blindly download with other accounts when credentials file has no owner', async () => {
      // Credentials file specifies martyy owns SpeedRun, but nobody owns Pro EggWars
      await writeFile(
        accountsFile,
        JSON.stringify([
          {
            label: 'martyycz4@gmail.com',
            username: 'martyy',
            password: 'pwd',
            purchasedResources: ['SpeedRun Minigame'],
            enabled: true,
          },
        ]),
      );

      const fetchCalls: string[] = [];
      const fetchJar = async (account: { label: string }) => {
        fetchCalls.push(account.label);
        return { status: 'incomplete' as const, detail: 'should not be called' };
      };

      const finding = makeFinding(8888, 'Pro EggWars'); // Not owned by martyy

      const result = await autoDownloadVersions(
        {
          db,
          ingest: { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') },
          accounts: [stubAccount('martyycz4@gmail.com')],
          accountsFile,
          download: { tmpDir: join(root, 'tmp'), maxBytes: 10_000_000 },
          minIntervalMs: 0,
          maxPerSweep: 5,
          isEnabled: () => true,
          fetchJar,
        },
        [finding],
      );

      // Must NOT call fetchJar with martyy for Pro EggWars!
      expect(fetchCalls).toHaveLength(0);
      expect(result.outcomes[0]?.status).toBe('not_owned');
      expect(result.outcomes[0]?.detail).toContain('chưa xác định tài khoản sở hữu');
    });

    it('auto-discovers owner from credentials file and downloads ONLY with that owner', async () => {
      await writeFile(
        accountsFile,
        JSON.stringify([
          {
            label: 'martyycz4@gmail.com',
            username: 'martyy',
            password: 'pwd',
            purchasedResources: ['SpeedRun Minigame [Racing, Stages]'],
            enabled: true,
          },
          {
            label: 'DavsonMC',
            username: 'DavsonMC',
            password: 'pwd',
            purchasedResources: ['Pro EggWars [Solo, Teams]'],
            enabled: true,
          },
        ]),
      );

      const fetchCalls: string[] = [];
      const fetchJar = async (account: { label: string }) => {
        fetchCalls.push(account.label);
        const jarPath = join(root, 'tmp', 'downloaded.jar');
        await writeFile(jarPath, makeJar('ProEggWars', '1.0.0'));
        return { status: 'ok' as const, tmpPath: jarPath, bytes: 1024, rotated: null };
      };

      const finding = makeFinding(8888, 'Pro EggWars');

      const result = await autoDownloadVersions(
        {
          db,
          ingest: {
            db,
            vaultDir: join(root, 'vault'),
            tmpDir: join(root, 'tmp'),
          },
          accounts: [stubAccount('martyycz4@gmail.com'), stubAccount('DavsonMC')],
          accountsFile,
          download: { tmpDir: join(root, 'tmp'), maxBytes: 10_000_000 },
          minIntervalMs: 0,
          maxPerSweep: 5,
          isEnabled: () => true,
          fetchJar,
        },
        [finding],
      );

      // Must call ONLY DavsonMC! martyycz4@gmail.com must never be called.
      expect(fetchCalls).toEqual(['DavsonMC']);
      expect(result.outcomes[0]?.status).toBe('archived');
      expect(result.outcomes[0]?.accountLabel).toBe('DavsonMC');

      // Check that DB learned DavsonMC as the owner
      expect(findOwner(db, 8888)).toBe('DavsonMC');
    });

    it('does NOT fallback to other accounts when confirmed owner download fails', async () => {
      // Both accounts exist in system, but 8888 is strictly owned by DavsonMC
      recordOwnership(db, 8888, 'DavsonMC', 'owned');

      const fetchCalls: string[] = [];
      const fetchJar = async (account: { label: string }) => {
        fetchCalls.push(account.label);
        // DavsonMC fails with transient error
        return { status: 'error' as const, detail: 'kết nối bị gián đoạn' };
      };

      const finding = makeFinding(8888, 'Pro EggWars');

      const result = await autoDownloadVersions(
        {
          db,
          ingest: { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') },
          accounts: [stubAccount('martyycz4@gmail.com'), stubAccount('DavsonMC')],
          accountsFile,
          download: { tmpDir: join(root, 'tmp'), maxBytes: 10_000_000 },
          minIntervalMs: 0,
          maxPerSweep: 5,
          isEnabled: () => true,
          fetchJar,
        },
        [finding],
      );

      // ONLY DavsonMC was attempted. martyycz4 was NEVER tried!
      expect(fetchCalls).toEqual(['DavsonMC']);
      expect(result.outcomes[0]?.status).toBe('retrying');
    });
  });
});
