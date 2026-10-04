import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Db } from '../db/connection.js';
import {
  handleFindCommand,
  handleFindModalSubmit,
  handleInfoAutocomplete,
  handleInfoCommand,
  handleMenuCommand,
  handlePanelSelectPlugin,
  handlePanelSentCommand,
  handleReportCommand,
  handleReportModalSubmit,
} from './commands/core-commands.js';
import {
  handleBankTopupModal,
  handleCardModal,
  handleTopupCommand,
  handleWalletCommand,
  WALLET_ID,
} from './commands/wallet-commands.js';
import { handleSpigotCommand } from './commands/spigot-commands.js';
import { handleShelfCommand, handleShelfButton, handleShelfSelect, SHELF_ID } from './commands/shelf-commands.js';
import { handlePluginInfoCommand, handlePluginInfoAutocomplete } from './commands/plugin-info-commands.js';
import { handleSpigotAccountCommand } from './commands/spigot-account-commands.js';
import { handleSetupCommand } from './commands/setup-commands.js';
import { getNeonDb, type Database } from '../db/neon.js';
import { isTelco } from '../services/card/card2k-telcos.js';
import { handleComponentInteraction, type BotDeps } from './components/handle-component-interaction.js';
import { createErrorContainer, v2Payload } from './components/build-v2-containers.js';

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
  neonDb?: Database;
  env: Env;
  delivery: DeliveryConfig;
  orders?: BotDeps['orders'];
  card?: BotDeps['card'];
  maintenance?: BotDeps['maintenance'];
}): { client: Client; login: () => Promise<void> } {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  const botDeps: BotDeps = {
    db: deps.db,
    neonDb: deps.neonDb,
    env: deps.env,
    delivery: { ...deps.delivery, client },
    ...(deps.orders ? { orders: deps.orders } : {}),
    ...(deps.card ? { card: deps.card } : {}),
    ...(deps.maintenance ? { maintenance: deps.maintenance } : {}),
  };

  client.once(Events.ClientReady, (ready) => {
    console.log(`Bot đã đăng nhập: ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName === 'info' || interaction.commandName === 'plugin-info') {
            await handleInfoAutocomplete(interaction, botDeps);
            return;
          }
        }

        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'menu' || interaction.commandName === 'kho' || interaction.commandName === 'shelf') {
            await handleMenuCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'panel-sent' || interaction.commandName === 'panel') {
            await handlePanelSentCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'info' || interaction.commandName === 'plugin-info') {
            await handleInfoCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'find') {
            await handleFindCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'report') {
            await handleReportCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'setup') {
            await handleSetupCommand(interaction, botDeps);
          }
          else if (interaction.commandName === 'spigot-account') await handleSpigotAccountCommand(interaction, botDeps);
          else if (interaction.commandName === 'vi') await handleWalletCommand(interaction, botDeps);
          else if (interaction.commandName === 'nap') await handleTopupCommand(interaction, botDeps);
          else if (interaction.commandName === 'spigot') await handleSpigotCommand(interaction, botDeps);
          else {
            // Never fall through in silence. An unhandled name leaves Discord
            // waiting on "Sending command..." until it times out, which looks like
            // the bot hanging — when the real cause is a command registered against
            // a build that does not know it yet, almost always a missed restart.
            console.warn(`Lệnh không xử lý được: /${interaction.commandName} — bản đang chạy chưa có lệnh này`);
            const unkContainer = createErrorContainer('Lệnh không nhận diện được', 'Bản cập nhật hiện tại chưa hỗ trợ lệnh này.');
            await interaction.reply(v2Payload(unkContainer, [], { ephemeral: true }));
          }
          return;
        }

        // Tương tác Kệ Hàng Plugins (Canvas Shelf)
        if (interaction.isButton() && interaction.customId.startsWith(SHELF_ID.pagePrefix)) {
          await handleShelfButton(interaction, botDeps);
          return;
        }
        if (interaction.isStringSelectMenu() && interaction.customId === SHELF_ID.selectPlugin) {
          await handleShelfSelect(interaction, botDeps);
          return;
        }

        // Tương tác Panel Chọn Plugin Components V2
        if (interaction.isStringSelectMenu() && interaction.customId === 'panel:select_plugin') {
          await handlePanelSelectPlugin(interaction, botDeps);
          return;
        }

        // Modals arrive as their own interaction type, not as components, so
        // they need their own branch — handleComponentInteraction only sees
        // buttons and select menus.
        if (interaction.isModalSubmit()) {
          if (interaction.customId === 'modal:find_plugin') {
            await handleFindModalSubmit(interaction, botDeps);
            return;
          }
          if (interaction.customId === 'modal:report_issue') {
            await handleReportModalSubmit(interaction, botDeps);
            return;
          }
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
        if (interaction.isRepliable()) {
          const errContainer = createErrorContainer('Giao dịch chưa hoàn tất', 'Đã có lỗi xảy ra hoặc tương tác đã hết hạn. Vui lòng thử lại.');
          const errPayload = v2Payload(errContainer, [], { ephemeral: true });
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errPayload).catch(() => undefined);
          } else {
            await interaction
              .reply(errPayload)
              .catch(() => undefined);
          }
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
