import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, ilike, or, sql, count, desc, and, plugins, versions } from '@vault/db';

import { db } from '../db/neon.js';

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().optional(),
});

const pluginInputSchema = z.object({
  pluginId: z.string().min(1).optional(),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  descriptorName: z.string().min(1),
  platform: z.string().default('spigot'),
  resourceId: z.number().int().nullable().optional(),
  depositPrice: z.number().int().min(0).default(0),
  isPremium: z.boolean().default(false),
  description: z.string().optional().default(''),
  spigotLink: z.string().optional().default(''),
  externalLink: z.string().optional().default(''),
  aliases: z.array(z.string()).optional().default([]),
});

export function registerPluginsRoutes(app: FastifyInstance) {
  // Lấy danh sách plugins phân trang + tìm kiếm
  app.get('/api/plugins', async (request) => {
    const qp = pageQuerySchema.parse(request.query);
    const offset = (qp.page - 1) * qp.pageSize;

    const searchCondition = qp.q
      ? or(
          ilike(plugins.slug, `%${qp.q}%`),
          ilike(plugins.displayName, `%${qp.q}%`),
          ilike(plugins.descriptorName, `%${qp.q}%`),
          sql`${qp.q} = ANY(${plugins.aliases})`
        )
      : undefined;

    const [totalRow] = await db
      .select({ val: count() })
      .from(plugins)
      .where(searchCondition);

    const total = totalRow?.val ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / qp.pageSize));

    const pluginRows = await db
      .select()
      .from(plugins)
      .where(searchCondition)
      .limit(qp.pageSize)
      .offset(offset)
      .orderBy(desc(plugins.updatedAt));

    // Đếm số lượng version của các plugin trong trang
    const pluginIds = pluginRows.map((p: typeof plugins.$inferSelect) => p.id);
    const versionCountMap = new Map<number, number>();

    if (pluginIds.length > 0) {
      const versionCounts = await db
        .select({ pluginId: versions.pluginId, val: count() })
        .from(versions)
        .where(sql`${versions.pluginId} IN ${pluginIds}`)
        .groupBy(versions.pluginId);
      for (const vc of versionCounts) {
        versionCountMap.set(vc.pluginId, vc.val);
      }
    }

    const items = pluginRows.map((p: typeof plugins.$inferSelect) => ({
      id: p.id,
      pluginId: p.pluginId,
      slug: p.slug,
      displayName: p.displayName,
      descriptorName: p.descriptorName,
      platform: p.platform,
      resourceId: p.resourceId,
      depositPrice: p.depositPrice,
      isPremium: p.isPremium,
      description: p.description,
      spigotLink: p.spigotLink,
      externalLink: p.spigotLink,
      aliases: p.aliases ?? [],
      versionCount: versionCountMap.get(p.id) ?? 0,
    }));

    return {
      items,
      page: qp.page,
      pageSize: qp.pageSize,
      total,
      totalPages,
    };
  });

  // Tạo plugin mới
  app.post('/api/plugins', async (request, reply) => {
    const data = pluginInputSchema.parse(request.body);
    const generatedPluginId = data.pluginId || data.slug;
    const finalSpigotLink = data.spigotLink || data.externalLink || '';

    const [inserted] = await db
      .insert(plugins)
      .values({
        pluginId: generatedPluginId,
        slug: data.slug,
        displayName: data.displayName,
        descriptorName: data.descriptorName,
        aliases: data.aliases ?? [],
        platform: data.platform,
        resourceId: data.resourceId ?? null,
        depositPrice: data.depositPrice,
        isPremium: data.isPremium,
        description: data.description,
        spigotLink: finalSpigotLink,
      })
      .returning();

    if (!inserted) {
      return reply.code(500).send({ error: 'Không thể tạo plugin mới' });
    }

    return reply.code(201).send({
      id: inserted.id,
      pluginId: inserted.pluginId,
      slug: inserted.slug,
      displayName: inserted.displayName,
      descriptorName: inserted.descriptorName,
      platform: inserted.platform,
      resourceId: inserted.resourceId,
      depositPrice: inserted.depositPrice,
      isPremium: inserted.isPremium,
      description: inserted.description,
      spigotLink: inserted.spigotLink,
      externalLink: inserted.spigotLink,
      aliases: inserted.aliases,
      versionCount: 0,
    });
  });

  // Xem chi tiết plugin
  app.get('/api/plugins/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const [p] = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1);
    if (!p) return reply.code(404).send({ error: 'Plugin không tồn tại' });

    const versionRows = await db
      .select()
      .from(versions)
      .where(eq(versions.pluginId, p.id))
      .orderBy(desc(versions.uploadedAt));

    return {
      id: p.id,
      pluginId: p.pluginId,
      slug: p.slug,
      displayName: p.displayName,
      descriptorName: p.descriptorName,
      platform: p.platform,
      resourceId: p.resourceId,
      depositPrice: p.depositPrice,
      isPremium: p.isPremium,
      description: p.description,
      spigotLink: p.spigotLink,
      externalLink: p.spigotLink,
      aliases: p.aliases ?? [],
      versionCount: versionRows.length,
      versions: versionRows.map((v: typeof versions.$inferSelect) => ({
        id: v.id,
        version: v.version,
        rawVersion: v.rawVersion,
        bytes: v.bytes,
        originalName: v.originalName,
        isStable: v.isStable,
        versionFlag: v.versionFlag,
        changeLogs: v.changeLogs,
        source: v.source,
        uploadedAt: v.uploadedAt.getTime(),
      })),
    };
  });

  // Cập nhật plugin
  app.put('/api/plugins/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const data = pluginInputSchema.partial().parse(request.body);

    const updatePayload: Record<string, unknown> = {
      ...data,
      updatedAt: new Date(),
    };
    if (data.externalLink && !data.spigotLink) {
      updatePayload.spigotLink = data.externalLink;
      delete updatePayload.externalLink;
    }

    const [updated] = await db
      .update(plugins)
      .set(updatePayload)
      .where(eq(plugins.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: 'Plugin không tồn tại' });
    return updated;
  });

  // Xoá plugin
  app.delete('/api/plugins/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    await db.delete(plugins).where(eq(plugins.id, id));
    return reply.send({ ok: true });
  });

  // Cập nhật giá hàng loạt
  app.post('/api/plugins/bulk-prices', async (request) => {
    const schema = z.object({
      prices: z.array(z.object({ id: z.number(), depositPrice: z.number().min(0) })),
    });
    const { prices } = schema.parse(request.body);

    for (const item of prices) {
      await db
        .update(plugins)
        .set({ depositPrice: item.depositPrice, updatedAt: new Date() })
        .where(eq(plugins.id, item.id));
    }
    return { ok: true, updatedCount: prices.length };
  });

  // Thêm alias cho plugin vào mảng aliases
  app.post('/api/plugins/:id/aliases', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const { alias } = z.object({ alias: z.string().min(1) }).parse(request.body);

    await db.execute(sql`
      UPDATE ${plugins}
      SET aliases = array_append(${plugins.aliases}, ${alias}), updated_at = now()
      WHERE id = ${id} AND NOT (${alias} = ANY(${plugins.aliases}))
    `);
    return reply.code(201).send({ ok: true, alias });
  });

  // Xoá alias khỏi mảng aliases
  app.delete('/api/plugins/:id/aliases/:alias', async (request) => {
    const { id, alias } = z
      .object({ id: z.coerce.number(), alias: z.string() })
      .parse(request.params);

    await db.execute(sql`
      UPDATE ${plugins}
      SET aliases = array_remove(${plugins.aliases}, ${alias}), updated_at = now()
      WHERE id = ${id}
    `);
    return { ok: true };
  });

  // Lấy versions của plugin
  app.get('/api/plugins/:id/versions', async (request) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const rows = await db
      .select()
      .from(versions)
      .where(eq(versions.pluginId, id))
      .orderBy(desc(versions.uploadedAt));

    return rows.map((v: typeof versions.$inferSelect) => ({
      id: v.id,
      version: v.version,
      rawVersion: v.rawVersion,
      bytes: v.bytes,
      originalName: v.originalName,
      isStable: v.isStable,
      versionFlag: v.versionFlag,
      uploadedAt: v.uploadedAt.getTime(),
    }));
  });

  // Đổi trạng thái ổn định của version
  app.patch('/api/versions/:id/stable', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const { isStable } = z.object({ isStable: z.boolean() }).parse(request.body);

    const [v] = await db
      .update(versions)
      .set({ isStable })
      .where(eq(versions.id, id))
      .returning();

    if (!v) return reply.code(404).send({ error: 'Phiên bản không tồn tại' });
    return { ok: true, isStable: v.isStable };
  });

  // Đổi nhãn phiên bản
  app.patch('/api/versions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const { version } = z.object({ version: z.string().nullable() }).parse(request.body);

    const [v] = await db
      .update(versions)
      .set({ version })
      .where(eq(versions.id, id))
      .returning();

    if (!v) return reply.code(404).send({ error: 'Phiên bản không tồn tại' });
    return { ok: true, version: v.version };
  });

  // Xoá version
  app.delete('/api/versions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    await db.delete(versions).where(eq(versions.id, id));
    return reply.send({ ok: true });
  });
}
