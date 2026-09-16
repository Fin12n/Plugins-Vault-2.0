import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { VND_PER_COIN } from '../../domain/wallet.js';
import { isCard2kConfigured } from '../../services/card/card2k-client.js';
import { denominationsFor, TELCO_LABELS, TELCOS, type Telco } from '../../services/card/card2k-telcos.js';
import { submitCardTopup, type SubmitRejection } from '../../services/card/submit-card-topup.js';
import { getBalance, listLedger } from '../../repositories/wallets.js';
import { openWalletTopup } from '../../services/payment/open-wallet-topup.js';
import { botVi, formatVnd } from '../i18n/bot-vi.js';
import { cardResultEmbed, errorEmbed, noticeEmbed, topupQrEmbed, walletEmbed } from '../components/build-embeds.js';
import { hasAdminRole, requireAdminRole } from '../guards/require-admin-role.js';
import type { BotDeps } from '../components/handle-component-interaction.js';

export const walletCommand = new SlashCommandBuilder()
  .setName('vi')
  .setDescription('Xem số dư ví và lịch sử gần đây');

export const topupCommand = new SlashCommandBuilder()
  .setName('nap')
  .setDescription('Nạp coin vào ví');

/**
 * custom_id grammar for the wallet flow, sharing the 100-character budget with
 * the browse flow. All state lives here rather than in memory, so the buttons keep
 * working across a restart.
 *
 *   w:bank              open the bank-transfer amount modal
 *   w:modal:bank        that modal
 *   w:card              show the telco picker
 *   w:telco             a telco was chosen (value carries which)
 *   w:amt:<TELCO>:<n>   open the card modal for this telco and denomination
 *   w:modal:card:...    that modal, carrying the same two values
 *
 * The longest is `w:modal:card:VINAPHONE:1000000` at 30 characters, well inside
 * the cap.
 */
export const WALLET_ID = {
  openBank: 'w:bank',
  bankModal: 'w:modal:bank',
  bankAmountField: 'amount',
  openCard: 'w:card',
  selectTelco: 'w:telco',
  cardAmount: (telco: string) => `w:amt:${telco}`,
  cardModal: (telco: string, amount: number) => `w:modal:card:${telco}:${amount}`,
  cardSerialField: 'serial',
  cardCodeField: 'code',
};

/** Smallest transfer worth a payment code, and a ceiling that catches a typo. */
const MIN_TOPUP = 10_000;
const MAX_TOPUP = 50_000_000;

export async function handleWalletCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const balance = getBalance(deps.db, interaction.user.id);
  const recent = listLedger(deps.db, interaction.user.id, 5);

  const payload = {
    embeds: [walletEmbed(balance, recent)],
    components: [topupRow(deps)],
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export async function handleTopupCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const payload = {
    embeds: [walletEmbed(getBalance(deps.db, interaction.user.id), [])],
    components: [topupRow(deps)],
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

function topupRow(deps: BotDeps): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(WALLET_ID.openBank)
      .setLabel(botVi.topupBankButton)
      .setStyle(ButtonStyle.Primary),
  );

  // Offered only when the provider is actually usable. A button that always
  // answers "not configured" is worse than no button, since it reads as a bug.
  if (deps.card && isCard2kConfigured(deps.card)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(WALLET_ID.openCard)
        .setLabel(botVi.topupCardButton)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return row;
}

/** Telco picker. One select, values from the verified matrix. */
export function buildTelcoRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(WALLET_ID.selectTelco)
      .setPlaceholder(botVi.pickTelco)
      .addOptions(
        TELCOS.map((telco) => ({
          value: telco,
          label: TELCO_LABELS[telco],
        })),
      ),
  );
}

/**
 * Denomination picker for one telco.
 *
 * Per-telco rather than one shared list, because the sets genuinely differ: only
 * Viettel takes 1.000.000, and offering a value card2k will refuse would consume
 * the card on a request that was never going to succeed.
 */
export function buildDenominationRow(telco: Telco): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(WALLET_ID.cardAmount(telco))
      .setPlaceholder(botVi.pickDenomination)
      .addOptions(
        denominationsFor(telco).map((amount) => ({
          value: String(amount),
          label: formatVnd(amount),
          description: botVi.coinsFor(amount / VND_PER_COIN),
        })),
      ),
  );
}

/**
 * Serial and PIN entry.
 *
 * A modal, not chat input: a card PIN typed into a channel is visible to everyone
 * and stays in the history. Modal values reach only the bot.
 */
export function buildCardModal(telco: Telco, amount: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(WALLET_ID.cardModal(telco, amount))
    .setTitle(botVi.cardModalTitle(TELCO_LABELS[telco], amount))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(WALLET_ID.cardSerialField)
          .setLabel(botVi.cardSerialLabel)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(WALLET_ID.cardCodeField)
          .setLabel(botVi.cardCodeLabel)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}

/**
 * Submits the card the person just typed.
 *
 * Answers before submitting and then edits, because card2k can take seconds and a
 * modal reply has a three-second window. Never echoes the serial or PIN back.
 */
export async function handleCardModal(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
  telco: Telco,
  declaredValue: number,
): Promise<void> {
  if (!interaction.inCachedGuild() || !hasAdminRole(interaction, deps)) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.noAccess, botVi.noAccessHint)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!deps.card) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.cardDisabled, botVi.cardDisabledHint)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serial = interaction.fields.getTextInputValue(WALLET_ID.cardSerialField).trim();
  const code = interaction.fields.getTextInputValue(WALLET_ID.cardCodeField).trim();

  // Ephemerality is fixed at reply time, so the holding message must already be
  // ephemeral — a card result is nobody else's business.
  await interaction.reply({
    embeds: [noticeEmbed(botVi.cardSubmitting, botVi.cardSubmittingHint)],
    flags: MessageFlags.Ephemeral,
  });

  const result = await submitCardTopup(deps.db, deps.card, {
    discordUserId: interaction.user.id,
    telco,
    serial,
    code,
    declaredValue,
  });

  if (!result.ok) {
    await interaction.editReply({ embeds: [errorEmbed(...cardRejectionText(result.why))] });
    return;
  }

  const balance = getBalance(deps.db, interaction.user.id);
  await interaction.editReply({ embeds: [cardResultEmbed(result.topup, balance)] });
}

/** Rejection text, chosen so each one says what to do next. */
function cardRejectionText(why: SubmitRejection): [string, string] {
  if (why === 'not-configured') return [botVi.cardDisabled, botVi.cardDisabledHint];
  if (why === 'bad-telco') return [botVi.cardBadTelco, botVi.cardBadTelcoHint];
  if (why === 'bad-amount') return [botVi.cardBadAmount, botVi.cardBadAmountHint];
  if (why === 'bad-serial') return [botVi.cardBadSerial, botVi.cardBadSerialHint];
  if (why === 'bad-code') return [botVi.cardBadCode, botVi.cardBadCodeHint];
  return [botVi.cardDuplicate, botVi.cardDuplicateHint];
}

/**
 * Opens the amount modal.
 *
 * A modal must be shown from an interaction that has not been answered yet, which
 * is why the button exists at all instead of the command opening the modal
 * directly — a command that already replied cannot then open one.
 */
export function buildBankTopupModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(WALLET_ID.bankModal)
    .setTitle(botVi.topupModalTitle)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(WALLET_ID.bankAmountField)
          .setLabel(botVi.topupAmountLabel)
          .setPlaceholder(botVi.topupAmountPlaceholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12),
      ),
    );
}

/**
 * Turns the typed amount into a top-up and shows its QR.
 *
 * Accepts "50000", "50.000" and "50,000": Vietnamese keyboards produce all three
 * and rejecting the separators would read as the bot being broken. Also accepts a
 * plain coin count — "50" means 50.000 ₫, since the shop is priced in coins and
 * that is the number people have in mind.
 */
export async function handleBankTopupModal(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
): Promise<void> {
  // Re-checked here: a role can be revoked between opening the modal and
  // submitting it.
  if (!interaction.inCachedGuild() || !deps.orders) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.noAccess, botVi.noAccessHint)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const raw = interaction.fields.getTextInputValue(WALLET_ID.bankAmountField);
  const amount = parseTopupAmount(raw);

  if (amount === null) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.topupBadAmount, botVi.topupBadAmountHint(MIN_TOPUP, MAX_TOPUP))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const topup = openWalletTopup(deps.db, deps.orders, {
    discordUserId: interaction.user.id,
    amount,
  });

  if (!topup) {
    await interaction.reply({
      embeds: [errorEmbed(botVi.topupFailed, botVi.topupFailedHint)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [topupQrEmbed(topup)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Parses an amount in ĐỒNG, returning null when it is not a usable figure.
 *
 * A bare number below the minimum is read as coins rather than rejected: someone
 * typing "50" means fifty coins, and silently refusing would be baffling when the
 * whole shop quotes prices in coins.
 */
export function parseTopupAmount(raw: string): number | null {
  const digits = raw.replace(/[.,\s₫đd]/gi, '');
  if (!/^\d+$/.test(digits)) return null;

  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) return null;

  // "50" is fifty coins, not fifty đồng — no bank transfer of 50 ₫ exists.
  const vnd = value < MIN_TOPUP ? value * VND_PER_COIN : value;

  if (vnd < MIN_TOPUP || vnd > MAX_TOPUP) return null;
  return vnd;
}

export { MIN_TOPUP, MAX_TOPUP };
