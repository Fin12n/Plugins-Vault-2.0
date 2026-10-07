import { eq, and, or, ilike, desc, asc, lte, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { plugins, versions, type Plugin, type NewPlugin } from "@vault/db";

export type PluginWithVersionStats = Plugin & {
  versionCount: number;
};

/**
 * Tìm plugin theo ID số duy nhất.
 */
export async function findPluginById(
  db: Database,
  id: number
): Promise<Plugin | null> {
  const result = await db.select().from(plugins).where(eq(plugins.id, id));
  return result[0] ?? null;
}

/**
 * Tìm plugin theo plugin_id (mã định danh chuỗi nội bộ liên kết tài khoản).
 */
export async function findPluginByPluginId(
  db: Database,
  pluginId: string
): Promise<Plugin | null> {
  const result = await db
    .select()
    .from(plugins)
    .where(eq(plugins.pluginId, pluginId));
  return result[0] ?? null;
}

/**
 * Tìm plugin theo slug duy nhất.
 */
export async function findPluginBySlug(
  db: Database,
  slug: string
): Promise<Plugin | null> {
  const result = await db.select().from(plugins).where(eq(plugins.slug, slug));
  return result[0] ?? null;
}

/**
 * Tìm plugin theo tên descriptor trong jar, hoặc kiểm tra alias thay thế trong mảng aliases (GIN index).
 */
export async function findPluginByDescriptorName(
  db: Database,
  descriptorName: string
): Promise<Plugin | null> {
  // 1. Thử khớp trực tiếp descriptor_name
  const direct = await db
    .select()
    .from(plugins)
    .where(eq(plugins.descriptorName, descriptorName));
  if (direct[0]) return direct[0];

  // 2. Thử khớp qua mảng aliases (sử dụng ANY trên mảng text[] với GIN index)
  const viaAlias = await db
    .select()
    .from(plugins)
    .where(sql`${descriptorName} = ANY(${plugins.aliases})`);

  return viaAlias[0] ?? null;
}

/**
 * Tạo mới plugin trong catalog.
 */
export async function createPlugin(
  db: Database,
  input: NewPlugin
): Promise<Plugin> {
  const inserted = await db.insert(plugins).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể khởi tạo bản ghi plugin trong cơ sở dữ liệu");
  }
  return created;
}

/**
 * Cập nhật thông tin plugin.
 */
export async function updatePlugin(
  db: Database,
  id: number,
  patch: Partial<NewPlugin>
): Promise<Plugin | null> {
  const updated = await db
    .update(plugins)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(plugins.id, id))
    .returning();
  return updated[0] ?? null;
}

/**
 * Thêm alias tên gọi khác cho plugin vào mảng aliases.
 */
export async function addPluginAlias(
  db: Database,
  pluginId: number,
  alias: string
): Promise<void> {
  await db.execute(sql`
    UPDATE ${plugins}
    SET aliases = array_append(${plugins.aliases}, ${alias}), updated_at = now()
    WHERE id = ${pluginId} AND NOT (${alias} = ANY(${plugins.aliases}))
  `);
}

/**
 * Xóa alias khỏi mảng aliases của plugin.
 */
export async function removePluginAlias(
  db: Database,
  pluginId: number,
  alias: string
): Promise<void> {
  await db.execute(sql`
    UPDATE ${plugins}
    SET aliases = array_remove(${plugins.aliases}, ${alias}), updated_at = now()
    WHERE id = ${pluginId}
  `);
}

/**
 * Lấy danh sách alias của một plugin từ mảng aliases.
 */
export async function listPluginAliases(
  db: Database,
  pluginId: number
): Promise<string[]> {
  const rows = await db
    .select({ aliases: plugins.aliases })
    .from(plugins)
    .where(eq(plugins.id, pluginId));
  return rows[0]?.aliases ?? [];
}

/**
 * Đếm tổng số plugin có sẵn, hỗ trợ tìm kiếm.
 */
export async function countPlugins(
  db: Database,
  search?: string
): Promise<number> {
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    const raw = search.trim();
    const res = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(plugins)
      .where(
        or(
          ilike(plugins.displayName, term),
          ilike(plugins.slug, term),
          ilike(plugins.pluginId, term),
          ilike(plugins.descriptorName, term),
          sql`${raw} = ANY(${plugins.aliases})`
        )
      );
    return res[0]?.count ?? 0;
  }

  const res = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(plugins);
  return res[0]?.count ?? 0;
}

/**
 * Lấy danh sách plugins có phân trang và tìm kiếm.
 */
export async function listPlugins(
  db: Database,
  limit = 20,
  offset = 0,
  search?: string
): Promise<Plugin[]> {
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    const raw = search.trim();
    return db
      .select()
      .from(plugins)
      .where(
        or(
          ilike(plugins.displayName, term),
          ilike(plugins.slug, term),
          ilike(plugins.pluginId, term),
          ilike(plugins.descriptorName, term),
          sql`${raw} = ANY(${plugins.aliases})`
        )
      )
      .orderBy(desc(plugins.id))
      .limit(limit)
      .offset(offset);
  }

  return db
    .select()
    .from(plugins)
    .orderBy(desc(plugins.id))
    .limit(limit)
    .offset(offset);
}

/**
 * Lấy danh sách plugins kèm số lượng phiên bản thực tế (dùng cho Panel / Menu).
 */
export async function listPluginsWithVersionStats(
  db: Database,
  limit = 25
): Promise<PluginWithVersionStats[]> {
  const rows = await db
    .select({
      id: plugins.id,
      pluginId: plugins.pluginId,
      slug: plugins.slug,
      displayName: plugins.displayName,
      descriptorName: plugins.descriptorName,
      aliases: plugins.aliases,
      platform: plugins.platform,
      resourceId: plugins.resourceId,
      depositPrice: plugins.depositPrice,
      isPremium: plugins.isPremium,
      description: plugins.description,
      spigotLink: plugins.spigotLink,
      enabled: plugins.enabled,
      scanIntervalSeconds: plugins.scanIntervalSeconds,
      nextScanAt: plugins.nextScanAt,
      lastScanAt: plugins.lastScanAt,
      lastScanStatus: plugins.lastScanStatus,
      lastScanError: plugins.lastScanError,
      createdAt: plugins.createdAt,
      updatedAt: plugins.updatedAt,
      versionCount: sql<number>`count(${versions.id})::int`,
    })
    .from(plugins)
    .leftJoin(versions, eq(plugins.id, versions.pluginId))
    .groupBy(plugins.id)
    .orderBy(desc(plugins.id))
    .limit(limit);

  return rows;
}

/**
 * Tìm plugin theo bất kỳ định danh nào: ID số, pluginId, slug, descriptorName hoặc alias.
 */
export async function findPluginByAny(
  db: Database,
  query: string
): Promise<Plugin | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const numId = parseInt(trimmed, 10);
  if (!isNaN(numId) && String(numId) === trimmed) {
    const byId = await findPluginById(db, numId);
    if (byId) return byId;
  }

  const byPluginId = await findPluginByPluginId(db, trimmed);
  if (byPluginId) return byPluginId;

  const bySlug = await findPluginBySlug(db, trimmed);
  if (bySlug) return bySlug;

  const byDescriptor = await findPluginByDescriptorName(db, trimmed);
  if (byDescriptor) return byDescriptor;

  const term = `%${trimmed}%`;
  const byName = await db
    .select()
    .from(plugins)
    .where(
      or(
        ilike(plugins.displayName, term),
        ilike(plugins.slug, term),
        ilike(plugins.pluginId, term),
        sql`${trimmed} = ANY(${plugins.aliases})`
      )
    )
    .limit(1);

  return byName[0] ?? null;
}

/**
 * Tìm plugin theo source platform và source resource ID (e.g. platform='spigot', resourceId=12345).
 */
export async function findPluginBySourceIdentity(
  db: Database,
  platform: string,
  resourceId: number,
): Promise<Plugin | null> {
  const result = await db
    .select()
    .from(plugins)
    .where(
      and(
        eq(plugins.platform, platform),
        eq(plugins.resourceId, resourceId),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

/**
 * Lấy hoặc tạo mới Plugin theo cách lũy biến (idempotent getOrCreate).
 * Khớp theo source identity (platform + resourceId) hoặc theo slug.
 */
export async function getOrCreatePlugin(
  db: Database,
  input: NewPlugin,
): Promise<Plugin> {
  // 1. Khớp theo external source identity nếu có
  if (input.platform && input.resourceId !== undefined && input.resourceId !== null) {
    const bySource = await findPluginBySourceIdentity(db, input.platform, input.resourceId);
    if (bySource) return bySource;
  }

  // 2. Khớp theo slug duy nhất
  if (input.slug) {
    const bySlug = await findPluginBySlug(db, input.slug);
    if (bySlug) return bySlug;
  }

  // 3. Khớp theo pluginId duy nhất
  if (input.pluginId) {
    const byPluginId = await findPluginByPluginId(db, input.pluginId);
    if (byPluginId) return byPluginId;
  }

  // 4. Chèn mới với cơ chế an toàn concurrency
  try {
    return await createPlugin(db, input);
  } catch (err: any) {
    if (input.platform && input.resourceId !== undefined && input.resourceId !== null) {
      const bySource = await findPluginBySourceIdentity(db, input.platform, input.resourceId);
      if (bySource) return bySource;
    }
    if (input.slug) {
      const bySlug = await findPluginBySlug(db, input.slug);
      if (bySlug) return bySlug;
    }
    if (input.pluginId) {
      const byPluginId = await findPluginByPluginId(db, input.pluginId);
      if (byPluginId) return byPluginId;
    }
    throw err;
  }
}

/**
 * Lấy danh sách các plugin đủ điều kiện quét phiên bản từ xa.
 * Điều kiện: enabled = true, resourceId không rỗng, và (nextScanAt IS NULL hoặc nextScanAt <= now).
 */
export async function listEligiblePluginsForScan(
  db: Database,
  now: Date = new Date(),
  limit = 50,
): Promise<Plugin[]> {
  return await db
    .select()
    .from(plugins)
    .where(
      and(
        eq(plugins.enabled, true),
        sql`${plugins.resourceId} IS NOT NULL`,
        or(
          isNull(plugins.nextScanAt),
          lte(plugins.nextScanAt, now),
        ),
      ),
    )
    .orderBy(asc(plugins.nextScanAt))
    .limit(limit);
}

/**
 * Cập nhật trạng thái và thời gian sau khi hoàn tất một lượt quét plugin.
 */
export async function updatePluginScanResult(
  db: Database,
  id: number,
  params: {
    lastScanAt: Date;
    lastScanStatus: string;
    lastScanError: string | null;
    nextScanAt: Date;
  },
): Promise<Plugin | null> {
  const updated = await db
    .update(plugins)
    .set({
      lastScanAt: params.lastScanAt,
      lastScanStatus: params.lastScanStatus,
      lastScanError: params.lastScanError,
      nextScanAt: params.nextScanAt,
      updatedAt: new Date(),
    })
    .where(eq(plugins.id, id))
    .returning();

  return updated[0] ?? null;
}
