import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { count, eq, or, sql, desc, gte, and, plugins, versions, orders, spigotAccounts, walletLedger } from '@vault/db';

import { db } from '../db/neon.js';

export function registerStatsRoutes(app: FastifyInstance) {
  // Tổng quan Dashboard Analytics
  app.get('/api/overview', async () => {
    const [pCount] = await db.select({ val: count() }).from(plugins);
    const [vCount] = await db.select({ val: count() }).from(versions);
    const [oCount] = await db.select({ val: count() }).from(orders);

    const [paidCountRow] = await db
      .select({ val: count() })
      .from(orders)
      .where(or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')));

    const [revRow] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')));

    // Doanh thu hôm nay
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayRevRow] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')),
          gte(orders.createdAt, startOfToday)
        )
      );

    // Spigot accounts
    const [spigotTotalRow] = await db.select({ val: count() }).from(spigotAccounts);
    const [spigotHealthyRow] = await db
      .select({ val: count() })
      .from(spigotAccounts)
      .where(and(eq(spigotAccounts.isEnabled, true), eq(spigotAccounts.status, 'ok')));

    // Đơn hàng gần đây (5 orders)
    const recentOrders = await db
      .select({
        id: orders.id,
        code: orders.code,
        discordUserId: orders.discordUserId,
        pluginName: orders.pluginName,
        amount: orders.amount,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(5);

    // Top plugins phổ biến nhất (5 plugins)
    const popularRows = await db
      .select({
        pluginName: orders.pluginName,
        count: count(),
        amount: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')))
      .groupBy(orders.pluginName)
      .orderBy(desc(count()))
      .limit(5);

    return {
      totalPlugins: pCount?.val ?? 0,
      totalVersions: vCount?.val ?? 0,
      totalOrders: oCount?.val ?? 0,
      paidOrders: paidCountRow?.val ?? 0,
      totalRevenue: Number(revRow?.total ?? 0),
      todayRevenue: Number(todayRevRow?.total ?? 0),
      accountsHealthy: spigotHealthyRow?.val ?? 0,
      accountsTotal: spigotTotalRow?.val ?? 0,
      recentOrders: recentOrders.map((o: any) => ({
        ...o,
        createdAt: o.createdAt.getTime(),
      })),
      popularPlugins: popularRows.map((pr: any) => ({
        name: pr.pluginName,
        downloads: pr.count,
        amount: Number(pr.amount),
      })),
    };
  });

  // Báo cáo tháng
  app.get('/api/stats/monthly', async (request) => {
    const query = z.object({ month: z.string().optional() }).parse(request.query);
    const currentMonth = query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

    const [sumRow] = await db
      .select({
        downloads: count(),
        amount: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')),
          sql`to_char(${orders.createdAt}, 'YYYY-MM') = ${currentMonth}`
        )
      );

    const pluginRows = await db
      .select({
        pluginName: orders.pluginName,
        downloads: count(),
        amount: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')),
          sql`to_char(${orders.createdAt}, 'YYYY-MM') = ${currentMonth}`
        )
      )
      .groupBy(orders.pluginName)
      .orderBy(desc(count()));

    const userRows = await db
      .select({
        discordUserId: orders.discordUserId,
        downloads: count(),
        amount: sql<number>`COALESCE(SUM(${orders.paidAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          or(eq(orders.status, 'paid'), eq(orders.status, 'delivered')),
          sql`to_char(${orders.createdAt}, 'YYYY-MM') = ${currentMonth}`
        )
      )
      .groupBy(orders.discordUserId)
      .orderBy(desc(count()));

    return {
      month: currentMonth,
      totalDownloads: sumRow?.downloads ?? 0,
      totalAmount: Number(sumRow?.amount ?? 0),
      perPlugin: pluginRows.map((p: any) => ({
        pluginName: p.pluginName,
        downloads: p.downloads,
        amount: Number(p.amount),
      })),
      perUser: userRows.map((u: any) => ({
        discordUserId: u.discordUserId,
        downloads: u.downloads,
        amount: Number(u.amount),
      })),
    };
  });

  // Bảng xếp hạng nạp tiền (Leaderboard)
  app.get('/api/stats/leaderboard', async () => {
    const rows = await db
      .select({
        discordUserId: walletLedger.discordUserId,
        totalDeposit: sql<number>`COALESCE(SUM(${walletLedger.delta}), 0)`,
      })
      .from(walletLedger)
      .where(eq(walletLedger.kind, 'topup'))
      .groupBy(walletLedger.discordUserId)
      .orderBy(desc(sql`SUM(${walletLedger.delta})`))
      .limit(20);

    return {
      items: rows.map((r: any) => ({
        discordUserId: r.discordUserId,
        totalDeposit: Number(r.totalDeposit),
      })),
    };
  });

  // Nhật ký giao hàng (Audit log)
  app.get('/api/stats/audit', async () => {
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.status, 'delivered'))
      .orderBy(desc(orders.deliveredAt))
      .limit(50);

    return rows.map((o: typeof orders.$inferSelect) => ({
      id: o.id,
      discordUserId: o.discordUserId,
      pluginName: o.pluginName,
      versionLabel: o.versionLabel,
      amount: o.amount,
      deliveryMethod: 'direct',
      deliveredAt: o.deliveredAt?.getTime() ?? o.createdAt.getTime(),
    }));
  });
}
