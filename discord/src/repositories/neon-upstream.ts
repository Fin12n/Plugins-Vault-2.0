import { eq, and, lte } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { upstreamState, pendingDownload, type UpstreamState, type PendingDownload } from "@vault/db";

/**
 * Lấy trạng thái phiên bản upstream Spigot mới nhất đã ghi nhận của plugin.
 */
export async function getUpstreamState(
  db: Database,
  pluginId: number
): Promise<UpstreamState | null> {
  const result = await db
    .select()
    .from(upstreamState)
    .where(eq(upstreamState.pluginId, pluginId));
  return result[0] ?? null;
}

/**
 * Cập nhật trạng thái phiên bản mới nhất từ upstream Spigot.
 */
export async function setUpstreamState(
  db: Database,
  pluginId: number,
  versionUuid: string,
  versionName: string,
  releaseDateMs: string
): Promise<void> {
  await db
    .insert(upstreamState)
    .values({
      pluginId,
      versionUuid,
      versionName,
      releaseDateMs,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: upstreamState.pluginId,
      set: {
        versionUuid,
        versionName,
        releaseDateMs,
        checkedAt: new Date(),
      },
    });
}

/**
 * Đưa phiên bản cần tải vào hàng đợi pending_download.
 */
export async function enqueueDownload(
  db: Database,
  pluginId: number,
  versionUuid: string,
  versionName: string,
  nextAttemptAt: Date
): Promise<void> {
  await db
    .insert(pendingDownload)
    .values({
      pluginId,
      versionUuid,
      versionName,
      attempts: 0,
      lastError: "",
      nextAttemptAt,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Lấy danh sách các bản nợ cần tải đã đến hạn (nextAttemptAt <= now).
 */
export async function listDueDownloads(
  db: Database,
  dueBefore: Date = new Date()
): Promise<PendingDownload[]> {
  return db
    .select()
    .from(pendingDownload)
    .where(lte(pendingDownload.nextAttemptAt, dueBefore));
}

/**
 * Xóa bản ghi nợ sau khi đã tải thành công.
 */
export async function removePendingDownload(
  db: Database,
  pluginId: number,
  versionUuid: string
): Promise<void> {
  await db
    .delete(pendingDownload)
    .where(
      and(
        eq(pendingDownload.pluginId, pluginId),
        eq(pendingDownload.versionUuid, versionUuid)
      )
    );
}

/**
 * Cập nhật số lần thử lại và lỗi nếu lần tải bị thất bại.
 */
export async function recordDownloadFailure(
  db: Database,
  pluginId: number,
  versionUuid: string,
  lastError: string,
  nextAttemptAt: Date
): Promise<void> {
  const existing = await db
    .select()
    .from(pendingDownload)
    .where(
      and(
        eq(pendingDownload.pluginId, pluginId),
        eq(pendingDownload.versionUuid, versionUuid)
      )
    );
  const attempts = (existing[0]?.attempts ?? 0) + 1;

  await db
    .update(pendingDownload)
    .set({
      attempts,
      lastError,
      nextAttemptAt,
    })
    .where(
      and(
        eq(pendingDownload.pluginId, pluginId),
        eq(pendingDownload.versionUuid, versionUuid)
      )
    );
}
