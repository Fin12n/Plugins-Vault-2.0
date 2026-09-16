import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { now, type Db } from '../../db/connection.js';
import { getSettings, setSetting } from '../../db/settings-store.js';
import {
  addAlias,
  bulkUpdatePluginPrices,
  countPlugins,
  createPlugin,
  deletePlugin,
  findPluginById,
  findPluginBySlug,
  listAliases,
  listPlugins,
  updatePlugin,
} from '../../repositories/plugins.js';
import {
  createDiscountCode,
  deleteDiscountCode,
  listDiscountCodes,
  toggleDiscountActive,
  updateDiscountCode,
} from '../../repositories/discounts.js';
import { getDepositLeaderboard, setLeaderboardResetAt } from '../../repositories/leaderboard.js';
import { batchResolveDiscordUsers } from '../../services/discord/user-resolver.js';
import { getOverviewAnalytics } from '../../services/stats/overview-stats.js';
import {
  deleteVersionAndCheckBlob,
  listVersionsByPlugin,
  setVersionStable,
  setVersionString,
} from '../../repositories/versions.js';
import { listPendingIngest } from '../../repositories/pending-ingest.js';
import {
  findOrderById,
  listUndeliveredPaidOrders,
  markOrderStatus,
  refundOrderWallet,
} from '../../repositories/orders.js';
import { assignPendingIngest, discardPendingIngest } from '../../services/ingest/assign-pending-ingest.js';
import { findUsedOrderToken, revokeOrderTokens } from '../../services/delivery/mint-download-token.js';
import { fulfilOrder } from '../../services/payment/match-and-fulfil-order.js';
import type { DeliveryDeps } from '../../services/delivery/deliver-version.js';
import { listAuditLog, monthBounds, monthlyFundStats } from '../../services/stats/monthly-fund-stats.js';
import {
  applyLedgerEntry,
  countLedger,
  countWallets,
  getBalance,
  listLedger,
  listWallets,
  reconcileBalances,
  sumWalletBalances,
} from '../../repositories/wallets.js';
import {
  cardFeeCost,
  countCardTopups,
  findCardTopupById,
  listCardTopups,
  listCardsNeedingReview,
} from '../../repositories/card-topups.js';
import { CARD_REVIEW_STATUSES } from '../../domain/card-topup.js';
import { creditReviewedCard, markCardResolvedWithoutCredit } from '../../services/card/resolve-reviewed-card.js';
import { loadSpigotCredentials, saveSpigotCredentials } from '../../services/upstream/spigot-credential-store.js';
import { parseSpigotCredentialText } from '../../services/upstream/spigot-credential-import.js';
import { findScanState, forgetScanState } from '../../repositories/account-scan-state.js';
import {
  assignPluginOwnership,
  findUnassignedPlugins,
  listAccountOwnedPlugins,
  listAllPluginOwnerships,
  recordOwnership,
  removePluginOwnership,
} from '../../repositories/resource-ownership.js';
import { normalizeName } from '../../services/upstream/sync-purchased-resources.js';
import { seedImportedPurchasedResources } from '../../services/upstream/seed-imported-purchased-resources.js';
import { sweepLogs } from '../../services/maintenance/sweep-logs.js';
import { instanceTracker } from '../../services/maintenance/instance-tracker.js';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaintenanceControl } from '../server.js';
import type { SpigotChallengeSessionController } from '../../services/upstream/spigot-challenge-session.js';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    env: Env;
    delivery?: DeliveryDeps;
    maintenance?: MaintenanceControl;
    challengeSessions?: SpigotChallengeSessionController;
  },
): void {
  const { db, env } = deps;

  /**
   * Reconcile view: orders paid but not delivered. This is the recovery path when
   * a webhook is missed, since SePay publishes no transaction-query API.
   */
  /**
   * Đơn đã trả tiền mà chưa giao được.
   *
   * Kèm `linkUsedAt` cho từng đơn: một đơn `dm_blocked` có thể đã được khách tải qua
   * liên kết dù DM báo lỗi, và biết điều đó đổi hẳn quyết định — hoàn coin cho một đơn
   * khách đã tải là mất trắng, còn hoàn cho đơn chưa tải thì chỉ là trả lại tiền.
   */
  app.get('/api/orders/undelivered', async () => ({
    items: listUndeliveredPaidOrders(db).map((order) => ({
      ...order,
      linkUsedAt: findUsedOrderToken(db, order.id)?.usedAt ?? null,
    })),
  }));

  app.post('/api/orders/:id/release', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!deps.delivery) return reply.code(503).send({ error: 'Bot chưa sẵn sàng' });

    const result = await fulfilOrder({ db, delivery: deps.delivery }, id, { manual: true });
    if (!result.ok) return reply.code(409).send({ error: result.reason ?? 'Không giao được' });
    return { released: true };
  });

  /**
   * Returns the coins an order is holding, when the owner decides it is dead.
   *
   * Explicit rather than automatic on a delivery failure: a failure is usually
   * temporary, and refunding while the order is still releasable would hand back
   * the coins and then the file. This is the deliberate "give up on it" action.
   */
  app.post('/api/orders/:id/refund-wallet', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const order = findOrderById(db, id);
    if (!order) return reply.code(404).send({ error: 'Không tìm thấy đơn' });
    if (order.walletPaid === 0) return reply.code(409).send({ error: 'Đơn này không giữ coin nào' });

    if (!refundOrderWallet(db, id, 'chủ kho hoàn coin')) {
      return reply.code(409).send({ error: 'Không hoàn được — đơn đã giao hoặc đã hoàn' });
    }
    /*
     * Thu hồi liên kết tải TRƯỚC khi đóng đơn.
     *
     * Một đơn `dm_blocked` giữ liên kết tải còn hiệu lực (cố ý: Discord có thể báo lỗi
     * 50007 dù tin đã tới). Hoàn coin mà để liên kết sống là khách vừa lấy lại tiền vừa
     * tải được tệp — đúng cái mà repository cảnh báo là "tặng không tệp jar", nhưng
     * đường này lại không hề chặn. Thu hồi ở đây đóng đúng lỗ đó, và chỉ chạm tới liên
     * kết chưa dùng nên một lần tải đã ghi sổ vẫn còn nguyên dấu vết.
     */
    const revoked = revokeOrderTokens(db, id);
    // Closed out too: leaving it in the reconcile view after refunding invites a
    // release that would deliver for coins no longer held.
    markOrderStatus(db, id, 'expired');
    return { refunded: order.walletPaid, revokedLinks: revoked };
  });

  app.get('/api/plugins', async (request) => {
    const { page, pageSize, q } = pageQuery.parse(request.query);
    const total = countPlugins(db, q);
    const items = listPlugins(db, pageSize, (page - 1) * pageSize, q).map((plugin) => ({
      ...plugin,
      aliases: listAliases(db, plugin.id),
      versionCount: listVersionsByPlugin(db, plugin.id).length,
    }));
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  });

  app.get('/api/plugins/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const plugin = findPluginById(db, id);
    if (!plugin) return reply.code(404).send({ error: 'Không tìm thấy plugin' });
    return { ...plugin, aliases: listAliases(db, id), versions: listVersionsByPlugin(db, id) };
  });

  const createPluginSchema = z.object({
    displayName: z.string().min(1).max(200),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-_]+$/i).optional(),
    descriptorName: z.string().min(1).max(200).optional(),
    platform: z.enum(['paper', 'spigot', 'velocity', 'bungee']).default('spigot'),
    depositPrice: z.number().int().min(0).default(0),
    isPremium: z.boolean().default(false),
    resourceId: z.number().int().positive().nullable().optional(),
    description: z.string().max(5000).default(''),
    externalLink: z.string().max(1000).default(''),
  });

  app.post('/api/plugins', async (request, reply) => {
    const body = createPluginSchema.parse(request.body);
    let baseSlug = (body.slug || body.displayName)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!baseSlug) baseSlug = 'plugin-' + Date.now();

    let slug = baseSlug;
    let counter = 1;
    while (findPluginBySlug(db, slug)) {
      slug = `${baseSlug}-${counter++}`;
    }

    const descriptorName = body.descriptorName || body.displayName;
    let externalLink = body.externalLink?.trim() ?? '';
    if (!externalLink && body.resourceId) {
      externalLink = `https://www.spigotmc.org/resources/${body.resourceId}/`;
    }
    const plugin = createPlugin(db, {
      ...body,
      externalLink,
      slug,
      descriptorName,
    });
    return reply.code(201).send(plugin);
  });

  const patchPlugin = z.object({
    displayName: z.string().min(1).max(200).optional(),
    resourceId: z.number().int().positive().nullable().optional(),
    depositPrice: z.number().int().min(0).optional(),
    isPremium: z.boolean().optional(),
    description: z.string().max(5000).optional(),
    externalLink: z.string().max(1000).optional(),
  });

  app.patch('/api/plugins/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = findPluginById(db, id);
    if (!existing) return reply.code(404).send({ error: 'Không tìm thấy plugin' });
    const patch = patchPlugin.parse(request.body);
    if (patch.resourceId && (patch.externalLink === undefined || patch.externalLink.trim() === '')) {
      if (!existing.externalLink || existing.externalLink.trim() === '') {
        patch.externalLink = `https://www.spigotmc.org/resources/${patch.resourceId}/`;
      }
    }
    updatePlugin(db, id, patch);
    return { ...findPluginById(db, id), aliases: listAliases(db, id) };
  });

  const bulkPriceSchema = z.object({
    ids: z.array(z.number().int().positive()).optional(),
    allMatching: z.boolean().optional(),
    query: z.string().optional(),
    mode: z.enum(['set', 'add_fixed', 'multiply_percent']),
    value: z.number().int(),
  });

  app.post('/api/plugins/bulk-price', async (request) => {
    const input = bulkPriceSchema.parse(request.body);
    const updatedCount = bulkUpdatePluginPrices(db, input);
    return { updatedCount };
  });

  app.post('/api/plugins/:id/aliases', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { alias } = z.object({ alias: z.string().min(1).max(200) }).parse(request.body);
    if (!findPluginById(db, id)) return reply.code(404).send({ error: 'Không tìm thấy plugin' });
    addAlias(db, id, alias);
    return { aliases: listAliases(db, id) };
  });

  app.delete('/api/plugins/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!findPluginById(db, id)) return reply.code(404).send({ error: 'Không tìm thấy plugin' });

    // Collect blob paths before the cascade removes the rows that name them.
    const versions = listVersionsByPlugin(db, id);
    deletePlugin(db, id);
    for (const version of versions) {
      await unlink(join(env.VAULT_DIR, version.relPath)).catch(() => undefined);
    }
    return { deleted: true, removedVersions: versions.length };
  });

  const bulkDeleteSchema = z.object({
    ids: z.array(z.number().int().positive()).optional(),
    allMatching: z.boolean().optional(),
    query: z.string().optional(),
  });

  app.post('/api/plugins/bulk-delete', async (request) => {
    const input = bulkDeleteSchema.parse(request.body);
    let targetIds: number[] = [];

    if (input.allMatching) {
      if (input.query && input.query.trim()) {
        const rows = db
          .prepare('SELECT id FROM plugins WHERE display_name LIKE ?')
          .all(`%${input.query.trim()}%`) as { id: number }[];
        targetIds = rows.map((r) => r.id);
      } else {
        const rows = db.prepare('SELECT id FROM plugins').all() as { id: number }[];
        targetIds = rows.map((r) => r.id);
      }
    } else if (input.ids && input.ids.length > 0) {
      targetIds = input.ids;
    }

    if (targetIds.length === 0) {
      return { deletedCount: 0, removedVersions: 0 };
    }

    let removedVersionsTotal = 0;
    for (const id of targetIds) {
      if (!findPluginById(db, id)) continue;
      const versions = listVersionsByPlugin(db, id);
      deletePlugin(db, id);
      removedVersionsTotal += versions.length;
      for (const version of versions) {
        await unlink(join(env.VAULT_DIR, version.relPath)).catch(() => undefined);
      }
    }

    return { deletedCount: targetIds.length, removedVersions: removedVersionsTotal };
  });

  const patchVersion = z.object({
    version: z.string().min(1).max(100).optional(),
    isStable: z.boolean().optional(),
  });

  app.patch('/api/versions/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const patch = patchVersion.parse(request.body);
    if (patch.version !== undefined) setVersionString(db, id, patch.version);
    if (patch.isStable !== undefined) setVersionStable(db, id, patch.isStable);
    return { updated: true };
  });

  app.delete('/api/versions/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const outcome = deleteVersionAndCheckBlob(db, id);
    if (!outcome.deleted) return reply.code(404).send({ error: 'Không tìm thấy phiên bản' });

    // Unlink only when nothing references the blob any more; the check ran inside
    // the same transaction as the delete.
    if (outcome.blobUnreferenced && outcome.sha256) {
      await unlink(join(env.VAULT_DIR, outcome.sha256.slice(0, 2), outcome.sha256)).catch(() => undefined);
    }
    return { deleted: true, blobRemoved: outcome.blobUnreferenced };
  });

  app.get('/api/pending', async () => ({ items: listPendingIngest(db) }));

  const assignBody = z.object({
    pluginId: z.number().int().positive(),
    version: z.string().min(1).max(100),
    aliasName: z.string().min(1).max(200).optional(),
  });

  app.post('/api/pending/:id/assign', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = assignBody.parse(request.body);
    const result = await assignPendingIngest(
      { db, vaultDir: env.VAULT_DIR },
      { pendingId: id, ...body },
    );
    if (!result.ok) {
      const status = result.reason === 'duplicate' ? 409 : 404;
      return reply.code(status).send({ error: result.reason });
    }
    return { assigned: true, version: result.version };
  });

  app.delete('/api/pending/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const removed = await discardPendingIngest(db, id);
    if (!removed) return reply.code(404).send({ error: 'Không tìm thấy tệp chờ' });
    return { discarded: true };
  });

  app.get('/api/stats/monthly', async (request) => {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonth()) })
      .parse(request.query);
    const stats = monthlyFundStats(db, month);
    const userIds = stats.perUser.map((u) => u.discordUserId);
    const profiles = await batchResolveDiscordUsers(deps.delivery?.client, userIds);
    const enrichedPerUser = stats.perUser.map((u) => ({
      ...u,
      userProfile: profiles.get(u.discordUserId) ?? {
        id: u.discordUserId,
        username: u.discordUserId,
        displayName: u.discordUserId,
        avatarUrl: null,
      },
    }));
    return { ...stats, perUser: enrichedPerUser };
  });

  const leaderboardQuery = z.object({
    timeframe: z.enum(['all', 'month', 'week', 'today']).default('all'),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  });

  app.get('/api/leaderboard', async (request) => {
    const { timeframe, page, pageSize } = leaderboardQuery.parse(request.query);
    const currentTs = now();
    let since = 0;
    if (timeframe === 'today') {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      since = Math.floor(date.getTime() / 1000);
    } else if (timeframe === 'week') {
      since = Math.max(0, currentTs - 7 * 86400);
    } else if (timeframe === 'month') {
      const date = new Date();
      date.setDate(1);
      date.setHours(0, 0, 0, 0);
      since = Math.floor(date.getTime() / 1000);
    }
    const leaderboard = getDepositLeaderboard(db, { since, page, pageSize });
    const userIds = leaderboard.items.map((i) => i.discordUserId);
    const profiles = await batchResolveDiscordUsers(deps.delivery?.client, userIds);
    const enrichedItems = leaderboard.items.map((item) => ({
      ...item,
      userProfile: profiles.get(item.discordUserId) ?? {
        id: item.discordUserId,
        username: item.discordUserId,
        displayName: item.discordUserId,
        avatarUrl: null,
      },
    }));
    return { ...leaderboard, items: enrichedItems };
  });

  app.post('/api/leaderboard/reset', async (request) => {
    const { undo } = z.object({ undo: z.boolean().optional() }).parse(request.body ?? {});
    if (undo) {
      setLeaderboardResetAt(db, null);
      return { ok: true, resetAt: null };
    }
    const resetTs = now();
    setLeaderboardResetAt(db, resetTs);
    return { ok: true, resetAt: resetTs };
  });

  const overviewQuery = z.object({
    timeframe: z.enum(['7d', '30d', 'this_month', 'last_month', 'custom', 'all']).default('30d'),
    type: z.enum(['all', 'bank', 'card']).default('all'),
    from: z.string().optional(),
    to: z.string().optional(),
  });

  app.get('/api/overview', async (request) => {
    const { timeframe, type, from, to } = overviewQuery.parse(request.query);
    const overview = getOverviewAnalytics(db, timeframe, type, from, to);
    const userIds = overview.recentTopups.map((t) => t.discordUserId);
    const profiles = await batchResolveDiscordUsers(deps.delivery?.client, userIds);
    const enrichedRecent = overview.recentTopups.map((topup) => ({
      ...topup,
      userProfile: profiles.get(topup.discordUserId) ?? {
        id: topup.discordUserId,
        username: topup.discordUserId,
        displayName: topup.discordUserId,
        avatarUrl: null,
      },
    }));
    return { ...overview, recentTopups: enrichedRecent };
  });

  app.get('/api/discounts', async () => {
    return { items: listDiscountCodes(db) };
  });

  const createDiscountSchema = z.object({
    code: z.string().min(2).max(50),
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().positive(),
    minOrder: z.number().int().min(0).default(0),
    maxDiscount: z.number().int().positive().nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    expiresAt: z.number().int().nullable().optional(),
    isActive: z.boolean().default(true),
  });

  app.post('/api/discounts', async (request, reply) => {
    const body = createDiscountSchema.parse(request.body);
    const discount = createDiscountCode(db, body);
    return reply.code(201).send(discount);
  });

  const patchDiscountSchema = z.object({
    code: z.string().min(2).max(50).optional(),
    type: z.enum(['percent', 'fixed']).optional(),
    value: z.number().int().positive().optional(),
    minOrder: z.number().int().min(0).optional(),
    maxDiscount: z.number().int().positive().nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    expiresAt: z.number().int().nullable().optional(),
    isActive: z.boolean().optional(),
  });

  app.patch('/api/discounts/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchDiscountSchema.parse(request.body);
    const discount = updateDiscountCode(db, id, body);
    return discount;
  });

  app.patch('/api/discounts/:id/toggle', async (request) => {
    const { id } = idParam.parse(request.params);
    const { active } = z.object({ active: z.boolean().optional() }).parse(request.body ?? {});
    const discount = toggleDiscountActive(db, id, active);
    return { ok: true, discount, ...discount };
  });

  app.delete('/api/discounts/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    deleteDiscountCode(db, id);
    return { deleted: true, id };
  });

  app.get('/api/log', async (request) => {
    const { page, pageSize } = pageQuery.parse(request.query);
    const { month, userId } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), userId: z.string().optional() })
      .parse(request.query);
    const log = listAuditLog(db, { month, discordUserId: userId }, page, pageSize);
    const userIds = log.items.map((i) => i.discordUserId);
    const profiles = await batchResolveDiscordUsers(deps.delivery?.client, userIds);
    const enrichedItems = log.items.map((item) => ({
      ...item,
      userProfile: profiles.get(item.discordUserId) ?? {
        id: item.discordUserId,
        username: item.discordUserId,
        displayName: item.discordUserId,
        avatarUrl: null,
      },
    }));
    return { ...log, items: enrichedItems };
  });

  /**
   * Wallet overview.
   *
   * `drift` is expected to be empty forever. It is non-empty only if some write
   * path changed a balance without recording it, which is silent and
   * unrecoverable by the time anyone notices — so it is surfaced here rather than
   * left for a query nobody runs.
   */
  app.get('/api/wallets', async (request) => {
    const { page, pageSize, q } = pageQuery.parse(request.query);
    // Chỉ nhận chữ số: Discord ID là số, và một chuỗi bất kỳ đưa vào LIKE chỉ tạo ra
    // những lượt quét bảng không bao giờ khớp.
    const search = q && /^\d{1,20}$/.test(q) ? q : undefined;
    const total = countWallets(db, search);
    return {
      items: listWallets(db, pageSize, (page - 1) * pageSize, search),
      drift: reconcileBalances(db),
      // Tổng nợ người dùng: khoản đối ứng của quỹ, không phải tiền của quỹ. Luôn tính
      // trên TOÀN BỘ ví, không theo bộ lọc — một tổng chạy theo bộ lọc đọc thành số nợ
      // thật thì rất dễ hiểu sai.
      balanceSum: sumWalletBalances(db),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  });

  app.get('/api/wallets/:userId/ledger', async (request) => {
    const { userId } = z.object({ userId: z.string().regex(/^\d{17,20}$/) }).parse(request.params);
    const { page, pageSize } = pageQuery.parse(request.query);
    const total = countLedger(db, userId);
    return {
      items: listLedger(db, userId, pageSize, (page - 1) * pageSize),
      balance: getBalance(db, userId),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  });

  const adjustBody = z.object({
    discordUserId: z.string().regex(/^\d{17,20}$/),
    // Signed: the owner may need to take coins back as well as grant them.
    delta: z.number().int().refine((n) => n !== 0, 'phải khác 0'),
    // Required, not optional: an unexplained manual adjustment is indistinguishable
    // from a bug when read back months later.
    note: z.string().min(1).max(200),
  });

  app.post('/api/wallets/adjust', async (request, reply) => {
    const body = adjustBody.parse(request.body);
    const balance = applyLedgerEntry(db, {
      discordUserId: body.discordUserId,
      delta: body.delta,
      kind: 'manual',
      note: body.note,
    });
    if (balance === null) return reply.code(409).send({ error: 'Số dư không đủ để trừ' });
    return { balance };
  });

  /**
   * Card top-ups, with the owner's fee cost for the month.
   *
   * The cost is the point of this view: the fee is absorbed rather than passed on,
   * so the gap between what was credited and what card2k actually paid is
   * invisible anywhere else.
   */
  app.get('/api/cards', async (request) => {
    const { page, pageSize } = pageQuery.parse(request.query);
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonth()) })
      .parse(request.query);
    const bounds = monthBounds(month);
    const total = countCardTopups(db);

    /**
     * Mã PIN chỉ đi kèm những phiếu ĐANG chờ người xử lý.
     *
     * Chủ kho phải tự tra phiếu treo trên card2k, việc đó cần cả serial và PIN — nên
     * giấu PIN ở đó là bắt họ mở cơ sở dữ liệu. Ngược lại, danh sách lịch sử không có
     * việc gì với PIN, mà nó vẫn đang được gửi nguyên sang trình duyệt: gửi một bí mật
     * tới chỗ không ai dùng là rủi ro không đổi lại được gì. Sau khi cộng ví xong,
     * repository tự xoá PIN khỏi cơ sở dữ liệu.
     */
    const withoutPin = ({ code: _code, ...rest }: { code: string }): unknown => rest;

    return {
      items: listCardTopups(db, pageSize, (page - 1) * pageSize).map(withoutPin),
      review: listCardsNeedingReview(db),
      month,
      cost: cardFeeCost(db, bounds.from, bounds.to),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  });

  /**
   * Settles a card the poll could not resolve.
   *
   * Only reachable for 'timeout' and 'needs_review' — the states where the outcome
   * is genuinely unknown. Crediting goes through the same claim as the automatic
   * path, so releasing a card the poll settled a moment earlier cannot double-pay.
   */
  const resolveBody = z.object({
    credit: z.boolean(),
    /** Required when crediting: the poll never learned the card's real value. */
    amount: z.number().int().positive().optional(),
  });

  app.post('/api/cards/:id/resolve', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = resolveBody.parse(request.body);

    const card = findCardTopupById(db, id);
    if (!card) return reply.code(404).send({ error: 'Không tìm thấy phiếu nạp thẻ' });
    if (!CARD_REVIEW_STATUSES.includes(card.status)) {
      return reply.code(409).send({ error: 'Phiếu này không ở trạng thái cần xử lý' });
    }

    if (!body.credit) {
      markCardResolvedWithoutCredit(db, id);
      return { credited: false };
    }

    const amount = body.amount ?? card.actualValue ?? card.declaredValue;
    const credited = creditReviewedCard(db, id, amount);
    if (!credited) return reply.code(409).send({ error: 'Phiếu này đã được cộng ví' });
    return { credited: true, amount };
  });

  app.get('/api/settings', async () => getSettings(db, env));
  const settingsBody = z.object({
    adminRoleIds: z.array(z.string().regex(/^\d{17,20}$/)).min(1).optional(),
    pruneKeepCount: z.number().int().min(1).max(1000).optional(),
    attachMaxBytes: z.number().int().min(0).optional(),
    orderTtlMinutes: z.number().int().min(1).max(1440).optional(),
    downloadTokenTtlMinutes: z.number().int().min(1).max(1440).optional(),
    autoDownloadEnabled: z.boolean().optional(),
  });

  app.patch('/api/settings', async (request) => {
    const body = settingsBody.parse(request.body);
    if (body.adminRoleIds) setSetting(db, 'admin_role_ids', body.adminRoleIds.join(','));
    if (body.pruneKeepCount !== undefined) setSetting(db, 'prune_keep_count', String(body.pruneKeepCount));
    if (body.attachMaxBytes !== undefined) setSetting(db, 'attach_max_bytes', String(body.attachMaxBytes));
    if (body.orderTtlMinutes !== undefined) setSetting(db, 'order_ttl_minutes', String(body.orderTtlMinutes));
    if (body.downloadTokenTtlMinutes !== undefined) {
      setSetting(db, 'download_token_ttl_minutes', String(body.downloadTokenTtlMinutes));
    }
    if (body.autoDownloadEnabled !== undefined) {
      setSetting(db, 'auto_download_enabled', body.autoDownloadEnabled ? 'true' : 'false');
    }
    return getSettings(db, env);
  });

  /**
   * Auto-download account health.
   *
   * A separate route and a separate shape from /api/settings on purpose: cookie
   * values must never be reachable through the settings payload, so widening that
   * response is not an option. Only labels and a liveness flag leave the server.
   *
   * Served from the accounts file as loaded, never by probing Spigot — a probe on
   * a GET would turn a page refresh into outbound traffic.
   */
  app.get('/api/spigot-accounts', async () => {
    const load = loadSpigotCredentials(env.SPIGOT_CREDENTIALS_FILE);
    if (!load.ok) return { configured: false, reason: load.reason, accounts: [] };
    return {
      configured: true,
      accounts: load.credentials.map((account) => {
        const scan = findScanState(db, account.label);
        const liveScan = scan === null
          ? { status: 'never' as const, lastScanAt: null, resourceCount: null, error: null }
          : scan.lastError === ''
            ? { status: 'ok' as const, lastScanAt: scan.lastScanAt, resourceCount: scan.resourceCount, error: null }
            : { status: 'error' as const, lastScanAt: scan.lastScanAt, resourceCount: scan.resourceCount, error: scan.lastError };
        const ownedPlugins = listAccountOwnedPlugins(db, account.label);
        return {
          label: account.label,
          username: account.username,
          enabled: account.enabled !== false,
          purchasedResources: account.purchasedResources ?? [],
          importedStatus: account.importedStatus ?? '',
          exclusionReason: account.exclusionReason ?? '',
          liveScan,
          ownedPlugins,
        };
      }),
    };
  });

  app.get('/api/spigot-accounts/ownership', async () => {
    const load = loadSpigotCredentials(env.SPIGOT_CREDENTIALS_FILE);
    const accounts = load.ok
      ? load.credentials.map((acc) => ({
          label: acc.label,
          username: acc.username,
          enabled: acc.enabled !== false,
          purchasedCount: (acc.purchasedResources ?? []).length,
          ownedPlugins: listAccountOwnedPlugins(db, acc.label),
        }))
      : [];

    const unassignedPlugins = findUnassignedPlugins(db);
    const allPlugins = listPlugins(db, countPlugins(db), 0)
      .filter((p) => p.resourceId !== null)
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        slug: p.slug,
        resourceId: p.resourceId!,
      }));

    return {
      ok: true,
      accounts,
      unassignedPlugins,
      allPlugins,
    };
  });

  const assignOwnershipBody = z.object({
    resourceId: z.coerce.number().int().positive(),
    accountLabel: z.string().min(1),
  });

  app.post('/api/spigot-accounts/assign-ownership', async (request, reply) => {
    const parse = assignOwnershipBody.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'Dữ liệu không hợp lệ: resourceId và accountLabel là bắt buộc' });
    }
    const { resourceId, accountLabel } = parse.data;
    assignPluginOwnership(db, resourceId, accountLabel);
    sweepLogs.add(`🔗 Đã gán quyền sở hữu plugin #${resourceId} cho tài khoản @${accountLabel}`, 'info');
    return { ok: true, resourceId, accountLabel };
  });

  app.post('/api/spigot-accounts/remove-ownership', async (request, reply) => {
    const parse = assignOwnershipBody.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'Dữ liệu không hợp lệ: resourceId và accountLabel là bắt buộc' });
    }
    const { resourceId, accountLabel } = parse.data;
    const removed = removePluginOwnership(db, resourceId, accountLabel);
    sweepLogs.add(`✂️ Đã gỡ quyền sở hữu plugin #${resourceId} khỏi tài khoản @${accountLabel}`, 'info');
    return { ok: true, removed };
  });

  app.post('/api/spigot-accounts/auto-link', async (_request, reply) => {
    const load = loadSpigotCredentials(env.SPIGOT_CREDENTIALS_FILE);
    if (!load.ok) {
      return reply.code(400).send({ error: 'Không thể đọc tệp tài khoản Spigot' });
    }

    const plugins = listPlugins(db, countPlugins(db), 0);
    const byName = new Map<string, { resourceId: number; displayName: string } | 'ambiguous'>();
    for (const plugin of plugins) {
      if (plugin.resourceId === null) continue;
      for (const candidate of [plugin.displayName, plugin.descriptorName, ...listAliases(db, plugin.id)]) {
        const key = normalizeName(candidate);
        if (!key) continue;
        const existing = byName.get(key);
        if (existing && existing !== 'ambiguous' && existing.resourceId !== plugin.resourceId) {
          byName.set(key, 'ambiguous');
        } else if (!existing) {
          byName.set(key, { resourceId: plugin.resourceId, displayName: plugin.displayName });
        }
      }
    }

    let linkedCount = 0;
    const details: string[] = [];

    for (const account of load.credentials) {
      if (account.enabled === false || !account.purchasedResources) continue;
      for (const resource of account.purchasedResources) {
        const key = normalizeName(resource);
        if (!key) continue;
        const match = byName.get(key);
        if (match && match !== 'ambiguous') {
          if (assignPluginOwnership(db, match.resourceId, account.label)) {
            linkedCount++;
            details.push(`${match.displayName} (#${match.resourceId}) -> @${account.label}`);
          }
        }
      }
    }

    sweepLogs.add(`⚡ Tự động liên kết hoàn tất: Đã gán ${linkedCount} plugin vào đúng tài khoản sở hữu.`, 'success');
    return { ok: true, linkedCount, details };
  });

  const credentialTextBody = z.object({ text: z.string().min(1).max(900_000) });
  const previewCredentials = (text: string) => {
    const parsed = parseSpigotCredentialText(text);
    if (!parsed.ok) return parsed;
    return {
      ok: true as const,
      accounts: parsed.credentials.map((account) => ({
        label: account.label,
        username: account.username,
        enabled: account.enabled !== false,
        purchasedResources: account.purchasedResources ?? [],
        importedStatus: account.importedStatus ?? '',
        exclusionReason: account.exclusionReason ?? '',
      })),
      summary: {
        total: parsed.credentials.length,
        enabled: parsed.credentials.filter((account) => account.enabled !== false).length,
        excluded: parsed.credentials.filter((account) => account.enabled === false).length,
        resources: new Set(parsed.credentials.flatMap((account) => account.purchasedResources ?? [])).size,
      },
    };
  };

  app.post('/api/spigot-credentials/preview', async (request, reply) => {
    const result = previewCredentials(credentialTextBody.parse(request.body).text);
    if (!result.ok) return reply.code(400).send({ error: result.detail });
    return result;
  });

  app.put('/api/spigot-credentials', async (request, reply) => {
    const { text } = credentialTextBody.parse(request.body);
    const parsed = parseSpigotCredentialText(text);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.detail });
    saveSpigotCredentials(env.SPIGOT_CREDENTIALS_FILE, parsed.credentials);

    const plugins = listPlugins(db, countPlugins(db), 0);
    const byName = new Map<string, { resourceId: number } | 'ambiguous'>();
    for (const plugin of plugins) {
      if (plugin.resourceId === null) continue;
      for (const candidate of [plugin.displayName, plugin.descriptorName, ...listAliases(db, plugin.id)]) {
        const key = normalizeName(candidate);
        if (!key) continue;
        const existing = byName.get(key);
        if (existing && existing !== 'ambiguous' && existing.resourceId !== plugin.resourceId) byName.set(key, 'ambiguous');
        else if (!existing) byName.set(key, { resourceId: plugin.resourceId });
      }
    }

    let linkedOwnerships = 0;
    for (const account of parsed.credentials) {
      // Imported inventory is seed data, not proof of a successful browser scan.
      // Saving also covers corrected passwords: the next sweep must retry now.
      forgetScanState(db, account.label);
      if (account.importedStatus !== 'success' || !account.purchasedResources) continue;
      for (const resource of account.purchasedResources) {
        const match = byName.get(normalizeName(resource));
        if (!match || match === 'ambiguous') continue;
        if (recordOwnership(db, match.resourceId, account.label, 'owned')) linkedOwnerships++;
      }
    }

    const createdPlugins = seedImportedPurchasedResources(db, parsed.credentials);

    return { ...previewCredentials(text), linkedOwnerships, createdPlugins };
  });

  app.post('/api/spigot-accounts/scan-now', async (_request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ quét chưa sẵn sàng' });
    }
    const triggered = deps.maintenance.triggerScanOnly
      ? deps.maintenance.triggerScanOnly()
      : deps.maintenance.triggerUpdateCheck(true);

    if (!triggered) {
      return reply.code(409).send({ error: 'Một lượt quét hoặc tải đang chạy' });
    }
    return reply.code(202).send({ ok: true, status: deps.maintenance.getUpdateStatus() });
  });

  app.get('/api/spigot-downloads/run', async () =>
    deps.maintenance?.getUpdateStatus() ?? { running: false, lastStartedAt: null, lastFinishedAt: null },
  );

  app.post('/api/spigot-downloads/run-download-now', async (_request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ tải chưa sẵn sàng' });
    }
    if (!getSettings(db, env).autoDownloadEnabled) {
      return reply.code(409).send({ error: 'Hãy bật tự động tải Spigot trong Cài đặt trước khi chạy' });
    }
    const triggered = deps.maintenance.triggerOrderedDownload
      ? deps.maintenance.triggerOrderedDownload()
      : deps.maintenance.triggerUpdateCheck(true);

    if (!triggered) {
      return reply.code(409).send({ error: 'Một lượt tải đang chạy' });
    }
    return reply.code(202).send(deps.maintenance.getUpdateStatus());
  });

  app.post('/api/spigot-downloads/run', async (_request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ tải chưa sẵn sàng' });
    }
    if (!getSettings(db, env).autoDownloadEnabled) {
      return reply.code(409).send({ error: 'Hãy bật tự động tải Spigot trong Cài đặt trước khi chạy' });
    }
    const triggered = deps.maintenance.triggerOrderedDownload
      ? deps.maintenance.triggerOrderedDownload()
      : deps.maintenance.triggerUpdateCheck(true);

    if (!triggered) {
      return reply.code(409).send({ error: 'Một lượt tải đang chạy' });
    }
    return reply.code(202).send(deps.maintenance.getUpdateStatus());
  });

  app.post('/api/spigot-downloads/run-all', async (request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ tải chưa sẵn sàng' });
    }
    if (!getSettings(db, env).autoDownloadEnabled) {
      return reply.code(409).send({ error: 'Hãy bật tự động tải Spigot trong Cài đặt trước khi chạy' });
    }
    const body = (request.body ?? {}) as { autoResolveIds?: boolean };
    const triggered = deps.maintenance.triggerFullBatchDownload
      ? deps.maintenance.triggerFullBatchDownload({ autoResolveIds: body.autoResolveIds !== false })
      : deps.maintenance.triggerUpdateCheck(true);

    if (!triggered) {
      return reply.code(409).send({ error: 'Một lượt quét hoặc tải đang chạy' });
    }
    return reply.code(202).send(deps.maintenance.getUpdateStatus());
  });

  app.post('/api/spigot-downloads/stop', async (_request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ tải chưa sẵn sàng' });
    }
    const stopped = deps.maintenance.abortSweep ? await deps.maintenance.abortSweep() : false;
    sweepLogs.add('🛑 [Khẩn cấp] Đã kích hoạt dừng khẩn cấp toàn bộ các luồng tải!', 'warn');
    instanceTracker.resetAll();
    return reply.code(200).send({ ok: true, stopped });
  });

  app.get('/api/spigot-downloads/logs', async (request) => {
    const query = request.query as { since?: string; workerId?: string };
    const sinceId = query.since ? Number(query.since) : undefined;
    const workerId =
      query.workerId !== undefined && query.workerId !== '' && !Number.isNaN(Number(query.workerId))
        ? Number(query.workerId)
        : undefined;
    const status = deps.maintenance?.getUpdateStatus() ?? {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
    };
    const settings = getSettings(db, env);
    const proxyEnabled = settings.spigotProxyEnabled;
    const hasProxyConfig = Boolean(
      env.SPIGOT_PROXY_API_URL || env.SPIGOT_PROXY_RENEW_URL || env.SPIGOT_PROXY_LIST || env.SPIGOT_PROXY_FILE,
    );
    const fallbackProxy = hasProxyConfig ? 'Chờ kích hoạt' : 'Direct (IP máy chủ)';
    return {
      ...status,
      proxyEnabled,
      currentProxyIp: proxyEnabled ? (sweepLogs.getCurrentProxyIp() || fallbackProxy) : 'Direct (IP máy chủ)',
      activeWorkers: sweepLogs.getActiveWorkerIds(),
      logs: sweepLogs.getAll(sinceId, workerId),
    };
  });

  app.post('/api/spigot-proxy/toggle', async (request, reply) => {
    const body = (request.body ?? {}) as { enabled?: boolean };
    const current = getSettings(db, env).spigotProxyEnabled;
    const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : !current;
    setSetting(db, 'spigot_proxy_enabled', nextEnabled ? 'true' : 'false');

    if (!nextEnabled) {
      sweepLogs.setCurrentProxyIp('Direct (IP máy chủ)');
      sweepLogs.add('⚙️ Đã TẮT Proxy: Kết nối tới Spigot sẽ đi thẳng bằng IP máy chủ.', 'warn');
    } else {
      const hasProxyConfig = Boolean(
        env.SPIGOT_PROXY_API_URL || env.SPIGOT_PROXY_RENEW_URL || env.SPIGOT_PROXY_LIST || env.SPIGOT_PROXY_FILE,
      );
      sweepLogs.setCurrentProxyIp(hasProxyConfig ? 'Chờ kích hoạt' : 'Direct (IP máy chủ)');
      sweepLogs.add('⚙️ Đã BẬT Proxy: Sẽ sử dụng Proxy xoay IP cho các lượt kết nối Spigot.', 'info');
    }
    return reply.code(200).send({ ok: true, proxyEnabled: nextEnabled });
  });

  app.post('/api/spigot-proxy/rotate', async (_request, reply) => {
    if (!deps.maintenance || deps.maintenance.isReady?.() === false) {
      return reply.code(503).send({ error: 'Bộ tải chưa sẵn sàng' });
    }
    if (!deps.maintenance.rotateProxy) {
      return reply.code(501).send({ error: 'Tính năng xoay proxy chưa khả dụng' });
    }
    const result = await deps.maintenance.rotateProxy();
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error ?? 'Không thể xoay proxy' });
    }
    return reply.code(200).send({ ok: true, currentProxyIp: result.currentProxyIp });
  });

  app.post('/api/spigot-downloads/logs/clear', async (request) => {
    const body = (request.body ?? {}) as { workerId?: number };
    if (typeof body.workerId === 'number') {
      sweepLogs.clear(body.workerId);
    } else {
      sweepLogs.clear();
    }
    return { ok: true };
  });

  app.get('/api/spigot-downloads/instances', async () => {
    const settings = getSettings(db, env);
    return {
      concurrency: settings.spigotDownloadConcurrency,
      activeWorkers: instanceTracker.getActiveCount(),
      instances: instanceTracker.getAll(),
    };
  });

  app.post('/api/spigot-downloads/concurrency', async (request, reply) => {
    const body = (request.body ?? {}) as { concurrency?: number };
    const concurrency = Number(body.concurrency);
    if (!concurrency || concurrency < 1 || concurrency > 10) {
      return reply.code(400).send({ error: 'Số luồng chạy đồng thời phải từ 1 đến 10' });
    }
    setSetting(db, 'spigot_download_concurrency', String(concurrency));
    instanceTracker.pruneExtraWorkers(concurrency);
    sweepLogs.add(`⚙️ Đã cập nhật số luồng tải song song: ${concurrency} worker(s)`, 'info');
    return reply.code(200).send({ ok: true, concurrency });
  });

  app.get('/api/spigot-challenge', async () =>
    deps.challengeSessions?.getStatus() ?? {
      active: false,
      accountLabel: null,
      reason: null,
      startedAt: null,
      expiresAt: null,
    },
  );

  app.get('/api/spigot-challenge/frame', async (_request, reply) => {
    if (!deps.challengeSessions?.hasActive()) return reply.code(404).send({ error: 'Không có phiên xác minh đang mở' });
    try {
      const frame = await deps.challengeSessions.captureFrame();
      return reply
        .header('cache-control', 'no-store')
        .header('x-frame-width', String(frame.width))
        .header('x-frame-height', String(frame.height))
        .type('image/jpeg')
        .send(frame.image);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const normalizedPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
  app.post('/api/spigot-challenge/pointer', async (request, reply) => {
    const body = normalizedPoint.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Tá»a Ä‘á»™ khÃ´ng há»£p lá»‡' });
    try {
      await deps.challengeSessions?.movePointer(body.data.x, body.data.y);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/spigot-challenge/click', async (request, reply) => {
    const body = normalizedPoint.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Tọa độ không hợp lệ' });
    try {
      await deps.challengeSessions?.click(body.data.x, body.data.y);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const keyBody = z.object({ key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace']) });
  app.post('/api/spigot-challenge/key', async (request, reply) => {
    const body = keyBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Phím không hợp lệ' });
    try {
      await deps.challengeSessions?.pressKey(body.data.key);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const textBody = z.object({ text: z.string().min(1).max(500) });
  app.post('/api/spigot-challenge/type', async (request, reply) => {
    const body = textBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Nội dung nhập không hợp lệ' });
    try {
      await deps.challengeSessions?.typeText(body.data.text);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/spigot-challenge/retry', async (_request, reply) => {
    if (!deps.challengeSessions?.hasActive()) return reply.code(404).send({ error: 'Không có phiên xác minh đang mở' });
    try {
      const result = await deps.challengeSessions.retryLogin();
      if (!result.ok) return reply.code(409).send(result);
      await deps.challengeSessions.resolve();
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/spigot-challenge', async () => {
    await deps.challengeSessions?.close();
    return { ok: true };
  });
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
