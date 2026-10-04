import { eq, and, sql, isNull } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { downloadTokens, type DownloadToken, type NewDownloadToken } from "@vault/db";

export async function mintDownloadToken(
  db: Database,
  input: {
    tokenHash: string;
    versionId: number;
    discordUserId: string;
    orderId?: number | null;
    expiresAt?: Date;
    ttlMinutes?: number;
  }
): Promise<DownloadToken> {
  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + (input.ttlMinutes ?? 60) * 60 * 1000);

  const inserted = await db
    .insert(downloadTokens)
    .values({
      tokenHash: input.tokenHash,
      versionId: input.versionId,
      discordUserId: input.discordUserId,
      orderId: input.orderId ?? null,
      expiresAt,
    })
    .returning();

  const created = inserted[0];
  if (!created) throw new Error("Không thể tạo token tải file");
  return created;
}

export async function findDownloadToken(
  db: Database,
  tokenHash: string
): Promise<DownloadToken | null> {
  const result = await db
    .select()
    .from(downloadTokens)
    .where(eq(downloadTokens.tokenHash, tokenHash));
  return result[0] ?? null;
}

/**
 * Atomic claim: Exactly one concurrent request claims the token.
 */
export async function claimDownloadToken(
  db: Database,
  tokenHash: string
): Promise<DownloadToken | null> {
  const updated = await db
    .update(downloadTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(downloadTokens.tokenHash, tokenHash),
        isNull(downloadTokens.usedAt),
        sql`${downloadTokens.expiresAt} > NOW()`
      )
    )
    .returning();

  return updated[0] ?? null;
}

/**
 * Compensation unclaim: Giải phóng token nếu tệp bị thiếu/hỏng trên local storage trước khi stream.
 */
export async function unclaimDownloadToken(
  db: Database,
  tokenHash: string,
  failureReason: string
): Promise<boolean> {
  const updated = await db
    .update(downloadTokens)
    .set({
      usedAt: null,
      failureReason,
    })
    .where(eq(downloadTokens.tokenHash, tokenHash))
    .returning({ tokenHash: downloadTokens.tokenHash });

  return updated.length === 1;
}
