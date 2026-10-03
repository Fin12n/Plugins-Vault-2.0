import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';

export type DashboardStaffRow = {
  discord_user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  added_by: string;
  created_at: number;
};

export type DashboardStaff = {
  discordUserId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  addedBy: string;
  createdAt: number;
};

export function toDashboardStaff(row: DashboardStaffRow): DashboardStaff {
  return {
    discordUserId: row.discord_user_id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
}

export function listStaff(db: Db): DashboardStaff[] {
  const rows = db
    .prepare('SELECT * FROM dashboard_staff ORDER BY created_at ASC')
    .all() as DashboardStaffRow[];
  return rows.map(toDashboardStaff);
}

export function findStaffById(db: Db, discordUserId: string): DashboardStaff | null {
  const row = db
    .prepare('SELECT * FROM dashboard_staff WHERE discord_user_id = ?')
    .get(discordUserId) as DashboardStaffRow | undefined;
  return row ? toDashboardStaff(row) : null;
}

export function addStaff(
  db: Db,
  staff: {
    discordUserId: string;
    username: string;
    displayName: string;
    avatar?: string | null;
    addedBy: string;
  },
): DashboardStaff {
  const createdAt = now();
  db.prepare(
    `INSERT INTO dashboard_staff (discord_user_id, username, display_name, avatar, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar = excluded.avatar`,
  ).run(
    staff.discordUserId,
    staff.username,
    staff.displayName,
    staff.avatar ?? null,
    staff.addedBy,
    createdAt,
  );
  return findStaffById(db, staff.discordUserId)!;
}

export function removeStaff(db: Db, discordUserId: string): boolean {
  const res = db.prepare('DELETE FROM dashboard_staff WHERE discord_user_id = ?').run(discordUserId);
  return res.changes > 0;
}

export function isUserAuthorizedStaff(db: Db, discordUserId: string): boolean {
  return findStaffById(db, discordUserId) !== null;
}
