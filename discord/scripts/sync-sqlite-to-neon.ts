import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import path from 'node:path';
import fs from 'node:fs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in environment!');
  process.exit(1);
}

const sqlitePath = path.resolve(process.env.DB_PATH || './data/vault.db');
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found at ${sqlitePath}`);
  process.exit(1);
}

console.log(`[Sync] Reading from SQLite: ${sqlitePath}`);
console.log(`[Sync] Target Neon PostgreSQL: ${databaseUrl.replace(/:[^:@]+@/, ':***@')}`);

const sqlite = new Database(sqlitePath, { readonly: true });
const sql = neon(databaseUrl);

async function sync() {
  console.log('[Sync] Starting SQLite -> Neon PostgreSQL data synchronization...');

  // 1. Sync plugins
  const sqlitePlugins = sqlite.prepare('SELECT * FROM plugins ORDER BY id ASC').all() as any[];
  const sqliteAliases = sqlite.prepare('SELECT * FROM plugin_aliases').all() as any[];

  const aliasMap = new Map<number, string[]>();
  for (const a of sqliteAliases) {
    const list = aliasMap.get(a.plugin_id) || [];
    list.push(a.alias);
    aliasMap.set(a.plugin_id, list);
  }

  console.log(`[Sync] Found ${sqlitePlugins.length} plugins in SQLite.`);

  for (const p of sqlitePlugins) {
    const aliases = aliasMap.get(p.id) || [];
    const pluginId = p.slug || String(p.resource_id) || String(p.id);
    const createdAt = p.created_at ? new Date(p.created_at * 1000).toISOString() : new Date().toISOString();
    const updatedAt = new Date().toISOString();

    await sql`
      INSERT INTO plugins (
        id, plugin_id, slug, display_name, descriptor_name, aliases, platform,
        resource_id, deposit_price, is_premium, description, spigot_link, created_at, updated_at
      ) VALUES (
        ${p.id}, ${pluginId}, ${p.slug}, ${p.display_name}, ${p.descriptor_name},
        ${aliases}, ${p.platform || 'spigot'}, ${p.resource_id}, ${p.deposit_price || 0},
        ${Boolean(p.is_premium)}, ${p.description || ''}, ${p.external_link || ''},
        ${createdAt}, ${updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        plugin_id = EXCLUDED.plugin_id,
        slug = EXCLUDED.slug,
        display_name = EXCLUDED.display_name,
        descriptor_name = EXCLUDED.descriptor_name,
        aliases = EXCLUDED.aliases,
        platform = EXCLUDED.platform,
        resource_id = EXCLUDED.resource_id,
        deposit_price = EXCLUDED.deposit_price,
        is_premium = EXCLUDED.is_premium,
        description = EXCLUDED.description,
        spigot_link = EXCLUDED.spigot_link,
        updated_at = EXCLUDED.updated_at;
    `;
    console.log(`  + Plugin [${p.id}]: ${p.display_name} (${aliases.length} aliases)`);
  }

  // 2. Sync versions
  const sqliteVersions = sqlite.prepare('SELECT * FROM versions ORDER BY id ASC').all() as any[];
  console.log(`[Sync] Found ${sqliteVersions.length} versions in SQLite.`);

  for (const v of sqliteVersions) {
    const uploadedAt = v.uploaded_at ? new Date(v.uploaded_at * 1000).toISOString() : new Date().toISOString();

    await sql`
      INSERT INTO versions (
        id, plugin_id, version, raw_version, sha256, rel_path, bytes,
        original_name, descriptor_kind, is_stable, version_flag, change_logs, source, uploaded_at
      ) VALUES (
        ${v.id}, ${v.plugin_id}, ${v.version}, ${v.raw_version}, ${v.sha256}, ${v.rel_path}, ${v.bytes},
        ${v.original_name}, ${v.descriptor_kind || 'spigot'}, ${Boolean(v.is_stable)}, ${v.version_flag || 'ok'},
        ${''}, ${'spigot_auto'}, ${uploadedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        plugin_id = EXCLUDED.plugin_id,
        version = EXCLUDED.version,
        raw_version = EXCLUDED.raw_version,
        sha256 = EXCLUDED.sha256,
        rel_path = EXCLUDED.rel_path,
        bytes = EXCLUDED.bytes,
        original_name = EXCLUDED.original_name,
        descriptor_kind = EXCLUDED.descriptor_kind,
        is_stable = EXCLUDED.is_stable,
        version_flag = EXCLUDED.version_flag,
        uploaded_at = EXCLUDED.uploaded_at;
    `;
    console.log(`  + Version [${v.id}]: plugin ${v.plugin_id} -> ${v.original_name} (v${v.version})`);
  }

  // 3. Sync spigot_accounts
  const sqliteAccounts = sqlite.prepare('SELECT * FROM spigot_accounts ORDER BY id ASC').all() as any[];
  console.log(`[Sync] Found ${sqliteAccounts.length} spigot accounts in SQLite.`);
  for (const a of sqliteAccounts) {
    const createdAt = a.created_at ? new Date(a.created_at * 1000).toISOString() : new Date().toISOString();
    const updatedAt = a.updated_at ? new Date(a.updated_at * 1000).toISOString() : new Date().toISOString();
    const lastVerified = a.last_verified_at ? new Date(a.last_verified_at).toISOString() : null;

    await sql`
      INSERT INTO spigot_accounts (
        id, label, username, password_encrypted, xf_user_encrypted, xf_session_encrypted,
        status, is_enabled, last_verified_at, created_at, updated_at
      ) VALUES (
        ${a.id}, ${a.label}, ${a.username}, ${a.password_encrypted},
        ${a.xf_user_encrypted || ''}, ${a.xf_session_encrypted || ''},
        ${a.status || 'ok'}, ${Boolean(a.is_enabled)}, ${lastVerified},
        ${createdAt}, ${updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label,
        username = EXCLUDED.username,
        password_encrypted = EXCLUDED.password_encrypted,
        xf_user_encrypted = EXCLUDED.xf_user_encrypted,
        xf_session_encrypted = EXCLUDED.xf_session_encrypted,
        status = EXCLUDED.status,
        is_enabled = EXCLUDED.is_enabled,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = EXCLUDED.updated_at;
    `;
    console.log(`  + Account [${a.id}]: ${a.label}`);
  }

  // 4. Sync resource_ownership
  const sqliteOwnership = sqlite.prepare('SELECT * FROM resource_ownership').all() as any[];
  console.log(`[Sync] Found ${sqliteOwnership.length} resource ownerships in SQLite.`);
  for (const o of sqliteOwnership) {
    const checkedAt = o.checked_at ? new Date(o.checked_at * 1000).toISOString() : new Date().toISOString();
    await sql`
      INSERT INTO resource_ownership (
        resource_id, account_label, state, checked_at
      ) VALUES (
        ${o.resource_id}, ${o.account_label}, ${o.state}, ${checkedAt}
      )
      ON CONFLICT (resource_id, account_label) DO UPDATE SET
        state = EXCLUDED.state,
        checked_at = EXCLUDED.checked_at;
    `;
    console.log(`  + Ownership: resource ${o.resource_id} -> ${o.account_label} (${o.state})`);
  }

  // 5. Reset Postgres sequences to ensure future auto-increments succeed
  console.log('[Sync] Updating Postgres sequence counters...');
  await sql`SELECT setval('plugins_id_seq', COALESCE((SELECT MAX(id) FROM plugins), 1));`;
  await sql`SELECT setval('versions_id_seq', COALESCE((SELECT MAX(id) FROM versions), 1));`;
  await sql`SELECT setval('spigot_accounts_id_seq', COALESCE((SELECT MAX(id) FROM spigot_accounts), 1));`;

  console.log('[Sync] ✅ All data synchronized successfully to Neon PostgreSQL!');
}

sync()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Sync] ❌ Synchronization failed:', err);
    process.exit(1);
  });
