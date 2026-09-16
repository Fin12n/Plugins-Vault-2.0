import { REST, Routes } from 'discord.js';
import { config } from '../src/config/index.js';
import { findCommand, menuCommand, panelCommand } from '../src/bot/commands/plugin-commands.js';
import { topupCommand, walletCommand } from '../src/bot/commands/wallet-commands.js';

/**
 * Registers slash commands for the configured guild.
 *
 * Run manually on release, never on every startup: there is a daily
 * command-creation limit, and guild-scoped commands propagate instantly whereas
 * global ones can take about an hour.
 *
 * Guild commands are not available inside DMs. That is acceptable here — every
 * command is meant to be used in the server — but a DM-usable recovery command
 * would have to be registered globally.
 */
async function main(): Promise<void> {
  const env = config();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

  const body = [
    menuCommand.toJSON(),
    findCommand.toJSON(),
    panelCommand.toJSON(),
    walletCommand.toJSON(),
    topupCommand.toJSON(),
  ];

  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body });
  console.log(`Đã đăng ký ${body.length} lệnh cho guild ${env.DISCORD_GUILD_ID}`);
}

main().catch((err: unknown) => {
  console.error('Đăng ký lệnh thất bại:', err);
  process.exit(1);
});
