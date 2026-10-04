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
import { getNeonDb } from '../../db/neon.js';
import { getWalletBalance, listLedgerEntries } from '../../repositories/neon-wallets.js';
import { openWalletTopup, openWalletTopupNeon } from '../../services/payment/open-wallet-topup.js';
import { botVi, formatVnd } from '../i18n/bot-vi.js';
import {
  createCardResultContainer,
  createErrorContainer,
  createNoticeContainer,
  createTopupQrContainer,
  createWalletContainer,
  v2Payload,
} from '../components/build-v2-containers.js';
import { hasAdminRole, requireAdminRole } from '../guards/require-admin-role.js';
import type { BotDeps } from '../components/handle-component-interaction.js';

export const walletCommand = new SlashCommandBuilder()
  .setName('vi')
  .setDescription('Xem số dư ví và lịch sử gần đây (Components V2)');

export const topupCommand = new SlashCommandBuilder()
  .setName('nap')
  .setDescription('Nạp coin vào ví (Components V2)');

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
export const MIN_TOPUP = 10_000;
export const MAX_TOPUP = 10_000_000;

export async function handleWalletCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const neonDb = getNeonDb();
  let balance: number;
  let recent: any[];
  if (neonDb) {
    balance = await getWalletBalance(neonDb, interaction.user.id);
    const ledger = await listLedgerEntries(neonDb, interaction.user.id, 5);
    recent = ledger.map((l) => ({
      delta: l.delta,
      kind: l.kind,
      description: l.note || '',
      createdAt: l.createdAt ? l.createdAt.toISOString() : new Date().toISOString(),
    }));
  } else {
    balance = getBalance(deps.db, interaction.user.id);
    recent = listLedger(deps.db, interaction.user.id, 5);
  }

  const container = createWalletContainer(balance, recent);
  const payload = v2Payload(container, [topupRow(deps)], { ephemeral: true });

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

export async function handleTopupCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const neonDb = getNeonDb();
  const balance = neonDb
    ? await getWalletBalance(neonDb, interaction.user.id)
    : getBalance(deps.db, interaction.user.id);

  const container = createWalletContainer(balance, []);
  const payload = v2Payload(container, [topupRow(deps)], { ephemeral: true });

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

function topupRow(deps: BotDeps): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (deps.orders) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(WALLET_ID.openBank)
        .setLabel(botVi.topupBankButton)
        .setStyle(ButtonStyle.Success),
    );
  }
  if (deps.card && isCard2kConfigured(deps.card)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(WALLET_ID.openCard)
        .setLabel(botVi.topupCardButton)
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

export function buildTelcoRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(WALLET_ID.selectTelco)
      .setPlaceholder(botVi.pickTelco)
      .addOptions(
        TELCOS.map((telco) => ({
          label: TELCO_LABELS[telco],
          value: telco,
        })),
      ),
  );
}

export function buildDenominationRow(telco: Telco): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(WALLET_ID.cardAmount(telco))
      .setPlaceholder(botVi.pickDenomination)
      .addOptions(
        denominationsFor(telco).map((amount) => ({
          label: formatVnd(amount),
          value: String(amount),
        })),
      ),
  );
}

export function buildCardModal(telco: Telco, amount: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(WALLET_ID.cardModal(telco, amount))
    .setTitle(botVi.cardModalTitle(TELCO_LABELS[telco], amount))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(WALLET_ID.cardSerialField)
          .setLabel(botVi.cardSerialLabel)
          .setPlaceholder('Nhập số serial in trên thẻ')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(WALLET_ID.cardCodeField)
          .setLabel(botVi.cardCodeLabel)
          .setPlaceholder('Nhập mã thẻ cào (sau lớp cào)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}

export async function handleCardModal(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
  telco: string,
  declaredValue: number,
): Promise<void> {
  if (!deps.card) {
    const errorContainer = createErrorContainer(botVi.cardDisabled, botVi.cardDisabledHint);
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }
  if (!hasAdminRole(interaction, deps)) {
    const errorContainer = createErrorContainer(botVi.noAccess, botVi.noAccessHint);
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  const serial = interaction.fields.getTextInputValue(WALLET_ID.cardSerialField).trim();
  const code = interaction.fields.getTextInputValue(WALLET_ID.cardCodeField).trim();

  // Ephemerality is fixed at reply time, so the holding message must already be
  // ephemeral — a card result is nobody else's business.
  await interaction.reply(
    v2Payload(createNoticeContainer(botVi.cardSubmitting, botVi.cardSubmittingHint), [], { ephemeral: true }),
  );

  const result = await submitCardTopup(deps.db, deps.card, {
    discordUserId: interaction.user.id,
    telco,
    serial,
    code,
    declaredValue,
  });

  if (!result.ok) {
    const errorContainer = createErrorContainer(...cardRejectionText(result.why));
    await interaction.editReply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  const balance = getBalance(deps.db, interaction.user.id);
  const cardContainer = createCardResultContainer(result.topup, balance);
  await interaction.editReply(v2Payload(cardContainer, [], { ephemeral: true }));
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

export async function handleBankTopupModal(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.inCachedGuild() || !deps.orders) {
    const errorContainer = createErrorContainer(botVi.noAccess, botVi.noAccessHint);
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  const raw = interaction.fields.getTextInputValue(WALLET_ID.bankAmountField);
  const amount = parseTopupAmount(raw);

  if (amount === null) {
    const errorContainer = createErrorContainer(botVi.topupBadAmount, botVi.topupBadAmountHint(MIN_TOPUP, MAX_TOPUP));
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  const neonDb = getNeonDb();
  const topup = neonDb
    ? await openWalletTopupNeon(neonDb, deps.orders, {
        discordUserId: interaction.user.id,
        amount,
      })
    : openWalletTopup(deps.db, deps.orders, {
        discordUserId: interaction.user.id,
        amount,
      });

  if (!topup) {
    const errorContainer = createErrorContainer(botVi.topupFailed, botVi.topupFailedHint);
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  const qrContainer = createTopupQrContainer(topup);
  await interaction.reply(v2Payload(qrContainer, [], { ephemeral: true }));
}

export function parseTopupAmount(raw: string): number | null {
  const stripped = raw.trim().replace(/\s*(₫|đ|vnd|coin)\s*$/i, '');
  const cleaned = stripped.trim().replace(/\s+/g, '').replace(/[.,]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isSafeInteger(n) || n <= 0) return null;

  const inVnd = n < MIN_TOPUP ? n * VND_PER_COIN : n;
  if (inVnd < MIN_TOPUP || inVnd > MAX_TOPUP) return null;
  return inVnd;
}
