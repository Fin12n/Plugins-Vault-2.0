import { eq, and } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { resourceOwnership } from "@vault/db";

/**
 * Kiểm tra trạng thái sở hữu của một tài nguyên Spigot đối với tài khoản chỉ định.
 */
export async function getOwnership(
  db: Database,
  resourceId: number,
  accountLabel: string
): Promise<"owned" | "not_owned" | null> {
  const result = await db
    .select({ state: resourceOwnership.state })
    .from(resourceOwnership)
    .where(
      and(
        eq(resourceOwnership.resourceId, resourceId),
        eq(resourceOwnership.accountLabel, accountLabel)
      )
    );
  const state = result[0]?.state;
  return state === "owned" || state === "not_owned" ? state : null;
}

/**
 * Ghi nhận hoặc cập nhật quyền sở hữu tài nguyên Spigot vào Neon DB.
 */
export async function setOwnership(
  db: Database,
  resourceId: number,
  accountLabel: string,
  state: "owned" | "not_owned"
): Promise<void> {
  await db
    .insert(resourceOwnership)
    .values({
      resourceId,
      accountLabel,
      state,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [resourceOwnership.resourceId, resourceOwnership.accountLabel],
      set: {
        state,
        checkedAt: new Date(),
      },
    });
}

/**
 * Lấy danh sách ID các resource mà tài khoản sở hữu.
 */
export async function listOwnedResources(
  db: Database,
  accountLabel: string
): Promise<number[]> {
  const rows = await db
    .select({ resourceId: resourceOwnership.resourceId })
    .from(resourceOwnership)
    .where(
      and(
        eq(resourceOwnership.accountLabel, accountLabel),
        eq(resourceOwnership.state, "owned")
      )
    );
  return rows.map((r) => r.resourceId);
}

/**
 * Tìm tài khoản đầu tiên sở hữu resourceId này.
 */
export async function findOwningAccount(
  db: Database,
  resourceId: number
): Promise<string | null> {
  const result = await db
    .select({ accountLabel: resourceOwnership.accountLabel })
    .from(resourceOwnership)
    .where(
      and(
        eq(resourceOwnership.resourceId, resourceId),
        eq(resourceOwnership.state, "owned")
      )
    )
    .limit(1);
  return result[0]?.accountLabel ?? null;
}
