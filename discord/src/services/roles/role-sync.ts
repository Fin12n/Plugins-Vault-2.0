import type { Client } from "discord.js";
import type { Database } from "../../db/neon.js";
import { orders } from "@vault/db";
import { eq, and, sql } from "drizzle-orm";

export type RoleSyncResult = {
  success: boolean;
  assignedRoles: string[];
  removedRoles: string[];
  message: string;
};

/**
 * Kiểm tra và gán/gỡ role Discord cho một thành viên dựa trên lịch sử mua hàng và số dư trên Neon DB.
 */
export async function syncRolesForMember(
  client: Client,
  guildId: string,
  discordUserId: string,
  neonDb: Database
): Promise<RoleSyncResult> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    return {
      success: false,
      assignedRoles: [],
      removedRoles: [],
      message: "Không tìm thấy Discord Server",
    };
  }

  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) {
    return {
      success: false,
      assignedRoles: [],
      removedRoles: [],
      message: "Không tìm thấy thành viên trong Server",
    };
  }

  // 1. Kiểm tra đơn hàng đã hoàn tất (paid / delivered / wallet_paid)
  const paidOrders = await neonDb
    .select({ id: orders.id, amount: orders.amount })
    .from(orders)
    .where(
      and(
        eq(orders.discordUserId, discordUserId),
        sql`${orders.status} IN ('paid', 'delivered', 'wallet_paid')`
      )
    );

  const hasPurchased = paidOrders.length > 0;
  const totalSpent = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

  // 2. Tìm hoặc xác định role cấu hình (Khách Hàng / VIP / Gold)
  const assigned: string[] = [];

  // Tìm role "Khách Hàng" hoặc "Buyer"
  const buyerRole = guild.roles.cache.find((r) =>
    /khách hàng|buyer/i.test(r.name)
  );
  if (hasPurchased && buyerRole && !member.roles.cache.has(buyerRole.id)) {
    await member.roles.add(buyerRole).catch(() => null);
    assigned.push(buyerRole.name);
  }

  // VIP / Gold Buyer nếu chi tiêu >= 200.000 VNĐ
  const vipRole = guild.roles.cache.find((r) => /vip|gold/i.test(r.name));
  if (totalSpent >= 200_000 && vipRole && !member.roles.cache.has(vipRole.id)) {
    await member.roles.add(vipRole).catch(() => null);
    assigned.push(vipRole.name);
  }

  return {
    success: true,
    assignedRoles: assigned,
    removedRoles: [],
    message:
      assigned.length > 0
        ? `Đã đồng bộ vai trò: ${assigned.join(", ")}`
        : "Vai trò hiện tại đã đồng bộ đầy đủ",
  };
}
