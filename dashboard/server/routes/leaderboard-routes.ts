import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, sql, config, walletLedger, wallets } from '@vault/db';
import { db } from '../db/neon.js';
import { requireRole } from '../auth/rbac.js';

const leaderboardQuerySchema = z.object({
  timeframe: z.enum(['all', 'month', 'week', 'today']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const DEPOSIT_KINDS = ['bank_topup', 'card_topup', 'overpay', 'manual', 'topup', 'manual_adjust'];

export function registerLeaderboardRoutes(app: FastifyInstance) {
  // Lấy bảng xếp hạng nạp coin
  app.get('/api/leaderboard', async (request) => {
    const { timeframe, page, pageSize } = leaderboardQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;

    // 1. Lấy mốc resetAt từ bảng config
    const [resetConfig] = await db
      .select()
      .from(config)
      .where(eq(config.key, 'leaderboard_reset_at'))
      .limit(1);

    const resetAtSeconds = resetConfig ? parseInt(resetConfig.value, 10) : null;
    const resetAtMs = resetAtSeconds ? resetAtSeconds * 1000 : 0;

    // 2. Tính mốc thời gian since theo timeframe
    const now = new Date();
    let timeframeSinceMs = 0;

    if (timeframe === 'today') {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      timeframeSinceMs = today.getTime();
    } else if (timeframe === 'week') {
      timeframeSinceMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    } else if (timeframe === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      timeframeSinceMs = startOfMonth.getTime();
    }

    const effectiveSinceMs = Math.max(timeframeSinceMs, resetAtMs);
    const effectiveSinceDate = effectiveSinceMs > 0 ? new Date(effectiveSinceMs) : null;

    // 3. Điều kiện lọc chung
    const conditions = [
      sql`${walletLedger.delta} > 0`,
      inArray(walletLedger.kind, DEPOSIT_KINDS),
    ];
    if (effectiveSinceDate) {
      conditions.push(gte(walletLedger.createdAt, effectiveSinceDate));
    }
    const whereClause = and(...conditions);

    // 4. Thống kê tổng quan (Stats)
    const [statsRow] = await db
      .select({
        overallTotal: sql<number>`COALESCE(SUM(${walletLedger.delta}), 0)`,
        overallUsers: sql<number>`COUNT(DISTINCT ${walletLedger.discordUserId})`,
        maxSingleDeposit: sql<number>`COALESCE(MAX(${walletLedger.delta}), 0)`,
      })
      .from(walletLedger)
      .where(whereClause);

    const overallTotal = Number(statsRow?.overallTotal ?? 0);
    const overallUsers = Number(statsRow?.overallUsers ?? 0);
    const maxSingleDeposit = Number(statsRow?.maxSingleDeposit ?? 0);
    const averageDeposit = overallUsers > 0 ? Math.round(overallTotal / overallUsers) : 0;

    // 5. Danh sách người dùng xếp hạng
    const rows = await db
      .select({
        discordUserId: walletLedger.discordUserId,
        totalDeposited: sql<number>`COALESCE(SUM(${walletLedger.delta}), 0)`,
        bankDeposited: sql<number>`COALESCE(SUM(CASE WHEN ${walletLedger.kind} IN ('bank_topup', 'topup') THEN ${walletLedger.delta} ELSE 0 END), 0)`,
        cardDeposited: sql<number>`COALESCE(SUM(CASE WHEN ${walletLedger.kind} = 'card_topup' THEN ${walletLedger.delta} ELSE 0 END), 0)`,
        otherDeposited: sql<number>`COALESCE(SUM(CASE WHEN ${walletLedger.kind} NOT IN ('bank_topup', 'topup', 'card_topup') THEN ${walletLedger.delta} ELSE 0 END), 0)`,
        topupCount: sql<number>`COUNT(*)`,
        currentBalance: sql<number>`COALESCE(MAX(${wallets.balance}), 0)`,
        lastTopupAt: sql<Date>`MAX(${walletLedger.createdAt})`,
      })
      .from(walletLedger)
      .leftJoin(wallets, eq(wallets.discordUserId, walletLedger.discordUserId))
      .where(whereClause)
      .groupBy(walletLedger.discordUserId)
      .orderBy(sql`SUM(${walletLedger.delta}) DESC`, sql`MAX(${walletLedger.createdAt}) ASC`)
      .limit(pageSize)
      .offset(offset);

    const items = rows.map((r, index) => ({
      rank: offset + index + 1,
      discordUserId: r.discordUserId,
      totalDeposited: Number(r.totalDeposited),
      coins: Number(r.totalDeposited),
      bankDeposited: Number(r.bankDeposited),
      cardDeposited: Number(r.cardDeposited),
      otherDeposited: Number(r.otherDeposited),
      topupCount: Number(r.topupCount),
      currentBalance: Number(r.currentBalance),
      lastTopupAt: r.lastTopupAt ? new Date(r.lastTopupAt).getTime() : 0,
    }));

    const totalPages = Math.max(1, Math.ceil(overallUsers / pageSize));

    return {
      items,
      stats: {
        overallTotal,
        overallUsers,
        averageDeposit,
        maxSingleDeposit,
      },
      total: overallUsers,
      page,
      pageSize,
      totalPages,
      resetAt: resetAtSeconds,
    };
  });

  // Reset mốc thống kê bảng xếp hạng (Owner Only)
  app.post(
    '/api/leaderboard/reset',
    { preHandler: requireRole(['owner']) },
    async (request) => {
      const { undo } = z.object({ undo: z.boolean().optional(), reset: z.boolean().optional() }).parse(request.body ?? {});

      if (undo) {
        await db.delete(config).where(eq(config.key, 'leaderboard_reset_at'));
        return { ok: true, resetAt: null };
      }

      const resetTs = Math.floor(Date.now() / 1000);
      await db
        .insert(config)
        .values({
          key: 'leaderboard_reset_at',
          value: String(resetTs),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: config.key,
          set: { value: String(resetTs), updatedAt: new Date() },
        });

      return { ok: true, resetAt: resetTs };
    }
  );
}
