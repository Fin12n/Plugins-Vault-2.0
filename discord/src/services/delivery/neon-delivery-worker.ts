import { AttachmentBuilder, DiscordAPIError, RESTJSONErrorCodes, type Client } from "discord.js";
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../../db/neon.js";
import {
  claimStaleOrQueuedDeliveryJob,
  markDeliveryJobSuccess,
  markDeliveryJobRetryable,
  markDeliveryJobFailed,
} from "../../repositories/neon-delivery-jobs.js";
import { createDeliveryLog } from "../../repositories/neon-delivery-logs.js";
import { mintDownloadToken } from "../../repositories/neon-download-tokens.js";
import { findVersionById } from "../../repositories/neon-versions.js";
import { findPluginById } from "../../repositories/neon-plugins.js";
import { updateOrderStatus } from "../../repositories/neon-orders.js";
import { resolveBlobPath, suggestFilename } from "./deliver-version.js";

export type DeliveryWorkerDeps = {
  neonDb: Database;
  client: Client;
  vaultDir: string;
  publicBaseUrl: string;
  attachMaxBytes: number;
  tokenTtlMinutes: number;
  workerId?: string;
};

/**
 * Xử lý 1 delivery job từ hàng đợi Neon delivery_jobs.
 * Thực hiện:
 * - Claim job an toàn bằng FOR UPDATE SKIP LOCKED kèm cơ chế timeout lease
 * - Mint token tải một lần ghi vào Neon
 * - Gửi DM hoặc đính kèm JAR cho người mua qua Discord Bot
 * - Ghi delivery_logs idempotent
 * - Cập nhật orders.delivered_at
 */
export async function processNextDeliveryJob(
  deps: DeliveryWorkerDeps
): Promise<{ processed: boolean; jobId?: number; success?: boolean; reason?: string }> {
  const workerId = deps.workerId || `worker-${process.pid}`;

  // 1. Claim job
  const job = await claimStaleOrQueuedDeliveryJob(deps.neonDb, workerId, 5);
  if (!job) {
    return { processed: false };
  }

  const claimToken = job.claimToken ?? workerId;

  try {
    // 2. Tra cứu phiên bản và plugin
    const version = await findVersionById(deps.neonDb, job.versionId);
    if (!version) {
      await markDeliveryJobFailed(deps.neonDb, job.id, claimToken, "Phiên bản không tồn tại trong Neon");
      return { processed: true, jobId: job.id, success: false, reason: "version_not_found" };
    }

    const plugin = await findPluginById(deps.neonDb, version.pluginId);
    const pluginSlug = plugin?.slug ?? String(version.pluginId);
    const pluginName = plugin?.displayName ?? version.pluginId.toString();

    // 3. Kiểm tra tệp trong kho đĩa cục bộ
    const blobPath = await resolveBlobPath(deps.vaultDir, version.relPath);
    if (!blobPath) {
      await markDeliveryJobRetryable(
        deps.neonDb,
        job.id,
        claimToken,
        `Tệp không còn trên đĩa cục bộ: ${version.relPath}`
      );
      return { processed: true, jobId: job.id, success: false, reason: "blob_missing" };
    }

    // 4. Tạo download token (1-shot)
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHashHex = createHash("sha256").update(rawToken).digest("hex");

    await mintDownloadToken(deps.neonDb, {
      tokenHash: tokenHashHex,
      versionId: version.id,
      discordUserId: job.discordUserId,
      orderId: job.orderId,
      ttlMinutes: deps.tokenTtlMinutes,
    });

    const downloadUrl = `${deps.publicBaseUrl}/download/${rawToken}`;
    const filename = suggestFilename(pluginSlug, version.version, version.originalName);
    const useAttachment = version.bytes <= deps.attachMaxBytes;

    const label = `${pluginName} ${version.version ?? ""}`.trim();
    const minutes = deps.tokenTtlMinutes;

    const content = useAttachment
      ? `**${label}**\nTệp đính kèm bên dưới. Liên kết dự phòng (hết hạn sau ${minutes} phút): ${downloadUrl}`
      : `**${label}**\nTệp (${(version.bytes / (1024 * 1024)).toFixed(1)} MB) — tải qua liên kết sau (dùng một lần, hết hạn sau ${minutes} phút):\n${downloadUrl}`;

    // 5. Gửi file / link qua Discord DM
    let sentMessageId: string | undefined;
    try {
      const user = await deps.client.users.fetch(job.discordUserId);
      const sent = await user.send({
        content,
        files: useAttachment ? [new AttachmentBuilder(blobPath, { name: filename })] : [],
      });
      sentMessageId = sent.id;
    } catch (err) {
      if (
        err instanceof DiscordAPIError &&
        (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser ||
          err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds)
      ) {
        // DM bị khóa
        await markDeliveryJobFailed(deps.neonDb, job.id, claimToken, "dm_blocked");
        await updateOrderStatus(deps.neonDb, job.orderId, "underpaid" as any);
        return { processed: true, jobId: job.id, success: false, reason: "dm_blocked" };
      }

      // Lỗi tạm thời mạng / Discord API -> cho phép retry
      const errMsg = err instanceof Error ? err.message : String(err);
      await markDeliveryJobRetryable(deps.neonDb, job.id, claimToken, errMsg);
      return { processed: true, jobId: job.id, success: false, reason: errMsg };
    }

    // 6. Ghi nhận giao dịch thành công
    await markDeliveryJobSuccess(deps.neonDb, job.id, claimToken);

    // Ghi delivery_logs idempotent
    await createDeliveryLog(deps.neonDb, {
      orderId: job.orderId,
      discordUserId: job.discordUserId,
      versionId: job.versionId,
      pluginName,
      versionLabel: version.version ?? "",
      amount: 0,
      requestedMethod: job.requestedMethod,
      actualMethod: useAttachment ? "attachment" : "link",
      deliveryIdempotencyKey: `order_${job.orderId}_${job.requestedMethod}`,
      deliveredAt: new Date(),
    });

    // Cập nhật đơn hàng thành delivered
    await updateOrderStatus(deps.neonDb, job.orderId, "delivered");

    return { processed: true, jobId: job.id, success: true };
  } catch (unexpectedErr) {
    const msg = unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
    await markDeliveryJobRetryable(deps.neonDb, job.id, claimToken, `Lỗi không mong muốn: ${msg}`);
    return { processed: true, jobId: job.id, success: false, reason: msg };
  }
}
