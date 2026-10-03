import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, discountCodes } from '@vault/db';

import { db } from '../db/neon.js';

const discountInputSchema = z.object({
  code: z.string().min(1).toUpperCase(),
  type: z.enum(['percent', 'fixed']),
  value: z.number().int().min(1),
  minOrder: z.number().int().min(0).default(0),
  maxDiscount: z.number().int().min(0).nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
  isActive: z.boolean().default(true),
});

export function registerDiscountsRoutes(app: FastifyInstance) {
  // Lấy danh sách mã giảm giá
  app.get('/api/discounts', async () => {
    const rows = await db
      .select()
      .from(discountCodes)
      .orderBy(desc(discountCodes.createdAt));

    return rows.map((d: typeof discountCodes.$inferSelect) => ({
      id: d.id,
      code: d.code,
      type: d.type,
      value: d.value,
      minOrder: d.minOrder,
      maxDiscount: d.maxDiscount,
      maxUses: d.maxUses,
      usedCount: d.usedCount,
      expiresAt: d.expiresAt ? d.expiresAt.getTime() : null,
      isActive: d.isActive,
      createdAt: d.createdAt.getTime(),
    }));
  });

  // Tạo mã mới
  app.post('/api/discounts', async (request, reply) => {
    const data = discountInputSchema.parse(request.body);

    const [created] = await db
      .insert(discountCodes)
      .values({
        code: data.code,
        type: data.type,
        value: data.value,
        minOrder: data.minOrder,
        maxDiscount: data.maxDiscount ?? null,
        maxUses: data.maxUses ?? null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        isActive: data.isActive,
      })
      .returning();

    if (!created) {
      return reply.code(500).send({ error: 'Không thể tạo mã giảm giá' });
    }

    return reply.code(201).send({
      id: created.id,
      code: created.code,
      type: created.type,
      value: created.value,
      minOrder: created.minOrder,
      maxDiscount: created.maxDiscount,
      maxUses: created.maxUses,
      usedCount: created.usedCount,
      expiresAt: created.expiresAt ? created.expiresAt.getTime() : null,
      isActive: created.isActive,
      createdAt: created.createdAt.getTime(),
    });
  });

  // Cập nhật mã giảm giá
  app.put('/api/discounts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const data = discountInputSchema.partial().parse(request.body);

    const [updated] = await db
      .update(discountCodes)
      .set({
        ...data,
        expiresAt: data.expiresAt !== undefined ? (data.expiresAt ? new Date(data.expiresAt) : null) : undefined,
      })
      .where(eq(discountCodes.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: 'Mã không tồn tại' });
    return updated;
  });

  // Bật / tắt kích hoạt mã
  app.patch('/api/discounts/:id/toggle', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const [current] = await db.select().from(discountCodes).where(eq(discountCodes.id, id)).limit(1);
    if (!current) return reply.code(404).send({ error: 'Mã không tồn tại' });

    const [updated] = await db
      .update(discountCodes)
      .set({ isActive: !current.isActive })
      .where(eq(discountCodes.id, id))
      .returning();

    if (!updated) return reply.code(500).send({ error: 'Không thể cập nhật mã giảm giá' });
    return { ok: true, isActive: updated.isActive };

  });

  // Xoá mã giảm giá
  app.delete('/api/discounts/:id', async (request) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    await db.delete(discountCodes).where(eq(discountCodes.id, id));
    return { ok: true };
  });
}
