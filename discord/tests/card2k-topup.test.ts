import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import {
  Card2kError,
  isCard2kConfigured,
  mapStatus,
  signRequest,
  submitCard,
  type Card2kConfig,
} from '../src/services/card/card2k-client.js';
import {
  denominationsFor,
  isTelco,
  isValidDenomination,
  TELCO_DENOMINATIONS,
  TELCOS,
} from '../src/services/card/card2k-telcos.js';
import {
  applyResult,
  MAX_POLL_ATTEMPTS,
  pollPendingCards,
  submitCardTopup,
} from '../src/services/card/submit-card-topup.js';
import {
  findCardTopupById,
  cardFeeCost,
  listCardsNeedingReview,
  listDuePolls,
} from '../src/repositories/card-topups.js';
import { getBalance, listLedger, reconcileBalances } from '../src/repositories/wallets.js';
import { creditReviewedCard } from '../src/services/card/resolve-reviewed-card.js';

const USER = '100000000000000001';

/** Fully configured, using a plausible-but-invented sign order and commands. */
const config: Card2kConfig = {
  baseUrl: 'https://card2k.com',
  partnerId: 'PID',
  partnerKey: 'PKEY',
  signFields: ['partner_key', 'code', 'serial'],
  commandCharge: 'charge',
  commandCheck: 'check',
  timeoutMs: 5_000,
};

const unconfigured: Card2kConfig = { ...config, signFields: [], commandCharge: '', commandCheck: '' };

/** Replies with one JSON body, and records what was sent. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; body: Record<string, string>; redirect?: string; headers: Record<string, string> }[] = [];
  const fake = vi.fn(async (url: string | URL, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(opts.body ?? '{}')) as Record<string, string>,
      redirect: opts.redirect,
      headers: opts.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fake);
  return calls;
}

describe('bảng nhà mạng card2k', () => {
  it('không có Vietnamobile', () => {
    // Absent from card2k's config, docs, and price API — offering it would consume
    // a card on a request that can only be refused.
    expect(isTelco('VIETNAMOBILE')).toBe(false);
    expect(TELCOS).not.toContain('VIETNAMOBILE');
  });

  it('chỉ Viettel có mệnh giá 1 triệu trong ba nhà mạng điện thoại', () => {
    expect(isValidDenomination('VIETTEL', 1_000_000)).toBe(true);
    expect(isValidDenomination('VINAPHONE', 1_000_000)).toBe(false);
    expect(isValidDenomination('MOBIFONE', 1_000_000)).toBe(false);
  });

  it('Garena và Zing không có 300k', () => {
    expect(isValidDenomination('GARENA', 300_000)).toBe(false);
    expect(isValidDenomination('ZING', 300_000)).toBe(false);
    expect(isValidDenomination('VIETTEL', 300_000)).toBe(true);
  });

  it('mọi nhà mạng đều có ít nhất một mệnh giá và đều tăng dần', () => {
    for (const telco of TELCOS) {
      const values = denominationsFor(telco);
      expect(values.length).toBeGreaterThan(0);
      expect([...values]).toEqual([...values].sort((a, b) => a - b));
      expect(TELCO_DENOMINATIONS[telco]).toBe(values);
    }
  });
});

describe('client card2k', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('cấu hình', () => {
    it('thiếu sign hoặc command thì coi như chưa cấu hình', () => {
      expect(isCard2kConfigured(config)).toBe(true);
      expect(isCard2kConfigured(unconfigured)).toBe(false);
      expect(isCard2kConfigured({ ...config, signFields: [] })).toBe(false);
      expect(isCard2kConfigured({ ...config, commandCharge: '' })).toBe(false);
      expect(isCard2kConfigured({ ...config, partnerKey: '' })).toBe(false);
    });

    it('chưa cấu hình thì không gọi mạng', async () => {
      const calls = stubFetch({ status: 1 });
      await expect(
        submitCard(unconfigured, { telco: 'VIETTEL', serial: 'S123456', code: 'C123456', amount: 50_000, requestId: 'r' }),
      ).rejects.toThrow(Card2kError);
      expect(calls).toHaveLength(0);
    });
  });

  describe('ký yêu cầu', () => {
    it('nối theo đúng thứ tự đã cấu hình', () => {
      const values = { code: 'CODE', serial: 'SER', amount: '50000', telco: 'VIETTEL', request_id: 'r' };
      // Same fields in a different order must hash differently — otherwise the
      // configured order would be decorative.
      const a = signRequest({ ...config, signFields: ['partner_key', 'code', 'serial'] }, values);
      const b = signRequest({ ...config, signFields: ['partner_key', 'serial', 'code'] }, values);
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(a).not.toBe(b);
    });

    it('không có thứ tự thì ném lỗi thay vì ký bừa', () => {
      // A signature over an empty string looks valid and can never verify.
      expect(() => signRequest({ ...config, signFields: [] }, {})).toThrow(/CARD2K_SIGN_FIELDS/);
    });

    it('tên trường lạ thì ném lỗi', () => {
      expect(() => signRequest({ ...config, signFields: ['nonsense'] }, {})).toThrow(/không biết/);
    });
  });

  describe('ánh xạ trạng thái', () => {
    it('theo bảng đã xác minh', () => {
      expect(mapStatus(1)).toBe('success');
      expect(mapStatus(2)).toBe('wrong_amount');
      expect(mapStatus(3)).toBe('failed');
      expect(mapStatus(99)).toBe('pending');
    });

    it('mã lạ và mã 100 đều là unknown, không phải failed', () => {
      // 'failed' means the card is spent and worthless. An unrecognised status
      // means we do not know, so writing it off could discard a paid card.
      expect(mapStatus(42)).toBe('unknown');
      expect(mapStatus(0)).toBe('unknown');
      // 100 is our own bad command — the card was never even submitted.
      expect(mapStatus(100)).toBe('unknown');
    });
  });

  describe('gọi HTTP', () => {
    it('không đi theo redirect và gửi User-Agent giống trình duyệt', async () => {
      const calls = stubFetch({ status: 1, value: '50000', amount: '40000', trans_id: 123 });

      await submitCard(config, {
        telco: 'VIETTEL',
        serial: 'S123456',
        code: 'C123456',
        amount: 50_000,
        requestId: 'req-1',
      });

      expect(calls[0]!.url).toBe('https://card2k.com/chargingws/v2');
      // Following the redirect to card2k.net silently drops the POST body.
      expect(calls[0]!.redirect).toBe('manual');
      // Cloudflare answers a default agent with 403.
      expect(calls[0]!.headers['user-agent']).toContain('Mozilla/5.0');
      expect(calls[0]!.body).toMatchObject({ command: 'charge', partner_id: 'PID', request_id: 'req-1' });
      expect(calls[0]!.body.sign).toMatch(/^[0-9a-f]{32}$/);
    });

    it('đọc được số dạng chuỗi', async () => {
      // card2k returns status as a number but value/amount as strings.
      stubFetch({ status: 1, value: '100000', amount: '85000', trans_id: '9007199254740993' });

      const result = await submitCard(config, {
        telco: 'VIETTEL',
        serial: 'S123456',
        code: 'C123456',
        amount: 100_000,
        requestId: 'r',
      });

      expect(result.actualValue).toBe(100_000);
      expect(result.netAmount).toBe(85_000);
      // Kept as text: a long beyond 2^53 loses precision as a JS number.
      expect(result.transId).toBe('9007199254740993');
    });

    it('redirect báo lỗi cấu hình và nói rõ là chưa gửi', async () => {
      stubFetch({}, { status: 302 });
      await expect(
        submitCard(config, { telco: 'VIETTEL', serial: 'S123456', code: 'C123456', amount: 50_000, requestId: 'r' }),
      ).rejects.toMatchObject({ notSubmitted: true });
    });

    it('403 của Cloudflare cũng là chưa gửi', async () => {
      stubFetch({}, { status: 403 });
      await expect(
        submitCard(config, { telco: 'VIETTEL', serial: 'S123456', code: 'C123456', amount: 50_000, requestId: 'r' }),
      ).rejects.toMatchObject({ notSubmitted: true });
    });

    it('mất mạng thì KHÔNG dám nói là chưa gửi', async () => {
      // The provider may already hold the card; claiming otherwise would let the
      // caller write it off.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
      await expect(
        submitCard(config, { telco: 'VIETTEL', serial: 'S123456', code: 'C123456', amount: 50_000, requestId: 'r' }),
      ).rejects.toMatchObject({ notSubmitted: false });
    });

    it('mệnh giá sai bị chặn trước khi gọi mạng', async () => {
      const calls = stubFetch({ status: 1 });
      await expect(
        submitCard(config, { telco: 'VINAPHONE', serial: 'S123456', code: 'C123456', amount: 1_000_000, requestId: 'r' }),
      ).rejects.toMatchObject({ notSubmitted: true });
      expect(calls).toHaveLength(0);
    });
  });
});

describe('nạp thẻ vào ví', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  const card = { telco: 'VIETTEL', serial: 'SER12345', code: 'PIN12345', declaredValue: 50_000 };

  describe('kiểm tra trước khi gửi', () => {
    it('chưa cấu hình thì từ chối', async () => {
      const result = await submitCardTopup(db, unconfigured, { discordUserId: USER, ...card });
      expect(result).toEqual({ ok: false, why: 'not-configured' });
    });

    it('nhà mạng và mệnh giá sai bị chặn', async () => {
      expect(await submitCardTopup(db, config, { discordUserId: USER, ...card, telco: 'VIETNAMOBILE' })).toEqual({
        ok: false,
        why: 'bad-telco',
      });
      expect(await submitCardTopup(db, config, { discordUserId: USER, ...card, declaredValue: 25_000 })).toEqual({
        ok: false,
        why: 'bad-amount',
      });
    });

    it('serial và mã thẻ sai định dạng bị chặn', async () => {
      expect(await submitCardTopup(db, config, { discordUserId: USER, ...card, serial: 'abc' })).toEqual({
        ok: false,
        why: 'bad-serial',
      });
      expect(await submitCardTopup(db, config, { discordUserId: USER, ...card, code: 'x y z!!' })).toEqual({
        ok: false,
        why: 'bad-code',
      });
    });

    it('cùng serial đang chờ thì không gửi lần hai', async () => {
      stubFetch({ status: 99 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(await submitCardTopup(db, config, { discordUserId: USER, ...card })).toEqual({
        ok: false,
        why: 'duplicate',
      });
    });
  });

  describe('cộng ví', () => {
    it('cộng đủ mệnh giá dù card2k trả về ít hơn', async () => {
      // The owner absorbs the fee: a 50k card credits 50k even though card2k paid
      // 40k. net_amount is recorded so the cost is visible.
      stubFetch({ status: 1, value: '50000', amount: '40000', trans_id: 111 });

      const result = await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(result.ok).toBe(true);
      expect(getBalance(db, USER)).toBe(50_000);
      const row = findCardTopupById(db, 1)!;
      expect(row).toMatchObject({ status: 'success', actualValue: 50_000, netAmount: 40_000 });
    });

    it('khai sai mệnh giá thì cộng theo giá trị THẬT', async () => {
      // Declared 50k, card was really 100k. card2k consumed it either way, so
      // refusing would take the money and give nothing back.
      stubFetch({ status: 2, value: '100000', amount: '60000', declared_value: '50000' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(getBalance(db, USER)).toBe(100_000);
      expect(findCardTopupById(db, 1)).toMatchObject({ status: 'wrong_amount', actualValue: 100_000 });
      const [entry] = listLedger(db, USER, 1);
      expect(entry).toMatchObject({ delta: 100_000, kind: 'card_topup', refType: 'card', refId: 1 });
    });

    it('thẻ hỏng không cộng gì', async () => {
      stubFetch({ status: 3, message: 'Thẻ không hợp lệ' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(getBalance(db, USER)).toBe(0);
      expect(findCardTopupById(db, 1)?.status).toBe('failed');
      expect(listLedger(db, USER, 10)).toEqual([]);
    });

    it('xoá mã thẻ sau khi cộng, giữ serial để tra cứu', async () => {
      stubFetch({ status: 1, value: '50000', amount: '40000' });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      const row = findCardTopupById(db, 1)!;
      expect(row.code).toBe('');
      expect(row.serial).toBe('SER12345');
    });

    it('giữ lại mã thẻ khi thẻ bị từ chối', async () => {
      // A rejected PIN still holds money; the person will want it to try elsewhere.
      stubFetch({ status: 3 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      expect(findCardTopupById(db, 1)?.code).toBe('PIN12345');
    });

    it('không cộng hai lần khi hai lượt xử lý cùng một kết quả', async () => {
      stubFetch({ status: 1, value: '50000', amount: '40000' });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      // Replaying the same provider answer: the credit claim is what stops it.
      const again = applyResult(db, 1, {
        outcome: 'success',
        providerStatus: 1,
        providerMessage: '',
        transId: null,
        actualValue: 50_000,
        netAmount: 40_000,
      });

      expect(again.credited).toBe(false);
      expect(getBalance(db, USER)).toBe(50_000);
      expect(reconcileBalances(db)).toEqual([]);
    });

    it('thiếu giá trị thật thì vào hàng chờ xử lý, không rơi vào khoảng trống', async () => {
      // Falling back to the declared value would be wrong precisely for a
      // wrong-denomination card, which is the case where they differ. But settling
      // it as 'success' with no credit would be worse: not pending so no poll
      // retries it, not in the review list so nobody sees it, and the resolve route
      // refuses it — card2k took the card and nobody can fix it.
      stubFetch({ status: 2, amount: '60000' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      const row = findCardTopupById(db, 1)!;
      expect(row.status).toBe('needs_review');
      expect(row.creditedAt).toBeNull();
      expect(getBalance(db, USER)).toBe(0);
      expect(listCardsNeedingReview(db).map((c) => c.id)).toEqual([1]);
    });

    it('status thành công mà thiếu value cũng vào hàng chờ', async () => {
      // `value` is optional in the schema, so this parses cleanly and would
      // otherwise settle as a silent no-credit success.
      stubFetch({ status: 1, amount: '47000' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(findCardTopupById(db, 1)?.status).toBe('needs_review');
      expect(listCardsNeedingReview(db)).toHaveLength(1);
    });
  });

  describe('trạng thái chờ và dò lại', () => {
    it('status 99 để lại pending và hẹn giờ dò', async () => {
      stubFetch({ status: 99, message: 'Đang xử lý' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      const row = findCardTopupById(db, 1)!;
      expect(row.status).toBe('pending');
      expect(row.nextPollAt).not.toBeNull();
      expect(getBalance(db, USER)).toBe(0);
    });

    it('lỗi mạng khi gửi vẫn để pending, không coi là thẻ hỏng', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));

      const result = await submitCardTopup(db, config, { discordUserId: USER, ...card });

      expect(result.ok).toBe(true);
      // card2k may hold the card. Marking it failed here is how a paid card
      // disappears.
      expect(findCardTopupById(db, 1)?.status).toBe('pending');
    });

    it('dò lại và cộng ví khi có kết quả', async () => {
      stubFetch({ status: 99 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      db.prepare('UPDATE card_topups SET next_poll_at = 1 WHERE id = 1').run();

      vi.unstubAllGlobals();
      stubFetch({ status: 1, value: '50000', amount: '40000' });

      const summary = await pollPendingCards(db, config);

      expect(summary).toMatchObject({ checked: 1, settled: 1, credited: 1 });
      expect(getBalance(db, USER)).toBe(50_000);
    });

    it('hết số lần dò thì thành timeout, không phải failed', async () => {
      stubFetch({ status: 99 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      db.prepare('UPDATE card_topups SET next_poll_at = 1, attempts = ? WHERE id = 1').run(MAX_POLL_ATTEMPTS);

      await pollPendingCards(db, config);

      // The card may have been consumed while we never learned the outcome.
      expect(findCardTopupById(db, 1)?.status).toBe('timeout');
      expect(getBalance(db, USER)).toBe(0);
      expect(listCardsNeedingReview(db).map((c) => c.id)).toEqual([1]);
    });

    it('trạng thái lạ thành needs_review và dừng dò', async () => {
      stubFetch({ status: 77, message: 'gì đó' });

      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      const row = findCardTopupById(db, 1)!;
      expect(row.status).toBe('needs_review');
      expect(row.providerStatus).toBe(77);
      expect(row.nextPollAt).toBeNull();
      expect(listDuePolls(db)).toEqual([]);
      expect(getBalance(db, USER)).toBe(0);
    });

    it('chưa cấu hình thì lượt dò không làm gì', async () => {
      expect(await pollPendingCards(db, unconfigured)).toEqual({ checked: 0, settled: 0, credited: 0 });
    });

    it('lỗi mạng khi dò chỉ tăng số lần, giữ pending', async () => {
      stubFetch({ status: 99 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      db.prepare('UPDATE card_topups SET next_poll_at = 1 WHERE id = 1').run();
      const before = findCardTopupById(db, 1)!.attempts;

      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));

      await pollPendingCards(db, config);

      const after = findCardTopupById(db, 1)!;
      expect(after.status).toBe('pending');
      expect(after.attempts).toBe(before + 1);
    });
  });

  describe('chi phí phí thẻ', () => {
    it('tính đúng phần chủ kho gánh', async () => {
      stubFetch({ status: 1, value: '50000', amount: '40000' });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });

      const cost = cardFeeCost(db, 0, 9_999_999_999);
      expect(cost).toEqual({ credited: 50_000, received: 40_000, cost: 10_000 });
    });

    it('không tính thẻ chưa cộng ví', async () => {
      stubFetch({ status: 3 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      expect(cardFeeCost(db, 0, 9_999_999_999).cost).toBe(0);
    });

    it('thẻ chủ kho cộng tay không bị tính là 100% phí', async () => {
      stubFetch({ status: 99 });
      await submitCardTopup(db, config, { discordUserId: USER, ...card });
      db.prepare("UPDATE card_topups SET status = 'timeout', next_poll_at = NULL WHERE id = 1").run();

      expect(creditReviewedCard(db, 1, 50_000)).toBe(true);

      expect(getBalance(db, USER)).toBe(50_000);
      // The provider never reported a payout, so claiming a 50.000 fee would
      // overstate the owner's cost by the card's whole face value.
      expect(cardFeeCost(db, 0, 9_999_999_999)).toEqual({ credited: 50_000, received: 50_000, cost: 0 });
    });
  });
});
