import { AttachmentBuilder, DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { join, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { Db } from '../../db/connection.js';
import { now } from '../../db/connection.js';
import type { DeliveryMethod, DeliveryOutcome } from '../../domain/audit.js';
import { findVersionWithPlugin } from '../../repositories/versions.js';
import { mintDownloadToken } from './mint-download-token.js';

export type DeliveryDeps = {
  db: Db;
  client: Client;
  vaultDir: string;
  publicBaseUrl: string;
  attachMaxBytes: number;
  tokenTtlMinutes: number;
};

export type DeliveryRequest = {
  discordUserId: string;
  versionId: number;
  orderId?: number | null;
  amount?: number;
  /** Set for a manual release from the dashboard, which is audited differently. */
  manual?: boolean;
};

/**
 * Hands a version to a user and records it.
 *
 * Deliberately independent of any interaction: an interaction token is valid for
 * only 15 minutes and deferReply() does not extend that, so a payment flow that
 * can take longer must deliver over the bot token instead. That is why this is a
 * service the bot, the payment webhook, and the dashboard all call.
 *
 * Link delivery is the default. Discord's free-tier per-file cap is 10 MiB and a
 * DM gets no boost benefit — the limit follows the uploader (a bot, which has no
 * Nitro) and a DM channel belongs to no guild, so even a Level 3 server does not
 * raise it. Attachment is a convenience for small files only.
 */
export async function resolveBlobPath(vaultDir: string, relPath: string): Promise<string | null> {
  const canonicalVault = await realpath(vaultDir).catch(() => resolve(vaultDir));

  const candidates = [
    join(vaultDir, relPath),
    join(process.cwd(), vaultDir, relPath),
    join(process.cwd(), 'vault', relPath),
    join(process.cwd(), 'discord', vaultDir, relPath),
    join(process.cwd(), 'discord/vault', relPath),
  ];

  for (const candidate of candidates) {
    try {
      const realCandidate = await realpath(candidate);
      // Kiểm tra jail: File thực tế phải nằm trong canonicalVault
      if (realCandidate.startsWith(canonicalVault + sep) || realCandidate === canonicalVault) {
        return realCandidate;
      }
      console.warn(
        `[resolveBlobPath] Cảnh báo an ninh: Phát hiện đường dẫn/symlink thoát khỏi vault: candidate=${candidate}, real=${realCandidate}`
      );
      return null;
    } catch {
      // Candidate không tồn tại hoặc không thể resolve
      continue;
    }
  }

  return null;
}

export async function deliverVersion(deps: DeliveryDeps, request: DeliveryRequest): Promise<DeliveryOutcome> {
  const version = findVersionWithPlugin(deps.db, request.versionId);
  if (!version) return { ok: false, reason: 'error', message: 'Không tìm thấy phiên bản' };

  const blobPath = await resolveBlobPath(deps.vaultDir, version.relPath);
  if (!blobPath) {
    console.error(`[deliverVersion] Không tìm thấy file trên đĩa: relPath=${version.relPath}, vaultDir=${deps.vaultDir}`);
    return { ok: false, reason: 'error', message: 'Tệp không còn trong kho' };
  }

  const token = mintDownloadToken(deps.db, {
    versionId: version.id,
    discordUserId: request.discordUserId,
    orderId: request.orderId ?? null,
    ttlMinutes: deps.tokenTtlMinutes,
  });

  const label = `${version.pluginDisplayName} ${version.version ?? ''}`.trim();
  const filename = suggestFilename(version.pluginSlug, version.version, version.originalName);
  const useAttachment = version.bytes <= deps.attachMaxBytes;
  const method: DeliveryMethod = request.manual ? 'manual' : useAttachment ? 'attachment' : 'link';

  const downloadUrl = `${deps.publicBaseUrl}/download/${token.token}`;
  const minutes = deps.tokenTtlMinutes;

  const content = useAttachment
    ? `**${label}**\nTệp đính kèm bên dưới. Liên kết dự phòng (hết hạn sau ${minutes} phút): ${downloadUrl}`
    : `**${label}**\nTệp ${formatBytes(version.bytes)} — tải qua liên kết sau (dùng một lần, hết hạn sau ${minutes} phút):\n${downloadUrl}`;

  try {
    const user = await deps.client.users.fetch(request.discordUserId);
    await user.send({
      content,
      files: useAttachment ? [new AttachmentBuilder(blobPath, { name: filename })] : [],
    });
  } catch (err) {
    console.warn(`[deliverVersion] Không gửi được DM cho user ${request.discordUserId}:`, err);
    // Two distinct codes mean "cannot DM this user" and both return HTTP 403 with
    // the same message, so they cannot be told apart by text. Catching only the
    // first would let the second escape and a retry loop spin forever.
    if (
      err instanceof DiscordAPIError &&
      (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser ||
        err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds)
    ) {
      return {
        ok: false,
        reason: 'dm_blocked',
        downloadUrl,
        blobPath,
        filename,
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
      downloadUrl,
      blobPath,
      filename,
    };
  }

  recordDelivery(deps.db, {
    discordUserId: request.discordUserId,
    versionId: version.id,
    orderId: request.orderId ?? null,
    pluginName: version.pluginDisplayName,
    versionLabel: version.version ?? '',
    amount: request.amount ?? 0,
    method,
  });

  return { ok: true, method, downloadUrl, blobPath, filename };
}

export function recordDelivery(
  db: Db,
  entry: {
    discordUserId: string;
    versionId: number | null;
    orderId: number | null;
    pluginName: string;
    versionLabel: string;
    amount: number;
    method: DeliveryMethod;
    ip?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (discord_user_id, version_id, order_id, plugin_name, version_label,
                            amount, delivery_method, ip, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.discordUserId,
    entry.versionId,
    entry.orderId,
    entry.pluginName,
    entry.versionLabel,
    entry.amount,
    entry.method,
    entry.ip ?? null,
    now(),
  );
}

/**
 * Filename for the delivered jar. Prefers a clean slug-version name and falls
 * back to the original upload name.
 */
export function suggestFilename(slug: string, version: string | null, originalName: string): string {
  if (!version) return originalName;
  const extension = originalName.toLowerCase().endsWith('.zip') ? 'zip' : 'jar';
  const safeVersion = version.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safeVersion ? `${slug}-${safeVersion}.${extension}` : originalName;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
