import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';

/**
 * Which Spigot account owns which resource, learned from real downloads.
 *
 * The first sweep has to try accounts in turn to find out. Every sweep after
 * that goes straight to the account that worked, which matters for two reasons:
 * walking N accounts per plugin is slow, and a burst of 403s across several
 * accounts is the behaviour most likely to read as credential stuffing and get
 * the accounts locked.
 *
 * Keyed on the account *label* rather than an id because the credentials file is
 * hand-edited and has no stable numbering. Renaming a label simply re-learns on
 * the next sweep, which is cheaper than making the owner keep an id in sync.
 */

export type OwnershipState = 'owned' | 'not_owned';

export type OwnershipRow = {
  resourceId: number;
  accountLabel: string;
  state: OwnershipState;
  checkedAt: number;
};

type Row = { resource_id: number; account_label: string; state: string; checked_at: number };

const toRow = (r: Row): OwnershipRow => ({
  resourceId: r.resource_id,
  accountLabel: r.account_label,
  state: r.state as OwnershipState,
  checkedAt: r.checked_at,
});

/** Records a new ownership fact or semantic state transition. */
export function recordOwnership(
  db: Db,
  resourceId: number,
  accountLabel: string,
  state: OwnershipState,
): boolean {
  const checkedAt = now();
  const changed = db.prepare(
    `INSERT INTO resource_ownership (resource_id, account_label, state, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (resource_id, account_label)
     DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at
     WHERE resource_ownership.state <> excluded.state`,
  ).run(resourceId, accountLabel, state, checkedAt).changes > 0;

  if (!changed) {
    db.prepare(
      `UPDATE resource_ownership SET checked_at = ?
       WHERE resource_id = ? AND account_label = ?`,
    ).run(checkedAt, resourceId, accountLabel);
  }
  return changed;
}

/**
 * The account known to own this resource, or null if never learned.
 *
 * Ordered, not `LIMIT 1` on an unordered scan: several accounts commonly own the
 * same plugin, and without an ORDER BY SQLite is free to return either. That made
 * the sweep pick a different owner from one call to the next, so it logged in and
 * out repeatedly — 40 seconds each time — for downloads a single session could
 * have served. Most recently confirmed wins, since that is the session most
 * likely still valid.
 */
export function findOwner(db: Db, resourceId: number): string | null {
  const row = db
    .prepare(
      `SELECT account_label FROM resource_ownership
       WHERE resource_id = ? AND state = 'owned'
       ORDER BY checked_at DESC, account_label ASC
       LIMIT 1`,
    )
    .get(resourceId) as { account_label: string } | undefined;
  return row?.account_label ?? null;
}

/** Every account known to own this resource, most recently confirmed first. */
export function findOwners(db: Db, resourceId: number): string[] {
  const rows = db
    .prepare(
      `SELECT account_label FROM resource_ownership
       WHERE resource_id = ? AND state = 'owned'
       ORDER BY checked_at DESC, account_label ASC`,
    )
    .all(resourceId) as { account_label: string }[];
  return rows.map((r) => r.account_label);
}

/** Accounts already proven not to own this resource, so they can be skipped. */
export function findNonOwners(db: Db, resourceId: number): Set<string> {
  const rows = db
    .prepare("SELECT account_label FROM resource_ownership WHERE resource_id = ? AND state = 'not_owned'")
    .all(resourceId) as { account_label: string }[];
  return new Set(rows.map((r) => r.account_label));
}

/**
 * Orders accounts for one resource: known owner first, unknowns next, known
 * non-owners last.
 *
 * `prefer` names the account already signed in. When it also owns the resource it
 * goes first, because switching accounts costs a full logout plus login — around
 * 40 seconds and a Cloudflare challenge — while every account that owns the
 * plugin can serve the download equally well. Without this the sweep bounced
 * between two accounts that BOTH owned the plugin, paying that cost per download
 * and failing whenever a re-login hiccupped.
 *
 * Non-owners are ordered last rather than dropped. A plugin can be purchased
 * later, and a cache that could never be corrected would make that purchase
 * invisible forever — but they still go behind the unknowns so the common case
 * costs one request.
 */
export function orderAccountsFor<T extends { label: string }>(
  db: Db,
  resourceId: number,
  accounts: T[],
  prefer?: string | null,
): T[] {
  const owner = findOwner(db, resourceId);
  const owners = new Set(findOwners(db, resourceId));
  const nonOwners = findNonOwners(db, resourceId);

  const rank = (account: T): number => {
    // The live session, when it can serve this resource: no switch needed.
    if (prefer && account.label === prefer && owners.has(account.label)) return 0;
    if (account.label === owner) return 1;
    if (owners.has(account.label)) return 2;
    if (nonOwners.has(account.label)) return 4;
    return 3;
  };
  // Stable sort, so accounts of equal rank keep the order the owner listed them.
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/**
 * Forgets an account entirely.
 *
 * Called when a label disappears from the credentials file, so a renamed or
 * removed account cannot keep steering the ordering from stale rows.
 */
export function forgetAccount(db: Db, accountLabel: string): number {
  return db.prepare('DELETE FROM resource_ownership WHERE account_label = ?').run(accountLabel).changes;
}

/** Everything learned so far, for the dashboard and for tests. */
export function listOwnership(db: Db): OwnershipRow[] {
  const rows = db
    .prepare('SELECT * FROM resource_ownership ORDER BY resource_id ASC, account_label ASC')
    .all() as Row[];
  return rows.map(toRow);
}

export type OwnedPluginInfo = {
  id: number;
  slug: string;
  displayName: string;
  resourceId: number;
  isPremium: boolean;
  state: OwnershipState;
  checkedAt: number;
};

/**
 * Returns plugins in the database that are confirmed as owned by a specific account.
 */
export function listAccountOwnedPlugins(db: Db, accountLabel: string): OwnedPluginInfo[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.display_name, p.is_premium, ro.resource_id, ro.state, ro.checked_at
       FROM resource_ownership ro
       JOIN plugins p ON p.resource_id = ro.resource_id
       WHERE ro.account_label = ? AND ro.state = 'owned'
       ORDER BY p.display_name ASC`,
    )
    .all(accountLabel) as {
      id: number;
      slug: string;
      display_name: string;
      is_premium: number;
      resource_id: number;
      state: string;
      checked_at: number;
    }[];

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    resourceId: r.resource_id,
    isPremium: Boolean(r.is_premium),
    state: r.state as OwnershipState,
    checkedAt: r.checked_at,
  }));
}

export type PluginOwnershipMap = {
  pluginId: number;
  slug: string;
  displayName: string;
  resourceId: number;
  owners: string[];
};

/**
 * Lists all plugins with resource_id and their currently assigned owning accounts.
 */
export function listAllPluginOwnerships(db: Db): PluginOwnershipMap[] {
  const rows = db
    .prepare(
      `SELECT p.id as plugin_id, p.slug, p.display_name, p.resource_id, ro.account_label
       FROM plugins p
       LEFT JOIN resource_ownership ro ON ro.resource_id = p.resource_id AND ro.state = 'owned'
       WHERE p.resource_id IS NOT NULL
       ORDER BY p.display_name ASC, ro.account_label ASC`,
    )
    .all() as {
      plugin_id: number;
      slug: string;
      display_name: string;
      resource_id: number;
      account_label: string | null;
    }[];

  const map = new Map<number, PluginOwnershipMap>();
  for (const row of rows) {
    let existing = map.get(row.plugin_id);
    if (!existing) {
      existing = {
        pluginId: row.plugin_id,
        slug: row.slug,
        displayName: row.display_name,
        resourceId: row.resource_id,
        owners: [],
      };
      map.set(row.plugin_id, existing);
    }
    if (row.account_label) {
      existing.owners.push(row.account_label);
    }
  }
  return Array.from(map.values());
}

/**
 * Manually assigns a plugin resource_id to an account as owned.
 */
export function assignPluginOwnership(db: Db, resourceId: number, accountLabel: string): boolean {
  return recordOwnership(db, resourceId, accountLabel, 'owned');
}

/**
 * Removes the ownership link between a resource_id and an account.
 */
export function removePluginOwnership(db: Db, resourceId: number, accountLabel: string): boolean {
  return (
    db
      .prepare('DELETE FROM resource_ownership WHERE resource_id = ? AND account_label = ?')
      .run(resourceId, accountLabel).changes > 0
  );
}

/**
 * Finds plugins in the vault that have a resource_id but no confirmed owning account.
 */
export function findUnassignedPlugins(
  db: Db,
): { id: number; slug: string; displayName: string; resourceId: number }[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.display_name, p.resource_id
       FROM plugins p
       WHERE p.resource_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM resource_ownership ro
           WHERE ro.resource_id = p.resource_id AND ro.state = 'owned'
         )
       ORDER BY p.display_name ASC`,
    )
    .all() as { id: number; slug: string; display_name: string; resource_id: number }[];

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    resourceId: r.resource_id,
  }));
}

