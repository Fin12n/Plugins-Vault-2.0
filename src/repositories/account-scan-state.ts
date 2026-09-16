import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';

/**
 * Lần cuối quét danh sách "đã mua" của từng tài khoản Spigot.
 *
 * Tồn tại vì quét tốn thời gian thật: mỗi tài khoản mất khoảng 45 giây cho
 * Cloudflare, đăng nhập, đọc trang và nghỉ giữa hai tài khoản. Với 100 tài khoản
 * thì một lượt quét mất hơn một giờ — dài hơn cả chu kỳ quét — và nó chặn luôn
 * việc tải jar, tức là tính năng chính không bao giờ chạy tới.
 *
 * Danh sách plugin đã mua gần như không đổi (chỉ đổi khi chủ bot mua thêm), nên
 * quét lại mỗi giờ là vô nghĩa. Mỗi ngày một lần cho mỗi tài khoản là đủ, và việc
 * tải vẫn chạy mỗi giờ như trước.
 */

export type AccountScanState = {
  accountLabel: string;
  lastScanAt: number;
  resourceCount: number;
  lastError: string;
};

type Row = {
  account_label: string;
  last_scan_at: number;
  resource_count: number;
  last_error: string;
};

const toState = (r: Row): AccountScanState => ({
  accountLabel: r.account_label,
  lastScanAt: r.last_scan_at,
  resourceCount: r.resource_count,
  lastError: r.last_error,
});

/**
 * Ghi lại một lần quét, thành công hay thất bại.
 *
 * `retryAfterMs` làm ngắn thời gian chờ cho lần thất bại. Ghi lần lỗi là cần
 * thiết — không ghi thì tài khoản lỗi được thử mỗi giờ và chiếm suất của tài
 * khoản chưa quét bao giờ. Nhưng ghi nó y như một lần thành công thì một lần
 * đăng nhập trượt sẽ khoá tài khoản đó suốt 24 giờ, kể cả khi nguyên nhân đã
 * được sửa ngay sau đó. Mốc thời gian được lùi lại để hạn chờ còn đúng
 * `retryAfterMs`.
 */
export function recordScan(
  db: Db,
  accountLabel: string,
  resourceCount: number,
  lastError = '',
  options: { retryAfterMs?: number; intervalMs?: number } = {},
): void {
  let scannedAt = now();

  if (lastError !== '' && options.retryAfterMs !== undefined && options.intervalMs !== undefined) {
    // Backdated so the normal interval check lets this account through again after
    // retryAfterMs rather than a full interval.
    const shortfall = Math.floor((options.intervalMs - options.retryAfterMs) / 1000);
    if (shortfall > 0) scannedAt -= shortfall;
  }

  db.prepare(
    `INSERT INTO account_scan_state (account_label, last_scan_at, resource_count, last_error)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_label) DO UPDATE SET
       last_scan_at = excluded.last_scan_at,
       resource_count = excluded.resource_count,
       last_error = excluded.last_error`,
  ).run(accountLabel, scannedAt, resourceCount, lastError);
}

export function findScanState(db: Db, accountLabel: string): AccountScanState | null {
  const row = db.prepare('SELECT * FROM account_scan_state WHERE account_label = ?').get(accountLabel) as
    | Row
    | undefined;
  return row ? toState(row) : null;
}

/** Reuses the persisted scan retry timestamp as the account browser cooldown. */
export function findScanRetry(
  db: Db,
  accountLabel: string,
  intervalMs: number,
  nowMs = Date.now(),
): { reason: string; retryAt: number; remainingMs: number } | null {
  const state = findScanState(db, accountLabel);
  if (!state || state.lastError === '') return null;

  const retryAt = state.lastScanAt * 1000 + intervalMs;
  const remainingMs = retryAt - nowMs;
  return remainingMs > 0 ? { reason: state.lastError, retryAt, remainingMs } : null;
}

/** A successful login removes only the retry gate, preserving scan history. */
export function clearScanError(db: Db, accountLabel: string): void {
  db.prepare('UPDATE account_scan_state SET last_error = ? WHERE account_label = ?').run('', accountLabel);
}

/**
 * Các tài khoản đến hạn quét lại.
 *
 * Tài khoản chưa từng quét luôn đến hạn, nên lần chạy đầu vẫn học được đầy đủ.
 * Có giới hạn số lượng mỗi lượt: 100 tài khoản đến hạn cùng lúc mà quét hết trong
 * một lượt thì lại đúng vấn đề đang tránh, nên phần còn lại để lượt sau.
 *
 * Ưu tiên tài khoản lâu chưa quét nhất, để mọi tài khoản đều được luân phiên thay
 * vì vài tài khoản đầu danh sách chiếm hết suất.
 */
export function selectAccountsDueForScan<T extends { label: string }>(
  db: Db,
  accounts: T[],
  intervalMs: number,
  limit: number,
): T[] {
  const cutoff = now() - Math.floor(intervalMs / 1000);

  const withTime = accounts.map((account) => {
    const state = findScanState(db, account.label);
    return { account, lastScanAt: state?.lastScanAt ?? null };
  });

  const due = withTime.filter((entry) => entry.lastScanAt === null || entry.lastScanAt <= cutoff);

  // Chưa quét bao giờ thì lên trước; còn lại theo thứ tự lâu nhất trước.
  due.sort((a, b) => {
    if (a.lastScanAt === null && b.lastScanAt === null) return 0;
    if (a.lastScanAt === null) return -1;
    if (b.lastScanAt === null) return 1;
    return a.lastScanAt - b.lastScanAt;
  });

  return due.slice(0, limit).map((entry) => entry.account);
}

/** Xoá trạng thái của tài khoản đã bị bỏ khỏi tệp, để bảng không phình mãi. */
export function forgetScanState(db: Db, accountLabel: string): number {
  return db.prepare('DELETE FROM account_scan_state WHERE account_label = ?').run(accountLabel).changes;
}

export function listScanStates(db: Db): AccountScanState[] {
  const rows = db.prepare('SELECT * FROM account_scan_state ORDER BY account_label').all() as Row[];
  return rows.map(toState);
}
