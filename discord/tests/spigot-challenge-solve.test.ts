import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadViaBrowser,
  loginToSpigot,
  type BrowserPage,
  type ChallengeSolver,
} from '../src/services/upstream/download-via-browser.js';

/**
 * Kiểm nhánh "Cloudflare chặn, mua vé rồi đi qua" ở cả đường đăng nhập và đường tải.
 *
 * Trang giả ở đây đứng ở tiêu đề "Just a moment..." cho tới khi solver tiêm vé vào —
 * đúng thứ đo được trong container của host, nơi tiêu đề không đổi suốt 90 giây và không
 * hiện widget nào.
 *
 * Ca quan trọng nhất là ca KHÔNG có solver: nó chốt rằng một deployment không bật
 * YesCaptcha vẫn xử lý cú chặn y như trước, để tính năng tuỳ chọn này không lặng lẽ đổi
 * hành vi của những chỗ chưa cấu hình nó.
 */

const CHALLENGE_TITLE = 'Just a moment...';

/**
 * Nhịp chờ giả, với đồng hồ mà chính lần "ngủ" đẩy lên.
 *
 * Phải tiêm cả đồng hồ, không chỉ hàm ngủ: trần chờ thử thách là 90 giây đo bằng
 * `now()`, nên một hàm ngủ rỗng đi cùng `Date.now` thật sẽ quay vòng chặt suốt 90 giây
 * thật cho MỖI ca — nhánh bị chặn là nhánh đắt nhất để kiểm sai cách.
 */
function fastTimings(): { pollMs: number; delay: (ms: number) => Promise<void>; now: () => number } {
  let value = 1_000_000;
  return {
    pollMs: 5_000,
    delay: async (ms: number) => void (value += ms),
    now: () => value,
  };
}

/** Vé đã tiêm hay chưa — trạng thái duy nhất trang giả cần mang. */
type Gate = { cleared: boolean };

/**
 * Solver giả: `outcome` quyết định nó mở được cổng hay thất bại.
 *
 * `primed` mô phỏng "đã có vé còn hạn trong cache": lúc đó cổng mở ngay trước khi điều
 * hướng và không có lượt mua nào — đúng đường đi của mọi lượt tải sau lượt đầu.
 */
function fakeSolver(
  gate: Gate,
  outcome: { ok: true; reused?: boolean } | { ok: false; detail: string },
  options: { primed?: boolean } = {},
): { solver: ChallengeSolver; urls: string[]; primes: string[] } {
  const urls: string[] = [];
  const primes: string[] = [];
  return {
    urls,
    primes,
    solver: {
      prime: async (_page, url) => {
        primes.push(url);
        if (!options.primed) return false;
        gate.cleared = true;
        return true;
      },
      solve: async (_page, url) => {
        urls.push(url);
        if (!outcome.ok) return { ok: false, detail: outcome.detail };
        gate.cleared = true;
        return { ok: true, reused: outcome.reused ?? false };
      },
    },
  };
}

describe('loginToSpigot khi Cloudflare chặn trang đăng nhập', () => {
  /**
   * Trang đăng nhập bị chặn cho tới khi cổng mở.
   *
   * Chặn ở đây là nhánh KHÔNG tương tác: tiêu đề đứng nguyên, không có widget nào — đúng
   * thứ đo được trong container, và cũng là thứ khiến nhánh chờ 90 giây không có gì để
   * bấm.
   */
  const gatedLoginPage = (gate: Gate): BrowserPage =>
    ({
      goto: async () => undefined,
      title: async () => (gate.cleared ? 'Log in | SpigotMC' : CHALLENGE_TITLE),
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (!gate.cleared) return src.includes('challenge-running') ? false : '';
        // Sau khi qua cổng: form tìm thấy, chữ vào đủ, và trang báo đã đăng nhập.
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return 1;
        if (src.includes('accountUsername')) return true;
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
    }) as unknown as BrowserPage;

  const credential = { label: 'acc-1', username: 'nguoi-dung', password: 'mat-khau' };
  /** `settleMs` nhỏ vì nhánh sau khi gửi form không phải thứ tệp này kiểm. */
  const timings = () => ({ ...fastTimings(), settleMs: 20_000 });

  it('không có solver thì vẫn báo challenged y như trước', async () => {
    // Chốt hành vi cho deployment chưa cấu hình YesCaptcha: tính năng tuỳ chọn không được
    // lặng lẽ đổi đường đi của những chỗ chưa bật nó.
    const page = gatedLoginPage({ cleared: false });

    await expect(loginToSpigot(page, credential, timings())).resolves.toMatchObject({
      ok: false,
      reason: 'challenged',
    });
  });

  it('có solver thì mua vé, đăng nhập lại, và vào được', async () => {
    const gate: Gate = { cleared: false };
    const { solver, urls } = fakeSolver(gate, { ok: true });

    await expect(loginToSpigot(gatedLoginPage(gate), credential, timings(), solver)).resolves.toEqual({ ok: true });
    // Giải cho ĐÚNG URL đang bị chặn, và không có dấu / ở cuối — `/login/` bị chặn 403
    // còn `/login` thì không.
    expect(urls).toEqual(['https://www.spigotmc.org/login']);
  });

  it('solver thất bại thì giữ nguyên challenged và nói thêm lý do, không đổi thành sai mật khẩu', async () => {
    // Đọc sai một cú chặn thành sai mật khẩu là thứ từng gửi chủ bot đi đổi một mật khẩu
    // vốn vẫn đúng.
    const gate: Gate = { cleared: false };
    const { solver } = fakeSolver(gate, { ok: false, detail: 'unsolvable: proxy không qua được' });

    const result = await loginToSpigot(gatedLoginPage(gate), credential, timings(), solver);

    expect(result).toMatchObject({ ok: false, reason: 'challenged' });
    expect(result.ok ? '' : result.detail).toContain('unsolvable');
  });

  it('không gọi solver khi trang vốn đã sạch, nên một lượt đang lành không tốn điểm nào', async () => {
    const { solver, urls } = fakeSolver({ cleared: true }, { ok: true });

    await expect(
      loginToSpigot(gatedLoginPage({ cleared: true }), credential, timings(), solver),
    ).resolves.toEqual({ ok: true });
    expect(urls).toEqual([]);
  });

  it('tiêm vé còn hạn TRƯỚC khi mở trang, nên không mua lại và không phải chờ chút nào', async () => {
    // Đây là đường đi của mọi account sau account đầu trong cùng lượt quét: vé đã nằm
    // trong cache, nên lượt đăng nhập không tốn điểm và không tốn thời gian chờ.
    const gate: Gate = { cleared: false };
    const { solver, urls, primes } = fakeSolver(gate, { ok: true }, { primed: true });

    await expect(loginToSpigot(gatedLoginPage(gate), credential, timings(), solver)).resolves.toEqual({ ok: true });
    expect(primes).toEqual(['https://www.spigotmc.org/login']);
    // Không có lượt MUA nào: cái vé đã có sẵn.
    expect(urls).toEqual([]);
  });
});

/** Jar tối thiểu: hai byte `PK` là thứ đường tải kiểm để loại trang HTML đội tên .jar. */
const fakeJar = (): Buffer => Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048, 0x41)]);

describe('downloadViaBrowser khi Cloudflare chặn trang resource', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'vault-cf-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * Trang resource bị chặn cho tới khi cổng mở; mở rồi thì lần điều hướng tới link tải
   * ghi một jar vào thư mục tải mà CDP đã chỉ định.
   */
  const gatedResourcePage = (gate: Gate): { page: BrowserPage; visited: string[] } => {
    const visited: string[] = [];
    let downloadDir = '';

    const page = {
      goto: async (url: string) => {
        visited.push(url);
        if (gate.cleared && url.includes('download') && downloadDir) {
          writeFileSync(join(downloadDir, 'Vulcan.jar'), fakeJar());
        }
        return undefined;
      },
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (!gate.cleared) return src.includes('challenge-running') ? false : '';
        if (src.includes('a[href*="download"]')) return 'resources/vulcan.83626/download?version=645021';
        return '';
      },
      title: async () => (gate.cleared ? 'Vulcan | SpigotMC' : CHALLENGE_TITLE),
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
    } as unknown as BrowserPage;

    return { page, visited };
  };

  it('không có solver thì vẫn báo challenged y như trước', async () => {
    const { page } = gatedResourcePage({ cleared: false });

    await expect(
      downloadViaBrowser({ tmpDir: tmp, maxBytes: 50_000_000, challengeTimings: fastTimings() }, page, 83626),
    ).resolves.toMatchObject({ status: 'challenged' });
  });

  it('có solver thì mua vé, mở lại trang, và tải xong thật', async () => {
    const gate: Gate = { cleared: false };
    const { solver, urls } = fakeSolver(gate, { ok: true });
    const { page, visited } = gatedResourcePage(gate);

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000, solver, challengeTimings: fastTimings() },
      page,
      83626,
    );

    expect(outcome).toMatchObject({ status: 'ok' });
    // Giải cho trang resource, và trang được mở LẠI sau khi tiêm vé — không mở lại thì
    // vé nằm trong Chrome mà nội dung trên màn hình vẫn là trang chặn.
    expect(urls).toEqual(['https://www.spigotmc.org/resources/83626/']);
    expect(visited.filter((u) => u === 'https://www.spigotmc.org/resources/83626/')).toHaveLength(2);
  });

  it('solver thất bại thì vẫn là challenged, và lý do vào log để chẩn đoán được', async () => {
    const gate: Gate = { cleared: false };
    const { solver } = fakeSolver(gate, { ok: false, detail: 'out_of_credit: không đủ số dư' });
    const { page } = gatedResourcePage(gate);
    const lines: string[] = [];

    const outcome = await downloadViaBrowser(
      {
        tmpDir: tmp,
        maxBytes: 50_000_000,
        solver,
        challengeTimings: fastTimings(),
        log: (message) => void lines.push(message),
      },
      page,
      83626,
    );

    expect(outcome).toMatchObject({ status: 'challenged' });
    expect(lines.some((line) => line.includes('out_of_credit'))).toBe(true);
  });

  it('không gọi solver khi trang vốn đã sạch', async () => {
    const { solver, urls } = fakeSolver({ cleared: true }, { ok: true });
    const { page } = gatedResourcePage({ cleared: true });

    await expect(
      downloadViaBrowser(
        { tmpDir: tmp, maxBytes: 50_000_000, solver, challengeTimings: fastTimings() },
        page,
        83626,
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(urls).toEqual([]);
  });
});

