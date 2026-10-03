import type BetterSqlite3 from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { plugins, versions, spigotAccounts, resourceOwnership } from '@vault/db';
import type { Database } from '../db/neon.js';

export async function autoSyncSqliteToNeonIfEmpty(
  sqlite: BetterSqlite3.Database,
  neonDb: Database,
): Promise<number> {
  try {
    const existing = await neonDb
      .select({ count: sql<number>`count(*)::int` })
      .from(plugins);
    const count = existing[0]?.count ?? 0;

    if (count > 0) {
      return 0; // Đã có dữ liệu trong Neon, không cần sync tự động
    }

    const sqlitePlugins = sqlite.prepare('SELECT * FROM plugins ORDER BY id ASC').all() as any[];
    if (sqlitePlugins.length === 0) {
      return 0;
    }

    console.log(`[NeonSync] Neon database trống. Tự động đồng bộ ${sqlitePlugins.length} plugin từ SQLite...`);

    const sqliteAliases = sqlite.prepare('SELECT * FROM plugin_aliases').all() as any[];
    const aliasMap = new Map<number, string[]>();
    for (const a of sqliteAliases) {
      const list = aliasMap.get(a.plugin_id) || [];
      list.push(a.alias);
      aliasMap.set(a.plugin_id, list);
    }

    // 1. Sync plugins
    for (const p of sqlitePlugins) {
      const aliases = aliasMap.get(p.id) || [];
      const pluginId = p.slug || String(p.resource_id) || String(p.id);
      const createdAt = p.created_at ? new Date(p.created_at * 1000) : new Date();

      await neonDb
        .insert(plugins)
        .values({
          id: p.id,
          pluginId,
          slug: p.slug,
          displayName: p.display_name,
          descriptorName: p.descriptor_name,
          aliases,
          platform: p.platform || 'spigot',
          resourceId: p.resource_id,
          depositPrice: p.deposit_price || 0,
          isPremium: Boolean(p.is_premium),
          description: p.description || '',
          spigotLink: p.external_link || '',
          createdAt,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    // 2. Sync versions
    const sqliteVersions = sqlite.prepare('SELECT * FROM versions ORDER BY id ASC').all() as any[];
    for (const v of sqliteVersions) {
      const uploadedAt = v.uploaded_at ? new Date(v.uploaded_at * 1000) : new Date();
      await neonDb
        .insert(versions)
        .values({
          id: v.id,
          pluginId: v.plugin_id,
          version: v.version,
          rawVersion: v.raw_version,
          sha256: v.sha256,
          relPath: v.rel_path,
          bytes: v.bytes,
          originalName: v.original_name,
          descriptorKind: v.descriptor_kind || 'spigot',
          isStable: Boolean(v.is_stable),
          versionFlag: v.version_flag || 'ok',
          changeLogs: '',
          source: 'spigot_auto',
          uploadedAt,
        })
        .onConflictDoNothing();
    }

    // 3. Sync spigot_accounts
    const sqliteAccounts = sqlite.prepare('SELECT * FROM spigot_accounts ORDER BY id ASC').all() as any[];
    for (const a of sqliteAccounts) {
      const createdAt = a.created_at ? new Date(a.created_at * 1000) : new Date();
      const lastVerified = a.last_verified_at ? new Date(a.last_verified_at) : null;
      await neonDb
        .insert(spigotAccounts)
        .values({
          id: a.id,
          label: a.label,
          username: a.username,
          passwordEncrypted: a.password_encrypted,
          xfUserEncrypted: a.xf_user_encrypted || '',
          xfSessionEncrypted: a.xf_session_encrypted || '',
          status: a.status || 'ok',
          isEnabled: Boolean(a.is_enabled),
          lastVerifiedAt: lastVerified,
          createdAt,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    // 4. Sync resource_ownership
    const sqliteOwnership = sqlite.prepare('SELECT * FROM resource_ownership').all() as any[];
    for (const o of sqliteOwnership) {
      const checkedAt = o.checked_at ? new Date(o.checked_at * 1000) : new Date();
      await neonDb
        .insert(resourceOwnership)
        .values({
          resourceId: o.resource_id,
          accountLabel: o.account_label,
          state: o.state,
          checkedAt,
        })
        .onConflictDoNothing();
    }

    // 5. Reset sequences
    await neonDb.execute(sql`SELECT setval('plugins_id_seq', COALESCE((SELECT MAX(id) FROM plugins), 1));`);
    await neonDb.execute(sql`SELECT setval('versions_id_seq', COALESCE((SELECT MAX(id) FROM versions), 1));`);
    await neonDb.execute(sql`SELECT setval('spigot_accounts_id_seq', COALESCE((SELECT MAX(id) FROM spigot_accounts), 1));`);

    console.log(`[NeonSync] ✅ Đã tự động đồng bộ ${sqlitePlugins.length} plugin và ${sqliteVersions.length} phiên bản sang Neon PostgreSQL!`);
    return sqlitePlugins.length;
  } catch (err) {
    console.warn('[NeonSync] Lỗi trong quá trình tự động đồng bộ SQLite -> Neon:', err);
    return 0;
  }
}
