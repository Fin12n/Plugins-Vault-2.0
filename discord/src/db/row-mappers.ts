/**
 * Row <-> domain conversion in one place.
 *
 * Two mismatches make this worth centralizing: SQLite has no boolean type (so
 * every flag crosses as 0/1, and better-sqlite3 THROWS when handed a JS
 * boolean), and column names are snake_case while domain fields are camelCase.
 * Without this module each repository re-implements both, which is seven places
 * to get it wrong instead of one.
 */
import type { AuditEntry, DeliveryMethod } from '../domain/audit.js';
import type { Order, OrderStatus } from '../domain/order.js';
import type {
  DescriptorKind,
  Plugin,
  PluginPlatform,
  PluginVersion,
  UpstreamState,
  VersionFlag,
} from '../domain/plugin.js';
import type { LedgerEntry, LedgerKind, LedgerRefType, Wallet } from '../domain/wallet.js';
import type { DiscountCode, DiscountType } from '../domain/discount.js';

/** SQLite stores booleans as 0/1; binding a JS boolean is a runtime error. */
export function toSqlBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqlBool(value: number): boolean {
  return value === 1;
}

export type PluginRow = {
  id: number;
  slug: string;
  display_name: string;
  descriptor_name: string;
  platform: string;
  resource_id: number | null;
  deposit_price: number;
  is_premium: number;
  description?: string | null;
  external_link?: string | null;
  created_at: number;
};

export function toPlugin(row: PluginRow): Plugin {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    descriptorName: row.descriptor_name,
    platform: row.platform as PluginPlatform,
    resourceId: row.resource_id,
    depositPrice: row.deposit_price,
    isPremium: fromSqlBool(row.is_premium),
    description: row.description ?? '',
    externalLink: row.external_link ?? '',
    createdAt: row.created_at,
  };
}

export type DiscountRow = {
  id: number;
  code: string;
  type: string;
  value: number;
  min_order: number;
  max_discount: number | null;
  max_uses: number | null;
  used_count: number;
  expires_at: number | null;
  is_active: number;
  created_at: number;
};

export function toDiscountCode(row: DiscountRow): DiscountCode {
  return {
    id: row.id,
    code: row.code,
    type: row.type as DiscountType,
    value: row.value,
    minOrder: row.min_order,
    maxDiscount: row.max_discount,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    isActive: fromSqlBool(row.is_active),
    createdAt: row.created_at,
  };
}

export type VersionRow = {
  id: number;
  plugin_id: number;
  version: string | null;
  raw_version: string | null;
  sha256: string;
  rel_path: string;
  bytes: number;
  original_name: string;
  descriptor_kind: string;
  is_stable: number;
  version_flag: string;
  uploaded_at: number;
};

export function toPluginVersion(row: VersionRow): PluginVersion {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    rawVersion: row.raw_version,
    sha256: row.sha256,
    relPath: row.rel_path,
    bytes: row.bytes,
    originalName: row.original_name,
    descriptorKind: row.descriptor_kind as DescriptorKind,
    isStable: fromSqlBool(row.is_stable),
    versionFlag: row.version_flag as VersionFlag,
    uploadedAt: row.uploaded_at,
  };
}

export type OrderRow = {
  id: number;
  code: string;
  discord_user_id: string;
  version_id: number | null;
  plugin_name: string;
  version_label: string;
  amount: number;
  wallet_paid: number;
  bank_due: number;
  status: string;
  paid_amount: number | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  delivered_at: number | null;
};

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    code: row.code,
    discordUserId: row.discord_user_id,
    versionId: row.version_id,
    pluginName: row.plugin_name,
    versionLabel: row.version_label,
    amount: row.amount,
    walletPaid: row.wallet_paid,
    bankDue: row.bank_due,
    status: row.status as OrderStatus,
    paidAmount: row.paid_amount,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
  };
}

export type AuditRow = {
  id: number;
  discord_user_id: string;
  version_id: number | null;
  order_id: number | null;
  plugin_name: string;
  version_label: string;
  amount: number;
  delivery_method: string;
  ip: string | null;
  delivered_at: number;
};

export function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    versionId: row.version_id,
    orderId: row.order_id,
    pluginName: row.plugin_name,
    versionLabel: row.version_label,
    amount: row.amount,
    deliveryMethod: row.delivery_method as DeliveryMethod,
    ip: row.ip,
    deliveredAt: row.delivered_at,
  };
}

export type UpstreamStateRow = {
  plugin_id: number;
  version_uuid: string;
  version_name: string;
  release_date_ms: number;
  checked_at: number;
};

export function toUpstreamState(row: UpstreamStateRow): UpstreamState {
  return {
    pluginId: row.plugin_id,
    versionUuid: row.version_uuid,
    versionName: row.version_name,
    releaseDateMs: row.release_date_ms,
    checkedAt: row.checked_at,
  };
}

export type WalletRow = {
  discord_user_id: string;
  balance: number;
  created_at: number;
  updated_at: number;
};

export function toWallet(row: WalletRow): Wallet {
  return {
    discordUserId: row.discord_user_id,
    balance: row.balance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type LedgerRow = {
  id: number;
  discord_user_id: string;
  delta: number;
  balance_after: number;
  kind: string;
  ref_type: string;
  ref_id: number | null;
  note: string;
  created_at: number;
};

export function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    delta: row.delta,
    balanceAfter: row.balance_after,
    kind: row.kind as LedgerKind,
    refType: row.ref_type as LedgerRefType,
    refId: row.ref_id,
    note: row.note,
    createdAt: row.created_at,
  };
}
