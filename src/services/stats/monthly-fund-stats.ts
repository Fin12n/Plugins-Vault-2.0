import type { Db } from '../../db/connection.js';
import type { AuditEntry, MonthlyFundStats } from '../../domain/audit.js';
import { toAuditEntry, type AuditRow } from '../../db/row-mappers.js';
import type { Paginated } from '../../domain/plugin.js';

/**
 * Monthly totals come from audit_log rather than orders.
 *
 * The audit log records what was actually delivered, which is what the party fund
 * is owed on; an order that was paid but never delivered should not count, and an
 * order row can be superseded while its audit row is immutable.
 */
export function monthlyFundStats(db: Db, month: string): MonthlyFundStats {
  const bounds = monthBounds(month);

  const totals = db
    .prepare(
      `SELECT count(*) AS downloads, coalesce(sum(amount), 0) AS amount
         FROM audit_log WHERE delivered_at >= ? AND delivered_at < ?`,
    )
    .get(bounds.from, bounds.to) as { downloads: number; amount: number };

  const perPlugin = db
    .prepare(
      `SELECT plugin_name AS pluginName, count(*) AS downloads, coalesce(sum(amount), 0) AS amount
         FROM audit_log WHERE delivered_at >= ? AND delivered_at < ?
        GROUP BY plugin_name ORDER BY amount DESC, downloads DESC`,
    )
    .all(bounds.from, bounds.to) as MonthlyFundStats['perPlugin'];

  const perUser = db
    .prepare(
      `SELECT discord_user_id AS discordUserId, count(*) AS downloads, coalesce(sum(amount), 0) AS amount
         FROM audit_log WHERE delivered_at >= ? AND delivered_at < ?
        GROUP BY discord_user_id ORDER BY amount DESC, downloads DESC`,
    )
    .all(bounds.from, bounds.to) as MonthlyFundStats['perUser'];

  return {
    month,
    totalDownloads: totals.downloads,
    totalAmount: totals.amount,
    perPlugin,
    perUser,
  };
}

/**
 * Unix-second bounds for a "YYYY-MM" string, half-open [from, to).
 *
 * Computed in UTC deliberately: a month boundary that shifts with the server's
 * timezone would move rows between months on a restart in a different locale.
 */
export function monthBounds(month: string): { from: number; to: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Tháng không hợp lệ: ${month}`);

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`Tháng không hợp lệ: ${month}`);

  const from = Date.UTC(year, monthIndex, 1) / 1000;
  const to = Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1) / 1000;
  return { from, to };
}

export type AuditFilter = { month?: string; discordUserId?: string };

/** Paginated delivery log, newest first. */
export function listAuditLog(
  db: Db,
  filter: AuditFilter,
  page: number,
  pageSize: number,
): Paginated<AuditEntry> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.month) {
    const bounds = monthBounds(filter.month);
    where.push('delivered_at >= ? AND delivered_at < ?');
    params.push(bounds.from, bounds.to);
  }
  if (filter.discordUserId) {
    where.push('discord_user_id = ?');
    params.push(filter.discordUserId);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT count(*) AS c FROM audit_log ${clause}`).get(...params) as { c: number }).c;

  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY delivered_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as AuditRow[];

  return {
    items: rows.map(toAuditEntry),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
