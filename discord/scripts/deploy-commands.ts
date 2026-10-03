import { REST, Routes } from 'discord.js';
import { config } from '../src/config/index.js';
import {
  findCommand,
  infoCommand,
  menuCommand,
  panelSentCommand,
  reportCommand,
} from '../src/bot/commands/core-commands.js';
import { setupCommand } from '../src/bot/commands/setup-commands.js';

/**
 * Registers slash commands for the configured guild.
 *
 * Chỉ đăng ký 5 lệnh tinh gọn cốt lõi:
 * 1. /menu - Mở kệ hàng plugins
 * 2. /panel-sent [channel] - Gửi UI Panel chọn plugin vào kênh chỉ định
 * 3. /info [plugin] - Xem thông tin chi tiết plugin
 * 4. /find - Mở Modal tìm kiếm plugin
 * 5. /report - Mở Modal gửi báo cáo sự cố về cho Admin
 */
async function main(): Promise<void> {
  const env = config();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

  const body = [
    menuCommand.toJSON(),
    panelSentCommand.toJSON(),
    infoCommand.toJSON(),
    findCommand.toJSON(),
    reportCommand.toJSON(),
    setupCommand.toJSON(),
  ];

  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body });
  console.log(`Đã đăng ký thành công ${body.length} lệnh tinh gọn cho guild ${env.DISCORD_GUILD_ID}:`);
  for (const cmd of body) {
    console.log(`- /${cmd.name}: ${cmd.description}`);
  }
}

main().catch((err: unknown) => {
  console.error('Đăng ký lệnh thất bại:', err);
  process.exit(1);
});
