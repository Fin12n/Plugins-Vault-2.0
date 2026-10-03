import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupCommand } from '../src/bot/commands/setup-commands.js';
import {
  invalidateChannelCache,
  getChannelId,
  updateChannelPurpose,
} from '../src/services/channel-manager.js';

// Mock Neon DB for isolated testing
vi.mock('../src/db/neon.js', () => {
  const store = new Map<string, any>();

  return {
    getNeonDb: () => ({
      select: () => ({
        from: (table: any) => ({
          where: (cond: any) => ({
            limit: () => {
              // Return mock channel or staff
              return [];
            },
          }),
          orderBy: () => [],
        }),
      }),
      insert: () => ({
        values: (data: any) => ({
          onConflictDoUpdate: () => ({
            returning: () => [data],
          }),
          onConflictDoNothing: () => ({
            returning: () => [data],
          }),
          returning: () => [data],
        }),
      }),
      update: () => ({
        set: (data: any) => ({
          where: () => ({
            returning: () => [data],
          }),
        }),
      }),
      delete: () => ({
        where: () => true,
      }),
    }),
  };
});

describe('Channels and Staffs Architecture', () => {
  beforeEach(() => {
    invalidateChannelCache();
    vi.clearAllMocks();
  });

  describe('Setup Slash Command Builder', () => {
    it('defines /setup with channel and staff subcommand groups', () => {
      const json = setupCommand.toJSON();
      expect(json.name).toBe('setup');
      expect(json.options).toBeDefined();

      const groupNames = json.options?.map((opt) => opt.name);
      expect(groupNames).toContain('channel');
      expect(groupNames).toContain('staff');
    });

    it('has correct channel subcommands: set and list', () => {
      const json = setupCommand.toJSON();
      const channelGroup: any = json.options?.find((opt) => opt.name === 'channel');
      expect(channelGroup).toBeDefined();

      const subNames = channelGroup.options?.map((s: any) => s.name);
      expect(subNames).toContain('set');
      expect(subNames).toContain('list');
    });

    it('has correct staff subcommands: add, remove, and list', () => {
      const json = setupCommand.toJSON();
      const staffGroup: any = json.options?.find((opt) => opt.name === 'staff');
      expect(staffGroup).toBeDefined();

      const subNames = staffGroup.options?.map((s: any) => s.name);
      expect(subNames).toContain('add');
      expect(subNames).toContain('remove');
      expect(subNames).toContain('list');
    });
  });

  describe('Channel Manager Cache & Fallback', () => {
    it('returns fallback channel ID when DB has no record for notify', async () => {
      const channelId = await getChannelId('notify', '123456789012345678');
      expect(channelId).toBe('123456789012345678');
    });

    it('returns null when no record and no fallback provided', async () => {
      const channelId = await getChannelId('unknown_purpose');
      expect(channelId).toBeNull();
    });

    it('caches channel ID after updating', async () => {
      await updateChannelPurpose({
        purpose: 'orders',
        channelId: '987654321098765432',
        channelName: 'orders-channel',
      });

      const channelId = await getChannelId('orders');
      expect(channelId).toBe('987654321098765432');
    });

    it('clears cache when invalidateChannelCache is called', async () => {
      await updateChannelPurpose({
        purpose: 'audit',
        channelId: '555555555555555555',
      });

      expect(await getChannelId('audit')).toBe('555555555555555555');

      invalidateChannelCache('audit');
      // After invalidation and DB mock returning [], fallback should be used
      const after = await getChannelId('audit', 'fallback_id');
      expect(after).toBe('fallback_id');
    });
  });
});
