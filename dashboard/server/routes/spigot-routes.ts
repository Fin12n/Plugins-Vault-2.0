import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { eq, and, sql, spigotAccounts, resourceOwnership, plugins } from '@vault/db';

import { db } from '../db/neon.js';
import { env } from '../config/env.js';

function getKeyBuffer(keyStr: string): Buffer {
  if (keyStr.length === 64) return Buffer.from(keyStr, 'hex');
  const buf = Buffer.alloc(32);
  Buffer.from(keyStr, 'utf8').copy(buf);
  return buf;
}

function encryptText(plainText: string): string {
  if (!plainText) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKeyBuffer(env.ENCRYPTION_KEY), iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function registerSpigotRoutes(app: FastifyInstance) {
  // Lấy danh sách tài khoản Spigot
  app.get('/api/spigot-accounts', async () => {
    const rows = await db.select().from(spigotAccounts);

    const ownerships = await db.select().from(resourceOwnership);
    const ownedMap = new Map<string, string[]>();
    for (const o of ownerships) {
      const arr = ownedMap.get(o.accountLabel) ?? [];
      arr.push(String(o.resourceId));
      ownedMap.set(o.accountLabel, arr);
    }

    const accounts = rows.map((a: typeof spigotAccounts.$inferSelect) => {
      const isEnabled = a.status === 'active';
      return {
        label: a.label,
        username: a.label,
        enabled: isEnabled,
        purchasedResources: ownedMap.get(a.label) ?? [],
        importedStatus: a.status,
        exclusionReason: isEnabled ? '' : 'Đã tắt bởi quản trị viên',

        liveScan: a.lastVerifiedAt
          ? {
              status: 'ok' as const,
              lastScanAt: a.lastVerifiedAt.getTime(),
              resourceCount: (ownedMap.get(a.label) ?? []).length,
              error: null,
            }
          : {
              status: 'never' as const,
              lastScanAt: null,
              resourceCount: null,
              error: null,
            },
      };
    });

    return {
      configured: accounts.length > 0,
      accounts,
    };
  });

  // Thêm hoặc cập nhật tài khoản Spigot (Metadata trong Neon; credentials nằm tại SQLite vault)
  app.post('/api/spigot-accounts', async (request, reply) => {
    const schema = z.object({
      label: z.string().min(1),
      username: z.string().min(1),
      password: z.string().optional(),
      xfUser: z.string().optional(),
      xfSession: z.string().optional(),
      isEnabled: z.boolean().default(true),
    });

    const data = schema.parse(request.body);
    const accountId = randomUUID();
    const status = data.isEnabled ? 'active' : 'inactive';

    const [account] = await db
      .insert(spigotAccounts)
      .values({
        accountId,
        label: data.label,
        status,
        health: 'healthy',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: spigotAccounts.label,
        set: {
          status,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!account) return reply.code(500).send({ error: 'Không thể lưu tài khoản Spigot' });
    return reply.code(201).send({ ok: true, label: account.label });
  });

  // Bật / tắt tài khoản Spigot
  app.patch('/api/spigot-accounts/:label/toggle', async (request, reply) => {
    const { label } = z.object({ label: z.string() }).parse(request.params);
    const [current] = await db
      .select()
      .from(spigotAccounts)
      .where(eq(spigotAccounts.label, label))
      .limit(1);

    if (!current) return reply.code(404).send({ error: 'Tài khoản không tồn tại' });

    const isCurrentlyActive = current.status === 'active';
    const nextStatus = isCurrentlyActive ? 'inactive' : 'active';

    const [updated] = await db
      .update(spigotAccounts)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(spigotAccounts.label, label))
      .returning();

    if (!updated) return reply.code(500).send({ error: 'Không thể đổi trạng thái tài khoản' });
    return { ok: true, enabled: updated.status === 'active' };
  });

  // Xoá tài khoản Spigot
  app.delete('/api/spigot-accounts/:label', async (request) => {
    const { label } = z.object({ label: z.string() }).parse(request.params);
    await db.delete(spigotAccounts).where(eq(spigotAccounts.label, label));
    await db.delete(resourceOwnership).where(eq(resourceOwnership.accountLabel, label));
    return { ok: true };
  });

  // Tổng quan sở hữu Spigot
  app.get('/api/spigot/ownership', async () => {
    const accounts = await db.select().from(spigotAccounts);
    const allPlugins = await db
      .select({
        id: plugins.id,
        slug: plugins.slug,
        displayName: plugins.displayName,
        resourceId: plugins.resourceId,
      })
      .from(plugins);

    const ownershipRows = await db.select().from(resourceOwnership);
    const assignedResourceIds = new Set(ownershipRows.map((o: typeof resourceOwnership.$inferSelect) => o.resourceId));

    type PluginSummary = { id: number; slug: string; displayName: string; resourceId: number | null };

    const unassignedPlugins = allPlugins
      .filter((p: PluginSummary) => p.resourceId && !assignedResourceIds.has(p.resourceId))
      .map((p: PluginSummary) => ({
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        resourceId: p.resourceId!,
      }));

    const accountList = accounts.map((a: typeof spigotAccounts.$inferSelect) => {
      const ownedResources = ownershipRows.filter((o: typeof resourceOwnership.$inferSelect) => o.accountLabel === a.label);
      const ownedResSet = new Set(ownedResources.map((o: typeof resourceOwnership.$inferSelect) => o.resourceId));
      const matchedPlugins = allPlugins.filter((p: PluginSummary) => p.resourceId && ownedResSet.has(p.resourceId));

      const isEnabled = a.status === 'active';
      return {
        label: a.label,
        username: a.label,
        enabled: isEnabled,
        purchasedCount: ownedResources.length,
        ownedPlugins: matchedPlugins.map((mp: PluginSummary) => ({
          id: mp.id,
          slug: mp.slug,
          displayName: mp.displayName,
          resourceId: mp.resourceId!,
          state: 'owned' as const,
          checkedAt: Date.now(),
        })),
      };
    });

    return {
      ok: true,
      accounts: accountList,
      unassignedPlugins,
      allPlugins: allPlugins
        .filter((p: PluginSummary) => p.resourceId !== null)
        .map((p: PluginSummary) => ({
          id: p.id,
          slug: p.slug,
          displayName: p.displayName,
          resourceId: p.resourceId!,
        })),

    };
  });

  // Gán plugin vào tài khoản
  app.post('/api/spigot/ownership/assign', async (request) => {
    const schema = z.object({
      resourceId: z.number().int(),
      accountLabel: z.string().min(1),
    });
    const { resourceId, accountLabel } = schema.parse(request.body);

    await db
      .insert(resourceOwnership)
      .values({
        resourceId,
        accountLabel,
        state: 'owned',
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [resourceOwnership.resourceId, resourceOwnership.accountLabel],
        set: { state: 'owned', checkedAt: new Date() },
      });

    return { ok: true };
  });

  // Gỡ gán plugin
  app.delete('/api/spigot/ownership/unassign', async (request) => {
    const schema = z.object({
      resourceId: z.coerce.number().int(),
      accountLabel: z.string().min(1),
    });
    const { resourceId, accountLabel } = schema.parse(request.query);

    await db
      .delete(resourceOwnership)
      .where(
        and(
          eq(resourceOwnership.resourceId, resourceId),
          eq(resourceOwnership.accountLabel, accountLabel)
        )
      );

    return { ok: true };
  });

  // Sweep logs & Status & Challenge Status (Stateless APIs)
  app.get('/api/spigot/sweep-logs', async () => {
    return {
      running: false,
      currentOperation: 'idle' as const,
      lastStartedAt: null,
      lastFinishedAt: null,
      proxyEnabled: false,
      currentProxyIp: null,
      activeWorkers: [],
      logs: [],
    };
  });

  app.get('/api/spigot/instances', async () => {
    return {
      concurrency: 1,
      activeWorkers: 0,
      instances: [],
    };
  });

  app.get('/api/spigot/status', async () => {
    return {
      running: false,
      currentOperation: 'idle' as const,
      lastStartedAt: null,
      lastFinishedAt: null,
    };
  });

  app.get('/api/spigot/challenge-status', async () => {
    return {
      active: false,
      accountLabel: null,
      reason: null,
      startedAt: null,
      expiresAt: null,
    };
  });
}
