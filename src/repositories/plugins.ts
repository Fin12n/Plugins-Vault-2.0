import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toPlugin, toSqlBool, type PluginRow } from '../db/row-mappers.js';
import type { Plugin, PluginPlatform } from '../domain/plugin.js';

export type CreatePluginInput = {
  slug: string;
  displayName: string;
  descriptorName: string;
  platform: PluginPlatform;
  resourceId?: number | null;
  depositPrice?: number;
  isPremium?: boolean;
  description?: string;
  externalLink?: string;
};

const SELECT = 'SELECT * FROM plugins';

export function findPluginById(db: Db, id: number): Plugin | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PluginRow | undefined;
  return row ? toPlugin(row) : null;
}

export function findPluginBySlug(db: Db, slug: string): Plugin | null {
  const row = db.prepare(`${SELECT} WHERE slug = ?`).get(slug) as PluginRow | undefined;
  return row ? toPlugin(row) : null;
}

/**
 * Resolves a descriptor name to a plugin, checking the alias table too.
 *
 * Aliases are exact-match rows rather than a delimited column so that an alias
 * of "Core" cannot swallow a jar whose descriptor name is "CoreProtect".
 */
export function findPluginByDescriptorName(db: Db, descriptorName: string): Plugin | null {
  const direct = db.prepare(`${SELECT} WHERE descriptor_name = ?`).get(descriptorName) as PluginRow | undefined;
  if (direct) return toPlugin(direct);

  const viaAlias = db
    .prepare(`${SELECT} WHERE id = (SELECT plugin_id FROM plugin_aliases WHERE alias = ?)`)
    .get(descriptorName) as PluginRow | undefined;
  return viaAlias ? toPlugin(viaAlias) : null;
}

export function createPlugin(db: Db, input: CreatePluginInput): Plugin {
  const info = db
    .prepare(
      `INSERT INTO plugins (slug, display_name, descriptor_name, platform, resource_id, deposit_price, is_premium, description, external_link, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.slug,
      input.displayName,
      input.descriptorName,
      input.platform,
      input.resourceId ?? null,
      input.depositPrice ?? 0,
      toSqlBool(input.isPremium ?? false),
      input.description ?? '',
      input.externalLink ?? '',
      now(),
    );

  const created = findPluginById(db, Number(info.lastInsertRowid));
  if (!created) throw new Error('Không tạo được plugin');
  return created;
}

export function addAlias(db: Db, pluginId: number, alias: string): void {
  db.prepare('INSERT OR IGNORE INTO plugin_aliases (plugin_id, alias) VALUES (?, ?)').run(pluginId, alias);
}

export function listAliases(db: Db, pluginId: number): string[] {
  const rows = db.prepare('SELECT alias FROM plugin_aliases WHERE plugin_id = ? ORDER BY alias').all(pluginId) as {
    alias: string;
  }[];
  return rows.map((r) => r.alias);
}

export function countPlugins(db: Db, search?: string): number {
  if (search) {
    const row = db
      .prepare('SELECT count(*) AS c FROM plugins WHERE display_name LIKE ? OR slug LIKE ?')
      .get(`%${search}%`, `%${search}%`) as { c: number };
    return row.c;
  }
  return (db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c;
}

export function listPlugins(db: Db, limit: number, offset: number, search?: string): Plugin[] {
  const rows = search
    ? (db
        .prepare(`${SELECT} WHERE display_name LIKE ? OR slug LIKE ? ORDER BY display_name LIMIT ? OFFSET ?`)
        .all(`%${search}%`, `%${search}%`, limit, offset) as PluginRow[])
    : (db.prepare(`${SELECT} ORDER BY display_name LIMIT ? OFFSET ?`).all(limit, offset) as PluginRow[]);
  return rows.map(toPlugin);
}

export type UpdatePluginInput = Partial<{
  displayName: string;
  resourceId: number | null;
  depositPrice: number;
  isPremium: boolean;
  description: string;
  externalLink: string;
}>;

export function updatePlugin(db: Db, id: number, patch: UpdatePluginInput): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (patch.resourceId !== undefined) {
    sets.push('resource_id = ?');
    values.push(patch.resourceId);
  }
  if (patch.depositPrice !== undefined) {
    sets.push('deposit_price = ?');
    values.push(patch.depositPrice);
  }
  if (patch.isPremium !== undefined) {
    sets.push('is_premium = ?');
    values.push(toSqlBool(patch.isPremium));
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.externalLink !== undefined) {
    sets.push('external_link = ?');
    values.push(patch.externalLink);
  }
  if (sets.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE plugins SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deletePlugin(db: Db, id: number): void {
  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
}

export type BulkPriceMode = 'set' | 'add_fixed' | 'multiply_percent';

export type BulkPriceInput = {
  ids?: number[];
  allMatching?: boolean;
  query?: string;
  mode: BulkPriceMode;
  value: number;
};

export function bulkUpdatePluginPrices(db: Db, input: BulkPriceInput): number {
  return db.transaction((): number => {
    let targetIds: number[] = [];
    if (input.allMatching) {
      if (input.query && input.query.trim()) {
        const rows = db
          .prepare('SELECT id FROM plugins WHERE display_name LIKE ?')
          .all(`%${input.query.trim()}%`) as { id: number }[];
        targetIds = rows.map((r) => r.id);
      } else {
        const rows = db.prepare('SELECT id FROM plugins').all() as { id: number }[];
        targetIds = rows.map((r) => r.id);
      }
    } else if (input.ids && input.ids.length > 0) {
      targetIds = input.ids;
    }

    if (targetIds.length === 0) return 0;

    let totalUpdated = 0;
    const chunkSize = 500;
    for (let i = 0; i < targetIds.length; i += chunkSize) {
      const chunk = targetIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      let sql = '';
      const params: (number | string)[] = [];

      if (input.mode === 'set') {
        const newPrice = Math.max(0, Math.floor(input.value));
        sql = `UPDATE plugins SET deposit_price = ? WHERE id IN (${placeholders})`;
        params.push(newPrice, ...chunk);
      } else if (input.mode === 'add_fixed') {
        const delta = Math.floor(input.value);
        sql = `UPDATE plugins SET deposit_price = max(0, deposit_price + ?) WHERE id IN (${placeholders})`;
        params.push(delta, ...chunk);
      } else if (input.mode === 'multiply_percent') {
        const factor = 1 + input.value / 100.0;
        sql = `UPDATE plugins SET deposit_price = max(0, cast(round(deposit_price * ? / 1000.0) * 1000 as integer)) WHERE id IN (${placeholders})`;
        params.push(factor, ...chunk);
      }

      if (sql) {
        const res = db.prepare(sql).run(...params);
        totalUpdated += res.changes;
      }
    }

    return totalUpdated;
  })();
}

