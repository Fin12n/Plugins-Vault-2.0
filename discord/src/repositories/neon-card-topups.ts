import { eq, desc, asc, and, sql, isNull, inArray } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { cardTopups, type CardTopup, type NewCardTopup } from "@vault/db";

export async function createCardTopup(
  db: Database,
  input: {
    requestId: string;
    discordUserId: string;
    telco: string;
    serial: string;
    code: string;
    declaredValue: number;
    firstPollAt?: Date;
  }
): Promise<CardTopup> {
  const inserted = await db
    .insert(cardTopups)
    .values({
      requestId: input.requestId,
      discordUserId: input.discordUserId,
      telco: input.telco,
      serial: input.serial,
      code: input.code,
      declaredValue: input.declaredValue,
      status: "pending",
      nextPollAt: input.firstPollAt ?? new Date(),
    })
    .returning();

  const created = inserted[0];
  if (!created) throw new Error("Không tạo được phiếu nạp thẻ");
  return created;
}

export async function findCardTopupById(
  db: Database,
  id: number
): Promise<CardTopup | null> {
  const result = await db.select().from(cardTopups).where(eq(cardTopups.id, id));
  return result[0] ?? null;
}

export async function findCardTopupByRequestId(
  db: Database,
  requestId: string
): Promise<CardTopup | null> {
  const result = await db
    .select()
    .from(cardTopups)
    .where(eq(cardTopups.requestId, requestId));
  return result[0] ?? null;
}

export async function hasPendingSerial(
  db: Database,
  telco: string,
  serial: string
): Promise<boolean> {
  const result = await db
    .select({ id: cardTopups.id })
    .from(cardTopups)
    .where(
      and(
        eq(cardTopups.telco, telco),
        eq(cardTopups.serial, serial),
        eq(cardTopups.status, "pending")
      )
    )
    .limit(1);
  return result.length > 0;
}

export async function listDuePolls(
  db: Database,
  limit = 50
): Promise<CardTopup[]> {
  return db
    .select()
    .from(cardTopups)
    .where(
      and(
        eq(cardTopups.status, "pending"),
        sql`${cardTopups.nextPollAt} IS NOT NULL`,
        sql`${cardTopups.nextPollAt} <= NOW()`
      )
    )
    .orderBy(asc(cardTopups.nextPollAt))
    .limit(limit);
}

export async function recordPollAttempt(
  db: Database,
  id: number,
  input: { nextPollAt: Date; providerStatus?: number | null; providerMessage?: string }
): Promise<void> {
  await db
    .update(cardTopups)
    .set({
      attempts: sql`${cardTopups.attempts} + 1`,
      nextPollAt: input.nextPollAt,
      providerStatus: input.providerStatus ?? undefined,
      providerMessage: input.providerMessage ?? "",
    })
    .where(and(eq(cardTopups.id, id), eq(cardTopups.status, "pending")));
}

export async function settleCardTopup(
  db: Database,
  id: number,
  input: {
    status: "success" | "wrong_amount" | "failed" | "timeout" | "needs_review";
    actualValue?: number | null;
    netAmount?: number | null;
    providerStatus?: number | null;
    providerMessage?: string;
    transId?: string | null;
  }
): Promise<boolean> {
  const updated = await db
    .update(cardTopups)
    .set({
      status: input.status,
      actualValue: input.actualValue ?? null,
      netAmount: input.netAmount ?? null,
      providerStatus: input.providerStatus ?? null,
      providerMessage: input.providerMessage ?? "",
      transId: input.transId ?? null,
      nextPollAt: null,
      attempts: sql`${cardTopups.attempts} + 1`,
    })
    .where(and(eq(cardTopups.id, id), eq(cardTopups.status, "pending")))
    .returning({ id: cardTopups.id });

  return updated.length === 1;
}

export async function claimCardCredit(
  db: Database,
  id: number
): Promise<boolean> {
  const updated = await db
    .update(cardTopups)
    .set({ creditedAt: new Date() })
    .where(and(eq(cardTopups.id, id), isNull(cardTopups.creditedAt)))
    .returning({ id: cardTopups.id });

  return updated.length === 1;
}

export async function scrubCardCode(db: Database, id: number): Promise<void> {
  await db
    .update(cardTopups)
    .set({ code: "" })
    .where(
      and(
        eq(cardTopups.id, id),
        inArray(cardTopups.status, ["success", "wrong_amount"])
      )
    );
}

export async function listCardTopupsByUser(
  db: Database,
  discordUserId: string,
  limit = 20
): Promise<CardTopup[]> {
  return db
    .select()
    .from(cardTopups)
    .where(eq(cardTopups.discordUserId, discordUserId))
    .orderBy(desc(cardTopups.createdAt))
    .limit(limit);
}
