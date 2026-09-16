/**
 * Runtime arrays are the single source of truth for these closed sets: the TS
 * union derives from the array, and src/db/schema.sql mirrors the same values in
 * CHECK constraints. Changing a set means changing both, deliberately.
 */
export const DESCRIPTOR_KINDS = ['paper', 'spigot', 'velocity', 'bungee', 'manual'] as const;
export type DescriptorKind = (typeof DESCRIPTOR_KINDS)[number];

/** Platform a plugin targets. Distinct from DescriptorKind, which is per-jar. */
export const PLUGIN_PLATFORMS = ['paper', 'spigot', 'velocity', 'bungee'] as const;
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/**
 * Trustworthiness of the extracted version string.
 * - ok: parsed cleanly from the descriptor
 * - unresolved-placeholder: literal `${project.version}` shipped in the jar
 * - regex-recovered: YAML failed to parse, value recovered by line regex
 * - manual: set by the owner in the dashboard
 */
export const VERSION_FLAGS = ['ok', 'unresolved-placeholder', 'regex-recovered', 'manual'] as const;
export type VersionFlag = (typeof VERSION_FLAGS)[number];

export type Plugin = {
  id: number;
  slug: string;
  displayName: string;
  descriptorName: string;
  platform: PluginPlatform;
  resourceId: number | null;
  depositPrice: number;
  isPremium: boolean;
  description: string;
  externalLink: string;
  createdAt: number;
};

/** Alternate descriptor name mapping to a plugin. Stored in plugin_aliases. */
export type PluginAlias = {
  pluginId: number;
  alias: string;
};

export type PluginVersion = {
  id: number;
  pluginId: number;
  /** Null only for platforms where version is optional (Velocity, BungeeCord). */
  version: string | null;
  rawVersion: string | null;
  sha256: string;
  relPath: string;
  bytes: number;
  originalName: string;
  descriptorKind: DescriptorKind;
  isStable: boolean;
  versionFlag: VersionFlag;
  uploadedAt: number;
};

/** Version joined with its plugin, for display in menus and logs. */
export type VersionWithPlugin = PluginVersion & {
  pluginSlug: string;
  pluginDisplayName: string;
  depositPrice: number;
};

/** Last-seen upstream version, used to notify once per new release. */
export type UpstreamState = {
  pluginId: number;
  /** Upstream identity. Version names are neither unique nor semver-ordered. */
  versionUuid: string;
  versionName: string;
  /** Milliseconds — Spiget returns seconds, the client converts at its boundary. */
  releaseDateMs: number;
  checkedAt: number;
};

/** Shared pagination envelope for dashboard lists and bot menus. */
export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
