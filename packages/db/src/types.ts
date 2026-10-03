import { InferSelectModel, InferInsertModel } from "drizzle-orm";
import * as schema from "./schema.js";

// Plugin Types
export type Plugin = InferSelectModel<typeof schema.plugins>;
export type NewPlugin = InferInsertModel<typeof schema.plugins>;

export type Version = InferSelectModel<typeof schema.versions>;
export type NewVersion = InferInsertModel<typeof schema.versions>;

export type ManualUpload = InferSelectModel<typeof schema.manualUploads>;
export type NewManualUpload = InferInsertModel<typeof schema.manualUploads>;

// Order Types
export type Order = InferSelectModel<typeof schema.orders>;
export type NewOrder = InferInsertModel<typeof schema.orders>;

export type SepayTransaction = InferSelectModel<typeof schema.sepayTransactions>;
export type NewSepayTransaction = InferInsertModel<typeof schema.sepayTransactions>;

// Wallet Types
export type Wallet = InferSelectModel<typeof schema.wallets>;
export type NewWallet = InferInsertModel<typeof schema.wallets>;

export type WalletLedgerEntry = InferSelectModel<typeof schema.walletLedger>;
export type NewWalletLedgerEntry = InferInsertModel<typeof schema.walletLedger>;

// Discount Types
export type DiscountCode = InferSelectModel<typeof schema.discountCodes>;
export type NewDiscountCode = InferInsertModel<typeof schema.discountCodes>;

// Spigot & Crawler Types
export type SpigotAccount = InferSelectModel<typeof schema.spigotAccounts>;
export type NewSpigotAccount = InferInsertModel<typeof schema.spigotAccounts>;

export type ResourceOwnership = InferSelectModel<typeof schema.resourceOwnership>;
export type NewResourceOwnership = InferInsertModel<typeof schema.resourceOwnership>;

export type UpstreamState = InferSelectModel<typeof schema.upstreamState>;
export type NewUpstreamState = InferInsertModel<typeof schema.upstreamState>;

export type PendingDownload = InferSelectModel<typeof schema.pendingDownload>;
export type NewPendingDownload = InferInsertModel<typeof schema.pendingDownload>;

// Staff, Channel & Audit Types
export type DiscordChannel = InferSelectModel<typeof schema.discordChannels>;
export type NewDiscordChannel = InferInsertModel<typeof schema.discordChannels>;

export type Staff = InferSelectModel<typeof schema.staffs>;
export type NewStaff = InferInsertModel<typeof schema.staffs>;

export type AuditLog = InferSelectModel<typeof schema.auditLogs>;
export type NewAuditLog = InferInsertModel<typeof schema.auditLogs>;

export type PendingIngest = InferSelectModel<typeof schema.pendingIngest>;
export type NewPendingIngest = InferInsertModel<typeof schema.pendingIngest>;

export type CardTopup = InferSelectModel<typeof schema.cardTopups>;
export type NewCardTopup = InferInsertModel<typeof schema.cardTopups>;

export type SystemConfig = InferSelectModel<typeof schema.config>;
export type NewSystemConfig = InferInsertModel<typeof schema.config>;

