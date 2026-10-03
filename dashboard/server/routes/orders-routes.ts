import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, ilike, or, count, desc, and, orders, wallets, walletLedger } from '@vault/db';

import { db } from '../db/neon.js';

const orderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.string().optional(),
  q: z.string().optional(),
});

export function registerOrdersRoutes(app: FastifyInstance) {
  // Danh sách đơn hàng phân trang
  app.get('/api/orders', async (request) => {
    const qp = orderQuerySchema.parse(request.query);
    const offset = (qp.page - 1) * qp.pageSize;

    const conditions = [];
    if (qp.status) {
      conditions.push(eq(orders.status, qp.status));
    }
    if (qp.q) {
      conditions.push(
        or(
          ilike(orders.code, `%${qp.q}%`),
          ilike(orders.discordUserId, `%${qp.q}%`),
          ilike(orders.pluginName, `%${qp.q}%`)
        )
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await db
      .select({ val: count() })
      .from(orders)
      .where(whereClause);

    const total = totalRow?.val ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / qp.pageSize));

    const rows = await db
      .select()
      .from(orders)
      .where(whereClause)
      .limit(qp.pageSize)
      .offset(offset)
      .orderBy(desc(orders.createdAt));

    const items = rows.map((o: typeof orders.$inferSelect) => ({
      id: o.id,
      code: o.code,
      discordUserId: o.discordUserId,
      versionId: o.versionId,
      pluginName: o.pluginName,
      versionLabel: o.versionLabel,
      amount: o.amount,
      walletPaid: o.walletPaid,
      bankDue: o.bankDue,
      status: o.status,
      paidAmount: o.paidAmount,
      createdAt: o.createdAt.getTime(),
      expiresAt: o.expiresAt.getTime(),
      paidAt: o.paidAt?.getTime() ?? null,
      deliveredAt: o.deliveredAt?.getTime() ?? null,
    }));

    return {
      items,
      page: qp.page,
      pageSize: qp.pageSize,
      total,
      totalPages,
    };
  });

  // Lấy đơn hàng chưa giao
  app.get('/api/orders/undelivered', async () => {
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'paid'), eq(orders.deliveredAt, null as unknown as Date)))
      .orderBy(desc(orders.paidAt));

    return rows.map((o: typeof orders.$inferSelect) => ({
      id: o.id,
      code: o.code,
      discordUserId: o.discordUserId,
      versionId: o.versionId,
      pluginName: o.pluginName,
      versionLabel: o.versionLabel,
      amount: o.amount,
      walletPaid: o.walletPaid,
      bankDue: o.bankDue,
      status: o.status,
      paidAmount: o.paidAmount,
      createdAt: o.createdAt.getTime(),
      expiresAt: o.expiresAt.getTime(),
      paidAt: o.paidAt?.getTime() ?? null,
      deliveredAt: null,
    }));
  });

  // Đánh dấu giao hàng hoàn tất
  app.post('/api/orders/:id/deliver', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const [o] = await db
      .update(orders)
      .set({
        status: 'delivered',
        deliveredAt: new Date(),
      })
      .where(eq(orders.id, id))
      .returning();

    if (!o) return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
    return { ok: true, deliveredAt: o.deliveredAt?.getTime() };
  });

  // Cập nhật trạng thái đơn hàng
  app.patch('/api/orders/:id/status', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const { status } = z.object({ status: z.string() }).parse(request.body);

    const [o] = await db
      .update(orders)
      .set({ status })
      .where(eq(orders.id, id))
      .returning();

    if (!o) return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
    return { ok: true, status: o.status };
  });

  // Hoàn tiền đơn hàng vào ví người dùng
  app.post('/api/orders/:id/refund', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);

    if (!order) return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
    if (order.status === 'refunded') {
      return reply.code(400).send({ error: 'Đơn hàng đã được hoàn tiền trước đó' });
    }

    const refundAmount = order.paidAmount ?? order.amount;
    if (refundAmount <= 0) {
      return reply.code(400).send({ error: 'Số tiền hoàn lại không hợp lệ' });
    }

    // Atomic transaction cập nhật ví và đánh dấu đơn hàng refunded
    await db.transaction(async (tx: any) => {
      // 1. Cập nhật ví hoặc tạo nếu chưa có
      const [w] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.discordUserId, order.discordUserId))
        .limit(1);

      const currentBalance = w?.balance ?? 0;
      const newBalance = currentBalance + refundAmount;

      await tx
        .insert(wallets)
        .values({
          discordUserId: order.discordUserId,
          balance: newBalance,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: wallets.discordUserId,
          set: { balance: newBalance, updatedAt: new Date() },
        });

      // 2. Ghi ledger
      await tx.insert(walletLedger).values({
        discordUserId: order.discordUserId,
        delta: refundAmount,
        balanceAfter: newBalance,
        kind: 'refund',
        refType: 'order',
        refId: order.id,
        note: `Hoàn tiền đơn hàng ${order.code} (${order.pluginName})`,
      });

      // 3. Đánh dấu order refunded
      await tx
        .update(orders)
        .set({ status: 'refunded' })
        .where(eq(orders.id, order.id));
    });

    return { ok: true, refundedAmount: refundAmount };
  });
}
