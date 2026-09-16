import { EmbedBuilder } from 'discord.js';
import type { Plugin, VersionWithPlugin } from '../../domain/plugin.js';
import { botVi, formatBytes, formatVnd, shortDate } from '../i18n/bot-vi.js';
import { formatBalance } from '../../domain/wallet.js';
import type { LedgerEntry } from '../../domain/wallet.js';
import type { CardTopup } from '../../domain/card-topup.js';

/**
 * Embed builders for every owner-facing message.
 *
 * Centralised so colour and layout cannot drift between the browse flow, the
 * payment flow, and the delivery result — three places that previously each built
 * their own message, two of them as plain text.
 *
 * Colour carries meaning and nothing else does the job: Discord shows no icons on
 * an embed, so a red stripe is the only way a failure reads as a failure before
 * the text is read.
 */
export const COLOUR = {
  /** Neutral: browsing, choosing, informational. */
  neutral: 0x5865f2,
  /** Something completed. */
  success: 0x57f287,
  /** Waiting on the person — a payment, a retry. */
  pending: 0xfee75c,
  /** Failed, or refused. */
  danger: 0xed4245,
} as const;

/**
 * The standing panel: one permanent public message.
 *
 * States the vault size so the button has a reason to be pressed, and says where
 * the file arrives — a download that lands silently in DMs looks like nothing
 * happened.
 */
export function panelEmbed(pluginCount: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(botVi.panelHeading)
    .setDescription(botVi.panelBody)
    .setFooter({ text: botVi.panelFooter(pluginCount) });
}

/** Plugin picker. Counts are stated because a truncated list looks like the whole one. */
export function browseEmbed(pluginCount: number, page: number, totalPages: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(botVi.vaultTitle)
    .setDescription(botVi.browseHint(pluginCount));

  if (totalPages > 1) embed.setFooter({ text: botVi.pageOf(page + 1, totalPages) });
  return embed;
}

/**
 * Version picker for one plugin.
 *
 * States the deposit up front. Discovering a charge only after picking a version
 * is the kind of surprise that makes a tool feel untrustworthy.
 */
export function versionsEmbed(plugin: Plugin, versionCount: number, page: number, totalPages: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(plugin.displayName)
    .setDescription(botVi.versionsHint(versionCount));

  if (plugin.externalLink && plugin.externalLink.trim() !== '') {
    const link = plugin.externalLink.trim();
    embed.setURL(link);
    embed.addFields({
      name: botVi.fieldExternalLink,
      value: `[${link}](${link})`,
      inline: false,
    });
  }

  if (plugin.depositPrice > 0) {
    embed.addFields({ name: botVi.fieldDeposit, value: formatVnd(plugin.depositPrice), inline: true });
  }
  if (totalPages > 1) embed.setFooter({ text: botVi.pageOf(page + 1, totalPages) });
  return embed;
}

/**
 * Payment request, with the QR as the image so it is scannable at a glance.
 *
 * When coins covered part of the price, all three numbers are shown. Showing only
 * the amount to transfer would read as the plugin's price and invite a transfer of
 * the full price instead; showing only the price would have them transfer too
 * much. The QR carries `bankDue`, so the stated amount must match it.
 */
export function paymentEmbed(
  version: VersionWithPlugin,
  order: { code: string; amount: number; walletPaid: number; bankDue: number; qrUrl: string | null; expiresAt: number },
): EmbedBuilder {
  const minutes = Math.max(1, Math.round((order.expiresAt - Math.floor(Date.now() / 1000)) / 60));

  const embed = new EmbedBuilder()
    .setColor(COLOUR.pending)
    .setTitle(botVi.payTitle)
    .setDescription(botVi.payLead(`${version.pluginDisplayName} ${version.version ?? ''}`.trim()));

  if (order.walletPaid > 0) {
    embed.addFields(
      { name: botVi.fieldPrice, value: formatVnd(order.amount), inline: true },
      { name: botVi.fieldWalletPaid, value: formatBalance(order.walletPaid), inline: true },
      { name: botVi.fieldBankDue, value: `**${formatVnd(order.bankDue)}**`, inline: true },
    );
  } else {
    embed.addFields({ name: botVi.fieldAmount, value: `**${formatVnd(order.bankDue)}**`, inline: true });
  }

  // Fenced so it can be copied on mobile without selecting neighbouring text.
  embed.addFields({ name: botVi.fieldTransferNote, value: `\`\`\`${order.code}\`\`\``, inline: false });

  if (order.qrUrl) embed.setImage(order.qrUrl);

  // The note is the whole mechanism: SePay matches the transfer by it, so a
  // transfer without it cannot be attributed and the file never arrives.
  return embed.setFooter({ text: botVi.payFooter(minutes) });
}

/**
 * Wallet overview.
 *
 * Lists recent movements alongside the balance, because a balance alone cannot
 * answer the question people actually have — "where did it go".
 */
export function walletEmbed(balance: number, recent: LedgerEntry[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(botVi.walletTitle)
    .setDescription(botVi.walletBalance(formatBalance(balance)));

  if (recent.length > 0) {
    embed.addFields({
      name: botVi.walletRecent,
      value: recent.map((entry) => botVi.ledgerLine(entry.delta, entry.kind, entry.createdAt)).join('\n'),
    });
  } else {
    embed.setFooter({ text: botVi.walletEmptyHint });
  }
  return embed;
}

/** Top-up payment request. Same note-is-everything rule as a plugin order. */
export function topupQrEmbed(topup: { code: string; amount: number; qrUrl: string; expiresAt: number }): EmbedBuilder {
  const minutes = Math.max(1, Math.round((topup.expiresAt - Math.floor(Date.now() / 1000)) / 60));

  return new EmbedBuilder()
    .setColor(COLOUR.pending)
    .setTitle(botVi.topupQrTitle)
    .setDescription(botVi.topupQrLead(formatBalance(topup.amount)))
    .addFields(
      { name: botVi.fieldAmount, value: `**${formatVnd(topup.amount)}**`, inline: true },
      // Fenced so it can be copied on mobile without selecting neighbouring text.
      { name: botVi.fieldTransferNote, value: `\`\`\`${topup.code}\`\`\``, inline: false },
    )
    .setImage(topup.qrUrl)
    .setFooter({ text: botVi.topupQrFooter(minutes) });
}

/**
 * Result of a card submission.
 *
 * Four visually distinct outcomes, because they call for different actions. A
 * wrong-denomination card is a warning rather than a success: the credit went
 * through, but the person should know their card was not what they said so the
 * next one is declared correctly. A timeout or review is neither — the money is
 * unresolved and only the owner can settle it, so it must not read as either
 * "done" or "lost".
 */
export function cardResultEmbed(topup: CardTopup, balance: number): EmbedBuilder {
  const embed = new EmbedBuilder().addFields({
    name: botVi.fieldTelco,
    value: `${topup.telco} · ${formatVnd(topup.declaredValue)}`,
    inline: true,
  });

  if (topup.status === 'success') {
    return embed
      .setColor(COLOUR.success)
      .setTitle(botVi.cardOkTitle)
      .setDescription(botVi.cardOkBody(topup.actualValue ?? topup.declaredValue, balance));
  }

  if (topup.status === 'wrong_amount') {
    return embed
      .setColor(COLOUR.pending)
      .setTitle(botVi.cardWrongTitle)
      .setDescription(botVi.cardWrongBody(topup.declaredValue, topup.actualValue ?? 0, balance));
  }

  if (topup.status === 'failed') {
    return embed.setColor(COLOUR.danger).setTitle(botVi.cardFailedTitle).setDescription(botVi.cardFailedBody);
  }

  if (topup.status === 'pending') {
    return embed.setColor(COLOUR.neutral).setTitle(botVi.cardPendingTitle).setDescription(botVi.cardPendingBody);
  }

  // timeout | needs_review: unresolved, and only the owner can settle it.
  return embed.setColor(COLOUR.pending).setTitle(botVi.cardReviewTitle).setDescription(botVi.cardReviewBody);
}

/**
 * Order settled entirely from the wallet — no QR, because nothing is owed.
 *
 * States what was spent and what remains, since a silent deduction is how a
 * balance appears to vanish.
 */
export function walletPaidEmbed(
  version: VersionWithPlugin,
  order: { amount: number; walletPaid: number },
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(botVi.walletPaidTitle)
    .setDescription(botVi.walletPaidBody(`${version.pluginDisplayName} ${version.version ?? ''}`.trim()))
    .addFields({ name: botVi.fieldWalletPaid, value: formatBalance(order.walletPaid), inline: true });
}

/** Delivery succeeded. Names the file so the person knows what to look for in DMs. */
export function deliveredEmbed(version: VersionWithPlugin): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOUR.success)
    .setTitle(botVi.sentTitle)
    .setDescription(botVi.sentBody(version.pluginDisplayName, version.version))
    .addFields(
      { name: botVi.fieldSize, value: formatBytes(version.bytes), inline: true },
      { name: botVi.fieldUploaded, value: shortDate(version.uploadedAt), inline: true },
    );
}

/** Anything that went wrong. `hint` is the action the person can take. */
export function errorEmbed(title: string, hint: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOUR.danger).setTitle(title).setDescription(hint);
}

/** Informational, for states that are neither success nor failure. */
export function noticeEmbed(title: string, body: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOUR.neutral).setTitle(title).setDescription(body);
}
