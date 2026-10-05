import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uuid,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ============================================================================
// 1. PLUGINS & CATALOG
// ============================================================================
export const plugins = pgTable(
  "plugins",
  {
    id: serial("id").primaryKey(),
    pluginId: varchar("plugin_id", { length: 64 }).unique().notNull(),
    slug: varchar("slug", { length: 128 }).unique().notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    descriptorName: varchar("descriptor_name", { length: 128 }).notNull(),
    aliases: text("aliases").array().default([]).notNull(),
    platform: varchar("platform", { length: 32 }).default("spigot").notNull(),
    resourceId: integer("resource_id"),
    depositPrice: bigint("deposit_price", { mode: "number" }).default(0).notNull(),
    isPremium: boolean("is_premium").default(false).notNull(),
    description: text("description").default("").notNull(),
    spigotLink: text("spigot_link").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_plugins_plugin_id").on(table.pluginId),
    uniqueIndex("idx_plugins_slug").on(table.slug),
    index("idx_plugins_resource_id").on(table.resourceId),
    index("idx_plugins_descriptor_name").on(table.descriptorName),
    index("idx_plugins_aliases").using("gin", table.aliases),
  ]
);

export const versions = pgTable(
  "versions",
  {
    id: serial("id").primaryKey(),
    pluginId: integer("plugin_id")
      .references(() => plugins.id, { onDelete: "cascade" })
      .notNull(),
    version: varchar("version", { length: 64 }),
    rawVersion: varchar("raw_version", { length: 128 }),
    sha256: varchar("sha256", { length: 64 }).unique().notNull(),
    relPath: text("rel_path").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    descriptorKind: varchar("descriptor_kind", { length: 32 }).default("spigot").notNull(),
    isStable: boolean("is_stable").default(true).notNull(),
    versionFlag: varchar("version_flag", { length: 32 }).default("ok").notNull(),
    changeLogs: text("change_logs").default("").notNull(),
    source: varchar("source", { length: 20 }).default("spigot_auto").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_versions_plugin_version").on(table.pluginId, table.version),
    index("idx_versions_plugin_id").on(table.pluginId),
    index("idx_versions_plugin_uploaded").on(table.pluginId, table.uploadedAt),
    uniqueIndex("idx_versions_sha256").on(table.sha256),
    index("idx_versions_is_stable").on(table.isStable),
  ]
);

export const manualUploads = pgTable(
  "manual_uploads",
  {
    id: serial("id").primaryKey(),
    versionId: integer("version_id")
      .references(() => versions.id, { onDelete: "cascade" })
      .notNull(),
    pluginId: integer("plugin_id")
      .references(() => plugins.id, { onDelete: "cascade" })
      .notNull(),
    uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    adminNote: text("admin_note").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_manual_uploads_plugin").on(table.pluginId),
    index("idx_manual_uploads_uploader").on(table.uploadedBy),
  ]
);

// ============================================================================
// 2. ORDERS & TRANSACTIONS
// ============================================================================
export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 32 }).unique().notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    versionId: integer("version_id").references(() => versions.id, {
      onDelete: "set null",
    }),
    pluginName: varchar("plugin_name", { length: 255 }).notNull(),
    versionLabel: varchar("version_label", { length: 64 }).default("").notNull(),
    amount: integer("amount").notNull(),
    walletPaid: integer("wallet_paid").default(0).notNull(),
    bankDue: integer("bank_due").default(0).notNull(),
    paidAmount: integer("paid_amount"),
    settledAmount: integer("settled_amount"),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_orders_status").on(table.status),
    index("idx_orders_user").on(table.discordUserId),
    index("idx_orders_version_id").on(table.versionId),
    index("idx_orders_code").on(table.code),
    index("idx_orders_settled_amount").on(table.settledAmount),
    index("idx_orders_paid_at").on(table.paidAt),
    check("chk_orders_settled_amount_non_negative", sql`settled_amount IS NULL OR settled_amount >= 0`),
  ]
);

export const walletTopups = pgTable(
  "wallet_topups",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 32 }).unique().notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    amount: integer("amount").notNull(), // requested amount
    paidAmount: integer("paid_amount"), // real received amount
    status: varchar("status", { length: 20 }).default("pending").notNull(), // pending | expired | credited
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    creditedAt: timestamp("credited_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_wallet_topups_code").on(table.code),
    index("idx_wallet_topups_status").on(table.status),
    index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt),
  ]
);

export const sepayTransactions = pgTable(
  "sepay_transactions",
  {
    id: serial("id").primaryKey(),
    sepayId: integer("sepay_id").unique().notNull(),
    amount: integer("amount").notNull(),
    transferType: varchar("transfer_type", { length: 10 }).notNull(),
    code: varchar("code", { length: 64 }),
    content: text("content").default("").notNull(),
    description: text("description").default("").notNull(),
    status: varchar("status", { length: 32 }).default("received").notNull(), // received | unmatched | credited | underpaid | overpaid | duplicate_transfer
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    topupId: integer("topup_id").references(() => walletTopups.id, {
      onDelete: "set null",
    }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "chk_sepay_target_exclusivity",
      sql`(order_id IS NULL AND topup_id IS NULL) OR (order_id IS NOT NULL AND topup_id IS NULL) OR (order_id IS NULL AND topup_id IS NOT NULL)`
    ),
    uniqueIndex("idx_sepay_tx_sepay_id").on(table.sepayId),
    index("idx_sepay_tx_code").on(table.code),
    index("idx_sepay_tx_status").on(table.status),
    index("idx_sepay_tx_order_id").on(table.orderId),
    index("idx_sepay_tx_topup_id").on(table.topupId),
  ]
);

// ============================================================================
// 3. WALLETS & LEDGER
// ============================================================================
export const wallets = pgTable("wallets", {
  discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
  balance: integer("balance").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const walletLedger = pgTable(
  "wallet_ledger",
  {
    id: serial("id").primaryKey(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    kind: varchar("kind", { length: 30 }).notNull(), // opening_balance | topup_credit | card_credit | order_debit | order_hold | order_partial_credit | order_overpay_credit | order_refund | admin_adjustment
    refType: varchar("ref_type", { length: 20 }).default("").notNull(),
    refId: integer("ref_id"),
    note: text("note").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_wallet_ledger_user").on(table.discordUserId, table.createdAt),
    uniqueIndex("idx_wallet_ledger_ref_kind_unique")
      .on(table.refType, table.refId, table.kind)
      .where(sql`ref_type != '' AND ref_id IS NOT NULL`),
    uniqueIndex("idx_wallet_ledger_opening_balance")
      .on(table.discordUserId)
      .where(sql`kind = 'opening_balance'`),
  ]
);

// ============================================================================
// 4. DISCOUNTS & REDEMPTIONS
// ============================================================================
export const discountCodes = pgTable(
  "discount_codes",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 32 }).unique().notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    value: integer("value").notNull(),
    minOrder: integer("min_order").default(0).notNull(),
    maxDiscount: integer("max_discount"),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_discount_codes_code").on(table.code),
    index("idx_discount_codes_active").on(table.isActive),
  ]
);

export const discountCodeRedemptions = pgTable(
  "discount_code_redemptions",
  {
    id: serial("id").primaryKey(),
    discountId: integer("discount_id")
      .references(() => discountCodes.id, { onDelete: "cascade" })
      .notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    discountAmount: integer("discount_amount").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_discount_redemptions_order").on(table.orderId),
    index("idx_discount_redemptions_discount_user").on(
      table.discountId,
      table.discordUserId
    ),
  ]
);

// ============================================================================
// 5. DOWNLOAD TOKENS & DURABLE DELIVERY
// ============================================================================
export const downloadTokens = pgTable(
  "download_tokens",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(), // sha256 hex
    versionId: integer("version_id")
      .references(() => versions.id, { onDelete: "cascade" })
      .notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_download_tokens_expires").on(table.expiresAt),
    index("idx_download_tokens_version").on(table.versionId),
    index("idx_download_tokens_user").on(table.discordUserId),
  ]
);

export const deliveryJobs = pgTable(
  "delivery_jobs",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    versionId: integer("version_id")
      .references(() => versions.id)
      .notNull(),
    requestedMethod: varchar("requested_method", { length: 32 })
      .default("attachment")
      .notNull(),
    status: varchar("status", { length: 20 }).default("queued").notNull(), // queued | processing | delivered | failed
    externalAttemptCount: integer("external_attempt_count").default(0).notNull(),
    claimToken: varchar("claim_token", { length: 64 }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    retryCount: integer("retry_count").default(0).notNull(),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_delivery_jobs_order_method").on(
      table.orderId,
      table.requestedMethod
    ),
    index("idx_delivery_jobs_status_locked").on(
      table.status,
      table.nextRetryAt,
      table.lockedAt
    ),
    index("idx_delivery_jobs_created").on(table.createdAt),
  ]
);

export const deliveryLogs = pgTable(
  "delivery_logs",
  {
    id: serial("id").primaryKey(),
    deliveryIdempotencyKey: varchar("delivery_idempotency_key", { length: 128 })
      .unique()
      .notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    versionId: integer("version_id")
      .references(() => versions.id)
      .notNull(),
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    pluginName: varchar("plugin_name", { length: 255 }).notNull(),
    versionLabel: varchar("version_label", { length: 64 }).default("").notNull(),
    amount: integer("amount").default(0).notNull(),
    requestedMethod: varchar("requested_method", { length: 32 }).notNull(), // attachment | link | manual
    actualMethod: varchar("actual_method", { length: 32 }).notNull(), // attachment | fallback_link | manual
    ip: varchar("ip", { length: 45 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_delivery_logs_idempotency").on(table.deliveryIdempotencyKey),
    index("idx_delivery_logs_user").on(table.discordUserId, table.deliveredAt),
    index("idx_delivery_logs_order").on(table.orderId),
  ]
);

// ============================================================================
// 6. SPIGOT PUBLIC ACCOUNT REFS (NON-SENSITIVE) & UPSTREAM STATE
// ============================================================================
export const spigotAccountRefs = pgTable(
  "spigot_account_refs",
  {
    accountId: uuid("account_id").primaryKey().notNull(),
    label: varchar("label", { length: 64 }).unique().notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    health: varchar("health", { length: 20 }).default("healthy").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_spigot_refs_label").on(table.label),
    index("idx_spigot_refs_status").on(table.status),
  ]
);

// Alias for backwards-compatibility
export const spigotAccounts = spigotAccountRefs;

export const resourceOwnership = pgTable(
  "resource_ownership",
  {
    id: serial("id").primaryKey(),
    resourceId: integer("resource_id").notNull(),
    accountId: uuid("account_id"),
    accountLabel: varchar("account_label", { length: 64 }).notNull(),
    state: varchar("state", { length: 20 }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_resource_ownership_pair").on(
      table.resourceId,
      table.accountLabel
    ),
    index("idx_resource_ownership_state").on(table.resourceId, table.state),
    index("idx_resource_ownership_account_id").on(table.accountId),
  ]
);

export const upstreamState = pgTable("upstream_state", {
  pluginId: integer("plugin_id")
    .primaryKey()
    .references(() => plugins.id, { onDelete: "cascade" }),
  versionUuid: varchar("version_uuid", { length: 64 }).notNull(),
  versionName: varchar("version_name", { length: 64 }).notNull(),
  releaseDateMs: text("release_date_ms").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pendingDownload = pgTable(
  "pending_download",
  {
    id: serial("id").primaryKey(),
    pluginId: integer("plugin_id")
      .references(() => plugins.id, { onDelete: "cascade" })
      .notNull(),
    versionUuid: varchar("version_uuid", { length: 64 }).notNull(),
    versionName: varchar("version_name", { length: 64 }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error").default("").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_pending_download_pair").on(
      table.pluginId,
      table.versionUuid
    ),
    index("idx_pending_download_due").on(table.nextAttemptAt),
  ]
);

// ============================================================================
// 7. DISCORD CHANNELS & SYSTEM CONFIGURATION
// ============================================================================
export const discordChannels = pgTable(
  "discord_channels",
  {
    id: serial("id").primaryKey(),
    purpose: varchar("purpose", { length: 32 }).unique().notNull(), // 'notify' | 'orders' | 'audit' | 'panel'
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    channelName: varchar("channel_name", { length: 100 }),
    guildId: varchar("guild_id", { length: 32 }),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    updatedBy: varchar("updated_by", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_discord_channels_purpose").on(table.purpose),
  ]
);

// ============================================================================
// 8. STAFFS & PERMISSIONS (Decoupled Authentication Architecture)
// ============================================================================
export const staffs = pgTable(
  "staffs",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).unique(),
    dashboardUserId: varchar("dashboard_user_id", { length: 64 }).unique(),
    discordUserId: varchar("discord_user_id", { length: 32 }).unique(),
    username: varchar("username", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 100 }),
    avatarUrl: text("avatar_url"),
    role: varchar("role", { length: 32 }).default("staff").notNull(),
    permissions: text("permissions").array().default([]).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    addedBy: varchar("added_by", { length: 32 }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_staffs_email").on(table.email),
    uniqueIndex("idx_staffs_dashboard_user_id").on(table.dashboardUserId),
    uniqueIndex("idx_staffs_discord_user_id").on(table.discordUserId),
    index("idx_staffs_role").on(table.role),
    index("idx_staffs_is_active").on(table.isActive),
  ]
);

// ============================================================================
// 9. AUDIT LOGS & SYSTEM
// ============================================================================
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").references(() => staffs.id, { onDelete: "set null" }),
    discordUserId: varchar("discord_user_id", { length: 32 }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 64 }),
    details: jsonb("details").default({}).notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_audit_logs_staff_id").on(table.staffId),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_created_at").on(table.createdAt),
  ]
);

export const pendingIngest = pgTable(
  "pending_ingest",
  {
    id: serial("id").primaryKey(),
    uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    tmpPath: text("tmp_path").notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    detectedPluginName: varchar("detected_plugin_name", { length: 128 }),
    detectedVersion: varchar("detected_version", { length: 64 }),
    detectedPlatform: varchar("detected_platform", { length: 32 }),
    status: varchar("status", { length: 32 }).default("needs_review").notNull(),
    errorReason: varchar("error_reason", { length: 64 }).notNull(),
    errorDetail: text("error_detail").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_pending_ingest_status").on(table.status),
    index("idx_pending_ingest_sha256").on(table.sha256),
  ]
);

export const cardTopups = pgTable(
  "card_topups",
  {
    id: serial("id").primaryKey(),
    requestId: varchar("request_id", { length: 64 }).unique().notNull(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    telco: varchar("telco", { length: 32 }).notNull(),
    serial: varchar("serial", { length: 64 }).notNull(),
    code: varchar("code", { length: 64 }).default("").notNull(),
    declaredValue: integer("declared_value").notNull(),
    actualValue: integer("actual_value"),
    netAmount: integer("net_amount"),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    providerStatus: integer("provider_status"),
    providerMessage: text("provider_message").default("").notNull(),
    transId: varchar("trans_id", { length: 64 }),
    attempts: integer("attempts").default(0).notNull(),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_card_topups_poll").on(table.status, table.nextPollAt),
    index("idx_card_topups_user").on(table.discordUserId, table.createdAt),
    index("idx_card_topups_serial").on(table.serial),
  ]
);

export const config = pgTable("config", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 10. MIGRATION CHECKPOINTS (Atomic Batch Progress)
// ============================================================================
export const migrationCheckpoints = pgTable(
  "migration_checkpoints",
  {
    stepName: varchar("step_name", { length: 64 }).primaryKey(),
    status: varchar("status", { length: 20 }).notNull(), // in_progress | completed | failed
    lastProcessedKey: varchar("last_processed_key", { length: 128 }),
    processedCount: integer("processed_count").default(0).notNull(),
    checksum: varchar("checksum", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  }
);

// ============================================================================
// 11. MIGRATION & RECONCILIATION EXCEPTIONS STORE
// ============================================================================
export const migrationExceptions = pgTable(
  "_migration_exceptions",
  {
    id: serial("id").primaryKey(),
    source: varchar("source", { length: 32 }).notNull(), // 'migration' | 'runtime_reconciliation' | 'runtime_worker'
    runId: varchar("run_id", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: integer("entity_id").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    evidence: jsonb("evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_migration_exceptions_entity").on(table.entityType, table.entityId),
    index("idx_migration_exceptions_reason").on(table.reasonCode),
    uniqueIndex("idx_migration_exceptions_uniq").on(
      table.source,
      table.runId,
      table.entityType,
      table.entityId,
      table.reasonCode
    ),
  ]
);

// ============================================================================
// RELATIONS DEFINITION
// ============================================================================
export const pluginsRelations = relations(plugins, ({ many }) => ({
  versions: many(versions),
  manualUploads: many(manualUploads),
}));

export const versionsRelations = relations(versions, ({ one, many }) => ({
  plugin: one(plugins, {
    fields: [versions.pluginId],
    references: [plugins.id],
  }),
  orders: many(orders),
  manualUploads: many(manualUploads),
  deliveryJobs: many(deliveryJobs),
  deliveryLogs: many(deliveryLogs),
  downloadTokens: many(downloadTokens),
}));

export const manualUploadsRelations = relations(manualUploads, ({ one }) => ({
  plugin: one(plugins, {
    fields: [manualUploads.pluginId],
    references: [plugins.id],
  }),
  version: one(versions, {
    fields: [manualUploads.versionId],
    references: [versions.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  version: one(versions, {
    fields: [orders.versionId],
    references: [versions.id],
  }),
  transactions: many(sepayTransactions),
  deliveryJobs: many(deliveryJobs),
  deliveryLogs: many(deliveryLogs),
  downloadTokens: many(downloadTokens),
  discountRedemptions: many(discountCodeRedemptions),
}));

export const walletTopupsRelations = relations(walletTopups, ({ many }) => ({
  transactions: many(sepayTransactions),
}));

export const sepayTransactionsRelations = relations(
  sepayTransactions,
  ({ one }) => ({
    order: one(orders, {
      fields: [sepayTransactions.orderId],
      references: [orders.id],
    }),
    topup: one(walletTopups, {
      fields: [sepayTransactions.topupId],
      references: [walletTopups.id],
    }),
  })
);

export const discountCodesRelations = relations(discountCodes, ({ many }) => ({
  redemptions: many(discountCodeRedemptions),
}));

export const discountCodeRedemptionsRelations = relations(
  discountCodeRedemptions,
  ({ one }) => ({
    discount: one(discountCodes, {
      fields: [discountCodeRedemptions.discountId],
      references: [discountCodes.id],
    }),
    order: one(orders, {
      fields: [discountCodeRedemptions.orderId],
      references: [orders.id],
    }),
  })
);

export const deliveryJobsRelations = relations(deliveryJobs, ({ one }) => ({
  order: one(orders, {
    fields: [deliveryJobs.orderId],
    references: [orders.id],
  }),
  version: one(versions, {
    fields: [deliveryJobs.versionId],
    references: [versions.id],
  }),
}));

export const deliveryLogsRelations = relations(deliveryLogs, ({ one }) => ({
  order: one(orders, {
    fields: [deliveryLogs.orderId],
    references: [orders.id],
  }),
  version: one(versions, {
    fields: [deliveryLogs.versionId],
    references: [versions.id],
  }),
}));

export const downloadTokensRelations = relations(downloadTokens, ({ one }) => ({
  order: one(orders, {
    fields: [downloadTokens.orderId],
    references: [orders.id],
  }),
  version: one(versions, {
    fields: [downloadTokens.versionId],
    references: [versions.id],
  }),
}));

export const staffsRelations = relations(staffs, ({ many }) => ({
  auditLogs: many(auditLogs),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  staff: one(staffs, {
    fields: [auditLogs.staffId],
    references: [staffs.id],
  }),
}));
