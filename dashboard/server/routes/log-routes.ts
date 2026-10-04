import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, gte, lt, deliveryLogs } from '@vault/db';
import { db } from '../db/neon.js';

const logQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  userId: z.string().optional(),
});

export function registerLogRoutes(app: FastifyInstance) {
  // Lấy nhật ký giao hàng / tải tệp (Audit Log)
  app.get('/api/log', async (request) => {
    const qp = logQuerySchema.parse(request.query);
    const offset = (qp.page - 1) * qp.pageSize;

    const conditions = [];

    if (qp.userId) {
      conditions.push(eq(deliveryLogs.discordUserId, qp.userId));
    }

    if (qp.month) {
      const parts = qp.month.split('-');
      const year = parseInt(parts[0] ?? '2026', 10);
      const month = parseInt(parts[1] ?? '1', 10);
      const startOfMonth = new Date(year, month - 1, 1);
      const startOfNextMonth = new Date(year, month, 1);
      conditions.push(gte(deliveryLogs.deliveredAt, startOfMonth));
      conditions.push(lt(deliveryLogs.deliveredAt, startOfNextMonth));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await db
      .select({ val: count() })
      .from(deliveryLogs)
      .where(whereClause);

    const total = totalRow?.val ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / qp.pageSize));

    const rows = await db
      .select()
      .from(deliveryLogs)
      .where(whereClause)
      .limit(qp.pageSize)
      .offset(offset)
      .orderBy(desc(deliveryLogs.deliveredAt));

    const items = rows.map((r: typeof deliveryLogs.$inferSelect) => ({
      id: r.id,
      discordUserId: r.discordUserId,
      pluginName: r.pluginName,
      versionLabel: r.versionLabel,
      amount: r.amount,
      deliveryMethod: r.actualMethod || r.requestedMethod,
      deliveredAt: r.deliveredAt.getTime(),
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
