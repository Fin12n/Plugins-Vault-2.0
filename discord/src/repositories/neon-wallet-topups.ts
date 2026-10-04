import { eq, desc, and, sql, inArray } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { walletTopups, type WalletTopup, type NewWalletTopup } from "@vault/db";

export async function createWalletTopup(
  db: Database,
  input: {
    code: string;
    discordUserId: string;
    amount: number;
    ttlMinutes?: number;
    expiresAt?: Date;
  }
): Promise<WalletTopup> {
  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + (input.ttlMinutes ?? 15) * 60 * 1000);

  const inserted = await db
    .insert(walletTopups)
    .values({
      code: input.code.toUpperCase(),
      discordUserId: input.discordUserId,
      amount: input.amount,
      status: "pending",
      expiresAt,
    })
    .returning();

  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể tạo phiếu nạp ví");
  }
  return created;
}

export async function findTopupById(
  db: Database,
  id: number
): Promise<WalletTopup | null> {
  const result = await db
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.id, id));
  return result[0] ?? null;
}

export async function findTopupByCode(
  db: Database,
  code: string
): Promise<WalletTopup | null> {
  const result = await db
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.code, code.toUpperCase()));
  return result[0] ?? null;
}

/**
 * Dynamic Real-Amount Credit Policy:
 * Cho phép chuyển từ 'pending' HOẶC 'expired' sang 'credited'
 * Gán đúng số tiền thực nhận paidAmount = receivedAmount
 */
export async function markTopupCredited(
  db: Database,
  id: number,
  paidAmount: number
): Promise<boolean> {
  const updated = await db
    .update(walletTopups)
    .set({
      status: "credited",
      paidAmount,
      creditedAt: new Date(),
    })
    .where(
      and(
        eq(walletTopups.id, id),
        inArray(walletTopups.status, ["pending", "expired"])
      )
    )
    .returning({ id: walletTopups.id });

  return updated.length === 1;
}

export async function listTopupsByUser(
  db: Database,
  discordUserId: string,
  limit = 20
): Promise<WalletTopup[]> {
  return db
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.discordUserId, discordUserId))
    .orderBy(desc(walletTopups.createdAt))
    .limit(limit);
}

export async function expireStaleTopups(db: Database): Promise<number> {
  const updated = await db
    .update(walletTopups)
    .set({ status: "expired" })
    .where(
      and(
        eq(walletTopups.status, "pending"),
        sql`${walletTopups.expiresAt} <= NOW()`
      )
    )
    .returning({ id: walletTopups.id });

  return updated.length;
}

export async function countTopupsByCode(
  db: Database,
  code: string
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTopups)
    .where(eq(walletTopups.code, code.toUpperCase()));
  return result[0]?.count ?? 0;
}
