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
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    paidAt: timestamp("paid_at"),
    deliveredAt: timestamp("delivered_at"),
  },
  (table) => [
    index("idx_orders_status").on(table.status),
    index("idx_orders_user").on(table.discordUserId),
    index("idx_orders_version_id").on(table.versionId),
    index("idx_orders_code").on(table.code),
  ]
);

export const sepayTransactions = pgTable(
  "sepay_transactions",
  {
    id: serial("id").primaryKey(),
    sepayId: integer("sepay_id").unique().notNull(),
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    amount: integer("amount").notNull(),
    transferType: varchar("transfer_type", { length: 10 }).notNull(),
    code: varchar("code", { length: 64 }),
    content: text("content").default("").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sepay_tx_sepay_id").on(table.sepayId),
    index("idx_sepay_tx_code").on(table.code),
  ]
);

// ============================================================================
// 3. WALLETS & LEDGER
// ============================================================================
export const wallets = pgTable("wallets", {
  discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
  balance: integer("balance").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const walletLedger = pgTable(
  "wallet_ledger",
  {
    id: serial("id").primaryKey(),
    discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    kind: varchar("kind", { length: 30 }).notNull(),
    refType: varchar("ref_type", { length: 20 }).default("").notNull(),
    refId: integer("ref_id"),
    note: text("note").default("").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_wallet_ledger_user").on(table.discordUserId, table.createdAt),
  ]
);

// ============================================================================
// 4. DISCOUNTS
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
    expiresAt: timestamp("expires_at"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_discount_codes_code").on(table.code),
    index("idx_discount_codes_active").on(table.isActive),
  ]
);

// ============================================================================
// 5. SPIGOT ACCOUNTS & AUTOMATION STATE
// ============================================================================
export const spigotAccounts = pgTable(
  "spigot_accounts",
  {
    id: serial("id").primaryKey(),
    label: varchar("label", { length: 64 }).unique().notNull(),
    username: varchar("username", { length: 128 }).notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    xfUserEncrypted: text("xf_user_encrypted").default("").notNull(),
    xfSessionEncrypted: text("xf_session_encrypted").default("").notNull(),
    status: varchar("status", { length: 20 }).default("ok").notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_spigot_accounts_status").on(table.status),
    index("idx_spigot_accounts_enabled").on(table.isEnabled),
  ]
);

export const resourceOwnership = pgTable(
  "resource_ownership",
  {
    id: serial("id").primaryKey(),
    resourceId: integer("resource_id").notNull(),
    accountLabel: varchar("account_label", { length: 64 }).notNull(),
    state: varchar("state", { length: 20 }).notNull(),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_resource_ownership_pair").on(
      table.resourceId,
      table.accountLabel
    ),
    index("idx_resource_ownership_state").on(table.resourceId, table.state),
  ]
);

export const upstreamState = pgTable("upstream_state", {
  pluginId: integer("plugin_id")
    .primaryKey()
    .references(() => plugins.id, { onDelete: "cascade" }),
  versionUuid: varchar("version_uuid", { length: 64 }).notNull(),
  versionName: varchar("version_name", { length: 64 }).notNull(),
  releaseDateMs: text("release_date_ms").notNull(),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
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
    nextAttemptAt: timestamp("next_attempt_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
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
// 6. DISCORD CHANNELS & SYSTEM CONFIGURATION
// ============================================================================
export const discordChannels = pgTable(
  "discord_channels",
  {
    id: serial("id").primaryKey(),
    purpose: varchar("purpose", { length: 32 }).unique().notNull(), // 'notify' | 'orders' | 'audit' | 'panel'
    channelId: varchar("channel_id", { length: 32 }).notNull(),     // Snowflake ID kênh
    channelName: varchar("channel_name", { length: 100 }),          // Tên hiển thị (ví dụ: #bao-cao-loi)
    guildId: varchar("guild_id", { length: 32 }),                   // Server Discord ID
    isEnabled: boolean("is_enabled").default(true).notNull(),       // Bật/tắt thông báo vào kênh này
    updatedBy: varchar("updated_by", { length: 32 }),               // Staff ID hoặc Discord User ID sửa
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_discord_channels_purpose").on(table.purpose),
  ]
);

// ============================================================================
// 7. STAFFS & PERMISSIONS (Decoupled Authentication Architecture)
// ============================================================================
export const staffs = pgTable(
  "staffs",
  {
    id: serial("id").primaryKey(),
    
    // Nhận diện tài khoản & Ánh xạ đa nền tảng
    email: varchar("email", { length: 255 }).unique(),                  // Khóa ánh xạ với Email từ Dashboard Auth DB
    dashboardUserId: varchar("dashboard_user_id", { length: 64 }).unique(), // UUID / User ID từ Dashboard Auth DB (nếu có)
    discordUserId: varchar("discord_user_id", { length: 32 }).unique(), // Snowflake ID của Staff trên Discord Bot
    username: varchar("username", { length: 64 }).notNull(),             // Tên tài khoản hiển thị
    displayName: varchar("display_name", { length: 100 }),               // Tên hiển thị thân thiện
    avatarUrl: text("avatar_url"),                                       // Ảnh đại diện
    
    // Phân quyền & Vai trò (RBAC)
    role: varchar("role", { length: 32 }).default("staff").notNull(),   // 'owner' | 'admin' | 'moderator' | 'support'
    permissions: text("permissions").array().default([]).notNull(),      // Chi tiết quyền hạn
    
    // Trạng thái & Vết
    isActive: boolean("is_active").default(true).notNull(),              // Khóa tài khoản tức thì khi cần
    addedBy: varchar("added_by", { length: 32 }),                        // ID người tạo tài khoản
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
// 8. AUDIT LOGS (Nhật ký hành động hệ thống)
// ============================================================================
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").references(() => staffs.id, { onDelete: "set null" }),
    discordUserId: varchar("discord_user_id", { length: 32 }),
    action: varchar("action", { length: 64 }).notNull(),                   // 'channel.update', 'plugin.price_set', 'staff.add', etc.
    targetType: varchar("target_type", { length: 32 }), // 'channel', 'plugin', 'version', 'staff', 'wallet'
    targetId: varchar("target_id", { length: 64 }),
    details: jsonb("details").default({}).notNull(),   // Dữ liệu cũ và mới (diff)
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
    nextPollAt: timestamp("next_poll_at"),
    creditedAt: timestamp("credited_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
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
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


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
}));

export const sepayTransactionsRelations = relations(
  sepayTransactions,
  ({ one }) => ({
    order: one(orders, {
      fields: [sepayTransactions.orderId],
      references: [orders.id],
    }),
  })
);

export const staffsRelations = relations(staffs, ({ many }) => ({
  auditLogs: many(auditLogs),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  staff: one(staffs, {
    fields: [auditLogs.staffId],
    references: [staffs.id],
  }),
}));

