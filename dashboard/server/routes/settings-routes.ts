import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, config } from '@vault/db';

import { db } from '../db/neon.js';

const settingsSchema = z.object({
  adminRoleIds: z.array(z.string()).default([]),
  pruneKeepCount: z.number().int().min(1).default(5),
  attachMaxBytes: z.number().int().min(1024).default(25 * 1024 * 1024),
  orderTtlMinutes: z.number().int().min(1).default(15),
  downloadTokenTtlMinutes: z.number().int().min(1).default(30),
  autoDownloadEnabled: z.boolean().default(true),
});

export function registerSettingsRoutes(app: FastifyInstance) {
  // Lấy cài đặt hệ thống
  app.get('/api/settings', async () => {
    const rows = await db.select().from(config);
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);

    return {
      adminRoleIds: map.has('admin_role_ids') ? JSON.parse(map.get('admin_role_ids')!) : [],
      pruneKeepCount: map.has('prune_keep_count') ? Number(map.get('prune_keep_count')) : 5,
      attachMaxBytes: map.has('attach_max_bytes') ? Number(map.get('attach_max_bytes')) : 25 * 1024 * 1024,
      orderTtlMinutes: map.has('order_ttl_minutes') ? Number(map.get('order_ttl_minutes')) : 15,
      downloadTokenTtlMinutes: map.has('download_token_ttl_minutes') ? Number(map.get('download_token_ttl_minutes')) : 30,
      autoDownloadEnabled: map.has('auto_download_enabled') ? map.get('auto_download_enabled') === 'true' : true,
    };
  });

  // Cập nhật cài đặt hệ thống
  app.put('/api/settings', async (request) => {
    const data = settingsSchema.partial().parse(request.body);

    const entries: [string, string][] = [];
    if (data.adminRoleIds !== undefined) entries.push(['admin_role_ids', JSON.stringify(data.adminRoleIds)]);
    if (data.pruneKeepCount !== undefined) entries.push(['prune_keep_count', String(data.pruneKeepCount)]);
    if (data.attachMaxBytes !== undefined) entries.push(['attach_max_bytes', String(data.attachMaxBytes)]);
    if (data.orderTtlMinutes !== undefined) entries.push(['order_ttl_minutes', String(data.orderTtlMinutes)]);
    if (data.downloadTokenTtlMinutes !== undefined) entries.push(['download_token_ttl_minutes', String(data.downloadTokenTtlMinutes)]);
    if (data.autoDownloadEnabled !== undefined) entries.push(['auto_download_enabled', String(data.autoDownloadEnabled)]);

    for (const [key, value] of entries) {
      await db
        .insert(config)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: config.key,
          set: { value, updatedAt: new Date() },
        });
    }

    return { ok: true };
  });
}
