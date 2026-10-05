import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, ilike, or, count, desc, and, isNull, orders, wallets, walletLedger, deliveryJobs } from '@vault/db';

import { db } from '../db/neon.js';
import { requireRole } from '../auth/rbac.js';

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

  // Lấy đơn hàng chưa giao - chuẩn hóa shape { items: [...] }
  app.get('/api/orders/undelivered', async () => {
    const rows = await db
      .select()
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'paid'), eq(orders.status, 'wallet_paid')),
          isNull(orders.deliveredAt)
        )
      )
      .orderBy(desc(orders.paidAt));

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
      deliveredAt: null,
    }));

    return { items };
  });

  // Đánh dấu giao hàng hoàn tất (Owner & Admin)
  app.post(
    '/api/orders/:id/deliver',
    { preHandler: requireRole(['owner', 'admin']) },
    async (request, reply) => {
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
    }
  );

  // Đưa lại đơn hàng vào hàng đợi giao hàng (Re-enqueue / Release) (All staff)
  app.post(
    '/api/orders/:id/release',
    { preHandler: requireRole(['owner', 'admin', 'moderator', 'support']) },
    async (request, reply) => {
      const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
      const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);

      if (!order) return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
      if (!order.versionId) {
        return reply.code(400).send({ error: 'Đơn hàng không có thông tin phiên bản để giao' });
      }
      if (order.status !== 'paid' && order.status !== 'wallet_paid') {
        return reply.code(400).send({
          error: `Chỉ có thể giao lại đơn hàng đã thanh toán (hiện tại: '${order.status}')`,
        });
      }

      const existingJob = await db
        .select()
        .from(deliveryJobs)
        .where(eq(deliveryJobs.orderId, id))
        .limit(1);

      if (existingJob[0]) {
        await db
          .update(deliveryJobs)
          .set({
            status: 'queued',
            claimToken: null,
            lockedAt: null,
            retryCount: 0,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(deliveryJobs.id, existingJob[0].id));
      } else {
        await db.insert(deliveryJobs).values({
          orderId: order.id,
          discordUserId: order.discordUserId,
          versionId: order.versionId,
          requestedMethod: 'attachment',
          status: 'queued',
        });
      }

      return { ok: true, message: `Đã đưa đơn hàng #${order.code} vào hàng đợi giao lại` };
    }
  );

  // Cập nhật trạng thái đơn hàng (Owner Only - Chỉ cho phép transition pending -> cancelled)
  app.patch(
    '/api/orders/:id/status',
    { preHandler: requireRole(['owner']) },
    async (request, reply) => {
      const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
      const { status } = z.object({ status: z.string() }).parse(request.body);

      // Chốt chặn bảo vệ: Cấm nhảy cóc trạng thái tùy ý
      if (status !== 'cancelled') {
        return reply.code(400).send({
          error: 'Chuyển đổi trạng thái không hợp lệ. Chỉ cho phép hủy đơn từ pending sang cancelled.',
        });
      }

      try {
        const result = await db.transaction(async (tx) => {
          const [pre] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, id))
            .limit(1);

          if (!pre) {
            throw new Error('ORDER_NOT_FOUND');
          }

          if (pre.status !== 'pending') {
            throw new Error(`ORDER_NOT_PENDING:${pre.status}`);
          }

          if (pre.walletPaid > 0) {
            // Case B: Có cấn trừ ví -> Canonical Lock Order: wallets (FOR UPDATE) -> orders (FOR UPDATE)
            await tx
              .insert(wallets)
              .values({
                discordUserId: pre.discordUserId,
                balance: 0,
                updatedAt: new Date(),
              })
              .onConflictDoNothing({ target: wallets.discordUserId });

            const [lockedWallet] = await tx
              .select()
              .from(wallets)
              .where(eq(wallets.discordUserId, pre.discordUserId))
              .for('update');

            const [lockedOrder] = await tx
              .select()
              .from(orders)
              .where(eq(orders.id, id))
              .for('update');

            if (!lockedOrder || lockedOrder.status !== 'pending') {
              throw new Error('ORDER_CONCURRENTLY_MODIFIED');
            }

            const refundCoins = lockedOrder.walletPaid;
            const newBalance = (lockedWallet?.balance ?? 0) + refundCoins;

            await tx
              .update(wallets)
              .set({
                balance: newBalance,
                updatedAt: new Date(),
              })
              .where(eq(wallets.discordUserId, pre.discordUserId));

            await tx.insert(walletLedger).values({
              discordUserId: pre.discordUserId,
              delta: refundCoins,
              balanceAfter: newBalance,
              kind: 'order_cancel_credit',
              refType: 'order',
              refId: lockedOrder.id,
              note: `Hủy đơn hàng #${lockedOrder.code}: Hoàn lại coin đã giữ (${refundCoins} coin)`,
            });

            const [cancelled] = await tx
              .update(orders)
              .set({
                status: 'cancelled',
                walletPaid: 0,
                updatedAt: new Date(),
              })
              .where(eq(orders.id, id))
              .returning();

            return { order: cancelled!, refundedCoins: refundCoins };
          } else {
            // Case A: walletPaid === 0 -> Lock orders FOR UPDATE -> Cancelled (0 biến động ví)
            const [lockedOrder] = await tx
              .select()
              .from(orders)
              .where(eq(orders.id, id))
              .for('update');

            if (!lockedOrder || lockedOrder.status !== 'pending') {
              throw new Error('ORDER_CONCURRENTLY_MODIFIED');
            }

            const [cancelled] = await tx
              .update(orders)
              .set({
                status: 'cancelled',
                updatedAt: new Date(),
              })
              .where(eq(orders.id, id))
              .returning();

            return { order: cancelled!, refundedCoins: 0 };
          }
        });

        return { ok: true, status: result.order.status, refundedCoins: result.refundedCoins };
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'ORDER_NOT_FOUND') {
          return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
        }
        if (msg.startsWith('ORDER_NOT_PENDING')) {
          const currentStatus = msg.split(':')[1];
          return reply.code(400).send({
            error: `Chỉ có thể hủy đơn hàng đang ở trạng thái pending (hiện tại: '${currentStatus}')`,
          });
        }
        if (msg === 'ORDER_CONCURRENTLY_MODIFIED') {
          return reply.code(409).send({ error: 'Đơn hàng đã bị thay đổi bởi thao tác khác' });
        }
        return reply.code(500).send({ error: msg });
      }
    }
  );

  // Handler hoàn tiền dùng chung cho cả /api/orders/:id/refund và /api/orders/:id/refund-wallet
  const refundHandler = async (request: any, reply: any) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
    const refundReason = body.reason?.trim() || 'Quản trị viên hoàn tiền từ Web Dashboard';

    try {
      const result = await db.transaction(async (tx) => {
        // 1. Pre-read để lấy discordUserId cho lock ordering
        const [pre] = await tx
          .select({ discordUserId: orders.discordUserId })
          .from(orders)
          .where(eq(orders.id, id))
          .limit(1);

        if (!pre) {
          throw new Error('ORDER_NOT_FOUND');
        }

        // 2. Canonical Lock Order: Khóa wallets FIRST bằng FOR UPDATE
        await tx
          .insert(wallets)
          .values({
            discordUserId: pre.discordUserId,
            balance: 0,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({ target: wallets.discordUserId });

        const [lockedWallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.discordUserId, pre.discordUserId))
          .for('update');

        if (!lockedWallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        // 3. Canonical Lock Order: Khóa orders NEXT bằng FOR UPDATE
        const [lockedOrder] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, id))
          .for('update');

        if (!lockedOrder) {
          throw new Error('ORDER_NOT_FOUND');
        }

        if (lockedOrder.status === 'refunded') {
          throw new Error('ALREADY_REFUNDED');
        }

        if (
          lockedOrder.status !== 'paid' &&
          lockedOrder.status !== 'wallet_paid' &&
          lockedOrder.status !== 'delivered'
        ) {
          throw new Error(`INVALID_STATUS:${lockedOrder.status}`);
        }

        // 3.1. Delivery Reservation Check (Delivery Reservation Protocol v7)
        const [activeJob] = await tx
          .select({ status: deliveryJobs.status })
          .from(deliveryJobs)
          .where(eq(deliveryJobs.orderId, id))
          .limit(1);

        if (activeJob) {
          if (activeJob.status === 'processing') {
            throw new Error(`DELIVERY_IN_PROGRESS: Đơn hàng #${id} đang trong tiến trình chuyển phát, không thể hoàn tiền`);
          }
          if (activeJob.status === 'queued' || activeJob.status === 'retryable' || activeJob.status === 'failed') {
            await tx
              .update(deliveryJobs)
              .set({ status: 'cancelled', updatedAt: new Date() })
              .where(eq(deliveryJobs.orderId, id));
          }
        }

        // 4. Tính toán số tiền hoàn dựa trên thực nhận
        const bankReceived =
          lockedOrder.paidAmount ??
          (lockedOrder.status === 'wallet_paid' ? 0 : lockedOrder.bankDue);
        const refundAmount = (lockedOrder.walletPaid ?? 0) + (bankReceived ?? 0);

        if (refundAmount <= 0) {
          throw new Error(`INVALID_REFUND_AMOUNT:${refundAmount}`);
        }

        // 5. Cập nhật số dư ví
        const newBalance = lockedWallet.balance + refundAmount;
        await tx
          .update(wallets)
          .set({
            balance: newBalance,
            updatedAt: new Date(),
          })
          .where(eq(wallets.discordUserId, pre.discordUserId));

        // 6. Ghi nhận sổ cái ví (wallet_ledger) với kind = 'order_refund'
        await tx.insert(walletLedger).values({
          discordUserId: pre.discordUserId,
          delta: refundAmount,
          balanceAfter: newBalance,
          kind: 'order_refund',
          refType: 'order',
          refId: lockedOrder.id,
          note: `Hoàn tiền đơn hàng #${lockedOrder.code} (${lockedOrder.pluginName}): ${refundReason}`,
        });

        // 7. Cập nhật trạng thái đơn hàng thành refunded
        const [finalOrder] = await tx
          .update(orders)
          .set({
            status: 'refunded',
            updatedAt: new Date(),
          })
          .where(eq(orders.id, id))
          .returning();

        return {
          order: finalOrder!,
          newBalance,
          refundAmount,
        };
      });

      return {
        ok: true,
        refundedAmount: result.refundAmount,
        newBalance: result.newBalance,
        status: result.order.status,
      };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'ORDER_NOT_FOUND') {
        return reply.code(404).send({ error: 'Đơn hàng không tồn tại' });
      }
      if (msg === 'ALREADY_REFUNDED') {
        return reply.code(400).send({ error: 'Đơn hàng đã được hoàn tiền trước đó' });
      }
      if (msg.startsWith('INVALID_STATUS')) {
        const curStatus = msg.split(':')[1];
        return reply.code(400).send({
          error: `Đơn hàng đang ở trạng thái '${curStatus}', không thể hoàn tiền`,
        });
      }
      if (msg.startsWith('INVALID_REFUND_AMOUNT')) {
        return reply.code(400).send({ error: 'Số tiền hoàn lại không hợp lệ' });
      }
      return reply.code(500).send({ error: msg });
    }
  };

  // Hoàn tiền đơn hàng vào ví người dùng (Owner & Admin)
  app.post(
    '/api/orders/:id/refund',
    { preHandler: requireRole(['owner', 'admin']) },
    refundHandler
  );

  // Alias tương thích frontend
  app.post(
    '/api/orders/:id/refund-wallet',
    { preHandler: requireRole(['owner', 'admin']) },
    refundHandler
  );
}
