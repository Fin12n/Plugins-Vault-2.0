/**
 * PHASE 1 FINAL IMPLEMENTATION: SQLite -> Neon Full DAG Migration Script
 *
 * Architecture Invariants:
 * 1. Dual-Vault Architecture:
 *    - SQLite (Local) = Secret / Private Account Vault (Passwords, cookies, sessions).
 *    - Neon (PostgreSQL) = Business Single Source of Truth (Orders, wallets, ledger, plugins, etc.).
 * 2. ZERO secret credentials copied: Spigot passwords and session cookies are NEVER sent to Neon.
 * 3. 16-Step DAG Parent -> Child order with in-memory ID remapping.
 * 4. Checkpoints recorded in `migration_checkpoints`.
 * 5. Full financial reconciliation: wallet.balance == SUM(wallet_ledger.delta).
 */
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Configuration
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[Migration] ERROR: DATABASE_URL is not set!');
  process.exit(1);
}

const sqlitePath = path.resolve(process.env.DB_PATH || './data/vault.db');
if (!fs.existsSync(sqlitePath)) {
  console.error(`[Migration] ERROR: SQLite database not found at ${sqlitePath}`);
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');
const isForce = process.argv.includes('--force');
const isVerifyOnly = process.argv.includes('--verify-only');

console.log(`[Migration] ====================================================`);
console.log(`[Migration] SQLite Source: ${sqlitePath}`);
console.log(`[Migration] Neon Target:   ${databaseUrl.replace(/:[^:@]+@/, ':***@')}`);
console.log(`[Migration] Options: dryRun=${isDryRun}, force=${isForce}, verifyOnly=${isVerifyOnly}`);
console.log(`[Migration] ====================================================`);

const sqlite = new Database(sqlitePath, { readonly: true });
const sql = neon(databaseUrl);

// ID Maps for foreign key re-referencing
const pluginIdMap = new Map<number, number>();
const versionIdMap = new Map<number, number>();
const orderIdMap = new Map<number, number>();
const topupIdMap = new Map<number, number>();
const discountIdMap = new Map<number, number>();

async function recordCheckpoint(stepName: string, status: 'in_progress' | 'completed' | 'failed', count: number) {
  if (isDryRun) return;
  await sql`
    INSERT INTO migration_checkpoints (step_name, status, processed_count, started_at, completed_at)
    VALUES (${stepName}, ${status}, ${count}, NOW(), ${status === 'completed' ? sql`NOW()` : null})
    ON CONFLICT (step_name) DO UPDATE SET
      status = EXCLUDED.status,
      processed_count = EXCLUDED.processed_count,
      completed_at = EXCLUDED.completed_at;
  `;
}

async function isCheckpointCompleted(stepName: string): Promise<boolean> {
  if (isForce || isDryRun) return false;
  const rows = await sql`
    SELECT status FROM migration_checkpoints WHERE step_name = ${stepName} LIMIT 1;
  `;
  return rows[0]?.status === 'completed';
}

function tableExistsInSqlite(tableName: string): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName);
  return Boolean(row);
}

async function runMigration() {
  const startTime = Date.now();

  if (isVerifyOnly) {
    console.log('[Migration] Mode: Verify Only');
    await runReconciliation();
    return;
  }

  // ==========================================================================
  // LEVEL 0: NO FOREIGN KEY DEPENDENCIES
  // ==========================================================================

  // Step 1: Plugins
  if (await isCheckpointCompleted('01_plugins')) {
    console.log('[Step 1/17] Plugins: Skipped (Already completed)');
  } else {
    console.log('[Step 1/17] Migrating Plugins...');
    await recordCheckpoint('01_plugins', 'in_progress', 0);

    const sqlitePlugins = sqlite.prepare('SELECT * FROM plugins ORDER BY id ASC').all() as any[];
    const sqliteAliases = tableExistsInSqlite('plugin_aliases')
      ? (sqlite.prepare('SELECT * FROM plugin_aliases').all() as any[])
      : [];

    const aliasMap = new Map<number, string[]>();
    for (const a of sqliteAliases) {
      const list = aliasMap.get(a.plugin_id) || [];
      list.push(a.alias);
      aliasMap.set(a.plugin_id, list);
    }

    for (const p of sqlitePlugins) {
      const aliases = aliasMap.get(p.id) || [];
      const pluginId = p.slug || String(p.resource_id) || String(p.id);
      const createdAt = p.created_at ? new Date(p.created_at * 1000).toISOString() : new Date().toISOString();

      if (!isDryRun) {
        const rows = await sql`
          INSERT INTO plugins (
            id, plugin_id, slug, display_name, descriptor_name, aliases, platform,
            resource_id, deposit_price, is_premium, description, spigot_link, created_at, updated_at
          ) VALUES (
            ${p.id}, ${pluginId}, ${p.slug}, ${p.display_name}, ${p.descriptor_name},
            ${aliases}, ${p.platform || 'spigot'}, ${p.resource_id}, ${p.deposit_price || 0},
            ${Boolean(p.is_premium)}, ${p.description || ''}, ${p.external_link || ''},
            ${createdAt}, NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            plugin_id = EXCLUDED.plugin_id,
            display_name = EXCLUDED.display_name,
            deposit_price = EXCLUDED.deposit_price,
            updated_at = NOW()
          RETURNING id;
        `;
        pluginIdMap.set(p.id, rows[0]?.id ?? p.id);
      } else {
        pluginIdMap.set(p.id, p.id);
      }
    }
    await recordCheckpoint('01_plugins', 'completed', sqlitePlugins.length);
    console.log(`  + Migrated ${sqlitePlugins.length} plugins.`);
  }

  // Step 2: Wallets
  if (await isCheckpointCompleted('02_wallets')) {
    console.log('[Step 2/17] Wallets: Skipped (Already completed)');
  } else {
    console.log('[Step 2/17] Migrating Wallets...');
    await recordCheckpoint('02_wallets', 'in_progress', 0);

    const sqliteWallets = tableExistsInSqlite('wallets')
      ? (sqlite.prepare('SELECT * FROM wallets').all() as any[])
      : [];

    for (const w of sqliteWallets) {
      if (!isDryRun) {
        await sql`
          INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
          VALUES (${w.discord_user_id}, ${w.balance || 0}, NOW(), NOW())
          ON CONFLICT (discord_user_id) DO UPDATE SET
            balance = EXCLUDED.balance,
            updated_at = NOW();
        `;
      }
    }
    await recordCheckpoint('02_wallets', 'completed', sqliteWallets.length);
    console.log(`  + Migrated ${sqliteWallets.length} wallets.`);
  }

  // Step 3: Discount Codes
  if (await isCheckpointCompleted('03_discount_codes')) {
    console.log('[Step 3/17] Discount Codes: Skipped (Already completed)');
  } else {
    console.log('[Step 3/17] Migrating Discount Codes...');
    await recordCheckpoint('03_discount_codes', 'in_progress', 0);

    const sqliteDiscounts = tableExistsInSqlite('discount_codes')
      ? (sqlite.prepare('SELECT * FROM discount_codes').all() as any[])
      : [];

    for (const d of sqliteDiscounts) {
      if (!isDryRun) {
        const rows = await sql`
          INSERT INTO discount_codes (
            id, code, type, value, min_order, max_discount, max_uses, used_count, expires_at, is_active, created_at
          ) VALUES (
            ${d.id}, ${d.code.toUpperCase()}, ${d.type}, ${d.value}, ${d.min_order || 0},
            ${d.max_discount ?? null}, ${d.max_uses ?? null}, ${d.used_count || 0},
            ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null},
            ${d.is_active !== undefined ? Boolean(d.is_active) : true},
            NOW()
          )
          ON CONFLICT (code) DO UPDATE SET
            used_count = EXCLUDED.used_count,
            is_active = EXCLUDED.is_active
          RETURNING id;
        `;
        discountIdMap.set(d.id, rows[0]?.id ?? d.id);
      } else {
        discountIdMap.set(d.id, d.id);
      }
    }
    await recordCheckpoint('03_discount_codes', 'completed', sqliteDiscounts.length);
    console.log(`  + Migrated ${sqliteDiscounts.length} discount codes.`);
  }

  // Step 4: Config
  if (await isCheckpointCompleted('04_config')) {
    console.log('[Step 4/17] Config: Skipped (Already completed)');
  } else {
    console.log('[Step 4/17] Migrating Config...');
    await recordCheckpoint('04_config', 'in_progress', 0);

    const sqliteConfig = tableExistsInSqlite('config')
      ? (sqlite.prepare('SELECT * FROM config').all() as any[])
      : [];

    for (const c of sqliteConfig) {
      if (!isDryRun) {
        await sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${c.key}, ${c.value}, NOW())
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW();
        `;
      }
    }
    await recordCheckpoint('04_config', 'completed', sqliteConfig.length);
    console.log(`  + Migrated ${sqliteConfig.length} config entries.`);
  }

  // Step 5: Spigot Account Refs (ZERO SECRETS! Non-sensitive metadata ONLY)
  if (await isCheckpointCompleted('05_spigot_refs')) {
    console.log('[Step 5/17] Spigot Account Refs: Skipped (Already completed)');
  } else {
    console.log('[Step 5/17] Migrating Spigot Account Refs (Non-sensitive metadata ONLY)...');
    await recordCheckpoint('05_spigot_refs', 'in_progress', 0);

    const sqliteAccounts = tableExistsInSqlite('spigot_accounts')
      ? (sqlite.prepare('SELECT * FROM spigot_accounts').all() as any[])
      : [];

    for (const a of sqliteAccounts) {
      const accountId = randomUUID();
      const status = a.is_enabled ? (a.status || 'active') : 'inactive';
      const health = a.status === 'ok' ? 'healthy' : 'unhealthy';
      const lastVerified = a.last_verified_at ? new Date(a.last_verified_at).toISOString() : null;

      if (!isDryRun) {
        await sql`
          INSERT INTO spigot_account_refs (
            account_id, label, status, health, last_verified_at, created_at, updated_at
          ) VALUES (
            ${accountId}, ${a.label}, ${status}, ${health}, ${lastVerified}, NOW(), NOW()
          )
          ON CONFLICT (label) DO UPDATE SET
            status = EXCLUDED.status,
            health = EXCLUDED.health,
            last_verified_at = EXCLUDED.last_verified_at,
            updated_at = NOW();
        `;
      }
    }
    await recordCheckpoint('05_spigot_refs', 'completed', sqliteAccounts.length);
    console.log(`  + Migrated ${sqliteAccounts.length} non-sensitive Spigot account refs (passwords & cookies kept in SQLite vault).`);
  }

  // ==========================================================================
  // LEVEL 1: DEPENDS ON LEVEL 0
  // ==========================================================================

  // Step 6: Versions
  if (await isCheckpointCompleted('06_versions')) {
    console.log('[Step 6/17] Versions: Skipped (Already completed)');
  } else {
    console.log('[Step 6/17] Migrating Versions...');
    await recordCheckpoint('06_versions', 'in_progress', 0);

    const sqliteVersions = sqlite.prepare('SELECT * FROM versions ORDER BY id ASC').all() as any[];

    for (const v of sqliteVersions) {
      const pluginId = pluginIdMap.get(v.plugin_id) ?? v.plugin_id;
      const uploadedAt = v.uploaded_at ? new Date(v.uploaded_at * 1000).toISOString() : new Date().toISOString();

      if (!isDryRun) {
        const rows = await sql`
          INSERT INTO versions (
            id, plugin_id, version, raw_version, sha256, rel_path, bytes, original_name,
            descriptor_kind, is_stable, version_flag, change_logs, source, uploaded_at
          ) VALUES (
            ${v.id}, ${pluginId}, ${v.version}, ${v.raw_version || v.version}, ${v.sha256},
            ${v.rel_path}, ${v.bytes || 0}, ${v.original_name || ''}, ${v.descriptor_kind || 'spigot'},
            ${Boolean(v.is_stable)}, ${v.version_flag || 'ok'}, ${v.change_logs || ''},
            ${v.source || 'spigot_auto'}, ${uploadedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            version = EXCLUDED.version,
            sha256 = EXCLUDED.sha256,
            rel_path = EXCLUDED.rel_path
          RETURNING id;
        `;
        versionIdMap.set(v.id, rows[0]?.id ?? v.id);
      } else {
        versionIdMap.set(v.id, v.id);
      }
    }
    await recordCheckpoint('06_versions', 'completed', sqliteVersions.length);
    console.log(`  + Migrated ${sqliteVersions.length} versions.`);
  }

  // Step 7: Wallet Topups
  if (await isCheckpointCompleted('07_wallet_topups')) {
    console.log('[Step 7/17] Wallet Topups: Skipped (Already completed)');
  } else {
    console.log('[Step 7/17] Migrating Wallet Topups...');
    await recordCheckpoint('07_wallet_topups', 'in_progress', 0);

    const sqliteTopups = tableExistsInSqlite('wallet_topups')
      ? (sqlite.prepare('SELECT * FROM wallet_topups ORDER BY id ASC').all() as any[])
      : [];

    for (const t of sqliteTopups) {
      const createdAt = t.created_at ? new Date(t.created_at * 1000).toISOString() : new Date().toISOString();
      const expiresAt = t.expires_at ? new Date(t.expires_at * 1000).toISOString() : new Date().toISOString();
      const creditedAt = t.credited_at ? new Date(t.credited_at * 1000).toISOString() : null;
      const paidAmount = t.status === 'credited' ? (t.paid_amount || t.amount) : null;

      if (!isDryRun) {
        const rows = await sql`
          INSERT INTO wallet_topups (
            id, code, discord_user_id, amount, paid_amount, status, created_at, expires_at, credited_at
          ) VALUES (
            ${t.id}, ${t.code}, ${t.discord_user_id}, ${t.amount}, ${paidAmount},
            ${t.status || 'pending'}, ${createdAt}, ${expiresAt}, ${creditedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            paid_amount = EXCLUDED.paid_amount
          RETURNING id;
        `;
        topupIdMap.set(t.id, rows[0]?.id ?? t.id);
      } else {
        topupIdMap.set(t.id, t.id);
      }
    }
    await recordCheckpoint('07_wallet_topups', 'completed', sqliteTopups.length);
    console.log(`  + Migrated ${sqliteTopups.length} wallet topups.`);
  }

  // Step 8: Card Topups
  if (await isCheckpointCompleted('08_card_topups')) {
    console.log('[Step 8/17] Card Topups: Skipped (Already completed)');
  } else {
    console.log('[Step 8/17] Migrating Card Topups...');
    await recordCheckpoint('08_card_topups', 'in_progress', 0);

    const sqliteCards = tableExistsInSqlite('card_topups')
      ? (sqlite.prepare('SELECT * FROM card_topups ORDER BY id ASC').all() as any[])
      : [];

    for (const c of sqliteCards) {
      const createdAt = c.created_at ? new Date(c.created_at * 1000).toISOString() : new Date().toISOString();
      const nextPollAt = c.next_poll_at ? new Date(c.next_poll_at * 1000).toISOString() : null;
      const creditedAt = c.credited_at ? new Date(c.credited_at * 1000).toISOString() : null;

      if (!isDryRun) {
        await sql`
          INSERT INTO card_topups (
            id, request_id, discord_user_id, telco, serial, code, declared_value,
            actual_value, net_amount, status, provider_status, provider_message,
            trans_id, attempts, next_poll_at, credited_at, created_at
          ) VALUES (
            ${c.id}, ${c.request_id}, ${c.discord_user_id}, ${c.telco}, ${c.serial},
            ${c.code || ''}, ${c.declared_value}, ${c.actual_value ?? null}, ${c.net_amount ?? null},
            ${c.status || 'pending'}, ${c.provider_status ?? null}, ${c.provider_message || ''},
            ${c.trans_id ?? null}, ${c.attempts || 0}, ${nextPollAt}, ${creditedAt}, ${createdAt}
          )
          ON CONFLICT (request_id) DO UPDATE SET
            status = EXCLUDED.status,
            net_amount = EXCLUDED.net_amount;
        `;
      }
    }
    await recordCheckpoint('08_card_topups', 'completed', sqliteCards.length);
    console.log(`  + Migrated ${sqliteCards.length} card topups.`);
  }

  // Step 9: Resource Ownership
  if (await isCheckpointCompleted('09_resource_ownership')) {
    console.log('[Step 9/17] Resource Ownership: Skipped (Already completed)');
  } else {
    console.log('[Step 9/17] Migrating Resource Ownership...');
    await recordCheckpoint('09_resource_ownership', 'in_progress', 0);

    const sqliteOwnership = tableExistsInSqlite('resource_ownership')
      ? (sqlite.prepare('SELECT * FROM resource_ownership').all() as any[])
      : [];

    for (const o of sqliteOwnership) {
      const checkedAt = o.checked_at ? new Date(o.checked_at * 1000).toISOString() : new Date().toISOString();
      if (!isDryRun) {
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
      }
    }
    await recordCheckpoint('09_resource_ownership', 'completed', sqliteOwnership.length);
    console.log(`  + Migrated ${sqliteOwnership.length} resource ownership records.`);
  }

  // ==========================================================================
  // LEVEL 2: DEPENDS ON LEVEL 1
  // ==========================================================================

  // Step 10: Orders
  if (await isCheckpointCompleted('10_orders')) {
    console.log('[Step 10/17] Orders: Skipped (Already completed)');
  } else {
    console.log('[Step 10/17] Migrating Orders...');
    await recordCheckpoint('10_orders', 'in_progress', 0);

    const sqliteOrders = tableExistsInSqlite('orders')
      ? (sqlite.prepare('SELECT * FROM orders ORDER BY id ASC').all() as any[])
      : [];

    for (const o of sqliteOrders) {
      const versionId = o.version_id ? (versionIdMap.get(o.version_id) ?? o.version_id) : null;
      const createdAt = o.created_at ? new Date(o.created_at * 1000).toISOString() : new Date().toISOString();
      const expiresAt = o.expires_at ? new Date(o.expires_at * 1000).toISOString() : new Date().toISOString();
      const paidAt = o.paid_at ? new Date(o.paid_at * 1000).toISOString() : null;
      const deliveredAt = o.delivered_at ? new Date(o.delivered_at * 1000).toISOString() : null;

      if (!isDryRun) {
        const rows = await sql`
          INSERT INTO orders (
            id, code, discord_user_id, version_id, plugin_name, version_label,
            amount, wallet_paid, bank_due, paid_amount, status, expires_at, paid_at,
            delivered_at, created_at
          ) VALUES (
            ${o.id}, ${o.code}, ${o.discord_user_id}, ${versionId}, ${o.plugin_name || ''},
            ${o.version_label || ''}, ${o.amount || 0}, ${o.wallet_paid || 0}, ${o.bank_due || 0},
            ${o.paid_amount ?? null}, ${o.status || 'pending'}, ${expiresAt}, ${paidAt},
            ${deliveredAt}, ${createdAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            paid_amount = EXCLUDED.paid_amount,
            delivered_at = EXCLUDED.delivered_at
          RETURNING id;
        `;
        orderIdMap.set(o.id, rows[0]?.id ?? o.id);
      } else {
        orderIdMap.set(o.id, o.id);
      }
    }
    await recordCheckpoint('10_orders', 'completed', sqliteOrders.length);
    console.log(`  + Migrated ${sqliteOrders.length} orders.`);
  }

  // Step 11: Wallet Ledger
  if (await isCheckpointCompleted('11_wallet_ledger')) {
    console.log('[Step 11/17] Wallet Ledger: Skipped (Already completed)');
  } else {
    console.log('[Step 11/17] Migrating Wallet Ledger...');
    await recordCheckpoint('11_wallet_ledger', 'in_progress', 0);

    const sqliteLedger = tableExistsInSqlite('wallet_ledger')
      ? (sqlite.prepare('SELECT * FROM wallet_ledger ORDER BY id ASC').all() as any[])
      : [];

    for (const l of sqliteLedger) {
      let refId = l.ref_id;
      if (l.ref_type === 'order' && l.ref_id) {
        refId = orderIdMap.get(l.ref_id) ?? l.ref_id;
      } else if (l.ref_type === 'topup' && l.ref_id) {
        refId = topupIdMap.get(l.ref_id) ?? l.ref_id;
      }

      const createdAt = l.created_at ? new Date(l.created_at * 1000).toISOString() : new Date().toISOString();

      if (!isDryRun) {
        await sql`
          INSERT INTO wallet_ledger (
            id, discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at
          ) VALUES (
            ${l.id}, ${l.discord_user_id}, ${l.delta}, ${l.balance_after}, ${l.kind},
            ${l.ref_type || ''}, ${refId ?? null}, ${l.note || ''}, ${createdAt}
          )
          ON CONFLICT (id) DO NOTHING;
        `;
      }
    }
    await recordCheckpoint('11_wallet_ledger', 'completed', sqliteLedger.length);
    console.log(`  + Migrated ${sqliteLedger.length} ledger entries.`);
  }

  // ==========================================================================
  // LEVEL 3: DEPENDS ON LEVEL 2
  // ==========================================================================

  // Step 12: SePay Transactions (Enforces chk_sepay_target_exclusivity)
  if (await isCheckpointCompleted('12_sepay_transactions')) {
    console.log('[Step 12/17] SePay Transactions: Skipped (Already completed)');
  } else {
    console.log('[Step 12/17] Migrating SePay Transactions...');
    await recordCheckpoint('12_sepay_transactions', 'in_progress', 0);

    const sqliteSepay = tableExistsInSqlite('sepay_transactions')
      ? (sqlite.prepare('SELECT * FROM sepay_transactions ORDER BY id ASC').all() as any[])
      : [];

    for (const s of sqliteSepay) {
      let orderId = s.order_id ? (orderIdMap.get(s.order_id) ?? s.order_id) : null;
      let topupId = s.topup_id ? (topupIdMap.get(s.topup_id) ?? s.topup_id) : null;

      // Invariant chk_sepay_target_exclusivity guard
      if (orderId && topupId) {
        topupId = null; // Enforce exclusivity
      }

      const receivedAt = s.received_at ? new Date(s.received_at * 1000).toISOString() : new Date().toISOString();
      const rawPayload = s.raw_payload ? JSON.parse(s.raw_payload) : {};

      if (!isDryRun) {
        await sql`
          INSERT INTO sepay_transactions (
            id, sepay_id, amount, transfer_type, code, content, description,
            status, order_id, topup_id, raw_payload, received_at
          ) VALUES (
            ${s.id}, ${s.sepay_id}, ${s.amount}, ${s.transfer_type}, ${s.code},
            ${s.content || ''}, ${s.description || ''}, ${s.status || 'credited'},
            ${orderId}, ${topupId}, ${rawPayload}, ${receivedAt}
          )
          ON CONFLICT (sepay_id) DO UPDATE SET
            status = EXCLUDED.status,
            order_id = EXCLUDED.order_id,
            topup_id = EXCLUDED.topup_id;
        `;
      }
    }
    await recordCheckpoint('12_sepay_transactions', 'completed', sqliteSepay.length);
    console.log(`  + Migrated ${sqliteSepay.length} SePay transactions.`);
  }

  // Step 13: Discount Code Redemptions
  if (await isCheckpointCompleted('13_discount_redemptions')) {
    console.log('[Step 13/17] Discount Redemptions: Skipped (Already completed)');
  } else {
    console.log('[Step 13/17] Migrating Discount Redemptions...');
    await recordCheckpoint('13_discount_redemptions', 'in_progress', 0);

    const sqliteRedemptions = tableExistsInSqlite('discount_code_redemptions')
      ? (sqlite.prepare('SELECT * FROM discount_code_redemptions ORDER BY id ASC').all() as any[])
      : [];

    for (const r of sqliteRedemptions) {
      const discountId = discountIdMap.get(r.discount_id) ?? r.discount_id;
      const orderId = r.order_id ? (orderIdMap.get(r.order_id) ?? r.order_id) : null;
      const redeemedAt = r.redeemed_at ? new Date(r.redeemed_at * 1000).toISOString() : new Date().toISOString();

      if (!isDryRun) {
        await sql`
          INSERT INTO discount_code_redemptions (
            id, discount_id, discord_user_id, order_id, discount_amount, redeemed_at
          ) VALUES (
            ${r.id}, ${discountId}, ${r.discord_user_id}, ${orderId}, ${r.applied_discount_amount || r.discount_amount || 0}, ${redeemedAt}
          )
          ON CONFLICT (id) DO NOTHING;
        `;
      }
    }
    await recordCheckpoint('13_discount_redemptions', 'completed', sqliteRedemptions.length);
    console.log(`  + Migrated ${sqliteRedemptions.length} discount redemptions.`);
  }

  // Step 14: Delivery Logs (From SQLite audit_log)
  if (await isCheckpointCompleted('14_delivery_logs')) {
    console.log('[Step 14/17] Delivery Logs: Skipped (Already completed)');
  } else {
    console.log('[Step 14/17] Migrating Delivery Logs...');
    await recordCheckpoint('14_delivery_logs', 'in_progress', 0);

    const sqliteAudit = tableExistsInSqlite('audit_log')
      ? (sqlite.prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as any[])
      : [];

    for (const a of sqliteAudit) {
      const versionId = a.version_id ? (versionIdMap.get(a.version_id) ?? a.version_id) : null;
      if (!versionId) continue;

      const orderId = a.order_id ? (orderIdMap.get(a.order_id) ?? a.order_id) : null;
      const idempotencyKey = `migrated_audit_${a.id}`;
      const deliveredAt = a.delivered_at ? new Date(a.delivered_at * 1000).toISOString() : new Date().toISOString();

      if (!isDryRun) {
        await sql`
          INSERT INTO delivery_logs (
            delivery_idempotency_key, discord_user_id, version_id, order_id,
            plugin_name, version_label, amount, requested_method, actual_method,
            ip, delivered_at
          ) VALUES (
            ${idempotencyKey}, ${a.discord_user_id}, ${versionId}, ${orderId},
            ${a.plugin_name || ''}, ${a.version_label || ''}, ${a.amount || 0},
            ${a.delivery_method || 'dm'}, ${a.delivery_method || 'dm'},
            ${a.ip ?? null}, ${deliveredAt}
          )
          ON CONFLICT (delivery_idempotency_key) DO NOTHING;
        `;
      }
    }
    await recordCheckpoint('14_delivery_logs', 'completed', sqliteAudit.length);
    console.log(`  + Migrated ${sqliteAudit.length} delivery logs.`);
  }

  // Step 15: Download Tokens
  if (await isCheckpointCompleted('15_download_tokens')) {
    console.log('[Step 15/17] Download Tokens: Skipped (Already completed)');
  } else {
    console.log('[Step 15/17] Migrating Download Tokens...');
    await recordCheckpoint('15_download_tokens', 'in_progress', 0);

    const sqliteTokens = tableExistsInSqlite('download_tokens')
      ? (sqlite.prepare('SELECT * FROM download_tokens ORDER BY id ASC').all() as any[])
      : [];

    for (const t of sqliteTokens) {
      const versionId = versionIdMap.get(t.version_id) ?? t.version_id;
      const orderId = t.order_id ? (orderIdMap.get(t.order_id) ?? t.order_id) : null;
      const expiresAt = t.expires_at ? new Date(t.expires_at * 1000).toISOString() : new Date().toISOString();
      const usedAt = t.used_at ? new Date(t.used_at * 1000).toISOString() : null;
      const tokenHash = t.token_hash instanceof Buffer ? t.token_hash.toString('hex') : String(t.token_hash);

      if (!isDryRun) {
        await sql`
          INSERT INTO download_tokens (
            token_hash, version_id, discord_user_id, order_id, expires_at, used_at, created_at
          ) VALUES (
            ${tokenHash}, ${versionId}, ${t.discord_user_id}, ${orderId}, ${expiresAt}, ${usedAt}, NOW()
          )
          ON CONFLICT (token_hash) DO NOTHING;
        `;
      }
    }
    await recordCheckpoint('15_download_tokens', 'completed', sqliteTokens.length);
    console.log(`  + Migrated ${sqliteTokens.length} download tokens.`);
  }

  // Step 16: Reset Sequences
  if (!isDryRun) {
    console.log('[Step 16/17] Resetting PostgreSQL Sequences...');
    const serialTables = [
      ['plugins', 'id'],
      ['versions', 'id'],
      ['orders', 'id'],
      ['wallet_topups', 'id'],
      ['sepay_transactions', 'id'],
      ['discount_codes', 'id'],
      ['discount_code_redemptions', 'id'],
      ['delivery_jobs', 'id'],
      ['delivery_logs', 'id'],
      ['card_topups', 'id'],
      ['wallet_ledger', 'id'],
    ];

    for (const [tbl, col] of serialTables) {
      await sql(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${col}) FROM ${tbl}), 1));`,
        [tbl, col]
      );
    }
    await recordCheckpoint('16_sequence_reset', 'completed', serialTables.length);
    console.log(`  + Sequences reset for ${serialTables.length} tables.`);
  }

  // Step 17: Financial Reconciliation & Invariant Check
  console.log('[Step 17/17] Running Financial Reconciliation & Invariant Checks...');
  await runReconciliation();

  const durationMs = Date.now() - startTime;
  console.log(`[Migration] ====================================================`);
  console.log(`[Migration] ✅ SQLite -> Neon Migration Completed in ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`[Migration] ====================================================`);
}

async function runReconciliation() {
  console.log('[Audit] Checking Invariant: wallet.balance == SUM(wallet_ledger.delta)...');
  const discrepancies = await sql`
    SELECT
      w.discord_user_id,
      w.balance,
      COALESCE(SUM(l.delta), 0)::int AS ledger_sum,
      (w.balance - COALESCE(SUM(l.delta), 0)::int) AS diff
    FROM wallets w
    LEFT JOIN wallet_ledger l ON w.discord_user_id = l.discord_user_id
    GROUP BY w.discord_user_id, w.balance
    HAVING w.balance != COALESCE(SUM(l.delta), 0)::int;
  `;

  if (discrepancies.length === 0) {
    console.log('[Audit] ✅ 100% PASS: All wallet balances perfectly match wallet_ledger deltas!');
  } else {
    console.warn(`[Audit] ⚠️ WARNING: ${discrepancies.length} wallet discrepancies found:`);
    for (const d of discrepancies) {
      console.warn(`  - User ${d.discord_user_id}: Balance=${d.balance}, LedgerSum=${d.ledger_sum}, Diff=${d.diff}`);
    }
  }

  console.log('[Audit] Checking Invariant: chk_sepay_target_exclusivity...');
  const invalidSepay = await sql`
    SELECT id, sepay_id, order_id, topup_id
    FROM sepay_transactions
    WHERE order_id IS NOT NULL AND topup_id IS NOT NULL;
  `;

  if (invalidSepay.length === 0) {
    console.log('[Audit] ✅ 100% PASS: All SePay transactions satisfy exclusivity invariant!');
  } else {
    console.error(`[Audit] ❌ ERROR: ${invalidSepay.length} invalid SePay records found violating exclusivity:`, invalidSepay);
  }
}

runMigration().catch((err) => {
  console.error('[Migration] FATAL ERROR during migration:', err);
  process.exit(1);
});
