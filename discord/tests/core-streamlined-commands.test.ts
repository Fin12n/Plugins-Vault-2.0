import { describe, expect, it } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  createStorePanelPayload,
  type StorePanelItem,
} from '../src/bot/components/build-v2-containers.js';
import {
  findCommand,
  infoCommand,
  menuCommand,
  panelSentCommand,
  reportCommand,
} from '../src/bot/commands/core-commands.js';

describe('Streamlined 5 Core Commands & Panel UI', () => {
  it('định nghĩa chuẩn xác 5 slash commands cốt lõi', () => {
    expect(menuCommand.name).toBe('menu');
    expect(panelSentCommand.name).toBe('panel-sent');
    expect(infoCommand.name).toBe('info');
    expect(findCommand.name).toBe('find');
    expect(reportCommand.name).toBe('report');

    // Kiểm tra cấu hình tham số
    const panelJson = panelSentCommand.toJSON();
    expect(panelJson.options?.some((o) => o.name === 'channel')).toBe(true);

    const infoJson = infoCommand.toJSON();
    expect(infoJson.options?.some((o) => o.name === 'plugin' && o.autocomplete)).toBe(true);
  });

  it('xây dựng UI Panel Components V2 với MediaGallery, Separators và Select Menu', () => {
    const mockItems: StorePanelItem[] = [
      {
        id: 1,
        pluginId: 'itemsadder',
        displayName: 'ItemsAdder',
        depositPrice: 75000,
        versionCount: 6,
      },
      {
        id: 2,
        pluginId: 'worldedit',
        displayName: 'WorldEdit',
        depositPrice: 0,
        versionCount: 12,
      },
    ];

    const payload = createStorePanelPayload(mockItems);

    // Kiểm tra cờ Components V2 (32768)
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components.length).toBe(1);

    const containerJson = payload.components[0].toJSON() as any;
    expect(containerJson.type).toBe(17); // Container component type
    expect(Array.isArray(containerJson.components)).toBe(true);

    // Kiểm tra TextDisplay chào mừng (Type 10)
    const textComp = containerJson.components.find((c: any) => c.type === 10);
    expect(textComp).toBeDefined();
    expect(textComp.content).toContain('## Welcome to EZStore');
    expect(textComp.content).toContain('Choose your product you want !');

    // Kiểm tra Separators (Type 14)
    const separators = containerJson.components.filter((c: any) => c.type === 14);
    expect(separators.length).toBeGreaterThanOrEqual(2);

    // Kiểm tra MediaGallery (Type 12)
    const mediaGallery = containerJson.components.find((c: any) => c.type === 12);
    expect(mediaGallery).toBeDefined();
    expect(mediaGallery.items[0]?.media?.url).toBe(
      'https://discord-webhook.com/uploads/e60133f9f684500d481a74cf37bd40a0.png',
    );

    // Kiểm tra ActionRow chứa StringSelectMenu (Type 1 -> Type 3)
    const actionRow = containerJson.components.find((c: any) => c.type === 1);
    expect(actionRow).toBeDefined();
    const selectMenu = actionRow.components.find((c: any) => c.type === 3);
    expect(selectMenu).toBeDefined();
    expect(selectMenu.custom_id).toBe('panel:select_plugin');
    expect(selectMenu.placeholder).toBe('🔻 Chọn plugin bạn muốn xem hoặc mua...');

    // Kiểm tra định dạng options: Title & Descr: {numbers} Phiên bản | xxx VND | xxx Coins!
    expect(selectMenu.options.length).toBe(2);
    expect(selectMenu.options[0].label).toBe('ItemsAdder');
    expect(selectMenu.options[0].description).toBe('6 Phiên bản | 75.000 VND | 75.000 Coins!');
    expect(selectMenu.options[0].value).toBe('1');

    expect(selectMenu.options[1].label).toBe('WorldEdit');
    expect(selectMenu.options[1].description).toBe('12 Phiên bản | 0 VND | 0 Coins!');
    expect(selectMenu.options[1].value).toBe('2');
  });
});
