/** Mirrored by a CHECK constraint on audit_log.delivery_method. */
export const DELIVERY_METHODS = ['attachment', 'link', 'manual'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export type AuditEntry = {
  id: number;
  discordUserId: string;
  versionId: number | null;
  orderId: number | null;
  /** Denormalized so the log survives plugin/version deletion. */
  pluginName: string;
  /** Empty string when the version had no version string (Velocity/Bungee). */
  versionLabel: string;
  amount: number;
  deliveryMethod: DeliveryMethod;
  ip: string | null;
  deliveredAt: number;
};

export type DeliveryOutcome =
  | { ok: true; method: DeliveryMethod; downloadUrl?: string; blobPath?: string; filename?: string }
  /**
   * The recipient blocks DMs or shares no mutual guild (error 50007 or 50278).
   * The download token stays valid, so a channel-ping recovery costs the admin
   * nothing and cannot double-charge.
   */
  | { ok: false; reason: 'dm_blocked'; downloadUrl?: string; blobPath?: string; filename?: string }
  | { ok: false; reason: 'error'; message: string; downloadUrl?: string; blobPath?: string; filename?: string };

export type MonthlyFundStats = {
  /** "YYYY-MM" */
  month: string;
  totalDownloads: number;
  totalAmount: number;
  perPlugin: { pluginName: string; downloads: number; amount: number }[];
  perUser: { discordUserId: string; downloads: number; amount: number }[];
};
