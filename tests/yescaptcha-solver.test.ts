import { describe, expect, it } from 'vitest';
import {
  fetchYesCaptchaBalance,
  solveCloudflareChallenge,
  type YesCaptchaConfig,
} from '../src/services/upstream/yescaptcha-client.js';
import {
  applyClearance,
  buildChallengeSolverPool,
  cookieDomainFor,
  proxyUrlFor,
} from '../src/services/upstream/cloudflare-clearance.js';
import type { BrowserPage } from '../src/services/upstream/download-via-browser.js';

/**
 * Kiểm việc mua `cf_clearance` từ YesCaptcha và nhét vào trình duyệt.
 *
 * Không ca nào ra mạng và không ca nào ngủ thật: `fetch` và đồng hồ đều tiêm vào, nên
 * một lượt giải 80 giây được kiểm trong vài phần nghìn giây.
 *
 * Ca quan trọng nhất trong tệp này là ca che bí mật. Mọi `detail` ở đây đều đi thẳng vào
 * log, còn chuỗi proxy thì chứa mật khẩu của gói trả tiền — nên "nhà cung cấp đọc lại
 * đầu vào trong câu lỗi" là đường rò rỉ thật, không phải giả định.
 */

type Scripted = { status?: number; body: unknown } | { throws: true };

/** `fetch` giả theo kịch bản; phần tử cuối được dùng lại cho mọi lời gọi sau. */
function scriptedFetch(script: Scripted[]): {
  impl: typeof fetch;
  calls: { url: string; body: Record<string, unknown> }[];
} {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const impl = (async (url: string | URL, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = script[Math.min(index++, script.length - 1)]!;
    if ('throws' in next) throw new Error('socket hang up');
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Đồng hồ điều khiển được, để kiểm hết hạn mà không phải chờ thật. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => void (value += ms) };
}

/** Cấu hình dùng chung: mọi lần "ngủ" chỉ đẩy đồng hồ giả lên. */
function configWith(impl: typeof fetch, timeoutMs = 120_000): YesCaptchaConfig {
  const time = clock();
  return {
    clientKey: 'key-abcdef123456',
    baseUrl: 'https://api.yescaptcha.com',
    timeoutMs,
    fetchImpl: impl,
    delay: async (ms) => time.advance(ms),
    now: time.now,
  };
}

const READY = {
  body: { errorId: 0, status: 'ready', solution: { cookies: { cf_clearance: 'vé-abc' }, user_agent: 'UA/thật' } },
};

describe('solveCloudflareChallenge', () => {
  it('trả về cookie và UA khi nhà cung cấp giải xong', async () => {
    const { impl } = scriptedFetch([{ body: { errorId: 0, taskId: 't1' } }, { body: { errorId: 0, status: 'processing' } }, READY]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toEqual({ ok: true, solution: { cookies: { cf_clearance: 'vé-abc' }, userAgent: 'UA/thật' } });
  });

  it('gửi CloudFlareTaskS2 kèm proxy, waitLoad và UA — ba thứ Cloudflare buộc phải khớp', async () => {
    const { impl, calls } = scriptedFetch([{ body: { errorId: 0, taskId: 't1' } }, READY]);
    await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://bob:s3cret@1.2.3.4:8000',
      userAgent: 'Chrome/152',
    });

    expect(calls[0]?.url).toBe('https://api.yescaptcha.com/createTask');
    expect(calls[0]?.body).toMatchObject({
      clientKey: 'key-abcdef123456',
      task: {
        type: 'CloudFlareTaskS2',
        websiteURL: 'https://www.spigotmc.org/login',
        proxy: 'http://bob:s3cret@1.2.3.4:8000',
        waitLoad: true,
        requiredCookies: ['cf_clearance'],
        userAgent: 'Chrome/152',
      },
    });
  });

  it('đọc hết điểm thành out_of_credit, vì đó là loại duy nhất mà thử lại chắc chắn vô ích', async () => {
    const { impl } = scriptedFetch([
      { body: { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'không đủ số dư' } },
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: false, reason: 'out_of_credit' });
  });

  it('đọc UNSOLVABLE thành unsolvable, vì việc đúng phải làm là đổi proxy chứ không phải nạp tiền', async () => {
    const { impl } = scriptedFetch([
      { body: { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE', errorDescription: 'proxy không qua được' } },
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: false, reason: 'unsolvable' });
  });

  it('không có taskId là thất bại, kể cả khi errorId nói không lỗi', async () => {
    // Vài phản hồi lỗi của nhà cung cấp không kèm errorId; taskId là dấu hiệu chắc chắn.
    const { impl } = scriptedFetch([{ body: { errorCode: 'ERROR_KEY_DOES_NOT_EXIST' } }]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: false, reason: 'create_failed' });
  });

  it('thiếu cf_clearance là bad_shape, và nói rõ đã nhận được cookie nào', async () => {
    // Phân biệt "nhà cung cấp đổi cấu trúc" với "giải không được": một cái phải sửa code,
    // cái kia chỉ cần đổi proxy.
    const { impl } = scriptedFetch([
      { body: { errorId: 0, taskId: 't1' } },
      { body: { errorId: 0, status: 'ready', solution: { cookies: { __cf_bm: 'x' }, user_agent: 'UA' } } },
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: false, reason: 'bad_shape' });
    expect(result.ok ? '' : result.detail).toContain('__cf_bm');
  });

  it('nhận cả dạng danh sách {name,value}, vì tài liệu tự nói giao diện còn trong nội bộ thử nghiệm', async () => {
    const { impl } = scriptedFetch([
      { body: { errorId: 0, taskId: 't1' } },
      {
        body: {
          errorId: 0,
          status: 'ready',
          solution: { cookies: [{ name: 'cf_clearance', value: 'vé-abc' }], user_agent: 'UA' },
        },
      },
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: true, solution: { cookies: { cf_clearance: 'vé-abc' } } });
  });

  it('bỏ cuộc bằng timeout khi mãi ở processing, thay vì hỏi mãi', async () => {
    const { impl, calls } = scriptedFetch([{ body: { errorId: 0, taskId: 't1' } }, { body: { errorId: 0, status: 'processing' } }]);
    const result = await solveCloudflareChallenge(configWith(impl, 30_000), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    // Có trần thật: 30 giây với nhịp 3 giây thì không thể là hàng nghìn lời gọi.
    expect(calls.length).toBeLessThan(15);
  });

  it('một lỗi mạng giữa lúc chờ không giết task đã trả tiền — hỏi lại rồi vẫn lấy được kết quả', async () => {
    const { impl } = scriptedFetch([
      { body: { errorId: 0, taskId: 't1' } },
      { throws: true },
      READY,
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://1.2.3.4:8000',
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('KHÔNG để khoá hay chuỗi proxy lọt vào detail, dù nhà cung cấp đọc lại chúng trong câu lỗi', async () => {
    // Đường rò rỉ thật: mọi detail ở đây đều đi vào log, và chuỗi proxy chứa mật khẩu của
    // gói trả tiền.
    const { impl } = scriptedFetch([
      {
        body: {
          errorId: 1,
          errorCode: 'ERROR_PROXY_BAD',
          errorDescription: 'proxy http://bob:s3cret@1.2.3.4:8000 lỗi với clientKey key-abcdef123456',
        },
      },
    ]);
    const result = await solveCloudflareChallenge(configWith(impl), {
      websiteURL: 'https://www.spigotmc.org/login',
      proxy: 'http://bob:s3cret@1.2.3.4:8000',
    });

    const detail = result.ok ? '' : result.detail;
    expect(detail).not.toContain('s3cret');
    expect(detail).not.toContain('key-abcdef123456');
    expect(detail).not.toContain('1.2.3.4');
    // Vẫn phải còn đọc được: một câu bị che sạch thì không ai chẩn đoán được gì.
    expect(detail).toContain('ERROR_PROXY_BAD');
  });
});

describe('fetchYesCaptchaBalance', () => {
  it('đọc được số dư, vì hết điểm là nguyên nhân số một khiến việc giải im lặng ngừng chạy', async () => {
    const { impl, calls } = scriptedFetch([{ body: { errorId: 0, balance: 1234.5 } }]);
    await expect(fetchYesCaptchaBalance(configWith(impl))).resolves.toEqual({ ok: true, balance: 1234.5 });
    expect(calls[0]?.url).toBe('https://api.yescaptcha.com/getBalance');
  });

  it('không che mất lý do khi khoá sai', async () => {
    const { impl } = scriptedFetch([
      { body: { errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST', errorDescription: 'khoá không tồn tại' } },
    ]);
    const result = await fetchYesCaptchaBalance(configWith(impl));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.detail).toContain('ERROR_KEY_DOES_NOT_EXIST');
  });
});

describe('proxyUrlFor', () => {
  it('giữ nguyên proxy không có mật khẩu', () => {
    expect(proxyUrlFor({ id: 'p-1', server: 'http://1.2.3.4:8000' })).toEqual({
      ok: true,
      url: 'http://1.2.3.4:8000',
    });
  });

  it('chèn lại phần đăng nhập và %-encode nó, vì bể proxy đã giải mã khi đọc vào', () => {
    // `p@ss:word` ghép thô sẽ phá cấu trúc URL và nhà cung cấp đọc ra một host khác.
    expect(
      proxyUrlFor({ id: 'p-1', server: 'http://1.2.3.4:8000', username: 'bo b', password: 'p@ss:word' }),
    ).toEqual({ ok: true, url: 'http://bo%20b:p%40ss%3Aword@1.2.3.4:8000' });
  });

  it('từ chối socks kèm mật khẩu, vì nhà cung cấp nói rõ không hỗ trợ', () => {
    // Gửi lên rồi nhận một lỗi mù thì vẫn mất lượt gọi mà không ai biết vì sao.
    const result = proxyUrlFor({ id: 'p-1', server: 'socks5://1.2.3.4:1080', username: 'bob', password: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.detail).toContain('socks');
  });
});

describe('cookieDomainFor', () => {
  it('bỏ www. và thêm dấu chấm, vì cf_clearance thật được đặt cho cả miền', () => {
    // Đặt đúng www.spigotmc.org thì một lần chuyển hướng sang miền trần là mất vé.
    expect(cookieDomainFor('https://www.spigotmc.org/login')).toBe('.spigotmc.org');
  });

  it('trả rỗng cho URL không đọc được, thay vì ném ra giữa lượt tải', () => {
    expect(cookieDomainFor('không-phải-url')).toBe('');
  });
});

/** Trang giả: chỉ cần UA và cầu CDP, đó là toàn bộ bề mặt phần tiêm vào dùng tới. */
function fakePage(userAgent = 'Chrome/152'): {
  page: BrowserPage;
  sends: { method: string; params: Record<string, unknown> }[];
} {
  const sends: { method: string; params: Record<string, unknown> }[] = [];
  const page = {
    goto: async () => undefined,
    evaluate: async (source: unknown) => (String(source).includes('navigator.userAgent') ? userAgent : ''),
    title: async () => '',
    createCDPSession: async () => ({
      send: async (method: string, params?: Record<string, unknown>) => {
        sends.push({ method, params: params ?? {} });
        return undefined;
      },
    }),
    mouse: { click: async () => undefined, move: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined },
  } as unknown as BrowserPage;
  return { page, sends };
}

describe('applyClearance', () => {
  it('bật Network trước khi đặt cookie, vì thiếu nó thì lệnh đặt cookie bị từ chối', async () => {
    // Và một cookie không đặt được trông y như một lời giải sai.
    const { page, sends } = fakePage();
    await applyClearance(page, { cookies: { cf_clearance: 'vé' }, userAgent: 'Chrome/152' }, '.spigotmc.org', 'Chrome/152');

    expect(sends[0]?.method).toBe('Network.enable');
    expect(sends.some((s) => s.method === 'Network.setCookie')).toBe(true);
  });

  it('KHÔNG tiêm xf_session của nhà cung cấp, vì nó sẽ đá account đang đăng nhập ra', async () => {
    // Đo trên dịch vụ thật: lời giải cho /login trả về xf_session, cf_clearance, _ga,
    // _ga_FKF3FWXLS9. `xf_session` là phiên XenForo của trình duyệt BÊN NHÀ CUNG CẤP —
    // phiên của một người khách vô danh. Ghi nó vào profile của một account đang đăng
    // nhập là phá đúng thứ mà "mỗi account một profile bền" tồn tại để giữ.
    const { page, sends } = fakePage();
    await applyClearance(
      page,
      { cookies: { xf_session: 'phiên-người-khác', cf_clearance: 'vé', _ga: 'GA1.2' }, userAgent: 'Chrome/152' },
      '.spigotmc.org',
      'Chrome/152',
    );

    const names = sends.filter((s) => s.method === 'Network.setCookie').map((s) => s.params.name);
    expect(names).toEqual(['cf_clearance']);
  });

  it('đặt cookie đúng thuộc tính Cloudflare tự đặt, vì lệch một cái là Chrome không gửi kèm', async () => {
    const { page, sends } = fakePage();
    await applyClearance(page, { cookies: { cf_clearance: 'vé' }, userAgent: 'Chrome/152' }, '.spigotmc.org', 'Chrome/152');

    expect(sends.find((s) => s.method === 'Network.setCookie')?.params).toEqual({
      name: 'cf_clearance',
      value: 'vé',
      domain: '.spigotmc.org',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
    });
  });

  it('ghi đè UA khi nhà cung cấp dùng UA khác, vì vé bị buộc vào UA của họ', async () => {
    const { page, sends } = fakePage();
    await applyClearance(page, { cookies: { cf_clearance: 'vé' }, userAgent: 'Chrome/126' }, '.spigotmc.org', 'Chrome/152');

    expect(sends.find((s) => s.method === 'Network.setUserAgentOverride')?.params).toEqual({
      userAgent: 'Chrome/126',
    });
  });

  it('KHÔNG ghi đè UA khi đã trùng: mỗi lần ghi đè là thêm một chỗ để navigator lệch header', async () => {
    const { page, sends } = fakePage();
    await applyClearance(page, { cookies: { cf_clearance: 'vé' }, userAgent: 'Chrome/152' }, '.spigotmc.org', 'Chrome/152');

    expect(sends.some((s) => s.method === 'Network.setUserAgentOverride')).toBe(false);
  });
});

const PROXY = { id: 'p-1', server: 'http://1.2.3.4:8000' };
const LOGIN = 'https://www.spigotmc.org/login';

function poolWith(
  script: Scripted[],
  overrides: { maxSolvesPerSweep?: number; clearanceTtlMs?: number; clientKey?: string } = {},
): {
  pool: ReturnType<typeof buildChallengeSolverPool>;
  createTasks: () => number;
  warnings: string[];
  time: ReturnType<typeof clock>;
} {
  const time = clock();
  const { impl, calls } = scriptedFetch(script);
  const warnings: string[] = [];
  const pool = buildChallengeSolverPool({
    clientKey: overrides.clientKey ?? 'key-abcdef123456',
    baseUrl: 'https://api.yescaptcha.com',
    timeoutMs: 120_000,
    clearanceTtlMs: overrides.clearanceTtlMs ?? 45 * 60_000,
    maxSolvesPerSweep: overrides.maxSolvesPerSweep ?? 10,
    fetchImpl: impl,
    delay: async (ms) => time.advance(ms),
    now: time.now,
    log: (message) => warnings.push(message),
  });
  return { pool, createTasks: () => calls.filter((c) => c.url.endsWith('/createTask')).length, warnings, time };
}

describe('buildChallengeSolverPool', () => {
  it('trả null khi chưa có khoá, để deployment không bật tính năng chạy đúng như trước', async () => {
    expect(poolWith([], { clientKey: '   ' }).pool).toBeNull();
  });

  it('không có proxy thì không dựng solver, và nói rõ vì sao đúng một lần', async () => {
    // Vé Cloudflare bị buộc vào IP đã giải, nên khoá không kèm proxy là cấu hình chưa đủ
    // — nhưng lặp câu đó mỗi lần mở trình duyệt thì log thành rác.
    const { pool, warnings } = poolWith([]);
    const forSweep = pool!.forSweep();

    expect(forSweep(null)).toBeNull();
    expect(forSweep(null)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('proxy');
  });

  it('dùng lại vé còn hạn cho account thứ hai, vì cf_clearance chứng minh IP chứ không phải danh tính', async () => {
    // Đây là khoản tiết kiệm điểm lớn nhất: 25 điểm mỗi lượt giải.
    const { pool, createTasks } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY]);
    const solver = pool!.forSweep()(PROXY)!;

    await expect(solver.solve(fakePage().page, LOGIN)).resolves.toEqual({ ok: true, reused: false });
    await expect(solver.solve(fakePage().page, LOGIN)).resolves.toEqual({ ok: true, reused: true });
    expect(createTasks()).toBe(1);
  });

  it('mua vé mới khi vé cũ hết hạn, vì một vé chết giữa lượt tải trông y như một vé sai', async () => {
    const script: Scripted[] = [{ body: { errorId: 0, taskId: 't1' } }, READY, { body: { errorId: 0, taskId: 't2' } }, READY];
    const { pool, createTasks, time } = poolWith(script, { clearanceTtlMs: 60_000 });
    const solver = pool!.forSweep()(PROXY)!;

    await solver.solve(fakePage().page, LOGIN);
    time.advance(120_000);
    await expect(solver.solve(fakePage().page, LOGIN)).resolves.toEqual({ ok: true, reused: false });
    expect(createTasks()).toBe(2);
  });

  it('dừng ở trần mỗi lượt quét, vì đó là cái phanh cho hoá đơn khi Cloudflare siết', async () => {
    const { pool, createTasks } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY], { maxSolvesPerSweep: 1 });
    const solver = pool!.forSweep()(PROXY)!;

    await expect(solver.solve(fakePage('Chrome/152').page, LOGIN)).resolves.toEqual({ ok: true, reused: false });
    // UA khác nên khoá cache khác: đây là một lượt giải mới, không phải một lượt dùng lại.
    const second = await solver.solve(fakePage('Chrome/151').page, LOGIN);
    expect(second).toMatchObject({ ok: false });
    expect(second.ok ? '' : second.detail).toContain('1 lượt giải');
    expect(createTasks()).toBe(1);
  });

  it('lượt quét mới đặt lại trần nhưng GIỮ cache, vì vé sống ~1 giờ còn lượt quét lặp mỗi ~5 phút', async () => {
    // Không giữ cache thì cùng một cái vé bị mua lại chín lần một giờ.
    const { pool, createTasks } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY], { maxSolvesPerSweep: 1 });

    const first = pool!.forSweep()(PROXY)!;
    await first.solve(fakePage().page, LOGIN);
    expect((await first.solve(fakePage('Chrome/151').page, LOGIN)).ok).toBe(false);

    const second = pool!.forSweep()(PROXY)!;
    await expect(second.solve(fakePage().page, LOGIN)).resolves.toEqual({ ok: true, reused: true });
    expect(createTasks()).toBe(1);
  });

  it('hết điểm thì thôi giải hẳn, thay vì lặp đúng một câu lỗi suốt đêm trong log', async () => {
    const { pool, warnings } = poolWith([
      { body: { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'không đủ số dư' } },
    ]);
    const solver = pool!.forSweep()(PROXY)!;

    expect((await solver.solve(fakePage().page, LOGIN)).ok).toBe(false);
    // Cả solver đang giữ lẫn solver dựng sau đều phải im.
    expect((await solver.solve(fakePage().page, LOGIN)).ok).toBe(false);
    expect(pool!.forSweep()(PROXY)).toBeNull();
    expect(warnings.some((line) => line.includes('hết điểm'))).toBe(true);
  });

  it('không giữ xf_session trong cache, vì vé nằm đó tới 45 phút', async () => {
    // Lọc ở lúc nhận, không chỉ ở lúc tiêm: không có lý gì để phiên của một người khách
    // vô danh nằm trong bộ nhớ tiến trình suốt thời gian đó.
    const { pool } = poolWith([
      { body: { errorId: 0, taskId: 't1' } },
      {
        body: {
          errorId: 0,
          status: 'ready',
          solution: { cookies: { xf_session: 'phiên-người-khác', cf_clearance: 'vé' }, user_agent: 'Chrome/152' },
        },
      },
    ]);
    const solver = pool!.forSweep()(PROXY)!;

    await solver.solve(fakePage().page, LOGIN);
    // Lượt hai đọc từ cache và tiêm lại: chỉ được thấy cf_clearance.
    const { page, sends } = fakePage();
    await expect(solver.solve(page, LOGIN)).resolves.toEqual({ ok: true, reused: true });
    expect(sends.filter((s) => s.method === 'Network.setCookie').map((s) => s.params.name)).toEqual(['cf_clearance']);
  });

  it('prime không gọi API: chưa có vé thì trả false, không tiêm gì, không tốn điểm', async () => {
    const { pool, createTasks } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY]);
    const solver = pool!.forSweep()(PROXY)!;
    const { page, sends } = fakePage();

    await expect(solver.prime(page, LOGIN)).resolves.toBe(false);
    expect(createTasks()).toBe(0);
    expect(sends).toEqual([]);
  });

  it('prime tiêm vé đã mua trước đó, nên lượt tải sau không phải mở trang chặn rồi chờ', async () => {
    // Đây là chỗ tiết kiệm thời gian lớn nhất: không có nó thì mỗi lần điều hướng phải
    // mở trang chặn và đợi hết thời gian chờ trước khi sửa được gì.
    const { pool, createTasks } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY]);
    const solver = pool!.forSweep()(PROXY)!;

    await solver.solve(fakePage().page, LOGIN);
    const { page, sends } = fakePage();
    await expect(solver.prime(page, LOGIN)).resolves.toBe(true);

    expect(createTasks()).toBe(1);
    expect(sends.filter((s) => s.method === 'Network.setCookie').map((s) => s.params.name)).toEqual(['cf_clearance']);
  });

  it('prime bỏ vé đã hết hạn, để không tiêm một vé Cloudflare đã không còn nhận', async () => {
    const { pool, time } = poolWith([{ body: { errorId: 0, taskId: 't1' } }, READY], { clearanceTtlMs: 60_000 });
    const solver = pool!.forSweep()(PROXY)!;

    await solver.solve(fakePage().page, LOGIN);
    time.advance(120_000);
    await expect(solver.prime(fakePage().page, LOGIN)).resolves.toBe(false);
  });

  it('không tiêm gì khi giải thất bại, để trang giữ nguyên trạng thái cho tầng trên đọc', async () => {    const { pool } = poolWith([{ body: { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' } }]);
    const solver = pool!.forSweep()(PROXY)!;
    const { page, sends } = fakePage();

    expect((await solver.solve(page, LOGIN)).ok).toBe(false);
    expect(sends).toEqual([]);
  });
});





