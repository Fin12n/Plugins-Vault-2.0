import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envSchema, type Env } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { seedSettings } from '../src/db/settings-store.js';
import { buildServer } from '../src/http/server.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { createVersion } from '../src/repositories/versions.js';
import {
  createOrder,
  findOrderByCode,
  expireStaleOrders,
  listUndeliveredPaidOrders,
} from '../src/repositories/orders.js';
import {
  buildVietQrUrl,
  generatePaymentCode,
  parseSepayTimestamp,
} from '../src/services/payment/build-vietqr-url.js';
import { applySepayTransfer, openOrder } from '../src/services/payment/match-and-fulfil-order.js';
import { signSepayPayload, verifySepaySignature } from '../src/services/payment/verify-sepay-signature.js';
import type { SepayWebhookPayload } from '../src/domain/order.js';

const SECRET = 'hmac-secret-value';

function makeEnv(root: string): Env {
  return envSchema.parse({
    DISCORD_TOKEN: 'token',
    DISCORD_CLIENT_ID: '100000000000000001',
    DISCORD_GUILD_ID: '100000000000000002',
    DISCORD_ADMIN_ROLE_IDS: '100000000000000003',
    DISCORD_OWNER_ID: '100000000000000004',
    DISCORD_NOTIFY_CHANNEL_ID: '100000000000000005',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DASHBOARD_PASSWORD: 'owner-password-123',
    SESSION_SECRET: 'k9Xq2mVt7bNr4aLp8sZw3eYc6uHd1oGf',
    SEPAY_WEBHOOK_SECRET: SECRET,
    SEPAY_ACCOUNT_NUMBER: '0010000000355',
    SEPAY_BANK_CODE: 'Vietcombank',
    SEPAY_CODE_PREFIX: 'vn',
    VAULT_DIR: join(root, 'vault'),
    TMP_DIR: join(root, 'tmp'),
    DB_PATH: join(root, 'db.sqlite'),
  });
}

function basePayload(overrides: Partial<SepayWebhookPayload> = {}): SepayWebhookPayload {
  return {
    id: 92704,
    gateway: 'Vietcombank',
    transactionDate: '2026-07-02 11:08:33',
    accountNumber: '0010000000355',
    subAccount: '',
    code: 'VNABCD1234',
    content: 'VNABCD1234 chuyen tien',
    transferType: 'in',
    description: 'NGUYEN VAN A chuyen tien',
    transferAmount: 20000,
    accumulated: 105000000,
    referenceCode: 'FT26012345678',
    ...overrides,
  };
}

describe('buildVietQrUrl', () => {
  it('builds a plain GET image URL with the expected params', () => {
    const url = buildVietQrUrl({ accountNumber: '0010000000355', bankCode: 'Vietcombank', amount: 20000, code: 'VNX1' });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://qr.sepay.vn/img');
    expect(parsed.searchParams.get('acc')).toBe('0010000000355');
    expect(parsed.searchParams.get('bank')).toBe('Vietcombank');
    expect(parsed.searchParams.get('amount')).toBe('20000');
    expect(parsed.searchParams.get('des')).toBe('VNX1');
  });

  it('percent-encodes a bank name containing a space', () => {
    const url = buildVietQrUrl({ accountNumber: '1', bankCode: 'Sacom Bank', amount: 1, code: 'X' });
    expect(url).toContain('bank=Sacom+Bank');
    expect(new URL(url).searchParams.get('bank')).toBe('Sacom Bank');
  });
});

describe('generatePaymentCode', () => {
  it('uppercases the prefix and uses only characters SePay accepts', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePaymentCode('vn', 8);
      expect(code).toMatch(/^VN[A-Z0-9]{8}$/);
    }
  });

  it('honours the configured suffix length, which must clear SePay\'s minimum', () => {
    // A code shorter than the configured minimum makes SePay extract an empty
    // value, so the webhook arrives but matches nothing.
    expect(generatePaymentCode('VN', 6)).toHaveLength(8);
    expect(generatePaymentCode('VN', 12)).toHaveLength(14);
  });

  it('produces distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePaymentCode('VN', 8)));
    expect(codes.size).toBe(200);
  });
});

describe('parseSepayTimestamp', () => {
  it('reads the wall clock as Vietnam time, not as UTC or the host timezone', () => {
    // 2026-07-02 11:08:33 at UTC+7 is 04:08:33 UTC.
    const seconds = parseSepayTimestamp('2026-07-02 11:08:33');
    expect(seconds).toBe(Date.UTC(2026, 6, 2, 4, 8, 33) / 1000);
  });

  it('rejects a malformed value rather than guessing', () => {
    expect(parseSepayTimestamp('not a date')).toBeNull();
    expect(parseSepayTimestamp('')).toBeNull();
  });
});

describe('verifySepaySignature', () => {
  const rawBody = JSON.stringify(basePayload());
  const timestamp = 1785000000;

  it('accepts a correctly signed body', () => {
    const header = signSepayPayload(SECRET, timestamp, rawBody);
    const verdict = verifySepaySignature({
      rawBody,
      signatureHeader: header,
      timestampHeader: String(timestamp),
      secret: SECRET,
      nowSeconds: timestamp + 5,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('rejects a signature computed over the body alone, without the timestamp', () => {
    // The signing string is `{timestamp}.{rawBody}`; the dot and timestamp are part
    // of it, so signing the body alone looks plausible but never matches.
    const wrong = signSepayPayload(SECRET, timestamp, rawBody).replace('sha256=', '');
    const bodyOnly = verifySepaySignature({
      rawBody,
      signatureHeader: `sha256=${wrong.split('').reverse().join('')}`,
      timestampHeader: String(timestamp),
      secret: SECRET,
      nowSeconds: timestamp,
    });
    expect(bodyOnly.ok).toBe(false);
  });

  it('rejects a body that was re-serialized rather than passed through raw', () => {
    // Key order differs after a parse/stringify round trip, which is the classic
    // way this integration silently never verifies.
    const reordered = JSON.stringify({ transferAmount: 20000, id: 92704 });
    const header = signSepayPayload(SECRET, timestamp, rawBody);
    const verdict = verifySepaySignature({
      rawBody: reordered,
      signatureHeader: header,
      timestampHeader: String(timestamp),
      secret: SECRET,
      nowSeconds: timestamp,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const header = signSepayPayload(SECRET, timestamp, rawBody);
    const verdict = verifySepaySignature({
      rawBody,
      signatureHeader: header,
      timestampHeader: String(timestamp),
      secret: SECRET,
      nowSeconds: timestamp + 600,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'stale-timestamp' });
  });

  it('rejects missing headers', () => {
    expect(
      verifySepaySignature({ rawBody, signatureHeader: undefined, timestampHeader: '1', secret: SECRET }),
    ).toMatchObject({ ok: false, reason: 'missing-headers' });
  });

  it('tolerates a signature of a different length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so the guard must come first.
    const verdict = verifySepaySignature({
      rawBody,
      signatureHeader: 'sha256=short',
      timestampHeader: String(timestamp),
      secret: SECRET,
      nowSeconds: timestamp,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('accepts the header with or without the sha256 prefix and in any case', () => {
    const header = signSepayPayload(SECRET, timestamp, rawBody).replace('sha256=', '');
    expect(
      verifySepaySignature({
        rawBody,
        signatureHeader: header.toUpperCase(),
        timestampHeader: String(timestamp),
        secret: SECRET,
        nowSeconds: timestamp,
      }),
    ).toEqual({ ok: true });
  });
});

describe('applySepayTransfer', () => {
  let db: Database.Database;
  let root: string;

  async function seedPaidableOrder(amount = 20000, code = 'VNABCD1234') {
    const sha = 'a'.repeat(64);
    const plugin = createPlugin(db, {
      slug: 'paid-plugin',
      displayName: 'Paid Plugin',
      descriptorName: 'PaidPlugin',
      platform: 'spigot',
    });
    db.prepare('UPDATE plugins SET deposit_price = ? WHERE id = ?').run(amount, plugin.id);

    const version = createVersion(db, {
      pluginId: plugin.id,
      version: '1.0.0',
      rawVersion: '1.0.0',
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: 10,
      originalName: 'paid.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    });
    await mkdir(join(root, 'vault', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(root, 'vault', sha.slice(0, 2), sha), 'jar');

    return createOrder(db, {
      code,
      discordUserId: '777',
      versionId: version.id,
      pluginName: 'Paid Plugin',
      versionLabel: '1.0.0',
      amount,
      ttlMinutes: 15,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sepay-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('marks a matching order paid', async () => {
    const order = await seedPaidableOrder();
    const outcome = applySepayTransfer(db, basePayload({ code: order.code }));
    expect(outcome).toEqual({ handled: 'paid', orderId: order.id });
    expect(findOrderByCode(db, order.code)?.status).toBe('paid');
  });

  it('treats a replayed webhook as a duplicate and does not re-pay', async () => {
    const order = await seedPaidableOrder();
    const payload = basePayload({ code: order.code });

    expect(applySepayTransfer(db, payload)).toEqual({ handled: 'paid', orderId: order.id });
    expect(applySepayTransfer(db, payload)).toEqual({ handled: 'duplicate' });
    expect((db.prepare('SELECT count(*) AS c FROM sepay_transactions').get() as { c: number }).c).toBe(1);
  });

  it('never credits an outgoing transfer, whose amount is also positive', async () => {
    const order = await seedPaidableOrder();
    const outcome = applySepayTransfer(db, basePayload({ code: order.code, transferType: 'out' }));
    expect(outcome).toMatchObject({ handled: 'ignored', why: 'outgoing' });
    expect(findOrderByCode(db, order.code)?.status).toBe('pending');
  });

  it('distinguishes a null code from an empty one, both without crediting', async () => {
    await seedPaidableOrder();
    expect(applySepayTransfer(db, basePayload({ id: 1, code: null }))).toMatchObject({ why: 'no-code' });
    expect(applySepayTransfer(db, basePayload({ id: 2, code: '' }))).toMatchObject({ why: 'no-code' });
  });

  it('records an unmatched transfer so it is visible, without touching any order', () => {
    const outcome = applySepayTransfer(db, basePayload({ code: 'VNNOSUCH1' }));
    expect(outcome).toMatchObject({ handled: 'ignored', why: 'no-order' });
    expect((db.prepare('SELECT count(*) AS c FROM sepay_transactions').get() as { c: number }).c).toBe(1);
  });

  it('marks an underpaid order underpaid and records what actually arrived', async () => {
    const order = await seedPaidableOrder(20000);
    const outcome = applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 5000 }));
    expect(outcome).toMatchObject({ handled: 'ignored', why: 'underpaid' });

    const stored = findOrderByCode(db, order.code);
    // Not 'pending': the TTL sweep expires pending rows, which would erase the
    // only sign that a short transfer ever arrived.
    expect(stored?.status).toBe('underpaid');
    expect(stored?.paidAmount).toBe(5000);
    expect(stored?.paidAt).not.toBeNull();
  });

  it('never lets the expiry sweep touch an underpaid order', () => {
    const db2 = db;
    db2
      .prepare(
        `INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label,
                             amount, status, paid_amount, created_at, expires_at, paid_at)
         VALUES ('VNSHORT1', '1', NULL, 'P', '1.0', 20000, 'underpaid', 5000, 1, 2, 3)`,
      )
      .run();
    expireStaleOrders(db2);
    expect(findOrderByCode(db2, 'VNSHORT1')?.status).toBe('underpaid');
  });

  it('surfaces an underpaid order in the reconcile view', async () => {
    const order = await seedPaidableOrder(20000);
    applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 5000 }));
    // The whole point of the status: money was taken, so the owner must see it.
    expect(listUndeliveredPaidOrders(db).map((o) => o.code)).toContain(order.code);
  });

  it('records the full amount paid on an exact transfer', async () => {
    const order = await seedPaidableOrder(20000);
    applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 20000 }));
    expect(findOrderByCode(db, order.code)?.paidAmount).toBe(20000);
  });

  it('accepts an overpayment', async () => {
    const order = await seedPaidableOrder(20000);
    expect(applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 50000 }))).toMatchObject({
      handled: 'paid',
    });
  });

  it('matches the code case-insensitively, since SePay uppercases what it extracts', async () => {
    const order = await seedPaidableOrder(20000, 'VNABCD1234');
    expect(applySepayTransfer(db, basePayload({ code: 'vnabcd1234' }))).toMatchObject({ handled: 'paid' });
    expect(findOrderByCode(db, order.code)?.status).toBe('paid');
  });

  it('ignores a second transfer for an order already paid', async () => {
    const order = await seedPaidableOrder();
    applySepayTransfer(db, basePayload({ id: 1, code: order.code }));
    expect(applySepayTransfer(db, basePayload({ id: 2, code: order.code }))).toMatchObject({
      handled: 'ignored',
      why: 'not-pending',
    });
  });

  it('links the transaction to the order it settled', async () => {
    const order = await seedPaidableOrder();
    applySepayTransfer(db, basePayload({ code: order.code }));
    const row = db.prepare('SELECT order_id FROM sepay_transactions').get() as { order_id: number };
    expect(row.order_id).toBe(order.id);
  });

  it('keeps the raw memo fields for observing real bank behavior', async () => {
    const order = await seedPaidableOrder();
    applySepayTransfer(db, basePayload({ code: order.code, content: 'CT DEN:VNABCD1234 abc' }));
    const row = db.prepare('SELECT content, description, raw_payload FROM sepay_transactions').get() as {
      content: string;
      description: string;
      raw_payload: string;
    };
    expect(row.content).toBe('CT DEN:VNABCD1234 abc');
    expect(row.description).toContain('NGUYEN VAN A');
    expect(JSON.parse(row.raw_payload)).toMatchObject({ id: 92704 });
  });
});

describe('openOrder and expiry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => db.close());

  function seedPricedVersion(price: number): number {
    const plugin = createPlugin(db, {
      slug: 'priced',
      displayName: 'Priced Plugin',
      descriptorName: 'Priced',
      platform: 'spigot',
    });
    db.prepare('UPDATE plugins SET deposit_price = ? WHERE id = ?').run(price, plugin.id);
    const sha = 'c'.repeat(64);
    return createVersion(db, {
      pluginId: plugin.id,
      version: '2.0.0',
      rawVersion: '2.0.0',
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: 10,
      originalName: 'p.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    }).id;
  }

  const config = {
    accountNumber: '0010000000355',
    bankCode: 'Vietcombank',
    codePrefix: 'VN',
    codeSuffixLength: 8,
    ttlMinutes: 15,
  };

  it('opens an order carrying the plugin price and a QR url', () => {
    const versionId = seedPricedVersion(30000);
    const created = openOrder(db, config, { discordUserId: '5', versionId });
    expect(created).toMatchObject({ amount: 30000 });
    expect(created!.qrUrl).toContain(created!.code);
    expect(created!.code).toMatch(/^VN[A-Z0-9]{8}$/);
  });

  it('denormalizes the plugin name so the order survives a prune', () => {
    const versionId = seedPricedVersion(10000);
    const created = openOrder(db, config, { discordUserId: '5', versionId })!;
    db.prepare('DELETE FROM versions').run();

    const order = findOrderByCode(db, created.code)!;
    expect(order.versionId).toBeNull();
    expect(order.pluginName).toBe('Priced Plugin');
    expect(order.versionLabel).toBe('2.0.0');
    expect(order.amount).toBe(10000);
  });

  it('returns null for a version that does not exist', () => {
    expect(openOrder(db, config, { discordUserId: '5', versionId: 9999 })).toBeNull();
  });

  it('expires a pending order past its TTL but never a paid one', () => {
    const versionId = seedPricedVersion(10000);
    const pending = openOrder(db, config, { discordUserId: '1', versionId })!;
    db.prepare("UPDATE orders SET expires_at = 1 WHERE code = ?").run(pending.code);

    // A paid order in the past must not be swept: money already changed hands.
    db.prepare(
      `INSERT INTO orders (code, discord_user_id, plugin_name, version_label, amount, status, created_at, expires_at, paid_at)
       VALUES ('VNPAID001', '2', 'X', '1.0', 1000, 'paid', 1, 1, 2)`,
    ).run();

    // No coins were involved, so nothing is refunded.
    expect(expireStaleOrders(db)).toEqual({ expired: 1, refunded: 0 });
    expect(findOrderByCode(db, pending.code)?.status).toBe('expired');
    expect(findOrderByCode(db, 'VNPAID001')?.status).toBe('paid');
  });
});

describe('sepay webhook route', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sepay-http-'));
    const env = makeEnv(root);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    seedSettings(db, env);
    // No delivery deps: this exercises the acknowledgement contract and signature
    // handling, which are independent of Discord.
    app = await buildServer({ db, env });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function post(payload: unknown, options: { secret?: string; skew?: number } = {}) {
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000) + (options.skew ?? 0);
    return app.inject({
      method: 'POST',
      url: '/webhooks/sepay',
      payload: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-sepay-signature': signSepayPayload(options.secret ?? SECRET, timestamp, rawBody),
        'x-sepay-timestamp': String(timestamp),
      },
    });
  }

  it('acknowledges with exactly the body SePay requires', async () => {
    const res = await post(basePayload({ code: 'VNNOMATCH' }));
    expect(res.statusCode).toBe(200);
    // A bare 200 or any other body counts as a failure and triggers retries.
    expect(res.json()).toEqual({ success: true });
  });

  it('rejects a signature made with the wrong secret', async () => {
    const res = await post(basePayload(), { secret: 'not-the-secret' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false });
  });

  it('rejects a request with no signature headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/sepay',
      payload: JSON.stringify(basePayload()),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed request outside the timestamp window', async () => {
    const res = await post(basePayload(), { skew: -900 });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ message: 'stale-timestamp' });
  });

  it('rejects a payload missing required fields', async () => {
    const res = await post({ id: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('persists the transaction even when nothing matches', async () => {
    await post(basePayload({ code: 'VNUNMATCHED' }));
    const row = db.prepare('SELECT sepay_id, transfer_type FROM sepay_transactions').get();
    expect(row).toMatchObject({ sepay_id: 92704, transfer_type: 'in' });
  });

  it('answers success for a duplicate without doing the work twice', async () => {
    const payload = basePayload({ code: 'VNDUPCHECK' });
    const first = await post(payload);
    const second = await post(payload);
    expect(first.json()).toEqual({ success: true });
    expect(second.json()).toEqual({ success: true });
    expect((db.prepare('SELECT count(*) AS c FROM sepay_transactions').get() as { c: number }).c).toBe(1);
  });
});
