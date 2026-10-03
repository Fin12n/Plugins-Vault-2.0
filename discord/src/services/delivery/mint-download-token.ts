import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db/connection.js';
import { now } from '../../db/connection.js';

export type MintedToken = { token: string; expiresAt: number };

/**
 * One-shot expiring download token.
 *
 * An opaque random token with a hashed row rather than a signed JWT: a JWT is
 * stateless and therefore cannot express "already consumed", so single-use needs a
 * server-side record regardless — at which point the JWT adds size and
 * alg-confusion risk for nothing.
 *
 * Only the digest is stored, so a database leak does not yield usable links.
 */
export function mintDownloadToken(
  db: Db,
  input: { versionId: number; discordUserId: string; orderId?: number | null; ttlMinutes: number },
): MintedToken {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now() + input.ttlMinutes * 60;

  db.prepare(
    `INSERT INTO download_tokens (token_hash, version_id, discord_user_id, order_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), input.versionId, input.discordUserId, input.orderId ?? null, expiresAt, now());

  return { token, expiresAt };
}

/** Raw digest bytes, not hex — the column is a BLOB. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export type RedeemedToken = { versionId: number; discordUserId: string; orderId: number | null };

/**
 * Consumes a token, returning what it grants access to.
 *
 * A single UPDATE guarded on `used_at IS NULL` makes redemption atomic, so two
 * concurrent requests cannot both win. Returns null for unknown, already-used,
 * and expired alike — distinguishing them would let an attacker enumerate valid
 * tokens.
 */
export function redeemDownloadToken(db: Db, token: string): RedeemedToken | null {
  const current = now();
  const row = db
    .prepare(
      `UPDATE download_tokens SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING version_id, discord_user_id, order_id`,
    )
    .get(current, hashToken(token), current) as
    | { version_id: number; discord_user_id: string; order_id: number | null }
    | undefined;

  if (!row) return null;
  return { versionId: row.version_id, discordUserId: row.discord_user_id, orderId: row.order_id };
}

/** Removes expired rows. Called by the maintenance scheduler. */
export function sweepExpiredTokens(db: Db): number {
  return db.prepare('DELETE FROM download_tokens WHERE expires_at <= ?').run(now()).changes;
}

/**
 * Vô hiệu hoá mọi liên kết tải chưa dùng của một đơn.
 *
 * Cần cho đường hoàn coin. Một đơn `dm_blocked` VẪN giữ liên kết tải còn hiệu lực —
 * cố ý như vậy, vì Discord từng báo lỗi 50007 dù tin nhắn đã tới, nên thu hồi ngay có
 * thể chặn oan người đã nhận được. Nhưng khi chủ kho hoàn coin thì họ nói "đơn này bỏ
 * đi": trả lại tiền mà vẫn để liên kết sống là tặng không tệp jar.
 *
 * Chỉ xoá liên kết CHƯA dùng: một liên kết đã tải xong là một lần giao đã ghi vào sổ,
 * và xoá nó chỉ làm mất dấu vết.
 *
 * Trả về số liên kết đã thu hồi, để chỗ gọi nói được điều đó cho người dùng.
 */
export function revokeOrderTokens(db: Db, orderId: number): number {
  return db.prepare('DELETE FROM download_tokens WHERE order_id = ? AND used_at IS NULL').run(orderId).changes;
}

/** Liên kết đã dùng của một đơn, để giao diện nói được "khách đã tải rồi". */
export function findUsedOrderToken(db: Db, orderId: number): { usedAt: number } | null {
  const row = db
    .prepare('SELECT used_at FROM download_tokens WHERE order_id = ? AND used_at IS NOT NULL ORDER BY used_at DESC')
    .get(orderId) as { used_at: number } | undefined;
  return row ? { usedAt: row.used_at } : null;
}

/**
 * Constant-time digest comparison. Both inputs are always 32-byte sha256 digests,
 * which matters because timingSafeEqual throws on a length mismatch.
 */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
