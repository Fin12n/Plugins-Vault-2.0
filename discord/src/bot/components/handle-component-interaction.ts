import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import type { CreatedOrder } from '../../domain/order.js';
import type { VersionWithPlugin } from '../../domain/plugin.js';
import { findPluginById, listPlugins, countPlugins } from '../../repositories/plugins.js';
import { findVersionWithPlugin, listVersionsByPlugin } from '../../repositories/versions.js';
import type { DeliveryDeps } from '../../services/delivery/deliver-version.js';
import { deliverVersion } from '../../services/delivery/deliver-version.js';
import type { OrderConfig } from '../../services/payment/match-and-fulfil-order.js';
import { openOrderNeon } from '../../services/payment/neon-payment-flow.js';
import { processNextDeliveryJob } from '../../services/delivery/neon-delivery-worker.js';
import { getNeonDb, type Database } from '../../db/neon.js';
import { botVi, shortDate } from '../i18n/bot-vi.js';
import {
  createBrowseContainer,
  createDeliveredContainer,
  createDirectDownloadContainer,
  createErrorContainer,
  createNoticeContainer,
  createPaymentContainer,
  createVersionsContainer,
  createWalletPaidContainer,
  v2Payload,
} from './build-v2-containers.js';
import { buildPagedSelect, toComponents, type SelectItem } from './build-paged-select.js';
import { hasAdminRole } from '../guards/require-admin-role.js';
import {
  buildBankTopupModal,
  buildCardModal,
  buildDenominationRow,
  buildTelcoRow,
} from '../commands/wallet-commands.js';
import type { Card2kConfig } from '../../services/card/card2k-client.js';
import { isTelco, TELCO_LABELS } from '../../services/card/card2k-telcos.js';

/**
 * custom_id grammar, budgeted against Discord's 100-character cap.
 *
 *   sel:p              plugin chosen
 *   pg:p:<page>        plugin page navigation
 *   sel:v:<pluginId>   version chosen
 *   pg:v:<pluginId>:<page>
 *   open:p             standing panel button — opens a private plugin menu
 *
 * Only short opaque keys — never serialized query or filter state.
 */
export const ID = {
  selectPlugin: 'sel:p',
  pagePlugin: 'pg:p',
  openPanel: 'open:p',
  selectVersion: (pluginId: number) => `sel:v:${pluginId}`,
  pageVersion: (pluginId: number) => `pg:v:${pluginId}`,
};

export type MaintenanceControl = {
  triggerUpdateCheck: (forcePurchasedScan?: boolean) => boolean;
  triggerFullBatchDownload: (options?: { autoResolveIds?: boolean }) => boolean;
  triggerScanOnly?: () => boolean;
  triggerOrderedDownload?: (options?: { targetResourceId?: number }) => boolean;
  getUpdateStatus: () => { running: boolean; lastStartedAt: number | Date | null; lastFinishedAt: number | Date | null };
  getCurrentOperation?: () => string;
  isReady: () => boolean;
  abortSweep?: () => Promise<boolean>;
  rotateProxy?: () => Promise<{ ok: boolean; currentProxyIp: string | null; error?: string }>;
};

export type BotDeps = {
  db: Db;
  neonDb?: Database;
  env: Env;
  delivery: DeliveryDeps;
  orders?: OrderConfig;
  /** Absent or incomplete disables card top-ups; see card2k-client. */
  card?: Card2kConfig;
  maintenance?: MaintenanceControl;
};

/** All plugins as select options, newest-first by name for stable paging. */
export function pluginOptions(db: Db): SelectItem[] {
  const total = countPlugins(db);
  return listPlugins(db, total, 0).map((plugin) => ({
    value: String(plugin.id),
    label: plugin.displayName,
    description: plugin.depositPrice > 0 ? `${plugin.depositPrice.toLocaleString('vi-VN')} ₫` : undefined,
  }));
}

/**
 * Versions as select options, newest upload first.
 *
 * Never ordered by version string: upstream names are neither unique nor
 * semver-ordered, so sorting by them would put "4.0.10" before "4.0.9".
 */
export function versionOptions(db: Db, pluginId: number): SelectItem[] {
  return listVersionsByPlugin(db, pluginId).map((version) => ({
    value: String(version.id),
    label: `${version.version ?? '—'}${version.isStable ? ` (${botVi.stableMark})` : ''}`,
    description: shortDate(version.uploadedAt),
  }));
}

export async function showPluginPage(
  interaction: StringSelectMenuInteraction | Parameters<typeof replyOrUpdate>[0],
  deps: BotDeps,
  page: number,
): Promise<void> {
  const items = pluginOptions(deps.db);
  if (items.length === 0) {
    await replyOrUpdate(
      interaction,
      createNoticeContainer(botVi.noPlugins, botVi.noPluginsHint),
      [],
    );
    return;
  }

  const paged = buildPagedSelect({
    items,
    page,
    selectId: ID.selectPlugin,
    navPrefix: ID.pagePlugin,
    placeholder: botVi.pickPlugin,
  });
  await replyOrUpdate(
    interaction,
    createBrowseContainer(items.length, paged.page, paged.totalPages),
    toComponents(paged),
  );
}

async function showVersionPage(
  interaction: Parameters<typeof replyOrUpdate>[0],
  deps: BotDeps,
  pluginId: number,
  page: number,
): Promise<void> {
  const plugin = findPluginById(deps.db, pluginId);
  if (!plugin) {
    await replyOrUpdate(
      interaction,
      createErrorContainer(botVi.staleMenu, botVi.staleMenuHint),
      [],
    );
    return;
  }

  const items = versionOptions(deps.db, pluginId);
  if (items.length === 0) {
    await replyOrUpdate(
      interaction,
      createNoticeContainer(botVi.noVersions, botVi.noVersionsHint),
      [],
    );
    return;
  }

  const paged = buildPagedSelect({
    items,
    page,
    selectId: ID.selectVersion(pluginId),
    navPrefix: ID.pageVersion(pluginId),
    placeholder: botVi.pickVersion,
  });

  const components: any[] = toComponents(paged);
  if (plugin.externalLink && plugin.externalLink.trim() !== '') {
    const linkButton = new ButtonBuilder()
      .setLabel(botVi.viewProductOnSpigot)
      .setStyle(ButtonStyle.Link)
      .setURL(plugin.externalLink.trim());
    if (paged.nav) {
      paged.nav.addComponents(linkButton);
    } else {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton));
    }
  }

  await replyOrUpdate(
    interaction,
    createVersionsContainer(plugin, items.length, paged.page, paged.totalPages),
    components,
  );
}

/**
 * Single global component handler.
 *
 * Replaces per-message collectors, which are in-memory and therefore break on
 * restart: the buttons stay on the message while nothing listens, and every click
 * answers "This interaction failed".
 */
export async function handleComponentInteraction(interaction: Interaction, deps: BotDeps): Promise<void> {
  if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

  const parts = interaction.customId.split(':');
  const [kind, scope, ...rest] = parts;

  // Wallet: the button exists purely so a modal can be opened. A modal must come
  // from an unanswered interaction, and the command that showed this button has
  // already replied.
  if (kind === 'w' && scope === 'bank' && interaction.isButton()) {
    await interaction.showModal(buildBankTopupModal());
    return;
  }

  // Card top-up, three steps: telco, denomination, then the modal. Split because
  // the denomination sets differ per telco, and offering a value card2k refuses
  // would consume the card for nothing.
  if (kind === 'w' && scope === 'card' && interaction.isButton()) {
    if (!deps.card) {
      const errorContainer = createErrorContainer(botVi.cardDisabled, botVi.cardDisabledHint);
      await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
      return;
    }
    const noticeContainer = createNoticeContainer(botVi.pickTelco, botVi.cardStepHint);
    await interaction.reply(v2Payload(noticeContainer, [buildTelcoRow()], { ephemeral: true }));
    return;
  }

  if (kind === 'w' && scope === 'telco' && interaction.isStringSelectMenu()) {
    const chosen = interaction.values[0] ?? '';
    if (!isTelco(chosen)) {
      const errorContainer = createErrorContainer(botVi.cardBadTelco, botVi.cardBadTelcoHint);
      await interaction.update(v2Payload(errorContainer, [], { ephemeral: true }));
      return;
    }
    const noticeContainer = createNoticeContainer(botVi.pickDenomination, botVi.cardAmountHint(TELCO_LABELS[chosen]));
    await interaction.update(v2Payload(noticeContainer, [buildDenominationRow(chosen)], { ephemeral: true }));
    return;
  }

  if (kind === 'w' && scope === 'amt' && interaction.isStringSelectMenu()) {
    const telco = rest[0] ?? '';
    const amount = Number(interaction.values[0]);
    if (!isTelco(telco) || !Number.isInteger(amount)) {
      const errorContainer = createErrorContainer(botVi.staleMenu, botVi.staleMenuHint);
      await interaction.update(v2Payload(errorContainer, [], { ephemeral: true }));
      return;
    }
    // showModal answers the interaction, so the select's own message stays as it
    // is — which is fine: it is ephemeral and the modal is now in front of them.
    await interaction.showModal(buildCardModal(telco, amount));
    return;
  }

  // The standing panel is one shared public message, so it must never be edited:
  // the first person to browse would rewrite the panel for everyone. Reply with a
  // private menu instead and leave the panel exactly as posted.
  if (kind === 'open' && scope === 'p') {
    if (!hasAdminRole(interaction, deps)) {
      const errorContainer = createErrorContainer(botVi.noAccess, botVi.noAccessHint);
      await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
      return;
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
    const items = pluginOptions(deps.db);
    if (items.length === 0) {
      await replyOrUpdate(
        interaction,
        createNoticeContainer(botVi.noPlugins, botVi.noPluginsHint),
        [],
      );
      return;
    }
    const paged = buildPagedSelect({
      items,
      page: 0,
      selectId: ID.selectPlugin,
      navPrefix: ID.pagePlugin,
      placeholder: botVi.pickPlugin,
    });
    await replyOrUpdate(
      interaction,
      createBrowseContainer(items.length, paged.page, paged.totalPages),
      toComponents(paged),
    );
    return;
  }

  if (kind === 'pg') {
    if (scope === 'p') {
      const page = Number(rest[0]);
      if (!Number.isInteger(page)) return void interaction.deferUpdate().catch(() => undefined);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => undefined);
      }
      await showPluginPage(interaction, deps, page);
      return;
    }
    if (scope === 'v') {
      const pluginId = Number(rest[0]);
      const page = Number(rest[1]);
      if (!Number.isInteger(pluginId) || !Number.isInteger(page)) return void interaction.deferUpdate().catch(() => undefined);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => undefined);
      }
      await showVersionPage(interaction, deps, pluginId, page);
      return;
    }
    // The disabled page-indicator button; acknowledge without changing anything.
    await interaction.deferUpdate().catch(() => undefined);
    return;
  }

  if (kind === 'sel') {
    if (scope === 'p' && interaction.isStringSelectMenu()) {
      const pluginId = Number(interaction.values[0]);
      if (!Number.isInteger(pluginId)) return void interaction.deferUpdate().catch(() => undefined);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => undefined);
      }
      await showVersionPage(interaction, deps, pluginId, 0);
      return;
    }
    if (scope === 'v') {
      // Khi bấm nút [📥 Tải Phiên Bản] hoặc [📥 Mua Phiên Bản Này] dạng Button
      if (interaction.isButton()) {
        const pluginId = Number(rest[0]);
        if (!Number.isInteger(pluginId)) return void interaction.deferUpdate().catch(() => undefined);

        const versions = listVersionsByPlugin(deps.db, pluginId);
        if (versions.length === 0) {
          const noticeContainer = createNoticeContainer(botVi.noVersions, botVi.noVersionsHint);
          await interaction.reply(v2Payload(noticeContainer, [], { ephemeral: true }));
          return;
        }

        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => undefined);
        }

        // Nếu chỉ có 1 phiên bản duy nhất: xử lý tải / mua thẳng phiên bản này
        if (versions.length === 1) {
          await handleVersionChosen(interaction, deps, versions[0]!.id);
          return;
        }

        // Nếu có nhiều phiên bản: mở danh sách phiên bản để người dùng chọn
        await showVersionPage(interaction, deps, pluginId, 0);
        return;
      }

      // Khi chọn phiên bản từ Select Menu
      if (interaction.isStringSelectMenu()) {
        const versionId = Number(interaction.values[0]);
        if (!Number.isInteger(versionId)) return void interaction.deferUpdate().catch(() => undefined);
        await handleVersionChosen(interaction, deps, versionId);
        return;
      }
    }
  }
}

async function updateComponentMessage(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  container: ContainerBuilder,
  extraComponents: any[] = [],
): Promise<void> {
  const payload = v2Payload(container, extraComponents, { ephemeral: true });
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.update(payload);
  }
}

/**
 * Delivers the chosen version, or opens a payment order first when the plugin
 * carries a deposit price.
 *
 * The interaction ends as soon as the QR is shown. An interaction token lives only
 * 15 minutes and deferReply does not extend it, so the file cannot be handed over
 * through this interaction later — the webhook delivers over the bot token
 * instead, which works indefinitely.
 */
async function handleVersionChosen(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  deps: BotDeps,
  versionId: number,
): Promise<void> {
  const version = findVersionWithPlugin(deps.db, versionId);
  if (!version) {
    await updateComponentMessage(
      interaction,
      createErrorContainer(botVi.staleMenu, botVi.staleMenuHint),
    );
    return;
  }

  if (version.depositPrice > 0 && deps.orders) {
    const neonDb = deps.neonDb ?? getNeonDb();
    const order = await openOrderNeon(neonDb, deps.orders, {
      discordUserId: interaction.user.id,
      versionId,
    });
    if (!order) {
      await updateComponentMessage(
        interaction,
        createErrorContainer(botVi.deliveryFailed, botVi.deliveryFailedHint),
      );
      return;
    }

    // Coins covered the whole price, so there is nothing to transfer and no
    // webhook will ever arrive to trigger delivery. Deliver here instead.
    if (order.bankDue === 0) {
      await deliverWalletPaidOrder(interaction, deps, version, order);
      return;
    }

    await updateComponentMessage(
      interaction,
      createPaymentContainer(version, order),
    );
    return;
  }

  await updateComponentMessage(
    interaction,
    createNoticeContainer(botVi.sending, botVi.sentBody(version.pluginDisplayName, version.version)),
  );

  const outcome = await deliverVersion(deps.delivery, {
    discordUserId: interaction.user.id,
    versionId,
  });

  if (outcome.ok) {
    const extraRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (outcome.downloadUrl) {
      extraRows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel('🔗 Tải Dự Phòng (Link)')
            .setStyle(ButtonStyle.Link)
            .setURL(outcome.downloadUrl),
        ),
      );
    }
    await interaction.editReply(
      v2Payload(createDeliveredContainer(version), extraRows, { ephemeral: true }),
    );
    return;
  }

  // Nếu không gửi được qua DM nhưng đã tạo được token tải trực tiếp
  if (outcome.downloadUrl) {
    const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('📥 Tải File Ngay Tại Đây')
        .setStyle(ButtonStyle.Link)
        .setURL(outcome.downloadUrl),
    );
    await interaction.editReply(
      v2Payload(createDirectDownloadContainer(version, outcome.downloadUrl), [linkRow], { ephemeral: true }),
    );
    return;
  }

  await interaction.editReply(
    v2Payload(
      createErrorContainer(
        outcome.reason === 'dm_blocked' ? botVi.dmBlocked : botVi.deliveryFailed,
        outcome.reason === 'dm_blocked' ? botVi.dmBlockedHint : (outcome.message ?? botVi.deliveryFailedHint),
      ),
      [],
      { ephemeral: true },
    ),
  );
}

/**
 * Delivers an order settled entirely from the wallet.
 *
 * Coins are already deducted at this point, so a delivery failure must return
 * them — otherwise the buyer has paid and received nothing. `dm_blocked` is the
 * exception the refund helper handles: the token stays valid there, so the file is
 * still collectable and refunding would give it away.
 */
async function deliverWalletPaidOrder(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  deps: BotDeps,
  version: VersionWithPlugin,
  order: CreatedOrder,
): Promise<void> {
  await updateComponentMessage(
    interaction,
    createWalletPaidContainer(version, order),
  );

  const neonDb = deps.neonDb ?? getNeonDb();
  const deliveryResult = await processNextDeliveryJob({
    neonDb,
    client: deps.delivery.client,
    vaultDir: deps.delivery.vaultDir,
    publicBaseUrl: deps.delivery.publicBaseUrl,
    attachMaxBytes: deps.delivery.attachMaxBytes,
    tokenTtlMinutes: deps.delivery.tokenTtlMinutes,
  });

  if (deliveryResult.success) {
    await interaction.editReply(
      v2Payload(createDeliveredContainer(version), [], { ephemeral: true }),
    );
    return;
  }

  await interaction.editReply(
    v2Payload(
      createErrorContainer(
        deliveryResult.reason === 'dm_blocked' ? botVi.dmBlocked : botVi.walletRefunded,
        deliveryResult.reason === 'dm_blocked' ? botVi.dmBlockedHint : botVi.walletRefundedHint,
      ),
      [],
      { ephemeral: true },
    ),
  );
}

/** Updates the message for a component interaction; replies for a command. */
async function replyOrUpdate(
  interaction: Interaction,
  container: ContainerBuilder,
  extraComponents: any[] = [],
): Promise<void> {
  const payload = v2Payload(container, extraComponents, { ephemeral: true });
  if (interaction.isStringSelectMenu() || interaction.isButton()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.update(payload);
    }
    return;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}
