import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/db/migrate.js';
import { buildPagedSelect, OPTIONS_PER_PAGE, toComponents } from '../src/bot/components/build-paged-select.js';
import { ID, pluginOptions, versionOptions } from '../src/bot/components/handle-component-interaction.js';
import { isIgnorableDiscordError } from '../src/bot/client.js';
import {
  hashToken,
  mintDownloadToken,
  redeemDownloadToken,
  sweepExpiredTokens,
} from '../src/services/delivery/mint-download-token.js';
import { suggestFilename } from '../src/services/delivery/deliver-version.js';
import {
  COLOUR,
  browseEmbed,
  deliveredEmbed,
  errorEmbed,
  panelEmbed,
  paymentEmbed,
  topupQrEmbed,
  versionsEmbed,
  walletEmbed,
  walletPaidEmbed,
} from '../src/bot/components/build-embeds.js';
import { ledgerKindVi } from '../src/bot/i18n/bot-vi.js';
import { LEDGER_KINDS } from '../src/domain/wallet.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { createVersion } from '../src/repositories/versions.js';
import { now } from '../src/db/connection.js';

function seedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

describe('buildPagedSelect', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `Plugin ${i}` }));

  it('caps options at the Discord limit of 25 per page', () => {
    const paged = buildPagedSelect({ items, page: 0, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(paged.select.components[0]!.options).toHaveLength(OPTIONS_PER_PAGE);
    expect(paged.totalPages).toBe(3);
  });

  it('clamps a page below range to the first page', () => {
    const paged = buildPagedSelect({ items, page: -5, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(paged.page).toBe(0);
  });

  it('clamps a page beyond range to the last page', () => {
    const paged = buildPagedSelect({ items, page: 99, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(paged.page).toBe(2);
    expect(paged.select.components[0]!.options).toHaveLength(10);
  });

  it('omits navigation when everything fits on one page', () => {
    const paged = buildPagedSelect({
      items: items.slice(0, 5),
      page: 0,
      selectId: 'sel:p',
      navPrefix: 'pg:p',
      placeholder: 'Chọn',
    });
    expect(paged.nav).toBeNull();
    expect(toComponents(paged)).toHaveLength(1);
  });

  it('uses two action rows when paginating, well inside the limit of five', () => {
    const paged = buildPagedSelect({ items, page: 1, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(toComponents(paged)).toHaveLength(2);
  });

  it('disables previous on the first page and next on the last', () => {
    const first = buildPagedSelect({ items, page: 0, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    const last = buildPagedSelect({ items, page: 2, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(first.nav!.components[0]!.data.disabled).toBe(true);
    expect(first.nav!.components[2]!.data.disabled).toBe(false);
    expect(last.nav!.components[0]!.data.disabled).toBe(false);
    expect(last.nav!.components[2]!.data.disabled).toBe(true);
  });

  it('keeps every custom_id inside the 100-character cap', () => {
    const paged = buildPagedSelect({
      items,
      page: 1,
      selectId: ID.selectVersion(999999),
      navPrefix: ID.pageVersion(999999),
      placeholder: 'Chọn',
    });
    expect(paged.select.components[0]!.data.custom_id!.length).toBeLessThanOrEqual(100);
    for (const button of paged.nav!.components) {
      expect(button.data.custom_id!.length).toBeLessThanOrEqual(100);
    }
  });

  it('truncates a long label rather than letting Discord reject the payload', () => {
    const paged = buildPagedSelect({
      items: [{ value: '1', label: 'x'.repeat(200) }],
      page: 0,
      selectId: 'sel:p',
      navPrefix: 'pg:p',
      placeholder: 'Chọn',
    });
    const label = paged.select.components[0]!.options[0]!.data.label!;
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.endsWith('…')).toBe(true);
  });

  it('handles an empty list without producing an invalid menu', () => {
    const paged = buildPagedSelect({ items: [], page: 0, selectId: 'sel:p', navPrefix: 'pg:p', placeholder: 'Chọn' });
    expect(paged.totalPages).toBe(1);
    expect(paged.select.components[0]!.options).toHaveLength(0);
  });
});

describe('download tokens', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
    const plugin = createPlugin(db, {
      slug: 'target',
      displayName: 'Target',
      descriptorName: 'Target',
      platform: 'spigot',
    });
    createVersion(db, {
      pluginId: plugin.id,
      version: '1.0.0',
      rawVersion: '1.0.0',
      sha256: 'a'.repeat(64),
      relPath: `aa/${'a'.repeat(64)}`,
      bytes: 100,
      originalName: 'target.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
  });

  afterEach(() => db.close());

  it('stores only the digest, never the token itself', () => {
    const minted = mintDownloadToken(db, { versionId: 1, discordUserId: '42', ttlMinutes: 15 });
    const row = db.prepare('SELECT token_hash FROM download_tokens').get() as { token_hash: Buffer };
    expect(row.token_hash.equals(hashToken(minted.token))).toBe(true);
    expect(row.token_hash.toString('utf8')).not.toContain(minted.token);
  });

  it('produces a URL-safe token', () => {
    const minted = mintDownloadToken(db, { versionId: 1, discordUserId: '42', ttlMinutes: 15 });
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(minted.token).toHaveLength(43);
  });

  it('redeems once and refuses the second attempt', () => {
    const minted = mintDownloadToken(db, { versionId: 1, discordUserId: '42', ttlMinutes: 15 });
    expect(redeemDownloadToken(db, minted.token)).toMatchObject({ versionId: 1, discordUserId: '42' });
    expect(redeemDownloadToken(db, minted.token)).toBeNull();
  });

  it('refuses an unknown token', () => {
    expect(redeemDownloadToken(db, 'totally-made-up-token')).toBeNull();
  });

  it('refuses an expired token', () => {
    const minted = mintDownloadToken(db, { versionId: 1, discordUserId: '42', ttlMinutes: 15 });
    db.prepare('UPDATE download_tokens SET expires_at = ?').run(now() - 10);
    expect(redeemDownloadToken(db, minted.token)).toBeNull();
  });

  it('sweeps expired rows and keeps live ones', () => {
    const live = mintDownloadToken(db, { versionId: 1, discordUserId: '1', ttlMinutes: 60 });
    const dead = mintDownloadToken(db, { versionId: 1, discordUserId: '2', ttlMinutes: 60 });
    db.prepare('UPDATE download_tokens SET expires_at = ? WHERE token_hash = ?').run(now() - 5, hashToken(dead.token));

    expect(sweepExpiredTokens(db)).toBe(1);
    expect(redeemDownloadToken(db, live.token)).not.toBeNull();
  });

  it('cascades tokens away when the version is deleted', () => {
    mintDownloadToken(db, { versionId: 1, discordUserId: '42', ttlMinutes: 15 });
    db.prepare('DELETE FROM versions WHERE id = 1').run();
    expect((db.prepare('SELECT count(*) AS c FROM download_tokens').get() as { c: number }).c).toBe(0);
  });
});

describe('suggestFilename', () => {
  it('builds a clean slug-version name', () => {
    expect(suggestFilename('mythicmobs', '5.6.2', 'MythicMobs-Premium.jar')).toBe('mythicmobs-5.6.2.jar');
  });

  it('preserves a zip extension', () => {
    expect(suggestFilename('bundle', '1.0', 'Bundle-Pack.zip')).toBe('bundle-1.0.zip');
  });

  it('falls back to the original name when there is no version', () => {
    expect(suggestFilename('proxy', null, 'proxy-thing.jar')).toBe('proxy-thing.jar');
  });

  it('strips characters that would be unsafe in a filename', () => {
    expect(suggestFilename('plug', '1.0/../etc', 'x.jar')).toBe('plug-1.0-..-etc.jar');
    expect(suggestFilename('plug', '2.0 BETA', 'x.jar')).toBe('plug-2.0-BETA.jar');
  });
});

describe('menu option builders', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bot-opts-'));
    db = seedDb();
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('orders versions newest upload first, never by version string', () => {
    const plugin = createPlugin(db, {
      slug: 'ordered',
      displayName: 'Ordered',
      descriptorName: 'Ordered',
      platform: 'spigot',
    });

    // Deliberately non-semver-sortable: "4.0.9" sorts after "4.0.10" as a string.
    const older = createVersion(db, {
      pluginId: plugin.id,
      version: '4.0.10',
      rawVersion: '4.0.10',
      sha256: 'b'.repeat(64),
      relPath: `bb/${'b'.repeat(64)}`,
      bytes: 1,
      originalName: 'a.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
    const newer = createVersion(db, {
      pluginId: plugin.id,
      version: '4.0.9',
      rawVersion: '4.0.9',
      sha256: 'c'.repeat(64),
      relPath: `cc/${'c'.repeat(64)}`,
      bytes: 1,
      originalName: 'b.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
    db.prepare('UPDATE versions SET uploaded_at = ? WHERE id = ?').run(1000, older.id);
    db.prepare('UPDATE versions SET uploaded_at = ? WHERE id = ?').run(2000, newer.id);

    const options = versionOptions(db, plugin.id);
    expect(options[0]!.value).toBe(String(newer.id));
    expect(options[0]!.label).toContain('4.0.9');
  });

  it('marks a stable version in its label', () => {
    const plugin = createPlugin(db, {
      slug: 'stable-test',
      displayName: 'Stable Test',
      descriptorName: 'StableTest',
      platform: 'spigot',
    });
    const version = createVersion(db, {
      pluginId: plugin.id,
      version: '1.0.0',
      rawVersion: '1.0.0',
      sha256: 'd'.repeat(64),
      relPath: `dd/${'d'.repeat(64)}`,
      bytes: 1,
      originalName: 'x.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
    db.prepare('UPDATE versions SET is_stable = 1 WHERE id = ?').run(version.id);

    expect(versionOptions(db, plugin.id)[0]!.label).toContain('ổn định');
  });

  it('shows the deposit price as an option description only when set', () => {
    createPlugin(db, { slug: 'free', displayName: 'Free One', descriptorName: 'FreeOne', platform: 'spigot' });
    const paid = createPlugin(db, { slug: 'paid', displayName: 'Paid One', descriptorName: 'PaidOne', platform: 'spigot' });
    db.prepare('UPDATE plugins SET deposit_price = 20000 WHERE id = ?').run(paid.id);

    const options = pluginOptions(db);
    const free = options.find((o) => o.label === 'Free One');
    const withPrice = options.find((o) => o.label === 'Paid One');
    expect(free?.description).toBeUndefined();
    expect(withPrice?.description).toContain('20.000');
  });

  it('returns every plugin so pagination can slice them', () => {
    for (let i = 0; i < 40; i++) {
      createPlugin(db, {
        slug: `p${i}`,
        displayName: `Plugin ${i}`,
        descriptorName: `Plugin${i}`,
        platform: 'spigot',
      });
    }
    expect(pluginOptions(db)).toHaveLength(40);
  });

  it('writes a fixture blob path that matches the content address layout', async () => {
    const sha = 'e'.repeat(64);
    await mkdir(join(root, sha.slice(0, 2)), { recursive: true });
    await writeFile(join(root, sha.slice(0, 2), sha), 'x');
    expect(join(root, `${sha.slice(0, 2)}/${sha}`)).toContain(sha.slice(0, 2));
  });
});

describe('message embeds', () => {
  const version = {
    id: 1,
    pluginId: 1,
    version: '2.9.7.23',
    rawVersion: '2.9.7.23',
    sha256: 'a'.repeat(64),
    relPath: `aa/${'a'.repeat(64)}`,
    bytes: 3_400_000,
    originalName: 'Vulcan.jar',
    descriptorKind: 'spigot' as const,
    isStable: false,
    versionFlag: 'ok' as const,
    uploadedAt: 1_780_000_000,
    pluginSlug: 'vulcan',
    pluginDisplayName: 'Vulcan Anti-Cheat',
    depositPrice: 20_000,
  };

  it('colours a failure differently from a success', () => {
    // Discord shows no icon on an embed, so the stripe colour is the only thing
    // that reads as "this went wrong" before the text is read.
    const bad = errorEmbed('Không gửi được tệp', 'Thử lại sau').toJSON();
    const good = deliveredEmbed(version).toJSON();

    expect(bad.color).toBe(COLOUR.danger);
    expect(good.color).toBe(COLOUR.success);
    expect(bad.color).not.toBe(good.color);
  });

  it('always pairs a failure title with something the person can do', () => {
    // A bare "Gửi thất bại" is true and useless — it leaves someone at a dead end.
    const embed = errorEmbed('Không gửi được tin nhắn riêng', 'Bật Direct Messages rồi thử lại.').toJSON();

    expect(embed.title).toBeTruthy();
    expect(embed.description).toBeTruthy();
    expect(embed.description!.length).toBeGreaterThan(10);
  });

  it('puts the transfer note in a code fence so it can be copied on mobile', () => {
    // SePay matches a transfer BY this note. Selecting it out of a sentence on a
    // phone is error-prone, and a wrong note means the money cannot be attributed.
    const embed = paymentEmbed(version, {
      code: 'VNAB12CD',
      amount: 20_000,
      walletPaid: 0,
      bankDue: 20_000,
      qrUrl: 'https://qr.sepay.vn/img?x=1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }).toJSON();

    const note = embed.fields?.find((f) => f.value.includes('VNAB12CD'));
    expect(note?.value).toContain('```');
    // The QR must be the image, not a link: it is meant to be scanned.
    expect(embed.image?.url).toContain('qr.sepay.vn');
  });

  it('states the amount and the deadline on a payment request', () => {
    const embed = paymentEmbed(version, {
      code: 'VNAB12CD',
      amount: 20_000,
      walletPaid: 0,
      bankDue: 20_000,
      qrUrl: 'https://qr.sepay.vn/img?x=1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }).toJSON();

    expect(JSON.stringify(embed)).toContain('20.000');
    expect(embed.footer?.text).toMatch(/\d+ phút/);
  });

  it('never reports a deadline of zero minutes', () => {
    // Rounding an almost-expired order to "0 phút" reads as already dead, so the
    // person does not even try.
    const embed = paymentEmbed(version, {
      code: 'VNAB12CD',
      amount: 20_000,
      walletPaid: 0,
      bankDue: 20_000,
      qrUrl: 'https://qr.sepay.vn/img?x=1',
      expiresAt: Math.floor(Date.now() / 1000) + 5,
    }).toJSON();

    expect(embed.footer?.text).toContain('1 phút');
  });

  it('states all three numbers when coins covered part of the price', () => {
    // Showing only the transfer amount reads as the price, so the buyer transfers
    // the full price and overpays; showing only the price has them transfer too
    // much. The QR carries bankDue, so the stated amount must match it.
    const embed = paymentEmbed(version, {
      code: 'VNAB12CD',
      amount: 50_000,
      walletPaid: 20_000,
      bankDue: 30_000,
      qrUrl: 'https://qr.sepay.vn/img?x=1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }).toJSON();

    const rendered = JSON.stringify(embed);
    expect(rendered).toContain('50.000');
    expect(rendered).toContain('20.000');
    expect(rendered).toContain('30.000');
    // Coins are what the wallet is denominated in for the reader.
    expect(rendered).toContain('20 coin');
  });

  it('omits the QR when the wallet settled the whole price', () => {
    // A QR on a settled order invites a second payment for nothing.
    const embed = paymentEmbed(version, {
      code: 'VNAB12CD',
      amount: 20_000,
      walletPaid: 20_000,
      bankDue: 0,
      qrUrl: null,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }).toJSON();

    expect(embed.image).toBeUndefined();
  });

  it('says what was spent on a wallet-paid order', () => {
    // A silent deduction is how a balance appears to vanish.
    const embed = walletPaidEmbed(version, { amount: 20_000, walletPaid: 20_000 }).toJSON();
    expect(JSON.stringify(embed)).toContain('20 coin');
  });

  it('shows the balance in both units and the coin rate', () => {
    // Coins are what the shop is priced in; VND is what people transfer. Either
    // number alone leaves the reader converting in their head.
    const embed = walletEmbed(1_500, []).toJSON();
    const rendered = JSON.stringify(embed);
    expect(rendered).toContain('1 coin');
    expect(rendered).toContain('1.500');
    expect(rendered).toContain('1.000');
  });

  it('lists recent movements with a readable reason', () => {
    const embed = walletEmbed(20_000, [
      {
        id: 2,
        discordUserId: '1',
        delta: -30_000,
        balanceAfter: 20_000,
        kind: 'order_hold',
        refType: 'order',
        refId: 5,
        note: '',
        createdAt: 1_760_000_000,
      },
      {
        id: 1,
        discordUserId: '1',
        delta: 50_000,
        balanceAfter: 50_000,
        kind: 'bank_topup',
        refType: 'topup',
        refId: 3,
        note: '',
        createdAt: 1_759_000_000,
      },
    ]).toJSON();

    const rendered = JSON.stringify(embed);
    expect(rendered).toContain('mua plugin');
    expect(rendered).toContain('nạp chuyển khoản');
    // Sign carries the direction; a bare number cannot.
    expect(rendered).toContain('30.000');
    expect(rendered).toContain('+50.000');
  });

  it('names every ledger kind so none renders as a raw key', () => {
    for (const kind of LEDGER_KINDS) {
      expect(ledgerKindVi(kind)).not.toBe(kind);
    }
  });

  it('keeps the transfer note on a top-up QR, since the note is the whole match', () => {
    const embed = topupQrEmbed({
      code: 'VNTOPUP01',
      amount: 50_000,
      qrUrl: 'https://qr.sepay.vn/img?x=1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }).toJSON();

    const note = embed.fields?.find((f) => f.value.includes('VNTOPUP01'));
    expect(note?.value).toContain('```');
    expect(embed.image?.url).toContain('qr.sepay.vn');
  });

  it('names the file size and date on delivery, so DMs are searchable', () => {
    const embed = deliveredEmbed(version).toJSON();

    expect(JSON.stringify(embed)).toContain('Vulcan Anti-Cheat');
    expect(embed.fields?.some((f) => f.value.includes('MB'))).toBe(true);
  });

  it('shows the deposit on the version picker, before a version is chosen', () => {
    // Discovering a charge only after picking is the kind of surprise that makes a
    // tool feel untrustworthy.
    const plugin = {
      id: 1,
      slug: 'vulcan',
      displayName: 'Vulcan Anti-Cheat',
      descriptorName: 'Vulcan',
      platform: 'spigot' as const,
      resourceId: 83626,
      depositPrice: 20_000,
      isPremium: true,
      createdAt: 1_780_000_000,
    };

    const embed = versionsEmbed(plugin, 7, 0, 1).toJSON();
    expect(JSON.stringify(embed)).toContain('20.000');
  });

  it('omits the deposit field when a plugin is free', () => {
    const plugin = {
      id: 2,
      slug: 'free',
      displayName: 'Free Thing',
      descriptorName: 'Free',
      platform: 'spigot' as const,
      resourceId: null,
      depositPrice: 0,
      isPremium: false,
      createdAt: 1_780_000_000,
    };

    const embed = versionsEmbed(plugin, 3, 0, 1).toJSON();
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('includes external link in embed url and fields when present', () => {
    const plugin = {
      id: 3,
      slug: 'vulcan',
      displayName: 'Vulcan Anti-Cheat',
      descriptorName: 'Vulcan',
      platform: 'spigot' as const,
      resourceId: 83626,
      depositPrice: 50_000,
      isPremium: true,
      externalLink: 'https://www.spigotmc.org/resources/83626/',
      createdAt: 1_780_000_000,
    };

    const embed = versionsEmbed(plugin, 5, 0, 1).toJSON();
    expect(embed.url).toBe('https://www.spigotmc.org/resources/83626/');
    expect(JSON.stringify(embed.fields)).toContain('https://www.spigotmc.org/resources/83626/');
  });

  it('shows a page footer only when there is more than one page', () => {
    expect(browseEmbed(5, 0, 1).toJSON().footer).toBeUndefined();
    expect(browseEmbed(60, 1, 3).toJSON().footer?.text).toContain('2/3');
  });

  it('says the vault is empty rather than showing an empty panel', () => {
    expect(panelEmbed(0).toJSON().footer?.text).toContain('chưa có');
    expect(panelEmbed(12).toJSON().footer?.text).toContain('12');
  });
});

describe('isIgnorableDiscordError', () => {
  it('identifies 10062 (Unknown interaction) as ignorable', () => {
    expect(isIgnorableDiscordError({ code: 10062, message: 'Unknown interaction' })).toBe(true);
  });

  it('identifies 40060 (Interaction has already been acknowledged) as ignorable', () => {
    expect(isIgnorableDiscordError({ code: 40060, message: 'Interaction has already been acknowledged.' })).toBe(true);
  });

  it('does not ignore other errors', () => {
    expect(isIgnorableDiscordError(new Error('something else'))).toBe(false);
    expect(isIgnorableDiscordError({ code: 50001 })).toBe(false);
    expect(isIgnorableDiscordError(null)).toBe(false);
    expect(isIgnorableDiscordError(undefined)).toBe(false);
  });
});
