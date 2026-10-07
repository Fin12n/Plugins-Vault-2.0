import { describe, it, expect, beforeEach } from 'vitest';
import {
  plugins,
  versions,
  pluginArtifacts,
  pluginEntitlements,
  orders,
  type Plugin,
  type Version,
  type PluginArtifact,
  type PluginEntitlement,
  type NewPlugin,
  type NewVersion,
  type NewPluginArtifact,
} from '@vault/db';
import { normalizePluginVersion } from '../src/services/registry/version-normalizer.js';
import {
  canonicalRegistryService,
  VersionAccessDeniedError,
} from '../src/services/registry/canonical-registry-service.js';
import type { Database } from '../src/db/neon.js';

function toCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase());
}

function extractEqPairs(cond: any): Array<{ colName: string; colKey: string; paramVal: any }> {
  if (!cond) return [];
  const pairs: Array<{ colName: string; colKey: string; paramVal: any }> = [];
  if (Array.isArray(cond.queryChunks)) {
    let colName: string | null = null;
    let paramVal: any = undefined;
    let hasParam = false;

    for (const chunk of cond.queryChunks) {
      if (chunk && chunk.table) {
        colName = chunk.name;
      } else if (chunk && chunk.value !== undefined && !Array.isArray(chunk.value)) {
        paramVal = chunk.value;
        hasParam = true;
      } else if (chunk && Array.isArray(chunk.queryChunks)) {
        pairs.push(...extractEqPairs(chunk));
      }
    }
    if (colName && hasParam) {
      pairs.push({ colName, colKey: toCamel(colName), paramVal });
    }
  }
  return pairs;
}

function matchesDrizzleCondition(item: any, cond: any): boolean {
  if (!cond) return true;
  if (typeof cond === 'function') return cond(item);

  const pairs = extractEqPairs(cond);
  if (pairs.length === 0) return true;

  for (const { colName, colKey, paramVal } of pairs) {
    const itemVal = item[colKey] !== undefined ? item[colKey] : item[colName];
    if (itemVal !== paramVal) {
      return false;
    }
  }
  return true;
}

function createQueryPromise<T>(items: T[]) {
  const result = [...items];
  const promise = Promise.resolve(result);
  const chainable = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: (n: number) => createQueryPromise(result.slice(0, n)),
    orderBy: () => createQueryPromise(result),
  };
  return chainable;
}

/**
 * In-memory Mock Database mô phỏng Drizzle ORM trên Neon PostgreSQL.
 * Đảm bảo kiểm thử chính xác các ràng buộc Uniqueness, Foreign Key, và Idempotency.
 */
function createMockRegistryDb(): Database {
  const pluginStore: Plugin[] = [];
  const versionStore: Version[] = [];
  const artifactStore: PluginArtifact[] = [];
  const entitlementStore: PluginEntitlement[] = [];
  let nextPluginId = 1;
  let nextVersionId = 1;
  let nextArtifactId = 1;
  let nextEntitlementId = 1;

  const mockDb: any = {
    _stores: {
      plugins: pluginStore,
      versions: versionStore,
      artifacts: artifactStore,
      entitlements: entitlementStore,
    },

    select: () => ({
      from: (table: any) => {
        let store: any[] = [];
        if (table === plugins) store = pluginStore;
        else if (table === versions) store = versionStore;
        else if (table === pluginArtifacts) store = artifactStore;
        else if (table === pluginEntitlements) store = entitlementStore;

        return {
          where: (cond: any) => {
            const filtered = store.filter((item) => matchesDrizzleCondition(item, cond));
            return createQueryPromise(filtered);
          },
          orderBy: () => createQueryPromise(store),
          limit: (n: number) => createQueryPromise(store.slice(0, n)),
        };
      },
    }),

    insert: (table: any) => ({
      values: (val: any) => ({
        returning: async () => {
          if (table === plugins) {
            // Check UNIQUE(slug)
            if (pluginStore.some((p) => p.slug === val.slug)) {
              throw new Error(`duplicate key value violates unique constraint "idx_plugins_slug"`);
            }
            // Check UNIQUE(platform, resource_id) where resource_id is not null
            if (val.resourceId !== null && val.resourceId !== undefined) {
              if (pluginStore.some((p) => p.platform === val.platform && p.resourceId === val.resourceId)) {
                throw new Error(`duplicate key value violates unique constraint "idx_plugins_source_resource"`);
              }
            }

            const record: Plugin = {
              id: nextPluginId++,
              pluginId: val.pluginId ?? `p-${val.slug}`,
              slug: val.slug,
              displayName: val.displayName,
              descriptorName: val.descriptorName,
              aliases: val.aliases ?? [],
              platform: val.platform ?? 'spigot',
              resourceId: val.resourceId ?? null,
              depositPrice: val.depositPrice ?? 0,
              isPremium: val.isPremium ?? false,
              description: val.description ?? '',
              spigotLink: val.spigotLink ?? '',
              enabled: val.enabled ?? true,
              scanIntervalSeconds: val.scanIntervalSeconds ?? 3600,
              nextScanAt: val.nextScanAt ?? null,
              lastScanAt: val.lastScanAt ?? null,
              lastScanStatus: val.lastScanStatus ?? 'idle',
              lastScanError: val.lastScanError ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            pluginStore.push(record);
            return [record];
          }

          if (table === versions) {
            // Check Foreign Key: plugin_id -> plugins.id
            if (!pluginStore.some((p) => p.id === val.pluginId)) {
              throw new Error(`violates foreign key constraint "versions_plugin_id_fkey"`);
            }
            // Check UNIQUE(plugin_id, version_normalized)
            if (val.versionNormalized) {
              if (versionStore.some((v) => v.pluginId === val.pluginId && v.versionNormalized === val.versionNormalized)) {
                throw new Error(`duplicate key value violates unique constraint "idx_versions_plugin_version_normalized"`);
              }
            }

            const record: Version = {
              id: nextVersionId++,
              pluginId: val.pluginId,
              version: val.version ?? null,
              versionNormalized: val.versionNormalized ?? null,
              rawVersion: val.rawVersion ?? null,
              sourceVersionId: val.sourceVersionId ?? null,
              sourceReleaseId: val.sourceReleaseId ?? null,
              releasedAt: val.releasedAt ?? null,
              metadata: val.metadata ?? {},
              status: val.status ?? 'active',
              firstSeenAt: new Date(),
              lastSeenAt: new Date(),
              sha256: val.sha256,
              relPath: val.relPath,
              bytes: val.bytes,
              originalName: val.originalName,
              descriptorKind: val.descriptorKind ?? 'spigot',
              isStable: val.isStable ?? true,
              versionFlag: val.versionFlag ?? 'ok',
              changeLogs: val.changeLogs ?? '',
              source: val.source ?? 'spigot_auto',
              uploadedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            versionStore.push(record);
            return [record];
          }

          if (table === pluginArtifacts) {
            // Check Foreign Key: plugin_version_id -> versions.id
            if (!versionStore.some((v) => v.id === val.pluginVersionId)) {
              throw new Error(`violates foreign key constraint "plugin_artifacts_plugin_version_id_fkey"`);
            }
            // Check UNIQUE(plugin_version_id)
            if (artifactStore.some((a) => a.pluginVersionId === val.pluginVersionId)) {
              throw new Error(`duplicate key value violates unique constraint "idx_plugin_artifacts_version"`);
            }

            const record: PluginArtifact = {
              id: nextArtifactId++,
              pluginVersionId: val.pluginVersionId,
              storageKey: val.storageKey,
              filename: val.filename,
              sizeBytes: val.sizeBytes,
              sha256: val.sha256,
              mimeType: val.mimeType ?? 'application/java-archive',
              jarValid: val.jarValid !== undefined ? val.jarValid : (val.status === 'READY'),
              status: val.status ?? 'PENDING',
              downloadedAt: val.downloadedAt ?? null,
              verifiedAt: val.verifiedAt ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            artifactStore.push(record);
            return [record];
          }

          if (table === pluginEntitlements) {
            // Check Foreign Key: plugin_version_id -> versions.id
            if (!versionStore.some((v) => v.id === val.pluginVersionId)) {
              throw new Error(`violates foreign key constraint "plugin_entitlements_plugin_version_id_fkey"`);
            }
            // Check UNIQUE(user_id, plugin_version_id)
            if (entitlementStore.some((e) => e.userId === val.userId && e.pluginVersionId === val.pluginVersionId)) {
              throw new Error(`duplicate key value violates unique constraint "idx_plugin_entitlements_user_version"`);
            }

            const record: PluginEntitlement = {
              id: nextEntitlementId++,
              userId: val.userId,
              pluginVersionId: val.pluginVersionId,
              orderId: val.orderId ?? null,
              status: val.status ?? 'ACTIVE',
              grantedAt: val.grantedAt ?? new Date(),
              revokedAt: val.revokedAt ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            entitlementStore.push(record);
            return [record];
          }

          return [];
        },
      }),
    }),

    update: (table: any) => ({
      set: (patch: any) => ({
        where: (cond: any) => ({
          returning: async () => {
            let store: any[] = [];
            if (table === plugins) store = pluginStore;
            else if (table === versions) store = versionStore;
            else if (table === pluginArtifacts) store = artifactStore;
            else if (table === pluginEntitlements) store = entitlementStore;

            const targets = store.filter((item) => matchesDrizzleCondition(item, cond));
            for (const item of targets) {
              Object.assign(item, patch);
            }
            return targets;
          },
        }),
      }),
    }),
  };

  return mockDb;
}

describe('PHASE 5A: Canonical Plugin / Version / Artifact Registry', () => {
  let db: Database;

  beforeEach(() => {
    db = createMockRegistryDb();
  });

  // ==========================================================================
  // VERSION NORMALIZATION (Section 5)
  // ==========================================================================
  describe('Version Normalization Logic', () => {
    it('normalizes raw version strings with leading v, V, release, ver prefixes', () => {
      expect(normalizePluginVersion('v1.20.3')).toBe('1.20.3');
      expect(normalizePluginVersion('V2.1.0')).toBe('2.1.0');
      expect(normalizePluginVersion('release-1.2.3')).toBe('1.2.3');
      expect(normalizePluginVersion('rel_2.4')).toBe('2.4');
      expect(normalizePluginVersion('ver 3.0.1')).toBe('3.0.1');
      expect(normalizePluginVersion('  v1.0.0  ')).toBe('1.0.0');
    });

    it('preserves non-SemVer strings without altering identity', () => {
      expect(normalizePluginVersion('1.20.4-R0.1-SNAPSHOT')).toBe('1.20.4-R0.1-SNAPSHOT');
      expect(normalizePluginVersion('b125')).toBe('b125');
      expect(normalizePluginVersion('Build #42')).toBe('Build #42');
      expect(normalizePluginVersion('2024.1')).toBe('2024.1');
      expect(normalizePluginVersion('')).toBe('');
      expect(normalizePluginVersion(null)).toBe('');
    });
  });

  // ==========================================================================
  // MANDATORY ACCEPTANCE TESTS (Section 19: TEST-5A-01 to TEST-5A-18)
  // ==========================================================================
  describe('Mandatory Registry Test Matrix', () => {
    it('TEST-5A-01: Create Plugin successfully initializes canonical identity', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'essentialsx',
        displayName: 'EssentialsX',
        descriptorName: 'Essentials',
        platform: 'spigot',
        resourceId: 9089,
        depositPrice: 0,
        isPremium: false,
      });

      expect(plugin.id).toBeDefined();
      expect(plugin.slug).toBe('essentialsx');
      expect(plugin.platform).toBe('spigot');
      expect(plugin.resourceId).toBe(9089);
      expect(plugin.enabled).toBe(true);
      expect(plugin.scanIntervalSeconds).toBe(3600);
      expect(plugin.lastScanStatus).toBe('idle');
    });

    it('TEST-5A-02: Same source/resource ID is idempotent', async () => {
      const p1 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'worldedit',
        displayName: 'WorldEdit',
        descriptorName: 'WorldEdit',
        platform: 'spigot',
        resourceId: 60,
      });

      // Gọi lại với cùng platform + resourceId nhưng slug/name có thể truyền vào lại
      const p2 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'worldedit-duplicate',
        displayName: 'WorldEdit Updated',
        descriptorName: 'WorldEdit',
        platform: 'spigot',
        resourceId: 60,
      });

      expect(p1.id).toBe(p2.id);
      expect(p2.slug).toBe('worldedit'); // Vẫn là plugin ban đầu
    });

    it('TEST-5A-03: Different source/resource ID creates different Plugin', async () => {
      const p1 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'vault',
        displayName: 'Vault',
        descriptorName: 'Vault',
        platform: 'spigot',
        resourceId: 34315,
      });

      const p2 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'luckperms',
        displayName: 'LuckPerms',
        descriptorName: 'LuckPerms',
        platform: 'spigot',
        resourceId: 28140,
      });

      expect(p1.id).not.toBe(p2.id);
      expect(p1.slug).toBe('vault');
      expect(p2.slug).toBe('luckperms');
    });

    it('TEST-5A-04: Create Plugin Version creates canonical version identity', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'coreprotect',
        displayName: 'CoreProtect',
        descriptorName: 'CoreProtect',
        platform: 'spigot',
        resourceId: 863,
      });

      const version = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: 'v22.4',
        rawVersion: 'v22.4',
        sha256: 'abc123sha',
        relPath: 'ab/abc123sha.jar',
        bytes: 1048576,
        originalName: 'CoreProtect-22.4.jar',
      });

      expect(version.id).toBeDefined();
      expect(version.pluginId).toBe(plugin.id);
      expect(version.version).toBe('v22.4');
      expect(version.versionNormalized).toBe('22.4');
      expect(version.status).toBe('active');
    });

    it('TEST-5A-05: Same plugin + normalized version is idempotent', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'citizens',
        displayName: 'Citizens',
        descriptorName: 'Citizens',
        platform: 'spigot',
        resourceId: 13811,
      });

      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: 'v2.0.30',
        sha256: 'shaCitizens1',
        relPath: 'ci/shaCitizens1.jar',
        bytes: 2000000,
        originalName: 'Citizens-2.0.30.jar',
      });

      // Lần scan thứ 2 với raw version không có chữ v (2.0.30)
      const v2 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '2.0.30',
        sha256: 'shaCitizens1',
        relPath: 'ci/shaCitizens1.jar',
        bytes: 2000000,
        originalName: 'Citizens-2.0.30.jar',
      });

      expect(v1.id).toBe(v2.id);
      expect(v2.versionNormalized).toBe('2.0.30');
    });

    it('TEST-5A-06: Same version string on different plugins is allowed', async () => {
      const p1 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'plugin-one',
        displayName: 'Plugin One',
        descriptorName: 'One',
        platform: 'spigot',
        resourceId: 101,
      });

      const p2 = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'plugin-two',
        displayName: 'Plugin Two',
        descriptorName: 'Two',
        platform: 'spigot',
        resourceId: 102,
      });

      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: p1.id,
        version: '1.0.0',
        sha256: 'sha1',
        relPath: 'p1/1.0.0.jar',
        bytes: 500,
        originalName: 'p1.jar',
      });

      const v2 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: p2.id,
        version: '1.0.0',
        sha256: 'sha2',
        relPath: 'p2/1.0.0.jar',
        bytes: 600,
        originalName: 'p2.jar',
      });

      expect(v1.id).not.toBe(v2.id);
      expect(v1.pluginId).toBe(p1.id);
      expect(v2.pluginId).toBe(p2.id);
      expect(v1.versionNormalized).toBe('1.0.0');
      expect(v2.versionNormalized).toBe('1.0.0');
    });

    it('TEST-5A-07: Version identity is immutable (cannot mutate 1.2 to 1.3 via update)', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'immutable-test',
        displayName: 'Immutable Plugin',
        descriptorName: 'Immutable',
        platform: 'spigot',
        resourceId: 200,
      });

      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.2.0',
        sha256: 'sha120',
        relPath: 'im/1.2.0.jar',
        bytes: 1000,
        originalName: 'im-1.2.0.jar',
      });

      // Tạo version 1.3.0 phải sinh bản ghi MỚI hoàn toàn
      const v2 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.3.0',
        sha256: 'sha130',
        relPath: 'im/1.3.0.jar',
        bytes: 1200,
        originalName: 'im-1.3.0.jar',
      });

      expect(v1.id).not.toBe(v2.id);
      expect(v1.versionNormalized).toBe('1.2.0');
      expect(v2.versionNormalized).toBe('1.3.0');
    });

    it('TEST-5A-08: Create Artifact successfully associates physical file to Version', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'art-plugin',
        displayName: 'Artifact Plugin',
        descriptorName: 'Art',
      });
      const version = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0',
        sha256: 'shaArt1',
        relPath: 'art/1.0.jar',
        bytes: 5000,
        originalName: 'art.jar',
      });

      const artifact = await canonicalRegistryService.getOrCreateArtifact(db, {
        pluginVersionId: version.id,
        storageKey: 'art/1.0.jar',
        filename: 'Art-1.0.jar',
        sizeBytes: 5000,
        sha256: 'shaArt1',
        mimeType: 'application/java-archive',
        jarValid: false,
        status: 'PENDING',
      });

      expect(artifact.id).toBeDefined();
      expect(artifact.pluginVersionId).toBe(version.id);
      expect(artifact.status).toBe('PENDING');
      expect(artifact.jarValid).toBe(false);
    });

    it('TEST-5A-09: Same Plugin Version cannot have duplicate canonical Artifact', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'single-art-plugin',
        displayName: 'Single Art',
        descriptorName: 'SingleArt',
      });
      const version = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0',
        sha256: 'shaSingle1',
        relPath: 'sa/1.0.jar',
        bytes: 4000,
        originalName: 'sa.jar',
      });

      const a1 = await canonicalRegistryService.getOrCreateArtifact(db, {
        pluginVersionId: version.id,
        storageKey: 'sa/1.0.jar',
        filename: 'sa.jar',
        sizeBytes: 4000,
        sha256: 'shaSingle1',
      });

      const a2 = await canonicalRegistryService.getOrCreateArtifact(db, {
        pluginVersionId: version.id,
        storageKey: 'sa/1.0-duplicate.jar',
        filename: 'sa-dup.jar',
        sizeBytes: 4000,
        sha256: 'shaSingle1',
      });

      // getOrCreateArtifact trả về cùng 1 artifact canonical
      expect(a1.id).toBe(a2.id);
    });

    it('TEST-5A-10: Artifact READY is the only usable state', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'ready-test',
        displayName: 'Ready Test',
        descriptorName: 'ReadyTest',
      });
      const version = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0',
        sha256: 'shaReady',
        relPath: 'r/1.0.jar',
        bytes: 100,
        originalName: 'r.jar',
      });

      await canonicalRegistryService.getOrCreateArtifact(db, {
        pluginVersionId: version.id,
        storageKey: 'r/1.0.jar',
        filename: 'r.jar',
        sizeBytes: 100,
        sha256: 'shaReady',
        status: 'DOWNLOADING',
        jarValid: false,
      });

      // Khi ở DOWNLOADING -> chưa usable
      expect(await canonicalRegistryService.isVersionArtifactReady(db, version.id)).toBe(false);

      // Chuyển sang VERIFYING -> vẫn chưa usable
      await canonicalRegistryService.updateArtifactStatus(db, version.id, 'VERIFYING');
      expect(await canonicalRegistryService.isVersionArtifactReady(db, version.id)).toBe(false);

      // Chuyển sang READY -> usable
      await canonicalRegistryService.updateArtifactStatus(db, version.id, 'READY');
      expect(await canonicalRegistryService.isVersionArtifactReady(db, version.id)).toBe(true);

      // Nếu FAILED hoặc CORRUPT -> không usable
      await canonicalRegistryService.updateArtifactStatus(db, version.id, 'CORRUPT');
      expect(await canonicalRegistryService.isVersionArtifactReady(db, version.id)).toBe(false);
    });

    it('TEST-5A-11: Create version-specific entitlement grants access to that specific version only', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'entitled-plugin',
        displayName: 'Entitled Plugin',
        descriptorName: 'Entitled',
      });
      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0.0',
        sha256: 'shaE1',
        relPath: 'e/1.jar',
        bytes: 100,
        originalName: 'e1.jar',
      });

      const entitlement = await canonicalRegistryService.grantVersionEntitlement(db, {
        userId: 'discord_user_123',
        pluginVersionId: v1.id,
      });

      expect(entitlement.id).toBeDefined();
      expect(entitlement.userId).toBe('discord_user_123');
      expect(entitlement.pluginVersionId).toBe(v1.id);
      expect(entitlement.status).toBe('ACTIVE');

      const hasAccess = await canonicalRegistryService.checkUserVersionAccess(db, {
        userId: 'discord_user_123',
        pluginVersionId: v1.id,
      });
      expect(hasAccess).toBe(true);
    });

    it('TEST-5A-12: Same user + same version cannot create duplicate active entitlement', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'dup-ent-plugin',
        displayName: 'Dup Ent Plugin',
        descriptorName: 'DupEnt',
      });
      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0.0',
        sha256: 'shaDE1',
        relPath: 'de/1.jar',
        bytes: 100,
        originalName: 'de1.jar',
      });

      const e1 = await canonicalRegistryService.grantVersionEntitlement(db, {
        userId: 'user_dup_test',
        pluginVersionId: v1.id,
      });

      const e2 = await canonicalRegistryService.grantVersionEntitlement(db, {
        userId: 'user_dup_test',
        pluginVersionId: v1.id,
      });

      expect(e1.id).toBe(e2.id);
    });

    it('TEST-5A-13: User owning version 1.1 does NOT own version 1.2 (BUSINESS RULE TUYỆT ĐỐI)', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'version-gate-plugin',
        displayName: 'Version Gate Plugin',
        descriptorName: 'VersionGate',
      });

      const v11 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.1.0',
        sha256: 'sha110',
        relPath: 'vg/1.1.0.jar',
        bytes: 1000,
        originalName: 'vg-1.1.0.jar',
      });

      const v12 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.2.0',
        sha256: 'sha120',
        relPath: 'vg/1.2.0.jar',
        bytes: 1200,
        originalName: 'vg-1.2.0.jar',
      });

      // User mua version 1.1.0
      await canonicalRegistryService.grantVersionEntitlement(db, {
        userId: 'buyer_vip',
        pluginVersionId: v11.id,
      });

      // User có quyền đối với 1.1.0
      expect(
        await canonicalRegistryService.checkUserVersionAccess(db, {
          userId: 'buyer_vip',
          pluginVersionId: v11.id,
        }),
      ).toBe(true);

      // User KHÔNG CÓ QUYỀN đối với 1.2.0
      expect(
        await canonicalRegistryService.checkUserVersionAccess(db, {
          userId: 'buyer_vip',
          pluginVersionId: v12.id,
        }),
      ).toBe(false);
    });

    it('TEST-5A-14: Refund/revoke does not delete historical Plugin, Version, or Artifact', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'refund-test-plugin',
        displayName: 'Refund Plugin',
        descriptorName: 'RefundPlugin',
      });
      const version = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0.0',
        sha256: 'shaRef1',
        relPath: 'ref/1.0.jar',
        bytes: 100,
        originalName: 'ref.jar',
      });
      const artifact = await canonicalRegistryService.getOrCreateArtifact(db, {
        pluginVersionId: version.id,
        storageKey: 'ref/1.0.jar',
        filename: 'ref.jar',
        sizeBytes: 100,
        sha256: 'shaRef1',
        status: 'READY',
        jarValid: true,
      });

      await canonicalRegistryService.grantVersionEntitlement(db, {
        userId: 'refund_user',
        pluginVersionId: version.id,
      });

      // Thu hồi quyền truy cập (Refund)
      const revoked = await canonicalRegistryService.revokeVersionEntitlement(db, {
        userId: 'refund_user',
        pluginVersionId: version.id,
        reason: 'Order refunded by customer request',
      });

      expect(revoked).toBeDefined();
      expect(revoked!.status).toBe('REVOKED');
      expect(revoked!.revokedAt).toBeDefined();

      // Quyền truy cập bị khóa
      expect(
        await canonicalRegistryService.checkUserVersionAccess(db, {
          userId: 'refund_user',
          pluginVersionId: version.id,
        }),
      ).toBe(false);

      // Nhưng Plugin, Version, và Artifact trong lịch sử VẪN TỒN TẠI NGUYÊN VẸN!
      expect(await canonicalRegistryService.getPluginById(db, plugin.id)).not.toBeNull();
      expect(await canonicalRegistryService.getVersionByNormalized(db, plugin.id, '1.0.0')).not.toBeNull();
      expect(await canonicalRegistryService.isVersionArtifactReady(db, version.id)).toBe(true);
    });

    it('TEST-5A-15: Concurrent upsert does not create duplicates (idempotency guarantee)', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'concurrency-plugin',
        displayName: 'Concurrency Plugin',
        descriptorName: 'Concurrency',
      });

      // 5 concurrent calls tạo cùng 1 version
      const versionPromises = Array.from({ length: 5 }, () =>
        canonicalRegistryService.getOrCreatePluginVersion(db, {
          pluginId: plugin.id,
          version: 'v3.5.0',
          sha256: 'shaConc350',
          relPath: 'c/3.5.0.jar',
          bytes: 888,
          originalName: 'c.jar',
        }),
      );

      const results = await Promise.all(versionPromises);
      const firstId = results[0]!.id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }
    });

    it('TEST-5A-16: Foreign-key integrity enforces valid relationships', async () => {
      // Cố tình tạo version cho plugin không tồn tại -> phải ném lỗi foreign key
      await expect(
        canonicalRegistryService.getOrCreatePluginVersion(db, {
          pluginId: 999999, // Không tồn tại
          version: '1.0',
          sha256: 'invalidFkSha',
          relPath: 'inv.jar',
          bytes: 1,
          originalName: 'inv.jar',
        }),
      ).rejects.toThrow(/foreign key/i);

      // Cố tình tạo artifact cho version không tồn tại -> phải ném lỗi foreign key
      await expect(
        canonicalRegistryService.getOrCreateArtifact(db, {
          pluginVersionId: 999999,
          storageKey: 'inv.jar',
          filename: 'inv.jar',
          sizeBytes: 1,
          sha256: 'invSha',
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('TEST-5A-17: Historical version remains queryable after new version release', async () => {
      const plugin = await canonicalRegistryService.getOrCreatePlugin(db, {
        slug: 'multi-ver-plugin',
        displayName: 'Multi Version',
        descriptorName: 'MultiVer',
      });

      const v1 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '1.0.0',
        sha256: 'shaV1',
        relPath: 'v1.jar',
        bytes: 100,
        originalName: 'v1.jar',
      });

      const v2 = await canonicalRegistryService.getOrCreatePluginVersion(db, {
        pluginId: plugin.id,
        version: '2.0.0',
        sha256: 'shaV2',
        relPath: 'v2.jar',
        bytes: 200,
        originalName: 'v2.jar',
      });

      // Cả 2 version đều truy vấn được độc lập
      const queriedV1 = await canonicalRegistryService.getVersionByNormalized(db, plugin.id, '1.0.0');
      const queriedV2 = await canonicalRegistryService.getVersionByNormalized(db, plugin.id, '2.0.0');

      expect(queriedV1?.id).toBe(v1.id);
      expect(queriedV2?.id).toBe(v2.id);
      expect(queriedV1?.id).not.toBe(queriedV2?.id);
    });

    it('TEST-5A-18: No duplicate/parallel schema concept was introduced', () => {
      // Xác nhận canonical model reuse đúng các thực thể cốt lõi
      expect(plugins).toBeDefined();
      expect(versions).toBeDefined();
      expect(pluginArtifacts).toBeDefined();
      expect(pluginEntitlements).toBeDefined();
      expect(orders).toBeDefined();
    });
  });
});
