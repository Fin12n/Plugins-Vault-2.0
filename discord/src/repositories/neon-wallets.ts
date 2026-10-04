import { eq, desc, sql, count } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import {
  wallets,
  walletLedger,
  type Wallet,
  type WalletLedgerEntry,
  type NewWalletLedgerEntry,
} from "@vault/db";

export type LedgerKind =
  | "opening_balance"
  | "topup_credit"
  | "card_credit"
  | "order_debit"
  | "order_hold"
  | "order_partial_credit"
  | "order_overpay_credit"
  | "order_refund"
  | "admin_adjustment";

export type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

/**
 * Lấy số dư ví tiền của người dùng Discord (đơn vị: VNĐ).
 */
export async function getWalletBalance(
  db: DbOrTx,
  discordUserId: string
): Promise<number> {
  const result = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.discordUserId, discordUserId));
  return result[0]?.balance ?? 0;
}

/**
 * Lấy hoặc tạo ví nếu chưa có (số dư khởi tạo 0).
 */
export async function getOrCreateWallet(
  db: DbOrTx,
  discordUserId: string
): Promise<Wallet> {
  const existing = await db
    .select()
    .from(wallets)
    .where(eq(wallets.discordUserId, discordUserId))
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  const inserted = await db
    .insert(wallets)
    .values({
      discordUserId,
      balance: 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: wallets.discordUserId,
      set: { updatedAt: new Date() },
    })
    .returning();

  const w = inserted[0];
  if (!w) {
    throw new Error(`Không thể khởi tạo ví cho user ${discordUserId}`);
  }
  return w;
}

/**
 * Áp dụng biến động số dư và ghi sổ cái trong một Transaction có row lock (SELECT FOR UPDATE).
 * Đảm bảo Canonical Lock Order (Lock wallets trước orders/topups/delivery_jobs).
 */
export async function applyLedgerEntry(
  db: Database,
  input: {
    discordUserId: string;
    delta: number;
    kind: LedgerKind | string;
    refType?: string;
    refId?: number | null;
    note?: string;
    allowNegative?: boolean;
  }
): Promise<{ wallet: Wallet; ledgerEntry: WalletLedgerEntry }> {
  return await db.transaction(async (tx) => {
    return await applyLedgerEntryTx(tx, input);
  });
}

/**
 * Phiên bản chạy bên trong một transaction đã có sẵn (Tx).
 */
export async function applyLedgerEntryTx(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: {
    discordUserId: string;
    delta: number;
    kind: LedgerKind | string;
    refType?: string;
    refId?: number | null;
    note?: string;
    allowNegative?: boolean;
  }
): Promise<{ wallet: Wallet; ledgerEntry: WalletLedgerEntry }> {
  const { discordUserId, delta, kind, refType = "", refId = null, note = "", allowNegative = false } = input;

  // 1. Đảm bảo ví tồn tại
  await tx
    .insert(wallets)
    .values({
      discordUserId,
      balance: 0,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: wallets.discordUserId });

  // 2. Lock row ví với SELECT ... FOR UPDATE
  const lockedRows = await tx
    .select()
    .from(wallets)
    .where(eq(wallets.discordUserId, discordUserId))
    .for("update");

  const currentWallet = lockedRows[0];
  if (!currentWallet) {
    throw new Error(`Ví của user ${discordUserId} không tìm thấy sau khi khởi tạo`);
  }

  const newBalance = currentWallet.balance + delta;
  if (!allowNegative && newBalance < 0) {
    throw new Error(
      `INSUFFICIENT_WALLET_BALANCE: Số dư ví không đủ (hiện có: ${currentWallet.balance}, cần trừ: ${Math.abs(delta)})`
    );
  }

  // 3. Cập nhật số dư ví
  const updatedWallets = await tx
    .update(wallets)
    .set({
      balance: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(wallets.discordUserId, discordUserId))
    .returning();

  const updatedWallet = updatedWallets[0];
  if (!updatedWallet) {
    throw new Error(`Không thể cập nhật ví cho user ${discordUserId}`);
  }

  // 4. Ghi append-only ledger trong cùng transaction
  const ledgerRows = await tx
    .insert(walletLedger)
    .values({
      discordUserId,
      delta,
      balanceAfter: newBalance,
      kind,
      refType,
      refId,
      note,
    })
    .returning();

  const ledgerEntry = ledgerRows[0];
  if (!ledgerEntry) {
    throw new Error(`Không thể ghi sổ cái cho user ${discordUserId}`);
  }

  return { wallet: updatedWallet, ledgerEntry };
}

/**
 * Backward compatibility wrapper cho adjustWalletBalance.
 */
export async function adjustWalletBalance(
  db: Database,
  discordUserId: string,
  delta: number,
  kind: string,
  refType = "",
  refId: number | null = null,
  note = ""
): Promise<number> {
  const result = await applyLedgerEntry(db, {
    discordUserId,
    delta,
    kind,
    refType,
    refId,
    note,
  });
  return result.wallet.balance;
}

/**
 * Lấy lịch sử sổ cái của user.
 */
export async function listLedger(
  db: DbOrTx,
  discordUserId: string,
  limit = 20,
  offset = 0
): Promise<WalletLedgerEntry[]> {
  return db
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.discordUserId, discordUserId))
    .orderBy(desc(walletLedger.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Backward compatibility alias.
 */
export const getWalletLedger = listLedger;

/**
 * Danh sách ví (phân trang).
 */
export async function listWallets(
  db: DbOrTx,
  limit = 50,
  offset = 0
): Promise<Wallet[]> {
  return db
    .select()
    .from(wallets)
    .orderBy(desc(wallets.updatedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Đếm tổng số ví.
 */
export async function countWallets(db: DbOrTx): Promise<number> {
  const res = await db.select({ total: count() }).from(wallets);
  return res[0]?.total ?? 0;
}

/**
 * Tổng số dư của tất cả các ví trong hệ thống.
 */
export async function sumWalletBalances(db: DbOrTx): Promise<number> {
  const res = await db
    .select({ total: sql<number>`COALESCE(SUM(${wallets.balance}), 0)::int` })
    .from(wallets);
  return res[0]?.total ?? 0;
}

/**
 * Đối soát toàn bộ số dư ví với tổng delta từ sổ cái.
 * Invariant: wallet.balance == SUM(wallet_ledger.delta).
 * Trả về danh sách các user bị lệch (nếu rỗng -> 100% khớp).
 */
export async function reconcileBalances(
  db: DbOrTx
): Promise<Array<{ discordUserId: string; walletBalance: number; ledgerSum: number; diff: number }>> {
  const query = sql<Array<{
    discord_user_id: string;
    balance: number;
    ledger_sum: number;
    diff: number;
  }>>`
    SELECT
      w.discord_user_id,
      w.balance,
      COALESCE(SUM(l.delta), 0)::int AS ledger_sum,
      (w.balance - COALESCE(SUM(l.delta), 0)::int) AS diff
    FROM wallets w
    LEFT JOIN wallet_ledger l ON w.discord_user_id = l.discord_user_id
    GROUP BY w.discord_user_id, w.balance
    HAVING w.balance != COALESCE(SUM(l.delta), 0)::int
  `;

  const result = await db.execute(query);
  const rows: any[] = Array.isArray(result) ? result : ((result as any).rows ?? []);
  return rows.map((r) => ({
    discordUserId: String(r.discord_user_id),
    walletBalance: Number(r.balance),
    ledgerSum: Number(r.ledger_sum),
    diff: Number(r.diff),
  }));
}
