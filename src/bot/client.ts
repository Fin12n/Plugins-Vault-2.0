import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Db } from '../db/connection.js';
import { handleFindCommand, handleMenuCommand, handlePanelCommand } from './commands/plugin-commands.js';
import {
  handleBankTopupModal,
  handleCardModal,
  handleTopupCommand,
  handleWalletCommand,
  WALLET_ID,
} from './commands/wallet-commands.js';
import { isTelco } from '../services/card/card2k-telcos.js';
import { handleComponentInteraction, type BotDeps } from './components/handle-component-interaction.js';
import { botVi } from './i18n/bot-vi.js';
import { errorEmbed } from './components/build-embeds.js';

/** Delivery configuration minus the client, which startBot supplies. */
export type DeliveryConfig = Omit<BotDeps['delivery'], 'client'>;

/**
 * Starts the Discord client.
 *
 * Minimal intents: sending a DM is a REST call and needs no DM intent at all.
 * GuildMembers is privileged and must be enabled in the Developer Portal — it is
 * required for the role cache the admin check reads.
 *
 * The delivery service needs a client and the client's handlers need the delivery
 * service, so the client is created here and injected into the config rather than
 * threading a placeholder through the caller.
 */
/**
 * Creates the Discord client and wires its handlers, returning login separately.
 *
 * Splitting construction from login lets the caller build the HTTP server against
 * a real client — the payment webhook and the dashboard's manual release both
 * deliver through it — while still being able to survive a login failure. A bad
 * token should degrade the bot, not take the dashboard down with it, since the
 * dashboard is exactly where the owner would go to diagnose the problem.
 *
 * Minimal intents: sending a DM is a REST call and needs no DM intent at all.
 * GuildMembers is privileged and must be enabled in the Developer Portal — it is
 * required for the role cache the admin check reads.
 */
export function isIgnorableDiscordError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 10062 || code === 40060;
}

export function createBotClient(deps: {
  db: Db;
  env: Env;
  delivery: DeliveryConfig;
  orders?: BotDeps['orders'];
  card?: BotDeps['card'];
}): { client: Client; login: () => Promise<void> } {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  const botDeps: BotDeps = {
    db: deps.db,
    env: deps.env,
    delivery: { ...deps.delivery, client },
    ...(deps.orders ? { orders: deps.orders } : {}),
    ...(deps.card ? { card: deps.card } : {}),
  };

  client.once(Events.ClientReady, (ready) => {
    console.log(`Bot đã đăng nhập: ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'menu') await handleMenuCommand(interaction, botDeps);
          else if (interaction.commandName === 'find') await handleFindCommand(interaction, botDeps);
          else if (interaction.commandName === 'panel') await handlePanelCommand(interaction, botDeps);
          else if (interaction.commandName === 'vi') await handleWalletCommand(interaction, botDeps);
          else if (interaction.commandName === 'nap') await handleTopupCommand(interaction, botDeps);
          else {
            // Never fall through in silence. An unhandled name leaves Discord
            // waiting on "Sending command..." until it times out, which looks like
            // the bot hanging — when the real cause is a command registered against
            // a build that does not know it yet, almost always a missed restart.
            console.warn(`Lệnh không xử lý được: /${interaction.commandName} — bản đang chạy chưa có lệnh này`);
            await interaction.reply({
              embeds: [errorEmbed(botVi.unknownCommand, botVi.unknownCommandHint)],
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
        // Modals arrive as their own interaction type, not as components, so
        // they need their own branch — handleComponentInteraction only sees
        // buttons and select menus.
        if (interaction.isModalSubmit()) {
          if (interaction.customId === WALLET_ID.bankModal) {
            await handleBankTopupModal(interaction, botDeps);
            return;
          }
          // w:modal:card:<TELCO>:<amount> — both values ride in the id rather
          // than in memory, so the flow survives a restart mid-entry.
          const parts = interaction.customId.split(':');
          if (parts[0] === 'w' && parts[1] === 'modal' && parts[2] === 'card') {
            const telco = parts[3] ?? '';
            const amount = Number(parts[4]);
            if (isTelco(telco) && Number.isInteger(amount)) {
              await handleCardModal(interaction, botDeps, telco, amount);
            }
          }
          return;
        }
        await handleComponentInteraction(interaction, botDeps);
      } catch (err) {
        if (isIgnorableDiscordError(err)) {
          const code = (err as { code?: unknown }).code;
          const msg = (err as { message?: string }).message;
          console.warn(`[Discord Interaction] Bỏ qua tương tác (${code}): ${msg}`);
          return;
        }
        console.error('Lỗi khi xử lý interaction:', err);
        // Best-effort notice; the interaction may already be answered or expired.
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction
            .reply({ embeds: [errorEmbed(botVi.deliveryFailed, botVi.deliveryFailedHint)], flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
    })();
  });

  return {
    client,
    login: async () => {
      await client.login(deps.env.DISCORD_TOKEN);
    },
  };
}
