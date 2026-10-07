import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
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
} from '@vault/db';
import type { Database } from '../src/db/neon.js';
import { normalizePluginVersion } from '../src/services/registry/version-normalizer.js';
import {
  comparePluginVersions,
  parsePluginVersion,
} from '../src/services/registry/version-comparator.js';
import {
  type PluginSourceAdapter,
  SourceAdapterError,
} from '../src/services/registry/source-adapter.js';
import { SpigetPluginSourceAdapter } from '../src/services/registry/spiget-source-adapter.js';
import {
  PluginScannerService,
  type SingleScanResult,
} from '../src/services/registry/plugin-scanner-service.js';

/**
 * Trợ thủ khởi tạo Real Local HTTP Server sử dụng node:http
 * Đáp ứng yêu cầu Section 32: Real HTTP Transport Verification.
 */
function createTestHttpServer() {
  let server: http.Server | null = null;
  let baseUrl = '';
  type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

  const routes: Array<{
    matcher: (url: string, req: http.IncomingMessage) => boolean;
    handler: Handler;
  }> = [];

  const requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
  }> = [];

  function on(
    pathPrefixOrMatcher: string | ((url: string, req: http.IncomingMessage) => boolean),
    handler: Handler,
  ) {
    const matcher =
      typeof pathPrefixOrMatcher === 'string'
        ? (url: string) => url.startsWith(pathPrefixOrMatcher)
        : pathPrefixOrMatcher;
    routes.unshift({ matcher, handler });
  }

  async function start(): Promise<string> {
    return new Promise((resolve) => {
      server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        requests.push({
          method: req.method ?? 'GET',
          url,
          headers: req.headers,
        });

        for (const route of routes) {
          if (route.matcher(url, req)) {
            await route.handler(req, res);
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve(baseUrl);
      });
    });
  }

  async function close(): Promise<void> {
    return new Promise((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  return {
    start,
    close,
    on,
    getBaseUrl: () => baseUrl,
    getRequests: () => requests,
    clearRequests: () => {
      requests.length = 0;
    },
  };
}

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
 * Đảm bảo các ràng buộc Unique, Foreign Key và Scan Eligibility logic.
 */
function createMockRegistryDb(): Database {
  const pluginStore: Plugin[] = [];
  const versionStore: Version[] = [];
  const artifactStore: PluginArtifact[] = [];
  const entitlementStore: PluginEntitlement[] = [];
  const orderStore: any[] = [];
  let nextPluginId = 1;
  let nextVersionId = 1;

  const mockDb: any = {
    _stores: {
      plugins: pluginStore,
      versions: versionStore,
      artifacts: artifactStore,
      entitlements: entitlementStore,
      orders: orderStore,
    },

    select: () => ({
      from: (table: any) => {
        let store: any[] = [];
        if (table === plugins) store = pluginStore;
        else if (table === versions) store = versionStore;
        else if (table === pluginArtifacts) store = artifactStore;
        else if (table === pluginEntitlements) store = entitlementStore;
        else if (table === orders) store = orderStore;

function hasNextScanCondition(cond: any): boolean {
  if (!cond) return false;
  if (Array.isArray(cond.queryChunks)) {
    for (const chunk of cond.queryChunks) {
      if (chunk && chunk.name === 'next_scan_at') return true;
      if (chunk && Array.isArray(chunk.queryChunks) && hasNextScanCondition(chunk)) return true;
    }
  }
  return false;
}

        const queryBase = createQueryPromise(store);
        return Object.assign(queryBase, {
          where: (cond: any) => {
            const filtered = store.filter((item: any) => {
              if (table === plugins && hasNextScanCondition(cond)) {
                if (item.enabled !== true) return false;
                if (item.resourceId === null || item.resourceId === undefined) return false;
                if (item.nextScanAt !== null && item.nextScanAt !== undefined) {
                  if (new Date(item.nextScanAt).getTime() > Date.now()) return false;
                }
                return true;
              }
              return matchesDrizzleCondition(item, cond);
            });
            return createQueryPromise(filtered);
          },
        });
      },
    }),

    insert: (table: any) => ({
      values: (val: any) => {
        const executeInsert = async () => {
          if (table === plugins) {
            // UNIQUE(slug)
            if (pluginStore.some((p) => p.slug === val.slug)) {
              throw new Error(`duplicate key value violates unique constraint "idx_plugins_slug"`);
            }
            // UNIQUE(platform, resource_id)
            if (val.resourceId !== null && val.resourceId !== undefined) {
              if (
                pluginStore.some(
                  (p) => p.platform === val.platform && p.resourceId === val.resourceId,
                )
              ) {
                throw new Error(
                  `duplicate key value violates unique constraint "idx_plugins_source_resource"`,
                );
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
            // Check Foreign Key
            if (!pluginStore.some((p) => p.id === val.pluginId)) {
              throw new Error(`violates foreign key constraint "versions_plugin_id_fkey"`);
            }
            // UNIQUE(plugin_id, version_normalized)
            if (val.versionNormalized) {
              if (
                versionStore.some(
                  (v) =>
                    v.pluginId === val.pluginId &&
                    v.versionNormalized === val.versionNormalized,
                )
              ) {
                throw new Error(
                  `duplicate key value violates unique constraint "idx_versions_plugin_version_normalized"`,
                );
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
            throw new Error('Scanner must not insert into plugin_artifacts');
          }

          if (table === pluginEntitlements) {
            throw new Error('Scanner must not insert into plugin_entitlements');
          }

          return [];
        };
        const p = executeInsert();
        return Object.assign(p, {
          returning: () => p,
        });
      },
    }),

    update: (table: any) => ({
      set: (patch: any) => ({
        where: (cond: any) => ({
          returning: async () => {
            let store: any[] = [];
            if (table === plugins) store = pluginStore;
            else if (table === versions) store = versionStore;

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

describe('PHASE 5B: Spiget Scanner & Remote Version Detection', () => {
  let db: Database;
  let testServer: ReturnType<typeof createTestHttpServer>;

  beforeEach(async () => {
    db = createMockRegistryDb();
    testServer = createTestHttpServer();
  });

  afterEach(async () => {
    await testServer.close();
  });

  // ==========================================================================
  // A. VERSION COMPARISON & PARSING ABSTRACTION
  // ==========================================================================
  describe('Version Comparison Abstraction', () => {
    it('TEST-5B-05: v-prefix normalization preserves version identity and ordering', () => {
      expect(normalizePluginVersion('v1.20.4')).toBe('1.20.4');
      expect(normalizePluginVersion('V2.5.0-RELEASE')).toBe('2.5.0-RELEASE');
      expect(normalizePluginVersion('release-3.1')).toBe('3.1');
      expect(normalizePluginVersion('ver_4.0')).toBe('4.0');
      // So sánh giữa v1.2.3 và 1.2.3 phải bằng 0 (cùng 1 identity)
      expect(comparePluginVersions('v1.2.3', '1.2.3')).toBe(0);
      expect(comparePluginVersions('Release-2.0', 'v2.0')).toBe(0);
    });

    it('TEST-5B-06: Numeric version comparison handles arbitrary segment lengths (not lexical)', () => {
      // 1.10.0 > 1.9.0 (lexical string comparison would falsely claim "1.10.0" < "1.9.0")
      expect(comparePluginVersions('1.10.0', '1.9.0')).toBe(1);
      expect(comparePluginVersions('1.9.0', '1.10.0')).toBe(-1);

      // Multi-segment numeric comparisons
      expect(comparePluginVersions('1.20.4', '1.20.3')).toBe(1);
      expect(comparePluginVersions('2.0.0', '1.99.99')).toBe(1);
      expect(comparePluginVersions('1.2.3.4', '1.2.3.3')).toBe(1);

      // Release > Prerelease
      expect(comparePluginVersions('1.0.0', '1.0.0-SNAPSHOT')).toBe(1);
      expect(comparePluginVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
    });

    it('TEST-5B-07: Ambiguous version does not silently invent ordering (returns null)', () => {
      // Chuỗi lạ không chứa phân đoạn số có thể so sánh an toàn
      const res1 = comparePluginVersions('SpecialEdition', 'CommunityBuild');
      expect(res1).toBeNull();

      const res2 = comparePluginVersions('build_alpha_x', 'build_beta_y');
      expect(res2).toBeNull();

      // parsePluginVersion đánh dấu ambiguous = true
      const parsed = parsePluginVersion('SpecialEdition');
      expect(parsed.isAmbiguous).toBe(true);
      expect(parsed.raw).toBe('SpecialEdition');
    });
  });

  // ==========================================================================
  // B. REAL HTTP TRANSPORT VERIFICATION (node:http Server)
  // ==========================================================================
  describe('Real HTTP Transport Verification (node:http)', () => {
    it('TEST-5B-01: Successful Spiget response over real HTTP transport', async () => {
      testServer.on('/resources/12345/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 99991,
            uuid: 'spiget-uuid-99991',
            name: 'v2.4.0',
            releaseDate: 1728000000, // Unix seconds
            downloads: 1500,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        timeoutMs: 3000,
      });

      const meta = await adapter.getLatestVersion({
        platform: 'spigot',
        resourceId: 12345,
      });

      expect(meta).not.toBeNull();
      expect(meta!.rawVersion).toBe('v2.4.0');
      expect(meta!.versionNormalized).toBe('2.4.0');
      expect(meta!.sourceVersionId).toBe('spiget-uuid-99991');
      expect(meta!.releasedAt.getTime()).toBe(1728000000 * 1000);
      expect(meta!.downloads).toBe(1500);

      const requests = testServer.getRequests();
      expect(requests.length).toBe(1);
      expect(requests[0]!.url).toContain('/resources/12345/versions/latest');
    });

    it('TEST-5B-08: Malformed API response throws INVALID_RESPONSE and avoids fake version', async () => {
      testServer.on('/resources/12345/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Trả về JSON thiếu trường "name" và "releaseDate"
        res.end(JSON.stringify({ invalid: true, foo: 'bar' }));
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        timeoutMs: 3000,
        maxRetries: 1,
      });

      await expect(
        adapter.getLatestVersion({ platform: 'spigot', resourceId: 12345 }),
      ).rejects.toThrow(/INVALID_RESPONSE|thiếu trường/i);
    });

    it('TEST-5B-10: 429 honors Retry-After header over real HTTP transport', async () => {
      let requestCount = 0;
      testServer.on('/resources/555/versions/latest', (_req, res) => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '1', // 1 giây
          });
          res.end(JSON.stringify({ error: 'Too Many Requests' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 5551,
            name: '1.0.0',
            releaseDate: 1728000000,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        maxRetries: 2,
        baseDelayMs: 50,
      });

      const meta = await adapter.getLatestVersion({
        platform: 'spigot',
        resourceId: 555,
      });

      expect(meta).not.toBeNull();
      expect(meta!.rawVersion).toBe('1.0.0');
      expect(requestCount).toBe(2);
    });

    it('TEST-5B-11: Transient 503 failure retries and succeeds over real HTTP', async () => {
      let callCount = 0;
      testServer.on('/resources/777/versions/latest', (_req, res) => {
        callCount++;
        if (callCount <= 2) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 7771,
            name: '3.0.0',
            releaseDate: 1728000000,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        maxRetries: 3,
        baseDelayMs: 20,
      });

      const meta = await adapter.getLatestVersion({
        platform: 'spigot',
        resourceId: 777,
      });

      expect(meta).not.toBeNull();
      expect(meta!.rawVersion).toBe('3.0.0');
      expect(callCount).toBe(3);
    });

    it('TEST-5B-12: Permanent failure (403 Forbidden) does not retry indefinitely', async () => {
      let callCount = 0;
      testServer.on('/resources/888/versions/latest', (_req, res) => {
        callCount++;
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        maxRetries: 3,
        baseDelayMs: 20,
      });

      await expect(
        adapter.getLatestVersion({ platform: 'spigot', resourceId: 888 }),
      ).rejects.toThrow(/PERMANENT|HTTP 403/i);

      // Thất bại ngay ở attempt 1, không thử lại 3 lần vô ích
      expect(callCount).toBe(1);
    });

    it('TEST-5B-13: Request timeout triggers TIMEOUT error cleanly', async () => {
      testServer.on('/resources/999/versions/latest', (_req, _res) => {
        // Cố tình không trả lời để kích hoạt AbortSignal.timeout
      });
      const baseUrl = await testServer.start();

      const adapter = new SpigetPluginSourceAdapter({
        baseUrl,
        timeoutMs: 100, // Timeout cực nhanh 100ms
        maxRetries: 1,
        baseDelayMs: 10,
      });

      await expect(
        adapter.getLatestVersion({ platform: 'spigot', resourceId: 999 }),
      ).rejects.toThrow(/TIMEOUT|Hết thời gian chờ/i);
    });
  });

  // ==========================================================================
  // C. SCANNER SERVICE WORKFLOW & DATABASE INTEGRATION MATRIX
  // ==========================================================================
  describe('Scanner Workflow & Database Matrix', () => {
    it('TEST-5B-03: New version is inserted on discovery', async () => {
      testServer.on('/resources/1001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 2001,
            name: '1.5.0',
            releaseDate: 1728000000,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const [plugin] = await db
        .insert(plugins)
        .values({
          slug: 'test-plugin-1',
          displayName: 'Test Plugin 1',
          descriptorName: 'Test1',
          platform: 'spigot',
          resourceId: 1001,
          enabled: true,
          scanIntervalSeconds: 3600,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 2000 }),
      );

      const res1 = await scanner.scanPlugin(db, plugin.id);
      expect(res1.status).toBe('SUCCESS');
      expect(res1.isNewVersion).toBe(true);
      expect(res1.remoteVersion).toBe('1.5.0');
      expect(res1.versionNormalized).toBe('1.5.0');

      const allVers = await db.select().from(versions);
      expect(allVers.length).toBe(1);
      expect(allVers[0]!.versionNormalized).toBe('1.5.0');
      expect(allVers[0]!.pluginId).toBe(plugin.id);
    });

    it('TEST-5B-02: Existing version is reused without creating duplicate rows', async () => {
      testServer.on('/resources/1001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 2001,
            name: '1.5.0',
            releaseDate: 1728000000,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const [plugin] = await db
        .insert(plugins)
        .values({
          slug: 'test-plugin-reuse',
          displayName: 'Test Plugin Reuse',
          descriptorName: 'TestReuse',
          platform: 'spigot',
          resourceId: 1001,
          enabled: true,
        })
        .returning();

      // Đã có sẵn version trong DB
      await db.insert(versions).values({
        pluginId: plugin.id,
        version: '1.5.0',
        versionNormalized: '1.5.0',
        sha256: 'sha-existing-150',
        relPath: 'p.jar',
        bytes: 100,
        originalName: 'p.jar',
      });

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 2000 }),
      );

      const res = await scanner.scanPlugin(db, plugin.id);
      expect(res.status).toBe('SUCCESS');
      expect(res.isNewVersion).toBe(false);

      const allVers = await db.select().from(versions);
      expect(allVers.length).toBe(1); // Vẫn chỉ là 1 bản ghi duy nhất!
    });

    it('TEST-5B-04: Repeated scan (5 times) is strictly idempotent', async () => {
      testServer.on('/resources/1002/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 2002,
            name: 'v3.2.1',
            releaseDate: 1728000000,
          }),
        );
      });
      const baseUrl = await testServer.start();

      const [plugin] = await db
        .insert(plugins)
        .values({
          slug: 'idempotent-plugin',
          displayName: 'Idempotent Plugin',
          descriptorName: 'Idem',
          platform: 'spigot',
          resourceId: 1002,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 2000 }),
      );

      // Quét 5 lần liên tiếp
      for (let i = 0; i < 5; i++) {
        const res = await scanner.scanPlugin(db, plugin.id);
        expect(res.status).toBe('SUCCESS');
      }

      // Chỉ có duy nhất 1 bản ghi version
      const vers = await db.select().from(versions);
      expect(vers.length).toBe(1);
      expect(vers[0]!.versionNormalized).toBe('3.2.1');
    });

    it('TEST-5B-09: 404 does not delete Plugin or historical Versions', async () => {
      testServer.on('/resources/4040/versions/latest', (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Resource not found' }));
      });
      const baseUrl = await testServer.start();

      const [plugin] = await db
        .insert(plugins)
        .values({
          slug: 'missing-resource-plugin',
          displayName: 'Missing Resource',
          descriptorName: 'Missing',
          platform: 'spigot',
          resourceId: 4040,
          enabled: true,
        })
        .returning();

      // Giả sử plugin đã có 1 version lịch sử từ trước
      await db.insert(versions).values({
        pluginId: plugin.id,
        version: '1.0.0',
        versionNormalized: '1.0.0',
        sha256: 'historical-sha-404',
        relPath: 'hist.jar',
        bytes: 500,
        originalName: 'hist.jar',
      });

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 2000 }),
      );

      const res = await scanner.scanPlugin(db, plugin.id);
      expect(res.status).toBe('NOT_FOUND');

      // Plugin và historical version VẪN NGUYÊN VẸN!
      const pAfter = await db.select().from(plugins);
      expect(pAfter.some((p) => p.id === plugin.id)).toBe(true);
      const vAfter = await db.select().from(versions);
      expect(vAfter.some((v) => v.versionNormalized === '1.0.0')).toBe(true);

      // Status được ghi nhận là NOT_FOUND
      expect(pAfter[0]!.lastScanStatus).toBe('NOT_FOUND');
    });

    it('TEST-5B-14: One plugin failure does not stop subsequent plugins in sweep', async () => {
      testServer.on('/resources/2001/versions/latest', (_req, res) => {
        // Plugin 1: Lỗi máy chủ 500 vĩnh viễn
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server Error' }));
      });

      testServer.on('/resources/2002/versions/latest', (_req, res) => {
        // Plugin 2: Thành công
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 22, name: '2.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p1] = await db
        .insert(plugins)
        .values({
          slug: 'failing-p1',
          displayName: 'Failing P1',
          descriptorName: 'P1',
          platform: 'spigot',
          resourceId: 2001,
          enabled: true,
        })
        .returning();

      const [p2] = await db
        .insert(plugins)
        .values({
          slug: 'healthy-p2',
          displayName: 'Healthy P2',
          descriptorName: 'P2',
          platform: 'spigot',
          resourceId: 2002,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        { maxConcurrentScans: 2 },
        new SpigetPluginSourceAdapter({ baseUrl, maxRetries: 0, timeoutMs: 2000 }),
      );

      const sweep = await scanner.scanEligiblePlugins(db, 10);
      expect(sweep.totalEligible).toBe(2);
      expect(sweep.scanned).toBe(2);
      expect(sweep.successful).toBe(1); // p2 thành công
      expect(sweep.failed).toBe(1); // p1 thất bại nhưng không dừng hệ thống

      const p2Versions = (await db.select().from(versions)).filter((v) => v.pluginId === p2.id);
      expect(p2Versions.length).toBe(1);
      expect(p2Versions[0]!.versionNormalized).toBe('2.0.0');
    });

    it('TEST-5B-15: Global concurrency limit restricts parallel active scans', async () => {
      let activeRequests = 0;
      let maxSeenActive = 0;

      testServer.on('/resources/', async (_req, res) => {
        activeRequests++;
        maxSeenActive = Math.max(maxSeenActive, activeRequests);
        // Delay 50ms để đo concurrency
        await new Promise((r) => setTimeout(r, 50));
        activeRequests--;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 100, name: '1.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      // Tạo 6 plugin khác nhau
      for (let i = 1; i <= 6; i++) {
        await db.insert(plugins).values({
          slug: `conc-plugin-${i}`,
          displayName: `Plugin ${i}`,
          descriptorName: `P${i}`,
          platform: 'spigot',
          resourceId: 3000 + i,
          enabled: true,
        });
      }

      // Giới hạn maxConcurrentScans = 2
      const scanner = new PluginScannerService(
        { maxConcurrentScans: 2 },
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 3000 }),
      );

      await scanner.scanEligiblePlugins(db, 10);

      // maxSeenActive không bao giờ vượt quá 2
      expect(maxSeenActive).toBeLessThanOrEqual(2);
    });

    it('TEST-5B-16: Same plugin cannot scan concurrently (mutex serialization)', async () => {
      testServer.on('/resources/9999/versions/latest', async (_req, res) => {
        await new Promise((r) => setTimeout(r, 60));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 99, name: '1.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 3000 }),
      );

      const [singleP] = await db
        .insert(plugins)
        .values({
          slug: 'mutex-plugin',
          displayName: 'Mutex Plugin',
          descriptorName: 'Mutex',
          platform: 'spigot',
          resourceId: 9999,
          enabled: true,
        })
        .returning();

      // Gọi 2 scan đồng thời trên cùng 1 plugin ID
      const [resA, resB] = await Promise.all([
        scanner.scanPlugin(db, singleP.id),
        scanner.scanPlugin(db, singleP.id),
      ]);

      const statuses = [resA.status, resB.status];
      expect(statuses).toContain('SUCCESS');
      expect(statuses).toContain('SKIPPED_ALREADY_RUNNING');
    });

    it('TEST-5B-17: Duplicate scheduler tick skips without duplicating HTTP request', async () => {
      let networkHitCount = 0;
      testServer.on('/resources/4444/versions/latest', async (_req, res) => {
        networkHitCount++;
        await new Promise((r) => setTimeout(r, 60));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 44, name: '1.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'dup-tick-p',
          displayName: 'Dup Tick Plugin',
          descriptorName: 'DupTick',
          platform: 'spigot',
          resourceId: 4444,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, timeoutMs: 2000 }),
      );

      // Chạy 2 lệnh scan đồng thời
      const p1 = scanner.scanPlugin(db, p.id);
      const p2 = scanner.scanPlugin(db, p.id);

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(networkHitCount).toBe(1); // Chỉ có đúng 1 HTTP request gửi đi!
      expect([r1.status, r2.status]).toContain('SKIPPED_ALREADY_RUNNING');
    });

    it('TEST-5B-18: Disabled plugin produces zero API requests', async () => {
      let networkCalled = false;
      testServer.on('/resources/5001/versions/latest', (_req, res) => {
        networkCalled = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 50, name: '1.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [disabledP] = await db
        .insert(plugins)
        .values({
          slug: 'disabled-plugin',
          displayName: 'Disabled Plugin',
          descriptorName: 'Dis',
          platform: 'spigot',
          resourceId: 5001,
          enabled: false, // TẮT
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      const res = await scanner.scanPlugin(db, disabledP.id);
      expect(res.status).toBe('DISABLED');
      expect(networkCalled).toBe(false); // Không có bất kỳ HTTP call nào!
    });

    it('TEST-5B-19: Concurrent workers cannot create duplicate Plugin Version', async () => {
      testServer.on('/resources/6001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 60, name: '4.5.6', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'race-plugin',
          displayName: 'Race Plugin',
          descriptorName: 'Race',
          platform: 'spigot',
          resourceId: 6001,
          enabled: true,
        })
        .returning();

      // 5 concurrent attempts chèn cùng 1 version
      const versPromises = Array.from({ length: 5 }, () =>
        db
          .insert(versions)
          .values({
            pluginId: p.id,
            version: '4.5.6',
            versionNormalized: '4.5.6',
            sha256: `discovered:${p.id}:4.5.6`,
            relPath: 'race.jar',
            bytes: 100,
            originalName: 'race.jar',
          })
          .returning()
          .catch(() => null), // Ràng buộc unique của DB sẽ ngăn chặn các bản ghi trùng lặp
      );

      await Promise.all(versPromises);

      const saved = (await db.select().from(versions)).filter((v) => v.pluginId === p.id);
      expect(saved.length).toBe(1);
    });

    it('TEST-5B-20: Successful scan updates next_scan_at and records SUCCESS status', async () => {
      testServer.on('/resources/7001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 70, name: '1.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'state-plugin',
          displayName: 'State Plugin',
          descriptorName: 'State',
          platform: 'spigot',
          resourceId: 7001,
          enabled: true,
          scanIntervalSeconds: 7200,
        })
        .returning();

      const scanner = new PluginScannerService(
        { scanIntervalSeconds: 7200, jitterMaxSeconds: 0 },
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      await scanner.scanPlugin(db, p.id);
      const [updatedP] = await db.select().from(plugins).where({ id: p.id });
      expect(updatedP.lastScanStatus).toBe('SUCCESS');
      expect(updatedP.lastScanError).toBeNull();
      expect(updatedP.nextScanAt).not.toBeNull();
      // nextScanAt phải lớn hơn hiện tại ít nhất 7000s
      expect(new Date(updatedP.nextScanAt!).getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);
    });

    it('TEST-5B-21: Failed scan records failure state and error message', async () => {
      testServer.on('/resources/7002/versions/latest', (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Crash' }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'fail-plugin',
          displayName: 'Fail Plugin',
          descriptorName: 'Fail',
          platform: 'spigot',
          resourceId: 7002,
          enabled: true,
        })
        .returning();

      const failScanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl, maxRetries: 0 }),
      );

      const failRes = await failScanner.scanPlugin(db, p.id);
      expect(failRes.status).toBe('FAILED');

      const [failedP] = await db.select().from(plugins).where({ id: p.id });
      expect(failedP.lastScanStatus).toBe('FAILED');
      expect(failedP.lastScanError).toContain('HTTP 500');
    });

    it('TEST-5B-22: Remote version disappearance does not delete local version', async () => {
      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'disappear-p',
          displayName: 'Disappear P',
          descriptorName: 'Disappear',
          platform: 'spigot',
          resourceId: 8001,
          enabled: true,
        })
        .returning();

      // Giả sử đã có version 1.0 và 2.0 trong DB
      await db.insert(versions).values({
        pluginId: p.id,
        version: '1.0.0',
        versionNormalized: '1.0.0',
        sha256: 'sha-v1',
        relPath: 'v1.jar',
        bytes: 100,
        originalName: 'v1.jar',
      });
      await db.insert(versions).values({
        pluginId: p.id,
        version: '2.0.0',
        versionNormalized: '2.0.0',
        sha256: 'sha-v2',
        relPath: 'v2.jar',
        bytes: 200,
        originalName: 'v2.jar',
      });

      // Spiget hiện tại chỉ trả về 2.0.0 (version 1.0.0 biến mất trên remote)
      testServer.on('/resources/8001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 82, name: '2.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      await scanner.scanPlugin(db, p.id);

      // Cả 2 version lịch sử (1.0.0 và 2.0.0) VẪN TỒN TẠI NGUYÊN VẸN!
      const allV = (await db.select().from(versions)).filter((v) => v.pluginId === p.id);
      expect(allV.length).toBe(2);
      expect(allV.some((v) => v.versionNormalized === '1.0.0')).toBe(true);
      expect(allV.some((v) => v.versionNormalized === '2.0.0')).toBe(true);
    });

    // ========================================================================
    // D. ABSOLUTE SCOPE GUARDRAILS: NO ARTIFACT, NO ENTITLEMENT, NO ORDER MOD
    // ========================================================================
    it('TEST-5B-23: Scanner does NOT create Artifact records', async () => {
      testServer.on('/resources/9001/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 91, name: '5.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'guardrail-art',
          displayName: 'Guardrail Art',
          descriptorName: 'GuardrailArt',
          platform: 'spigot',
          resourceId: 9001,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      const res = await scanner.scanPlugin(db, p.id);
      expect(res.status).toBe('SUCCESS');

      // ZERO Artifacts created!
      const allArtifacts = await db.select().from(pluginArtifacts);
      expect(allArtifacts.length).toBe(0);
    });

    it('TEST-5B-24: Scanner does NOT create Entitlement records', async () => {
      testServer.on('/resources/9002/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 92, name: '6.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'guardrail-ent',
          displayName: 'Guardrail Ent',
          descriptorName: 'GuardrailEnt',
          platform: 'spigot',
          resourceId: 9002,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      const res = await scanner.scanPlugin(db, p.id);
      expect(res.status).toBe('SUCCESS');

      // ZERO Entitlements created!
      const allEntitlements = await db.select().from(pluginEntitlements);
      expect(allEntitlements.length).toBe(0);
    });

    it('TEST-5B-25: Scanner does NOT modify Order/Purchase records', async () => {
      testServer.on('/resources/9003/versions/latest', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 93, name: '7.0.0', releaseDate: 1728000000 }));
      });
      const baseUrl = await testServer.start();

      const [p] = await db
        .insert(plugins)
        .values({
          slug: 'guardrail-ord',
          displayName: 'Guardrail Ord',
          descriptorName: 'GuardrailOrd',
          platform: 'spigot',
          resourceId: 9003,
          enabled: true,
        })
        .returning();

      const scanner = new PluginScannerService(
        {},
        new SpigetPluginSourceAdapter({ baseUrl }),
      );

      const res = await scanner.scanPlugin(db, p.id);
      expect(res.status).toBe('SUCCESS');

      // ZERO Orders created or modified!
      const allOrders = await db.select().from(orders);
      expect(allOrders.length).toBe(0);
    });
  });
});
