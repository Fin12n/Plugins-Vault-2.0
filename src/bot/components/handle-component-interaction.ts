import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
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
import { fulfilOrder, openOrder } from '../../services/payment/match-and-fulfil-order.js';
import { botVi, formatVnd, shortDate } from '../i18n/bot-vi.js';
import {
  browseEmbed,
  deliveredEmbed,
  errorEmbed,
  noticeEmbed,
  paymentEmbed,
  versionsEmbed,
  walletPaidEmbed,
} from './build-embeds.js';
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

export type BotDeps = {
  db: Db;
  env: Env;
  delivery: DeliveryDeps;
  orders?: OrderConfig;
  /** Absent or incomplete disables card top-ups; see card2k-client. */
  card?: Card2kConfig;
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
    await replyOrUpdate(interaction, {
      embeds: [noticeEmbed(botVi.noPlugins, botVi.noPluginsHint)],
      components: [],
    });
    return;
  }

  const paged = buildPagedSelect({
    items,
    page,
    selectId: ID.selectPlugin,
    navPrefix: ID.pagePlugin,
    placeholder: botVi.pickPlugin,
  });
  await replyOrUpdate(interaction, {
    embeds: [browseEmbed(items.length, paged.page, paged.totalPages)],
    components: toComponents(paged),
  });
}

async function showVersionPage(
  interaction: Parameters<typeof replyOrUpdate>[0],
  deps: BotDeps,
  pluginId: number,
  page: number,
): Promise<void> {
  const plugin = findPluginById(deps.db, pluginId);
  if (!plugin) {
    await replyOrUpdate(interaction, {
      embeds: [errorEmbed(botVi.staleMenu, botVi.staleMenuHint)],
      components: [],
    });
    return;
  }

  const items = versionOptions(deps.db, pluginId);
  if (items.length === 0) {
    await replyOrUpdate(interaction, {
      embeds: [noticeEmbed(botVi.noVersions, botVi.noVersionsHint)],
      components: [],
    });
    return;
  }

  const paged = buildPagedSelect({
    items,
    page,
    selectId: ID.selectVersion(pluginId),
    navPrefix: ID.pageVersion(pluginId),
    placeholder: botVi.pickVersion,
  });

  const components = toComponents(paged);
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

  await replyOrUpdate(interaction, {
    embeds: [versionsEmbed(plugin, items.length, paged.page, paged.totalPages)],
    components,
  });
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

  // Re-check on every step: a role can be revoked between opening the menu and
  // choosing a version.
  if (!hasAdminRole(interaction, deps)) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.noAccess, botVi.noAccessHint)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

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
      await interaction.reply({
        embeds: [errorEmbed(botVi.cardDisabled, botVi.cardDisabledHint)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      embeds: [noticeEmbed(botVi.pickTelco, botVi.cardStepHint)],
      components: [buildTelcoRow()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (kind === 'w' && scope === 'telco' && interaction.isStringSelectMenu()) {
    const chosen = interaction.values[0] ?? '';
    if (!isTelco(chosen)) {
      await interaction.update({
        embeds: [errorEmbed(botVi.cardBadTelco, botVi.cardBadTelcoHint)],
        components: [],
      });
      return;
    }
    await interaction.update({
      embeds: [noticeEmbed(botVi.pickDenomination, botVi.cardAmountHint(TELCO_LABELS[chosen]))],
      components: [buildDenominationRow(chosen)],
    });
    return;
  }

  if (kind === 'w' && scope === 'amt' && interaction.isStringSelectMenu()) {
    const telco = rest[0] ?? '';
    const amount = Number(interaction.values[0]);
    if (!isTelco(telco) || !Number.isInteger(amount)) {
      await interaction.update({
        embeds: [errorEmbed(botVi.staleMenu, botVi.staleMenuHint)],
        components: [],
      });
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
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    const items = pluginOptions(deps.db);
    if (items.length === 0) {
      await replyOrUpdate(interaction, {
        embeds: [noticeEmbed(botVi.noPlugins, botVi.noPluginsHint)],
        components: [],
      });
      return;
    }
    const paged = buildPagedSelect({
      items,
      page: 0,
      selectId: ID.selectPlugin,
      navPrefix: ID.pagePlugin,
      placeholder: botVi.pickPlugin,
    });
    await replyOrUpdate(interaction, {
      embeds: [browseEmbed(items.length, paged.page, paged.totalPages)],
      components: toComponents(paged),
    });
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

  if (kind === 'sel' && interaction.isStringSelectMenu()) {
    if (scope === 'p') {
      const pluginId = Number(interaction.values[0]);
      if (!Number.isInteger(pluginId)) return void interaction.deferUpdate().catch(() => undefined);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => undefined);
      }
      await showVersionPage(interaction, deps, pluginId, 0);
      return;
    }
    if (scope === 'v') {
      const versionId = Number(interaction.values[0]);
      if (!Number.isInteger(versionId)) return void interaction.deferUpdate().catch(() => undefined);
      await handleVersionChosen(interaction, deps, versionId);
      return;
    }
  }
}

async function updateComponentMessage(
  interaction: StringSelectMenuInteraction,
  payload: { content?: string; embeds: EmbedBuilder[]; components?: any[] },
): Promise<void> {
  const body = { content: '', components: [], ...payload };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(body);
  } else {
    await interaction.update(body);
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
  interaction: StringSelectMenuInteraction,
  deps: BotDeps,
  versionId: number,
): Promise<void> {
  const version = findVersionWithPlugin(deps.db, versionId);
  if (!version) {
    await updateComponentMessage(interaction, {
      embeds: [errorEmbed(botVi.staleMenu, botVi.staleMenuHint)],
    });
    return;
  }

  if (version.depositPrice > 0 && deps.orders) {
    const order = openOrder(deps.db, deps.orders, {
      discordUserId: interaction.user.id,
      versionId,
    });
    if (!order) {
      await updateComponentMessage(interaction, {
        embeds: [errorEmbed(botVi.deliveryFailed, botVi.deliveryFailedHint)],
      });
      return;
    }

    // Coins covered the whole price, so there is nothing to transfer and no
    // webhook will ever arrive to trigger delivery. Deliver here instead.
    if (order.bankDue === 0) {
      await deliverWalletPaidOrder(interaction, deps, version, order);
      return;
    }

    await updateComponentMessage(interaction, { embeds: [paymentEmbed(version, order)] });
    return;
  }

  await updateComponentMessage(interaction, {
    embeds: [noticeEmbed(botVi.sending, botVi.sentBody(version.pluginDisplayName, version.version))],
  });

  const outcome = await deliverVersion(deps.delivery, {
    discordUserId: interaction.user.id,
    versionId,
  });

  if (outcome.ok) {
    await interaction.editReply({ content: '', embeds: [deliveredEmbed(version)], components: [] });
    return;
  }
  await interaction.editReply({
    content: '',
    embeds: [
      outcome.reason === 'dm_blocked'
        ? errorEmbed(botVi.dmBlocked, botVi.dmBlockedHint)
        : errorEmbed(botVi.deliveryFailed, botVi.deliveryFailedHint),
    ],
    components: [],
  });
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
  interaction: StringSelectMenuInteraction,
  deps: BotDeps,
  version: VersionWithPlugin,
  order: CreatedOrder,
): Promise<void> {
  await updateComponentMessage(interaction, {
    embeds: [walletPaidEmbed(version, order)],
  });

  const result = await fulfilOrder({ db: deps.db, delivery: deps.delivery }, order.id);

  if (result.ok) {
    await interaction.editReply({ content: '', embeds: [deliveredEmbed(version)], components: [] });
    return;
  }

  await interaction.editReply({
    content: '',
    embeds: [
      result.reason === 'dm_blocked'
        ? errorEmbed(botVi.dmBlocked, botVi.dmBlockedHint)
        : errorEmbed(botVi.walletRefunded, botVi.walletRefundedHint),
    ],
    components: [],
  });
}

/** Updates the message for a component interaction; replies for a command. */
async function replyOrUpdate(
  interaction: Interaction,
  payload: { embeds: EmbedBuilder[]; components: ReturnType<typeof toComponents> },
): Promise<void> {
  // content: '' clears any text left by an earlier step in the same message —
  // without it a stale line sits above the new embed.
  const body = { content: '', ...payload };
  if (interaction.isStringSelectMenu() || interaction.isButton()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(body);
    } else {
      await interaction.update(body);
    }
    return;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(body);
    } else {
      await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
    }
  }
}
