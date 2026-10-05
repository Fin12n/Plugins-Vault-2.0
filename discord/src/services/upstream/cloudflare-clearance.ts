/**
 * Mua `cf_clearance` rồi nhét vào Chrome, để một trình duyệt không tự vượt được thử
 * thách Cloudflare vẫn đi qua được.
 *
 * Vì sao cần: đo được rằng Chrome trong container của host đứng ở "Just a moment..."
 * suốt 90 giây và KHÔNG hiện widget nào, trong khi cùng code / cùng Chrome / cùng
 * account trên VPS thì sạch trong ~12 giây. Đã loại phông, UA, `navigator.webdriver`,
 * screen, WebGL, cờ Chrome, profile và 12+ IP dân dụng — biến gây ra khác biệt vẫn chưa
 * cô lập được. Nên thay vì tìm tiếp, mua sẵn cái vé mà thử thách phát ra.
 *
 * Ba điều kiện Cloudflare buộc, và ba chỗ tệp này tôn trọng chúng:
 *   IP  → giải qua ĐÚNG proxy mà Chrome đang chạy, nên khoá cache có id proxy trong đó
 *   UA  → gửi UA thật của Chrome lên, và ghi đè lại nếu nhà cung cấp dùng UA khác
 *   TLS → không làm gì cả: Chrome thật vốn có dấu vân tay TLS của Chrome
 *
 * Cache sống lâu hơn một lượt quét là chủ ý. `cf_clearance` sống ~1 giờ còn lượt quét
 * lặp mỗi ~5 phút, nên cache theo lượt quét sẽ mua lại cùng một cái vé chín lần một
 * giờ. Nó cũng dùng chung được giữa các account: `cf_clearance` không phải cookie đăng
 * nhập, nó chứng minh MỘT IP đã qua thử thách — hai account cùng IP và cùng UA dùng
 * chung là đúng, và đó là khoản tiết kiệm điểm lớn nhất ở đây.
 *
 * Ngược lại, trần số lượt giải là theo LƯỢT QUÉT: nó ở đó để chặn hoá đơn khi
 * Cloudflare siết, và một trần tính cho cả đời tiến trình sẽ cạn một lần rồi không bao
 * giờ hồi.
 */
import type { BrowserPage, ChallengeSolver } from './download-via-browser.js';
import type { ProxyEndpoint } from './spigot-proxy-pool.js';
import {
  fetchYesCaptchaBalance,
  solveCloudflareChallenge,
  type BalanceResult,
  type CloudflareSolution,
  type YesCaptchaConfig,
} from './yescaptcha-client.js';

export type ChallengeSolverOptions = {
  /** Trống nghĩa là tính năng tắt: `buildChallengeSolverPool` trả về null. */
  clientKey: string;
  baseUrl: string;
  timeoutMs: number;
  clearanceTtlMs: number;
  /** Trần số lượt GIẢI (không tính lượt dùng lại cache) trong một lượt quét. */
  maxSolvesPerSweep: number;
  fetchImpl?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

export type ChallengeSolverPool = {
  /**
   * Bắt đầu một lượt quét: trần số lượt giải được đặt lại, cache giữ nguyên.
   *
   * Trả về hàm dựng solver cho MỘT proxy. Null khi không có proxy — không phải lỗi cấu
   * hình, chỉ là điều kiện bắt buộc chưa đủ, và mọi chỗ gọi đã là `solver?.solve(...)`.
   */
  forSweep(): (endpoint: ProxyEndpoint | null) => ChallengeSolver | null;
  /** Số điểm còn lại, cho script kiểm tra cấu hình. */
  balance(): Promise<BalanceResult>;
};

/**
 * Chuỗi proxy dạng YesCaptcha cần, từ một endpoint của bể proxy.
 *
 * Phần đăng nhập được `encodeURIComponent` lại vì bể proxy đã giải %-encode khi đọc vào
 * (`safeDecode`), nên một mật khẩu chứa `@` hoặc `:` sẽ phá cấu trúc URL nếu ghép thô.
 *
 * socks5 kèm mật khẩu bị từ chối ngay: tài liệu nhà cung cấp nói rõ không hỗ trợ, và
 * gửi lên rồi nhận về một lỗi mù thì vẫn mất lượt gọi mà không ai biết vì sao.
 */
export function proxyUrlFor(endpoint: ProxyEndpoint): { ok: true; url: string } | { ok: false; detail: string } {
  const { server, username, password } = endpoint;
  if (username === undefined || password === undefined) return { ok: true, url: server };

  const split = server.indexOf('://');
  if (split < 0) return { ok: false, detail: `proxy ${endpoint.id} không có scheme` };
  const scheme = server.slice(0, split);
  const address = server.slice(split + 3);

  if (/^socks/i.test(scheme)) {
    return {
      ok: false,
      detail: `proxy ${endpoint.id} là socks kèm mật khẩu — YesCaptcha không hỗ trợ, cần một proxy http/https`,
    };
  }
  return {
    ok: true,
    url: `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${address}`,
  };
}

/**
 * Tên miền để đặt cookie, từ URL đang bị chặn.
 *
 * Bỏ `www.` rồi thêm dấu chấm đầu, vì `cf_clearance` thật được Cloudflare đặt cho cả
 * miền (`.spigotmc.org`): đặt đúng `www.spigotmc.org` thì một lần chuyển hướng sang tên
 * miền trần là mất vé.
 */
export function cookieDomainFor(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  return `.${host.replace(/^www\./i, '')}`;
}

/**
 * Những cookie được phép tiêm vào Chrome của mình.
 *
 * Danh sách trắng, không phải danh sách đen, và đây là điều kiện an toàn chứ không phải
 * sự gọn gàng. Đo trên dịch vụ thật: một lời giải cho `/login` trả về **`xf_session`,
 * `cf_clearance`, `_ga`, `_ga_FKF3FWXLS9`** — `xf_session` là phiên XenForo của trình
 * duyệt BÊN NHÀ CUNG CẤP, tức phiên của một người khách vô danh. Tiêm nó vào profile của
 * một account đang đăng nhập sẽ ghi đè phiên thật và đá account đó ra — đúng thứ mà cả
 * kiến trúc "mỗi account một profile bền" tồn tại để giữ.
 *
 * `cf_clearance` là thứ duy nhất cần mua: nó chứng minh IP đã qua thử thách, và nó là
 * thứ duy nhất trong danh sách trên không mang danh tính của ai.
 */
const INJECTABLE_COOKIES = new Set(['cf_clearance']);

/**
 * Bỏ mọi cookie không được phép tiêm, ngay khi lời giải vừa về.
 *
 * Lọc ở đây CHỨ KHÔNG chỉ ở lúc tiêm: cache giữ lời giải tới 45 phút, và không có lý gì
 * để phiên XenForo của một người khách vô danh nằm trong bộ nhớ tiến trình suốt thời gian
 * đó. `applyClearance` vẫn lọc lần nữa vì nó là chỗ thật sự ghi vào trình duyệt.
 */
function keepInjectableCookies(solution: CloudflareSolution): CloudflareSolution {
  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(solution.cookies)) {
    if (INJECTABLE_COOKIES.has(name)) cookies[name] = value;
  }
  return { cookies, userAgent: solution.userAgent };
}

/** UA thật của trình duyệt đang chạy, để lời giải được buộc vào đúng nó. */
export async function readUserAgent(page: BrowserPage): Promise<string> {
  const ua = await (page.evaluate('navigator.userAgent' as never) as Promise<unknown>).catch(() => '');
  return typeof ua === 'string' ? ua : '';
}

/**
 * Đặt cookie đã mua vào trình duyệt đang chạy.
 *
 * Qua CDP chứ không qua `page.setCookie`: CDP là bề mặt duy nhất tệp
 * `download-via-browser.ts` đã khai báo (nó dùng `Browser.setDownloadBehavior` cho
 * đường tải), tương thích hoàn toàn với CDP session của CloakBrowser / Puppeteer.
 *
 * `Network.enable` là bắt buộc trước `Network.setCookie`; thiếu nó thì lệnh đặt cookie
 * bị từ chối và trang vẫn bị chặn, trông y như lời giải sai.
 *
 * Thuộc tính cookie sao đúng cái Cloudflare tự đặt: `Secure`, `HttpOnly`, `SameSite=None`,
 * `Path=/`. Lệch một thuộc tính thì Chrome giữ cookie nhưng không gửi kèm request.
 *
 * UA chỉ ghi đè KHI khác: mỗi lần ghi đè là thêm một chỗ để `navigator.userAgent` lệch
 * với header thật, và bình thường thì UA gửi lên đã là UA của Chrome này rồi.
 */
export async function applyClearance(
  page: BrowserPage,
  solution: CloudflareSolution,
  domain: string,
  currentUserAgent: string,
): Promise<void> {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Network.enable');
    if (solution.userAgent !== '' && solution.userAgent !== currentUserAgent) {
      await cdp.send('Network.setUserAgentOverride', { userAgent: solution.userAgent });
    }
    for (const [name, value] of Object.entries(solution.cookies)) {
      // Lọc theo danh sách trắng — xem INJECTABLE_COOKIES. Nhà cung cấp trả về cả cookie
      // phiên của chính trình duyệt họ, và tiêm nguyên gói là đá account đang đăng nhập.
      if (!INJECTABLE_COOKIES.has(name)) continue;
      await cdp.send('Network.setCookie', {
        name,
        value,
        domain,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
      });
    }
  } finally {
    await cdp.detach?.().catch(() => undefined);
  }
}

type CachedClearance = { solution: CloudflareSolution; expiresAt: number };

/**
 * Nguồn proxy dạng API phát một IP mới mỗi lần, nên bảng cache lớn dần suốt đời tiến
 * trình nếu không dọn. Chỉ dọn khi đã nhiều, và chỉ những vé đã hết hạn.
 */
const CACHE_ENTRY_LIMIT = 200;

/**
 * Dựng bể solver, hoặc null khi chưa cấu hình YesCaptcha.
 *
 * Null chứ không phải một solver luôn thất bại: mọi chỗ gọi đã là `solver?.solve(...)`,
 * nên null giữ cho một deployment không bật tính năng chạy đúng như hôm nay, không thêm
 * một lời gọi nào, không thêm một dòng log nào.
 */
export function buildChallengeSolverPool(options: ChallengeSolverOptions): ChallengeSolverPool | null {
  if (options.clientKey.trim() === '') return null;

  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const config: YesCaptchaConfig = {
    clientKey: options.clientKey,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.now ? { now: options.now } : {}),
  };

  const cache = new Map<string, CachedClearance>();
  /**
   * Hết điểm thì thôi gọi cho tới khi bot khởi động lại.
   *
   * Không phải sự thận trọng suông: hết điểm là loại lỗi duy nhất mà thử lại chắc chắn
   * vô ích, và mỗi lượt quét có hàng chục chỗ có thể gọi — không dừng thì log đầy đúng
   * một câu lỗi lặp lại suốt đêm.
   */
  let haltedDetail: string | null = null;
  let warnedNoProxy = false;

  const prune = (): void => {
    if (cache.size < CACHE_ENTRY_LIMIT) return;
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now()) cache.delete(key);
    }
  };

  return {
    balance: () => fetchYesCaptchaBalance(config),

    forSweep() {
      // Trần theo lượt quét, cache thì không: xem chú thích đầu tệp.
      let solves = 0;

      return (endpoint: ProxyEndpoint | null): ChallengeSolver | null => {
        if (haltedDetail !== null) return null;
        if (!endpoint) {
          if (!warnedNoProxy) {
            warnedNoProxy = true;
            log(
              'YesCaptcha đã cấu hình nhưng không có proxy — không giải được Cloudflare. ' +
                'Lời giải bị Cloudflare buộc vào IP đã giải, nên cần SPIGOT_PROXY_LIST hoặc SPIGOT_PROXY_API_URL.',
            );
          }
          return null;
        }

        return {
          /**
           * Tiêm vé còn hạn, không gọi API.
           *
           * Tách khỏi `solve` để chỗ gọi dùng được nó TRƯỚC khi điều hướng: một trang mở
           * ra đã mang vé thì không có thử thách nào để chờ, còn `solve` chỉ chạy sau khi
           * đã mất công mở trang chặn và đợi hết thời gian.
           */
          prime: async (page: BrowserPage, url: string) => {
            if (haltedDetail !== null) return false;
            const domain = cookieDomainFor(url);
            if (domain === '') return false;

            const userAgent = await readUserAgent(page);
            const cached = cache.get(`${endpoint.id}|${userAgent}`);
            if (!cached || cached.expiresAt <= now()) return false;

            await applyClearance(page, cached.solution, domain, userAgent);
            return true;
          },

          solve: async (page: BrowserPage, url: string) => {
            if (haltedDetail !== null) return { ok: false, detail: `YesCaptcha đã dừng: ${haltedDetail}` };

            const domain = cookieDomainFor(url);
            if (domain === '') return { ok: false, detail: `không đọc được tên miền từ ${url}` };

            // UA vào khoá cache cùng với proxy, vì lời giải bị buộc vào cả hai.
            const userAgent = await readUserAgent(page);
            const key = `${endpoint.id}|${userAgent}`;

            const cached = cache.get(key);
            if (cached && cached.expiresAt > now()) {
              await applyClearance(page, cached.solution, domain, userAgent);
              return { ok: true, reused: true };
            }
            if (cached) cache.delete(key);

            if (solves >= options.maxSolvesPerSweep) {
              return {
                ok: false,
                detail: `đã dùng hết ${options.maxSolvesPerSweep} lượt giải cho lượt quét này`,
              };
            }

            const proxy = proxyUrlFor(endpoint);
            if (!proxy.ok) return { ok: false, detail: proxy.detail };

            // Đếm TRƯỚC khi gọi: một lượt gọi thất bại vẫn có thể đã trừ điểm, nên đếm
            // sau khi thành công sẽ để một chuỗi lỗi chạy vượt trần.
            solves++;
            const solved = await solveCloudflareChallenge(config, {
              websiteURL: url,
              proxy: proxy.url,
              ...(userAgent !== '' ? { userAgent } : {}),
            });
            if (!solved.ok) {
              if (solved.reason === 'out_of_credit') {
                haltedDetail = solved.detail;
                log(
                  `YesCaptcha hết điểm (${solved.detail}) — thôi giải cho tới khi nạp thêm và khởi động lại bot.`,
                );
              }
              return { ok: false, detail: `${solved.reason}: ${solved.detail}` };
            }

            prune();
            // Lọc TRƯỚC khi cache: xem keepInjectableCookies.
            const kept = keepInjectableCookies(solved.solution);
            cache.set(key, { solution: kept, expiresAt: now() + options.clearanceTtlMs });
            await applyClearance(page, kept, domain, userAgent);
            return { ok: true, reused: false };
          },
        };
      };
    },
  };
}
