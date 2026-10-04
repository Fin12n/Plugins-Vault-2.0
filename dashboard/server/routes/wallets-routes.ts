import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, count, sql, wallets, walletLedger, cardTopups } from '@vault/db';
import { db } from '../db/neon.js';
import { requireRole } from '../auth/rbac.js';

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export function registerWalletsRoutes(app: FastifyInstance) {
  // Lấy danh sách ví + tổng số dư hệ thống
  app.get('/api/wallets', async (request) => {
    const qp = pageQuerySchema.parse(request.query);
    const offset = (qp.page - 1) * qp.pageSize;

    const [totalRow] = await db.select({ val: count() }).from(wallets);
    const total = totalRow?.val ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / qp.pageSize));

    const rows = await db
      .select()
      .from(wallets)
      .limit(qp.pageSize)
      .offset(offset)
      .orderBy(desc(wallets.balance));

    const [sumRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wallets.balance}), 0)` })
      .from(wallets);

    const items = rows.map((w) => ({
      discordUserId: w.discordUserId,
      balance: w.balance,
      createdAt: w.createdAt.getTime(),
      updatedAt: w.updatedAt.getTime(),
    }));

    return {
      items,
      totalBalance: Number(sumRow?.total ?? 0),
      page: qp.page,
      pageSize: qp.pageSize,
      total,
      totalPages,
    };
  });

  // Lịch sử biến động số dư của 1 ví
  app.get('/api/wallets/:discordUserId/ledger', async (request) => {
    const { discordUserId } = z
      .object({ discordUserId: z.string() })
      .parse(request.params);

    const rows = await db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.discordUserId, discordUserId))
      .orderBy(desc(walletLedger.createdAt))
      .limit(100);

    return rows.map((l: typeof walletLedger.$inferSelect) => ({
      id: l.id,
      discordUserId: l.discordUserId,
      delta: l.delta,
      balanceAfter: l.balanceAfter,
      kind: l.kind,
      refType: l.refType,
      refId: l.refId,
      note: l.note,
      createdAt: l.createdAt.getTime(),
    }));
  });

  // Cộng / trừ tiền thủ công (Điều chỉnh số dư - Chỉ dành cho OWNER)
  app.post(
    '/api/wallets/:discordUserId/adjust',
    { preHandler: requireRole(['owner']) },
    async (request, reply) => {
      const { discordUserId } = z
        .object({ discordUserId: z.string() })
        .parse(request.params);
      const { delta, note } = z
        .object({
          delta: z.number().int(),
          note: z.string().min(1),
        })
        .parse(request.body);

      if (delta === 0) {
        return reply.code(400).send({ error: 'Số tiền thay đổi không được bằng 0' });
      }

      try {
        const updated = await db.transaction(async (tx) => {
          // Đảm bảo hàng ví tồn tại trước khi khóa
          await tx
            .insert(wallets)
            .values({
              discordUserId,
              balance: 0,
              updatedAt: new Date(),
            })
            .onConflictDoNothing({ target: wallets.discordUserId });

          // Khóa dòng ví FOR UPDATE chống race condition / lost update
          const [w] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.discordUserId, discordUserId))
            .for('update');

          const currentBalance = w?.balance ?? 0;
          const newBalance = currentBalance + delta;
          if (newBalance < 0) {
            throw new Error('Số dư ví không được âm sau khi điều chỉnh');
          }

          await tx
            .update(wallets)
            .set({
              balance: newBalance,
              updatedAt: new Date(),
            })
            .where(eq(wallets.discordUserId, discordUserId));

          const actor =
            request.sessionUser?.displayName || request.sessionUser?.username || 'Owner';
          await tx.insert(walletLedger).values({
            discordUserId,
            delta,
            balanceAfter: newBalance,
            kind: 'manual_adjust',
            refType: 'admin',
            note: `[${actor}] ${note}`,
          });

          return { discordUserId, balance: newBalance };
        });

        return { ok: true, wallet: updated };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }
    }
  );

  // Kiểm tra đối soát lệch số dư (Reconcile Drift)
  app.get('/api/wallets/reconcile', async () => {
    const driftRows = await db.execute<{
      discord_user_id: string;
      balance: number;
      ledger_sum: number;
    }>(sql`
      SELECT 
        w.discord_user_id,
        w.balance,
        COALESCE(SUM(l.delta), 0) AS ledger_sum
      FROM wallets w
      LEFT JOIN wallet_ledger l ON w.discord_user_id = l.discord_user_id
      GROUP BY w.discord_user_id, w.balance
      HAVING w.balance != COALESCE(SUM(l.delta), 0)
    `);

    const drifts = (driftRows.rows || []).map((r: { discord_user_id: string; balance: number; ledger_sum: number }) => ({
      discordUserId: r.discord_user_id,
      balance: Number(r.balance),
      ledgerSum: Number(r.ledger_sum),
    }));

    return { ok: true, drifts };
  });

  // Danh sách nạp thẻ cào (Card Topups)
  app.get('/api/cards', async (request) => {
    const qp = pageQuerySchema.parse(request.query);
    const offset = (qp.page - 1) * qp.pageSize;

    const [totalRow] = await db.select({ val: count() }).from(cardTopups);
    const total = totalRow?.val ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / qp.pageSize));

    const rows = await db
      .select()
      .from(cardTopups)
      .limit(qp.pageSize)
      .offset(offset)
      .orderBy(desc(cardTopups.createdAt));

    const items = rows.map((c: typeof cardTopups.$inferSelect) => ({
      id: c.id,
      discordUserId: c.discordUserId,
      telco: c.telco,
      serial: c.serial,
      declaredValue: c.declaredValue,
      actualValue: c.actualValue,
      netAmount: c.netAmount,
      status: c.status,
      providerStatus: c.providerStatus,
      providerMessage: c.providerMessage,
      attempts: c.attempts,
      creditedAt: c.creditedAt?.getTime() ?? null,
      createdAt: c.createdAt.getTime(),
    }));

    return {
      items,
      page: qp.page,
      pageSize: qp.pageSize,
      total,
      totalPages,
    };
  });
}
