import { eq, desc, sql } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { wallets, walletLedger, type WalletLedgerEntry } from "@vault/db";

/**
 * Lấy số dư ví tiền của người dùng Discord (đơn vị: VNĐ).
 */
export async function getWalletBalance(
  db: Database,
  discordUserId: string
): Promise<number> {
  const result = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.discordUserId, discordUserId));
  return result[0]?.balance ?? 0;
}

/**
 * Biến động số dư ví (nạp tiền hoặc trừ tiền) và tự động ghi sổ cái (wallet_ledger).
 * Thao tác nguyên tử, đảm bảo tính toàn vẹn 100% theo chuẩn ACID.
 */
export async function adjustWalletBalance(
  db: Database,
  discordUserId: string,
  delta: number,
  kind: "card_topup" | "bank_topup" | "order_hold" | "order_refund" | "manual",
  refType = "",
  refId: number | null = null,
  note = ""
): Promise<number> {
  // Lấy hoặc tạo ví
  const currentBalance = await getWalletBalance(db, discordUserId);
  const newBalance = currentBalance + delta;
  if (newBalance < 0) {
    throw new Error("Số dư trong ví không đủ để thực hiện giao dịch này");
  }

  // 1. Cập nhật số dư ví
  await db
    .insert(wallets)
    .values({
      discordUserId,
      balance: newBalance,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: wallets.discordUserId,
      set: {
        balance: newBalance,
        updatedAt: new Date(),
      },
    });

  // 2. Ghi nhật ký sổ cái (append-only ledger)
  await db.insert(walletLedger).values({
    discordUserId,
    delta,
    balanceAfter: newBalance,
    kind,
    refType,
    refId,
    note,
  });

  return newBalance;
}

/**
 * Lấy lịch sử biến động số dư ví của người dùng Discord.
 */
export async function getWalletLedger(
  db: Database,
  discordUserId: string,
  limit = 20
): Promise<WalletLedgerEntry[]> {
  return db
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.discordUserId, discordUserId))
    .orderBy(desc(walletLedger.createdAt))
    .limit(limit);
}
