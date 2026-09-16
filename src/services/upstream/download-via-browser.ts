import { mkdirSync, rmSync } from 'node:fs';
import { open, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadOutcome } from './download-spigot-resource.js';
import type { Credential } from './spigot-credential-store.js';
import { downloadUrlFor, findVersionId } from './spigot-version-links.js';
import { fetchPublicPage, historyUrl } from './spigot-public-fetch.js';
import { isChromeClosedError } from './chrome-close-detector.js';

/** First `length` bytes of a file, without reading the rest into memory. */
async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Downloads jars by driving a real browser, for hosts that have one.
 *
 * Exists because Cloudflare gates certain spigotmc.org paths with a managed
 * challenge that a plain HTTP client cannot pass. The gating is PER PATH, not
 * per request shape — measured with curl carrying a full Chrome User-Agent:
 *
 *   200: /, /resources/<id>/, /resources/<id>/history, api.spiget.org
 *   403: /login/, /account/, /resources/purchased, /resources/<id>/download
 *
 * The 403s carry `Cf-Mitigated: challenge` and the `Just a moment...`
 * interstitial. Cloudflare terminates ahead of XenForo, so NO combination of
 * xf_user/xf_session cookies can open those paths — the cookie never reaches the
 * origin. A Chrome-accurate TLS fingerprint alone is also insufficient
 * (verified with curl_cffi impersonating Chrome: still 403), because a real JS
 * challenge is executed. Hence a real browser, not a cleverer HTTP client.
 *
 * Consequence worth remembering: only login and download need this module.
 * Version discovery and resource metadata are reachable with plain fetch.
 *
 * On Linux this needs `xvfb`, which is a virtual display rather than a visible
 * window: the process runs unattended as a daemon and nothing is ever shown.
 * `headless: true` does **not** work — the challenge detects it.
 *
 * Một trình duyệt thật vẫn có thể KHÔNG vượt được thử thách: đo được rằng Chrome trong
 * container của host đứng ở "Just a moment..." suốt 90 giây mà không hiện widget nào,
 * trong khi cùng code / cùng Chrome / cùng account trên VPS thì sạch trong ~12 giây. Cho
 * trường hợp đó, mọi chỗ bị chặn ở đây nhận một `ChallengeSolver` TUỲ CHỌN: nó mua
 * `cf_clearance` từ bên thứ ba rồi nhét vào trang, và trang được mở lại đúng một lần.
 * Không cấu hình solver thì mọi đường đi giống hệt trước, từng byte.
 *
 * Returns the same DownloadOutcome shape as the fetch-based downloader, so the
 * orchestrator, retry queue, and notifications are unchanged by which one runs.
 */

/** Cloudflare needs ~20s on a cold page; this is the ceiling. */
const CHALLENGE_TIMEOUT_MS = 90_000;
const CHALLENGE_POLL_MS = 2_500;
const DOWNLOAD_WAIT_MS = 180_000;
const MIN_PLAUSIBLE_BYTES = 1024;
/**
 * The slice of puppeteer-real-browser this module uses.
 *
 * Declared locally and injected rather than imported: the package is optional,
 * weighs ~100 transitive dependencies, and must not break typecheck or CI on
 * hosts that will never install it.
 */
export type BrowserPage = {
  goto: (url: string, options?: object) => Promise<unknown>;
  evaluate: (source: never) => Promise<unknown>;
  title: () => Promise<string>;
  createCDPSession: () => Promise<{ send: (method: string, params?: object) => Promise<unknown> }>;
  mouse: { click: (x: number, y: number) => Promise<void>; move: (x: number, y: number) => Promise<void> };
  keyboard: { type: (text: string, options?: object) => Promise<void>; press: (key: string) => Promise<void> };
  /** Present on a real puppeteer page; used only to answer a proxy's 407. */
  authenticate?: (credentials: { username: string; password: string }) => Promise<void>;
};

export type BrowserSession = {
  page: BrowserPage;
  close: () => Promise<void>;
  /** Check if browser or window was closed unexpectedly */
  isAbruptlyClosed?: () => boolean;
  /** Listen for unexpected disconnect or process exit */
  onAbruptClose?: (callback: (reason: string) => void) => void;
  /** Manually trigger abrupt close state */
  markAbruptlyClosed?: (reason?: string) => void;
};

/**
 * Bên ngoài mua hộ một `cf_clearance` rồi nhét vào trang đang mở.
 *
 * Khai báo ở đây, cạnh `BrowserPage`, theo đúng khuôn "khả năng tuỳ chọn được tiêm" mà
 * `BrowserLauncher` đang dùng: nhờ vậy đồ thị import chỉ đi một chiều
 * (`cloudflare-clearance` → tệp này), và tệp này không kéo theo bất cứ thứ gì của
 * YesCaptcha vào một deployment không bật tính năng đó.
 *
 * `reused` phân biệt "đã trả tiền cho lượt này" với "dùng lại vé còn hạn", vì dòng log
 * cần nói được điều đó — nếu không thì không cách nào biết hoá đơn đến từ đâu.
 */
export type ChallengeSolver = {
  solve: (page: BrowserPage, url: string) => Promise<{ ok: true; reused: boolean } | { ok: false; detail: string }>;
  /**
   * Tiêm vé CÒN HẠN vào trang trước khi điều hướng. Không gọi API, không tốn điểm.
   *
   * Đây là thứ biến tính năng này từ "chạy được" thành "dùng được cho cả kho". Không có
   * nó, mỗi lần điều hướng phải mở trang chặn, đợi hết thời gian chờ, rồi mới sửa —
   * trong một môi trường không bao giờ tự sạch thì đó là 90 giây chết mỗi lần, ba lần
   * mỗi lượt tải. Có nó, trang mở ra đã mang vé nên Cloudflare không dựng thử thách nào
   * để phải chờ, đúng như một trình duyệt đã qua thử thách một lần.
   *
   * Trả về false khi chưa có vé nào còn hạn cho cặp (proxy, UA) này — không phải lỗi,
   * chỉ nghĩa là lần này phải mua.
   */
  prime: (page: BrowserPage, url: string) => Promise<boolean>;
};

export type BrowserLaunchOptions = {
  /**
   * Chrome profile directory for this session. When omitted, the launcher's
   * shared default is used.
   */
  profileDir?: string;
  /**
   * Rotating proxy in `--proxy-server` form (`http://host:port`). Each launch can
   * carry a different one, so every account reaches Spigot from a different IP.
   */
  proxyServer?: string;
  /**
   * Proxy credentials, when the proxy asks for them.
   *
   * Separate from `proxyServer` because Chrome ignores `user:pass@` inside
   * `--proxy-server`: it answers the 407 with a native dialog no automation can
   * see, so every request fails with nothing in the logs. They have to be supplied
   * through the page's own authentication handler instead.
   */
  proxyUsername?: string;
  proxyPassword?: string;
};

/**
 * Boots a browser session, optionally in a specific profile directory and/or
 * through a proxy.
 *
 * The per-profile override exists so a sweep can give each account its OWN
 * profile: reusing one profile across accounts forced a logout between them, and
 * the logout left the reused page without OS keyboard focus — the empty-username-box
 * failure that every account after the first hit. A fresh profile per account makes
 * every login the browser's first, which is the case that reliably works.
 *
 * The proxy override exists so each launch can route through a rotating proxy,
 * lowering the chance Cloudflare flags a datacenter IP opening many sessions.
 */
export type BrowserLauncher = (options?: BrowserLaunchOptions) => Promise<BrowserSession>;

export type BrowserDownloadDeps = {
  tmpDir: string;
  maxBytes: number;
  signal?: AbortSignal;
  /**
   * Plain-fetch implementation for the ungated history lookup.
   *
   * Injected so a test never reaches the network: the default would otherwise
   * make every download test depend on spigotmc.org being up and unchanged.
   */
  fetchImpl?: typeof fetch;
  /**
   * Nơi ghi tiến trình từng bước. Tiêm vào để test không in ra, và để chủ bot
   * thấy được nó đang đứng ở đâu: một lượt tải mất vài phút và có nhiều bước có
   * thể treo, nên không có log từng bước thì "đang tải" và "đã treo" trông giống
   * nhau.
   */
  log?: (message: string) => void;
  /**
   * Người mua `cf_clearance` khi Cloudflare chặn. Vắng thì mọi cú chặn xử lý y như
   * trước: báo `challenged` và để tầng trên đổi IP.
   */
  solver?: ChallengeSolver;
  /**
   * Nhịp và đồng hồ của việc chờ thử thách Cloudflare.
   *
   * Tiêm vào vì cùng lý do `fetchImpl` được tiêm: không có nó thì một ca kiểm đường bị
   * chặn phải chờ thật 60–90 giây, nên nhánh đó sẽ không bao giờ được kiểm.
   */
  challengeTimings?: { pollMs?: number; delay?: (ms: number) => Promise<void>; now?: () => number };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Kết quả chờ trang thật hiện ra.
 *
 * `interactive` tách riêng vì hai kiểu bị chặn cần hai cách xử lý khác nhau: thử
 * thách JS chạy ngầm sẽ tự xong sau mươi giây, còn widget Turnstile đang đợi một
 * cú click thì đợi thêm bao lâu cũng không xong — thứ phải đổi là IP.
 */
type ChallengeWait = { cleared: true } | { cleared: false; interactive: boolean };

/**
 * Bao lâu thì coi widget tương tác là bế tắc.
 *
 * 60 giây, không phải 30: đo được rằng một trang đã dựng widget mà chưa qua thì
 * không tự qua (theo dõi 40 giây liền trên `/login/`, tiêu đề không đổi), nên bỏ
 * sớm là đúng — nhưng thứ dựng widget cũng có thể là thử thách "managed" tự giải
 * chậm, và bỏ ở 30 giây sẽ giết một lượt tải vốn sẽ xong ở giây 35, đồng thời cho
 * một proxy đang lành đi nghỉ. 60 giây vẫn cắt được một phần ba thời gian đứng im
 * mà chừa hai vòng kiểm dự phòng; quá mốc đó thì trần 90 giây phân xử.
 */
const INTERACTIVE_GIVE_UP_MS = 60_000;

/**
 * Chờ trang tự sạch bao lâu TRƯỚC khi mua vé, khi đã có người mua.
 *
 * 20 giây, không phải 90. Đo được: VPS tự sạch trong 11–14 giây, còn container thì đứng
 * nguyên ở "Just a moment..." suốt cả 90 giây. Chờ hết 90 giây rồi mới mua nghĩa là mỗi
 * lần điều hướng bị chặn tốn 90 giây chết — ba lần mỗi lượt tải, nên 77 bản trong hàng
 * chờ là gần 6 tiếng chỉ để ngồi đợi một thứ đã đo được là không bao giờ tới.
 *
 * 20 giây vẫn chừa đủ biên cho một môi trường lành tự sạch MIỄN PHÍ, mà cắt phần chờ vô
 * ích xuống còn một phần tư. Và khi không mua được vé, phần ngân sách còn lại vẫn được
 * chờ nốt — xem `openPastChallenge` — nên một thử thách managed tự giải chậm ở giây 35
 * không bị bỏ oan.
 */
const SOLVER_GRACE_MS = 20_000;

/**
 * Dấu hiệu trang đang là thử thách tương tác, không phải trang Spigot thật.
 *
 * Chỉ bắt những phần tử CHỈ CÓ ở trang chặn. Đặc biệt không dùng
 * `challenge-platform/scripts/jsd` — script đó nằm ở cuối MỌI trang Spigot bình
 * thường (đo được: byte 47471 của một trang resource 48158 byte trả 200), nên bắt
 * theo nó thì trang nào cũng bị coi là bị chặn.
 */
async function hasInteractiveChallenge(page: BrowserPage): Promise<boolean> {
  const found = await (page.evaluate(
    `(() => {
      if (document.getElementById('challenge-running')) return true;
      if (document.querySelector('#cf-chl-widget-container, form#challenge-form, input[name="cf-turnstile-response"]')) return true;
      return !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    })()` as never,
  ) as Promise<boolean>).catch(() => false);
  // So sánh với true chứ không lấy giá trị thật: page.evaluate ở test được giả lập
  // cho việc khác và có thể trả về chuỗi HTML, thứ nào cũng "truthy".
  return found === true;
}

async function tryClickTurnstile(page: BrowserPage): Promise<boolean> {
  try {
    const p = page as any;
    if (typeof p.frames === 'function') {
      for (const frame of p.frames()) {
        const url = typeof frame.url === 'function' ? frame.url() : '';
        if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
          const checkbox = typeof frame.$ === 'function' ? await frame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage input') : null;
          if (checkbox) {
            await checkbox.click({ delay: 50 }).catch(() => undefined);
            return true;
          }
        }
      }
    }
    if (typeof p.$ === 'function') {
      const stage = await p.$('#cf-chl-widget-container iframe, iframe[src*="challenges.cloudflare.com"]');
      if (stage && typeof stage.boundingBox === 'function') {
        const rect = await stage.boundingBox();
        if (rect && rect.width > 0 && rect.height > 0) {
          await page.mouse.click(rect.x + Math.min(30, rect.width / 4), rect.y + rect.height / 2).catch(() => undefined);
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** Waits out the Cloudflare interstitial. */
async function waitForRealPage(
  page: BrowserPage,
  pollMs = CHALLENGE_POLL_MS,
  delay: (ms: number) => Promise<void> = sleep,
  now: () => number = Date.now,
  budgetMs = CHALLENGE_TIMEOUT_MS,
): Promise<ChallengeWait> {
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let sawInteractive = false;
  while (now() < deadline) {
    await delay(pollMs);
    const title = await page.title().catch(() => '');
    if (!/just a moment|checking your browser/i.test(title)) return { cleared: true };

    // Nhớ MỘT lần thấy widget là đủ, không đòi thấy lại ở đúng vòng kiểm cuối: đo
    // trên trang chặn thật, `input[name=cf-turnstile-response]` xuất hiện rồi mất
    // rồi hiện lại giữa các vòng vì widget tự dựng lại — đòi thấy đúng lúc thì lần
    // nào cũng có thể trượt và lại đợi hết 90 giây.
    if (await hasInteractiveChallenge(page)) sawInteractive = true;
    if (sawInteractive && now() - startedAt >= INTERACTIVE_GIVE_UP_MS) {
      return { cleared: false, interactive: true };
    }
  }
  return { cleared: false, interactive: sawInteractive };
}

/** Câu giải thích kèm hướng xử lý, để dòng log nói được việc phải làm. */
function challengeDetail(where: string, wait: { interactive: boolean }): string {
  return wait.interactive
    ? `Cloudflare chặn ${where} bằng thử thách tương tác — cần đổi IP`
    : `Cloudflare chặn ${where}`;
}

/**
 * Điều hướng tới `url`, chờ trang thật hiện ra; bị chặn thì mua vé rồi thử lại một lần.
 *
 * Gộp ba việc vào một chỗ vì trước đây mỗi chỗ trong tệp này tự `goto` rồi tự chờ, và
 * thêm bước mua vé vào từng chỗ riêng lẻ sẽ thành mấy bản sao chực lệch nhau.
 *
 * Chỉ thử lại MỘT lần: vé mua được mà trang vẫn bị chặn thì thứ sai không phải cái vé,
 * và mua lần nữa chỉ tốn thêm tiền cho đúng một kết quả.
 *
 * `tolerateNavigationError` giữ nguyên hành vi của đường tra lịch sử, nơi một lần
 * `goto` thất bại vốn được bỏ qua. Ở những chỗ khác lỗi điều hướng PHẢI ném ra: tầng
 * trên đọc `ERR_PROXY_CONNECTION_FAILED` từ đúng lần ném đó để biết proxy đã chết thay
 * vì quy cho Cloudflare rồi cho tài khoản nghỉ oan.
 */
async function openPastChallenge(
  page: BrowserPage,
  url: string,
  options: {
    solver?: ChallengeSolver;
    log?: (message: string) => void;
    tolerateNavigationError?: boolean;
    timings?: { pollMs?: number; delay?: (ms: number) => Promise<void>; now?: () => number };
  } = {},
): Promise<ChallengeWait> {
  const log = options.log ?? (() => undefined);
  const { pollMs = CHALLENGE_POLL_MS, delay = sleep, now = Date.now } = options.timings ?? {};
  const solver = options.solver;

  const navigate = async (): Promise<void> => {
    const attempt = page.goto(url, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
    if (options.tolerateNavigationError) await attempt.catch(() => undefined);
    else await attempt;
  };

  // Vé còn hạn thì tiêm TRƯỚC khi mở trang, và việc này không tốn điểm: trang mở ra đã
  // mang vé nên Cloudflare không dựng thử thách nào để phải chờ. Đây là chỗ tiết kiệm
  // thời gian lớn nhất của cả tính năng — xem chú thích của `prime`.
  if (solver) {
    const primed = await solver.prime(page, url).catch(() => false);
    if (primed) log('  đã tiêm cf_clearance còn hạn trước khi mở trang');
  }

  await navigate();

  // Chờ ngắn khi có người mua vé, chờ đủ như trước khi không có.
  const graceMs = solver ? SOLVER_GRACE_MS : CHALLENGE_TIMEOUT_MS;
  const first = await waitForRealPage(page, pollMs, delay, now, graceMs);
  if (first.cleared || !solver) return first;

  const solved = await solver.solve(page, url);
  if (!solved.ok) {
    log(`  YesCaptcha không giải được: ${solved.detail}`);
    // Chờ nốt phần ngân sách còn lại. Khi không mua được vé thì hành vi phải giống hệt
    // lúc chưa có tính năng này: một thử thách managed tự giải chậm ở giây 35 vẫn phải
    // được chờ, chứ không bị bỏ ở giây 20 vì một lời gọi API vừa thất bại.
    return waitForRealPage(page, pollMs, delay, now, CHALLENGE_TIMEOUT_MS - graceMs);
  }
  log(solved.reused ? '  dùng lại cf_clearance còn hạn, mở lại trang' : '  đã mua cf_clearance, mở lại trang');

  await navigate();
  return waitForRealPage(page, pollMs, delay, now, graceMs);
}

/**
 * Tags the login form that actually submits, so every later step addresses it.
 *
 * Measured on the live page: it carries FIVE forms, THREE of them with an
 * `input[name=login]` — a header/sidebar copy, `#pageLogin`, and a hidden
 * `#login` (`style="display:none"`). Only `#pageLogin` is the page's real form.
 * Filling either of the others produces no usable submit, which surfaces as an
 * empty username box and reads exactly like a wrong password.
 *
 * Selection is by score — `#pageLogin` first, then a login input carrying
 * `autofocus` (what the page itself considers primary), then a rendered submit
 * button — and candidates are RANKED rather than reduced to one, so a wrong
 * guess is retried against the next form instead of failing the account.
 *
 * Candidacy is decided by whether the inputs are actually rendered, not by the
 * form's own computed style: a `display:none` ANCESTOR leaves the form's own
 * style clean while making its inputs untypeable.
 *
 * A marker attribute rather than coordinates: rects are viewport-relative, so a
 * form below the fold got clicks that focused nothing.
 *
 * Returns how many usable forms exist, so the caller knows whether a retry has
 * anywhere to go.
 */
async function tagLoginForm(page: BrowserPage, rank = 0): Promise<number> {
  const count = (await (page.evaluate(
    `(() => {
      // Renderedness of the INPUTS, not the computed style of the form.
      // getComputedStyle(form) reports the form's OWN declarations and says
      // nothing about an ancestor being display:none — and Spigot nests one of
      // its login forms inside exactly such a container. A form that passes the
      // style check while its inputs are unrendered is the whole bug: focus() on
      // an unrendered input silently does nothing, so every keystroke lands on
      // the body and an empty form is submitted, which XenForo reports as a
      // wrong password.
      const rendered = (el) =>
        !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      const usable = (f) => {
        const login = f.querySelector('input[name=login]');
        const password = f.querySelector('input[name=password]');
        return !!login && !!password && rendered(login) && rendered(password);
      };

      // Ranked rather than picked, so a wrong guess can be retried against the
      // next candidate instead of failing the account.
      const score = (f) => {
        let s = 0;
        if (f.id === 'pageLogin') s += 4;
        if (f.querySelector('input[name=login][autofocus]')) s += 2;
        if (rendered(f.querySelector('input[type=submit], button[type=submit]'))) s += 1;
        return s;
      };

      const cands = [...document.querySelectorAll('form')].filter(usable).sort((a, b) => score(b) - score(a));

      for (const el of document.querySelectorAll('[data-vault-form]')) el.removeAttribute('data-vault-form');
      const chosen = cands[${rank}];
      if (chosen) chosen.setAttribute('data-vault-form', '1');
      return cands.length;
    })()` as never,
  ) as Promise<number>).catch(() => 0)) as number;
  return count;
}

export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'challenged' | 'no_form' | 'bad_credentials' | 'two_factor' | 'form_mismatch';
      detail: string;
    };

/**
 * No trailing slash. Measured repeatedly: `/login/` returns 403 with
 * `Cf-Mitigated: challenge` while `/login` returns 200 and the real form. The slash was
 * costing a Cloudflare wait on every single login attempt.
 */
const LOGIN_URL = 'https://www.spigotmc.org/login';

/**
 * Logs one account into Spigot inside the given page.
 *
 * Hai lượt khi có người mua vé được: một cú chặn ở đây có thể đến ở hai chỗ — trang
 * `/login` chưa mở ra được, hoặc thử thách mới dựng lên NGAY SAU khi gửi form — và cả
 * hai đều nổi lên thành `reason: 'challenged'`. Nên chỗ mua vé đặt ở ngoài, đúng một
 * lần, phủ được cả hai.
 *
 * Chạy lại cả lượt đăng nhập chứ không nhét token vào form đã POST: request kia đã đi
 * rồi, và dựng lại trạng thái nội bộ của thử thách Cloudflare từ bên ngoài là thứ không
 * làm được. Điền lại form thì tốn vài giây, và nó chạy được.
 */
export async function loginToSpigot(
  page: BrowserPage,
  credential: Credential,
  timings: LoginTimings = {},
  solver?: ChallengeSolver,
): Promise<LoginResult> {
  // Vé còn hạn thì tiêm trước cả lần mở `/login` đầu tiên: đây là trang mà container đo
  // được là đứng nguyên 90 giây, nên tiêm sẵn là chỗ tiết kiệm lớn nhất của cả lượt quét.
  if (solver) await solver.prime(page, LOGIN_URL).catch(() => false);

  // Lượt một chờ ngắn KHI có người mua vé: chờ đủ 90 giây rồi mới mua là 90 giây chết
  // cho mỗi account trong một môi trường đã đo được là không bao giờ tự sạch.
  const first = await attemptSpigotLogin(
    page,
    credential,
    solver ? { ...timings, challengeBudgetMs: timings.challengeBudgetMs ?? SOLVER_GRACE_MS } : timings,
  );
  if (first.ok || first.reason !== 'challenged' || !solver) return first;

  const solved = await solver.solve(page, LOGIN_URL);
  if (!solved.ok) {
    return {
      ok: false,
      reason: 'challenged',
      detail: `${first.detail}; YesCaptcha không giải được: ${solved.detail}`,
    };
  }
  // Lượt hai chờ đủ: vé đã nằm trong trình duyệt, nên nếu vẫn còn thử thách thì nó là
  // loại tự giải được và đáng chờ hết.
  return attemptSpigotLogin(page, credential, timings);
}

/** Tiêm vào để test không phải ngủ thật; mặc định là thời gian dùng thật. */
type LoginTimings = {
  settleMs?: number;
  pollMs?: number;
  typeDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Trần chờ thử thách của MỘT lượt. Ngắn lại khi còn đường mua vé sau đó. */
  challengeBudgetMs?: number;
};

/** Một lượt đăng nhập: mở trang, chờ thử thách, điền, gửi, rồi đọc kết quả. */
async function attemptSpigotLogin(
  page: BrowserPage,
  credential: Credential,
  timings: LoginTimings = {},
): Promise<LoginResult> {
  // Submitting the form can trigger a fresh managed challenge. Use the same
  // ceiling as the initial page instead of timing out during a normal cold pass.
  //
  // `challengeBudgetMs` rút ngắn cả hai mốc khi lượt này còn một đường mua vé phía sau:
  // chờ hết trần rồi mới mua là trả giá đầy đủ cho một thứ đã đo được là không tới.
  const challengeBudgetMs = timings.challengeBudgetMs ?? CHALLENGE_TIMEOUT_MS;
  const settleMs = timings.settleMs ?? challengeBudgetMs;
  const pollMs = timings.pollMs ?? CHALLENGE_POLL_MS;
  const typeDelayMs = timings.typeDelayMs ?? 70;
  const delay = timings.delay ?? sleep;
  const now = timings.now ?? Date.now;
  // No trailing slash — see LOGIN_URL.
  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: CHALLENGE_TIMEOUT_MS,
  });
  const loginWait = await waitForRealPage(page, pollMs, delay, now, challengeBudgetMs);
  if (!loginWait.cleared) {
    return { ok: false, reason: 'challenged', detail: challengeDetail('trang đăng nhập', loginWait) };
  }

  const formCount = await tagLoginForm(page);
  if (formCount === 0) {
    // No form means the session in this profile is STILL live — Spigot hides the
    // form once logged in. Each account now has its OWN profile, so a live session
    // can only belong to THIS account: that is success, and re-typing the password
    // would be wasted work (and the thing Spigot rate-limits). This is what makes
    // "keep the profile, skip login next time" work; the form only reappears after
    // Spigot's own session expiry, and then the branch below signs back in.
    const stillLoggedIn = await (page.evaluate(
      `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
    ) as Promise<boolean>).catch(() => false);
    if (stillLoggedIn) return { ok: true };
    // 'no_form', không phải 'challenged': không có form nào gửi được là chuyện của
    // markup trang (XenForo đổi id, hoặc trang lỗi), còn 'challenged' giờ được đọc
    // là "IP này bị chặn" và kéo theo việc cho proxy nghỉ. Gộp hai thứ lại thì một
    // lần Spigot đổi markup sẽ cho nghỉ sạch cả bể proxy đang lành.
    return { ok: false, reason: 'no_form', detail: 'không thấy form đăng nhập gửi được' };
  }

  // Focus through the element, then type with the real keyboard.
  //
  // NOT a coordinate click. Coordinates were the cause of both failure modes seen
  // in practice: getBoundingClientRect is viewport-relative while page.mouse
  // clicks in viewport space, so a form below the fold got clicks that focused
  // nothing and every keystroke went to the page body — an empty form submitted,
  // reported by XenForo as a wrong password. focus() cannot miss.
  //
  // The keystrokes themselves still go through page.keyboard, which is what
  // produces genuine keydown/keypress/input events with human-plausible timing.
  // Only the targeting changed; assigning .value directly would fire no events at
  // all and is what the bot detection actually looks for.
  const focusField = async (name: 'login' | 'password'): Promise<void> => {
    await page.evaluate(
      `(() => {
        const f = document.querySelector('form[data-vault-form]');
        if (!f) return;
        const e = f.querySelector('input[name=${name}]');
        if (!e) return;
        // Scrolled into view first: focus() on an off-screen input works, but
        // Chrome then scrolls asynchronously and the keystrokes can start before
        // the caret settles.
        e.scrollIntoView({ block: 'center' });
        e.focus();
        // Cleared through the element so a retry cannot append to a partial value.
        e.value = '';
      })()` as never,
    );
  };

  const typeInto = async (): Promise<{ login: string; passwordLength: number }> => {
    await focusField('login');
    await page.keyboard.type(credential.username, { delay: typeDelayMs });
    await focusField('password');
    await page.keyboard.type(credential.password, { delay: typeDelayMs });
    // Scoped to the tagged form: an earlier version read the first
    // input[name=login] in the document, which belongs to a DIFFERENT login form
    // on this page, saw it empty, and retyped the username over an
    // already-correct password — breaking accounts that had been working.
    return fieldValues(page);
  };

  // Writes the value straight into the field and fires the events XenForo listens
  // for, bypassing Chrome's keyboard routing entirely.
  //
  // This is the fix for the real failure the sweep hit in practice: account 1
  // signs in, then EVERY later account fails with an empty username box. It is not
  // a wrong-form problem — the layout does not change with the account, so a bad
  // pick would fail account 1 too, and it never does. The cause is focus: after a
  // logout navigates the tab away and back, `document.hasFocus()` is false on the
  // reused page, so `element.focus()` sets activeElement in the DOM but the keys
  // from `page.keyboard.type` route to the real browser widget and land nowhere.
  // Setting `.value` through the native setter and dispatching a genuine
  // InputEvent puts the text in regardless of where the OS caret is, and still
  // fires the input/change events that bot detection checks for — the concern that
  // originally ruled out touching `.value` is answered by dispatching the events,
  // not by avoiding the assignment. The value is embedded as a JSON literal so a
  // quote in a password cannot break the script, and it never reaches a log.
  const fillDirect = async (name: 'login' | 'password', value: string): Promise<void> => {
    await page.evaluate(
      `(() => {
        const f = document.querySelector('form[data-vault-form]');
        if (!f) return;
        const e = f.querySelector('input[name=${name}]');
        if (!e) return;
        e.scrollIntoView({ block: 'center' });
        e.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(e, ${JSON.stringify(value)});
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      })()` as never,
    );
  };

  const isFilled = (v: { login: string; passwordLength: number }): boolean =>
    v.login === credential.username && v.passwordLength === credential.password.length;

  // The human keyboard first: real keystrokes with plausible timing, which is the
  // path that works on the first login of a browser.
  let filled = await typeInto();

  // When the keys did not land — the reused-page focus case above — repair the
  // tagged form directly. This is what makes accounts after the first succeed.
  if (!isFilled(filled)) {
    await tagLoginForm(page, 0);
    await fillDirect('login', credential.username);
    await fillDirect('password', credential.password);
    filled = await fieldValues(page);
  }

  // Only if the direct fill also came up empty is a wrong form plausible; walk the
  // rest, filling each directly rather than with the keyboard that already failed.
  for (let rank = 1; rank < formCount && !isFilled(filled); rank++) {
    await tagLoginForm(page, rank);
    await fillDirect('login', credential.username);
    await fillDirect('password', credential.password);
    filled = await fieldValues(page);
  }

  if (filled.login !== credential.username || filled.passwordLength !== credential.password.length) {
    return {
      ok: false,
      reason: 'form_mismatch',
      detail:
        `không điền được form đăng nhập (thử ${formCount} form, ô tên nhận ` +
        `${filled.login === '' ? 'rỗng' : `"${filled.login}"`}) — ` +
        'lỗi ở trang Spigot, không phải sai mật khẩu',
    };
  }

  // Tick "Stay logged in" before submitting. Without it XenForo issues no
  // xf_user at all and the session dies in an hour, which would look like the
  // feature working and then silently stopping.
  await page.evaluate(
    `(() => { const f = document.querySelector('form[data-vault-form]') || document;
       const b = [...f.querySelectorAll('input[name=remember]')]
        .find((e) => e.offsetWidth || e.offsetHeight); if (b && !b.checked) b.click(); })()` as never,
  );

  // Submit through the button element rather than its coordinates, for the same
  // reason the fields are focused rather than clicked: a button below the fold
  // yields a viewport y that misses. .click() on the real submit button still runs
  // XenForo's own handlers, so nothing about the request differs.
  await delay(300);
  let submitted = false;
  try {
    const p = page as any;
    if (typeof p.$ === 'function') {
      const submitBtn = await p.$('form[data-vault-form] input[type=submit], form[data-vault-form] button[type=submit]');
      if (submitBtn) {
        await page.evaluate(
          `(() => {
            const b = document.querySelector('form[data-vault-form] input[type=submit], form[data-vault-form] button[type=submit]');
            if (b) b.scrollIntoView({ block: 'center' });
          })()` as never,
        );
        await delay(150);
        await submitBtn.click({ delay: 50 });
        submitted = true;
      }
    }
  } catch {
    // fallback
  }

  if (!submitted) {
    try {
      if (page.keyboard) {
        await page.keyboard.press('Enter');
        submitted = true;
      }
    } catch {
      // fallback
    }
  }

  if (!submitted) {
    await page.evaluate(
      `(() => {
        const f = document.querySelector('form[data-vault-form]');
        if (!f) return;
        const b = f.querySelector('input[type=submit], button[type=submit]');
        if (b) b.click();
        else if (f.requestSubmit) f.requestSubmit();
      })()` as never,
    );
  }

  // Poll for an outcome instead of sleeping a fixed span and judging once.
  //
  // A single fixed wait was the real cause of the false "wrong password" reports:
  // if the POST had not finished, or if submitting raised a FRESH Cloudflare
  // interstitial, the logged-in marker was simply absent yet — and every later
  // branch then read that as bad credentials. Waiting until the page settles into
  // one of the three real states removes the race rather than lengthening it.
  const loginDeadline = now() + settleMs;
  let loggedIn = false;
  // do/while so the outcome is inspected at least once. A plain `while` with a
  // zero settle window would submit and then judge nothing at all.
  do {
    await delay(pollMs);

    const title = await page.title().catch(() => '');
    const isChallenge =
      /just a moment|checking your browser|attention required|cloudflare|turnstile/i.test(title) ||
      (await hasInteractiveChallenge(page));
    // Still on the interstitial: not an answer yet, try clicking turnstile if present.
    if (isChallenge) {
      await tryClickTurnstile(page);
      continue;
    }

    loggedIn = await (page.evaluate(
      `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
    ) as Promise<boolean>).catch(() => false);
    if (loggedIn) break;

    // An explicit error means the answer has arrived; no point waiting out the rest.
    const early = await readLoginFailure(page);
    if (early.message !== '' || early.needsTwoFactor) break;
  } while (now() < loginDeadline);
  if (loggedIn) return { ok: true };

  // A challenge that never cleared is environmental, not a credential problem.
  const finalTitle = await page.title().catch(() => '');
  const challengeRemaining =
    /just a moment|checking your browser|attention required|cloudflare|turnstile/i.test(finalTitle) ||
    (await hasInteractiveChallenge(page));
  if (challengeRemaining) {
    // One last attempt to click turnstile
    await tryClickTurnstile(page);
    await delay(2000);
    const retryLoggedIn = await (page.evaluate(
      `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
    ) as Promise<boolean>).catch(() => false);
    if (retryLoggedIn) return { ok: true };

    return { ok: false, reason: 'challenged', detail: 'Cloudflare chặn ngay sau khi gửi form đăng nhập' };
  }

  // Chẩn đoán thay vì đoán. "Đăng nhập không thành công" đúng nhưng vô dụng: nó
  // gộp sai mật khẩu, còn phiên cũ, xác thực hai lớp, và form gửi không thành
  // công vào một câu. Đọc thẳng trạng thái trang để phân biệt.
  const state = await readLoginFailure(page);

  if (state.needsTwoFactor) {
    return {
      ok: false,
      reason: 'two_factor',
      detail: 'tài khoản bật xác thực hai lớp (2FA) — bot không vượt được, hãy tắt 2FA hoặc dùng tài khoản khác',
    };
  }
  // Spigot's own message comes first: when the site states a reason, that reason
  // beats anything inferred from field contents.
  if (state.message) {
    // Pointed at the checker, because a wrong-password message far more often means
    // the file is malformed — a pasted quote, a lost column — than that the password
    // itself is wrong. Sending the owner to reset a working password is the wrong
    // first move.
    const hint = /password|incorrect|mật khẩu/i.test(state.message)
      ? ' — kiểm tra tệp tài khoản bằng `npm run check-accounts` trước khi đổi mật khẩu'
      : '';
    return { ok: false, reason: 'bad_credentials', detail: `${state.message}${hint}` };
  }

  if (state.stillOnLoginPage && state.filledUsername !== credential.username) {
    // Ô nhập không giữ đúng những gì đã gõ, và trang KHÔNG báo lỗi nào. Hai dạng,
    // cùng một nguyên nhân — con trỏ không nằm trong ô — nhưng dạng ô TRỐNG trước
    // đây lọt xuống nhánh cuối và bị báo như sai mật khẩu, khiến chủ bot đi đổi
    // mật khẩu vốn vẫn đúng.
    const seen = state.filledUsername === '' ? 'rỗng' : `"${state.filledUsername}"`;
    return {
      ok: false,
      reason: 'form_mismatch',
      detail:
        `ô tên đăng nhập ${seen} thay vì "${credential.username}" — chữ không vào được ô, ` +
        'không phải sai mật khẩu',
    };
  }

  // Tiêu đề rỗng và không hề có thông báo lỗi từ XenForo cũng không còn ở form đăng nhập
  // -> Đây là do Cloudflare chặn rỗng hoặc proxy đứt kết nối, không phải sai mật khẩu.
  if (state.title === '' && !state.stillOnLoginPage && !state.message) {
    return {
      ok: false,
      reason: 'challenged',
      detail: 'không nhận được phản hồi từ trang đăng nhập (tiêu đề rỗng — Cloudflare chặn hoặc proxy mất kết nối)',
    };
  }

  return {
    ok: false,
    reason: 'bad_credentials',
    detail:
      `không vào được (tiêu đề: "${state.title}"` +
      `${state.stillOnLoginPage ? ', vẫn ở trang đăng nhập' : ''}` +
      `${state.filledUsername ? `, ô tên: "${state.filledUsername}"` : ''})`,
  };
}

/** Nội dung hiện có trong hai ô, để biết chữ đã gõ vào đúng chỗ chưa. */
async function fieldValues(page: BrowserPage): Promise<{ login: string; passwordLength: number }> {
  const raw = (await (page.evaluate(
    `(() => {
      // Bên trong form đã đánh dấu. Trang có nhiều form đăng nhập, nên tìm theo
      // document sẽ đọc ô của form khác và luôn thấy rỗng.
      const f = document.querySelector('form[data-vault-form]');
      if (!f) return JSON.stringify({ login: '', passwordLength: 0 });
      const l = f.querySelector('input[name=login]');
      const p = f.querySelector('input[name=password]');
      // Chỉ trả về ĐỘ DÀI mật khẩu, không bao giờ trả nội dung: giá trị này đi qua
      // cầu CDP và có thể lọt vào log gỡ lỗi.
      return JSON.stringify({ login: l ? l.value || '' : '', passwordLength: p ? (p.value || '').length : 0 });
    })()` as never,
  ) as Promise<string>).catch(() => '')) as string;

  if (!raw) return { login: '', passwordLength: 0 };
  return JSON.parse(raw) as { login: string; passwordLength: number };
}

/** Trạng thái trang sau khi bấm đăng nhập mà không thành công. */
async function readLoginFailure(page: BrowserPage): Promise<{
  title: string;
  message: string;
  stillOnLoginPage: boolean;
  needsTwoFactor: boolean;
  filledUsername: string;
}> {
  const raw = (await (page.evaluate(
    `(() => {
      const text = (document.body ? document.body.textContent || '' : '').slice(0, 3000);
      const msg = [...document.querySelectorAll('.errors,.errorPanel,.blockMessage,.error,.errorOverlay,.js-errorMessage,.blockMessage--error')]
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean)[0] || '';
      // Ô của form ĐÃ ĐIỀN, không phải ô đầu tiên trong trang: trang có nhiều form
      // đăng nhập, và đọc form khác sẽ luôn báo rỗng rồi kết luận sai.
      const scoped = document.querySelector('form[data-vault-form]');
      const userInput = (scoped || document).querySelector('input[name=login]');
      return JSON.stringify({
        title: document.title,
        message: msg.slice(0, 200),
        stillOnLoginPage: !!document.querySelector('input[name=password]'),
        // XenForo chuyển sang trang /login/two-step/ khi bật 2FA.
        needsTwoFactor:
          location.href.indexOf('two-step') !== -1 ||
          /two.step|two.factor|xác thực hai/i.test(text),
        filledUsername: userInput ? userInput.value || '' : '',
      });
    })()` as never,
  ) as Promise<string>).catch(() => '')) as string;

  if (!raw) {
    return { title: '', message: '', stillOnLoginPage: false, needsTwoFactor: false, filledUsername: '' };
  }
  return JSON.parse(raw) as {
    title: string;
    message: string;
    stillOnLoginPage: boolean;
    needsTwoFactor: boolean;
    filledUsername: string;
  };
}

/**
 * Whatever error the page rendered, trimmed for a Discord message.
 *
 * `.errors` đứng đầu danh sách vì đó là lớp Spigot thật sự dùng: đo trên phản hồi
 * POST /login/login, câu "The requested user '…' could not be found." nằm trong
 * `<div class="errors">`. Bộ chọn `.error` KHÔNG khớp `class="errors"` — CSS so
 * khớp trọn token — nên trước đây mọi lỗi tên/mật khẩu đều đọc ra rỗng và bị xếp
 * thành một chẩn đoán chung.
 */
async function readPageMessage(page: BrowserPage): Promise<string> {
  return (await (page.evaluate(
    `[...document.querySelectorAll('.errors,.errorPanel,.blockMessage,.error,.errorOverlay,.resourceAlert')]
       .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200)` as never,
  ) as Promise<string>).catch(() => '')) as string;
}

/**
 * Lấy link tải NGUYÊN VĂN từ trang resource, cho ĐÚNG bản được yêu cầu.
 *
 * Spigot dùng `download?version=<id>` và bỏ tham số đó đi thì máy chủ trả về
 * trang HTML thay vì jar — đúng lỗi khiến bản tải về bị loại vì "không phải jar".
 * Số `version` này là id nội bộ của Spigot, KHÔNG phải uuid của Spiget, nên không
 * thể suy ra từ dữ liệu API; phải đọc từ trang.
 *
 * Trang resource CHỈ có link của bản mới nhất. Khi cần một bản cũ — lúc dựng lại
 * lịch sử cho plugin mới — phải đọc trang /history, nơi mỗi dòng có tên bản và
 * link tải riêng. Không làm vậy thì mọi lượt tải đều về cùng một jar mới nhất,
 * ghi đè nhau và kho tưởng như chưa có gì.
 */
async function findDownloadHref(page: BrowserPage): Promise<string | null> {
  const href = (await (page.evaluate(
    `(() => {
      const links = [...document.querySelectorAll('a[href*="download"]')]
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => h.indexOf('/download') !== -1 || h.indexOf('download?') !== -1);
      // Ưu tiên link có ?version=: đó là link tải thật của một bản cụ thể.
      const withVersion = links.filter((h) => h.indexOf('version=') !== -1);
      return (withVersion[0] || links[0] || '');
    })()` as never,
  ) as Promise<string>).catch(() => '')) as string;

  if (!href) return null;
  return absolute(href);
}

/** Biến href tương đối của Spigot thành URL đầy đủ. */
function absolute(href: string): string {
  return href.startsWith('http') ? href : `https://www.spigotmc.org/${href.replace(/^\//, '')}`;
}

/**
 * The rendered HTML of the current page.
 *
 * Version-id extraction happens in Node against this string rather than inside
 * `evaluate()`, so the same parser can be unit-tested against a real captured
 * history page. In-page DOM walking was untestable and got the pairing wrong.
 */
async function pageHtml(page: BrowserPage): Promise<string> {
  return (await (page.evaluate(
    `document.documentElement ? document.documentElement.outerHTML : ''` as never,
  ) as Promise<string>).catch(() => '')) as string;
}

/**
 * Downloads one resource with an already-logged-in page.
 *
 * Navigation, not fetch: an XHR from inside the page still gets the block, and
 * that difference is the whole reason this module works.
 *
 * `versionName` names the exact release wanted. Without it every call lands on
 * the resource page's own link, which always points at current latest — so a
 * queue of ten historical versions downloads the same jar ten times, nine of
 * them discarded as duplicates while the queue never drains.
 */
export async function downloadViaBrowser(
  deps: BrowserDownloadDeps,
  page: BrowserPage,
  resourceId: number,
  versionName?: string,
): Promise<DownloadOutcome> {
  const log = deps.log ?? (() => undefined);
  const dir = resolve(deps.tmpDir, `spigot-dl-${randomUUID()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  try {
    log(`resource ${resourceId}: mở trang`);

    // The resource page first: it establishes the cookies the download endpoint
    // checks and clears the challenge once, so the download navigation is cheap.
    const resourceWait = await openPastChallenge(page, `https://www.spigotmc.org/resources/${resourceId}/`, {
      ...(deps.solver ? { solver: deps.solver } : {}),
      ...(deps.challengeTimings ? { timings: deps.challengeTimings } : {}),
      log,
    });
    if (!resourceWait.cleared) {
      const detail = challengeDetail('trang resource', resourceWait);
      log(`resource ${resourceId}: ${detail}`);
      return { status: 'challenged', detail };
    }
    log(`resource ${resourceId}: trang mở được, đang tìm link tải`);

    const pageTitle = await page.title().catch(() => '');
    const pageMsg = await readPageMessage(page);
    if (/must be logged in|log in or sign up/i.test(pageMsg)) {
      log(`resource ${resourceId}: phiên đăng nhập đã hết hạn`);
      return { status: 'cookie_dead' };
    }
    if (/not be found|no longer available|deleted|do not have permission/i.test(pageMsg) || /do not have permission/i.test(pageTitle)) {
      log(`resource ${resourceId}: tài nguyên không tồn tại hoặc đã bị xoá trên Spigot (${pageTitle || pageMsg})`);
      return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
    }

    // Nhận diện trạng thái: plugin bị xoá (báo do not have permission) hoặc chưa mua (Buy Now mà không có Download)
    const isResourceStatus = await (page.evaluate(`(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (/do not have permission to view this page|not have permission to perform this action/i.test(text)) return 'gone';
      if (/not have access|must purchase|buy this/i.test(text)) return 'not_owned';
      const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price');
      const dl = document.querySelector('a[href*="/download"], label.downloadButton');
      return (buy && !dl) ? 'not_owned' : null;
    })()` as never) as Promise<string | null>).catch(() => null);

    if (isResourceStatus === 'gone') {
      log(`resource ${resourceId}: trang báo không có quyền xem — plugin đã bị xoá khỏi Spigot`);
      return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
    }
    if (isResourceStatus === 'not_owned') {
      log(`resource ${resourceId}: tài khoản không sở hữu plugin này (chưa mua)`);
      return { status: 'not_owned' };
    }

    let downloadUrl: string | null = null;

    if (versionName) {
      // The history page is the only place a specific older version's link
      // exists. Getting the wrong one is worse than getting none: archiving the
      // latest jar under an old version's name corrupts the vault silently.
      //
      // Two pages are tried. XenForo Resource Manager serves the version table at
      // /history on some themes and /updates on others, and a premium resource
      // answers an unauthenticated request with "You must be logged in" — which
      // renders as an ordinary page, not an error status, so it must be detected
      // by content.
      // Try plain fetch FIRST. History pages are not Cloudflare-gated (verified:
      // /resources/<id>/history answers 200 to curl), so a resource whose history
      // is public costs no browser navigation and no challenge wait at all. Only
      // a premium resource's history needs the authenticated session, and that is
      // exactly what the login wall below detects.
      //
      // Skipped entirely without an injected fetch, so a test that did not opt in
      // cannot silently reach the network.
      if (deps.fetchImpl) {
        const publicPage = await fetchPublicPage(
          { fetchImpl: deps.fetchImpl, ...(deps.signal ? { signal: deps.signal } : {}) },
          historyUrl(resourceId),
        );
        if (publicPage.ok) {
          const publicId = findVersionId(publicPage.html, versionName);
          if (publicId !== null) {
            downloadUrl = downloadUrlFor(resourceId, publicId);
            log(`resource ${resourceId}: lấy được id bản ${versionName} không cần trình duyệt`);
          }
        }
      }

      const pages = downloadUrl
        ? []
        : [
            `https://www.spigotmc.org/resources/${resourceId}/history`,
            `https://www.spigotmc.org/resources/${resourceId}/updates`,
          ];

      let sawLoginWall = false;
      for (const url of pages) {
        const historyWait = await openPastChallenge(page, url, {
          ...(deps.solver ? { solver: deps.solver } : {}),
          ...(deps.challengeTimings ? { timings: deps.challengeTimings } : {}),
          log,
          tolerateNavigationError: true,
        });
        if (!historyWait.cleared) {
          return { status: 'challenged', detail: challengeDetail('trang lịch sử', historyWait) };
        }

        const html = await pageHtml(page);
        if (/must be logged in|log in or sign up/i.test(html)) {
          sawLoginWall = true;
          continue;
        }

        const versionId = findVersionId(html, versionName);
        if (versionId !== null) {
          downloadUrl = downloadUrlFor(resourceId, versionId);
          break;
        }
      }

      if (!downloadUrl) {
        // Fallback: nếu là bản mới nhất hoặc có link download trên trang chính
        const mainDl = await findDownloadHref(page);
        if (mainDl) {
          log(`resource ${resourceId}: dùng link tải từ trang chính cho bản ${versionName}`);
          downloadUrl = mainDl;
        }
      }

      if (!downloadUrl) {
        if (sawLoginWall) {
          // The session did not carry into this page. Retryable, and distinctly
          // not "the version does not exist" — conflating them would defer the
          // wrong thing and hide a dead session behind a version-lookup message.
          log(`resource ${resourceId}: trang lịch sử đòi đăng nhập`);
          return { status: 'cookie_dead' };
        }

        const isHistoryStatus = await (page.evaluate(
          `(() => {
            const text = document.body ? document.body.innerText || '' : '';
            if (/do not have permission to view this page|not have permission to perform this action/i.test(text)) return 'gone';
            if (/not have access|must purchase|buy this/i.test(text)) return 'not_owned';
            const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price, .resourceAlert');
            const dl = document.querySelector('a[href*="/download"]');
            return (buy && !dl) ? 'not_owned' : null;
          })()` as never,
        ) as Promise<string | null>).catch(() => null);

        if (isHistoryStatus === 'gone') {
          log(`resource ${resourceId}: trang lịch sử báo không có quyền xem — plugin đã bị xoá khỏi Spigot`);
          return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
        }
        if (isHistoryStatus === 'not_owned') {
          log(`resource ${resourceId}: tài khoản không sở hữu plugin này (chưa mua)`);
          return { status: 'not_owned' };
        }

        log(`resource ${resourceId}: không thấy bản ${versionName} ở trang lịch sử đầu tiên`);
        return {
          status: 'incomplete',
          detail: `không thấy bản ${versionName} ở trang lịch sử (có thể ở trang sau)`,
        };
      }
    } else {
      downloadUrl = (await findDownloadHref(page)) ?? `https://www.spigotmc.org/resources/${resourceId}/download`;
    }

    log(`  link tải: ${downloadUrl}`);

    // ── Cách 1: fetch() ngay bên trong trình duyệt ──────────────────────────────
    //
    // Browser.setDownloadBehavior cần được gửi từ browser-level CDP target,
    // không phải page-level session (do createCDPSession() trả về). Khi gửi
    // sai target, Chrome nhận lệnh nhưng bỏ qua → file tải vào thư mục mặc
    // định thay vì `dir` → readdir(dir) luôn trống → 0.0 MB.
    //
    // Thay vào đó, gọi fetch() ngay trong trang: cách này dùng cookie phiên
    // hiện có, đi qua proxy của Chrome, và theo redirect tới CDN — giống hệt
    // nhấp tay vào nút Download, nhưng dữ liệu trả về Node.js dưới dạng
    // base64 để ghi vào đĩa. Không cần CDP download intercept.
    log(`resource ${resourceId}: đang tải qua fetch trong trình duyệt…`);
    const fetchOutcomeRaw = await (page.evaluate(
      `(async () => {
        try {
          const res = await fetch(${JSON.stringify(downloadUrl)}, {
            credentials: 'include',
            redirect: 'follow',
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '').then((t) => t.slice(0, 300));
            return JSON.stringify({ ok: false, status: res.status, text });
          }
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          // Convert to base64 in 32 KB chunks to avoid call-stack overflow
          const CHUNK = 32768;
          let binary = '';
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(
              null,
              bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
            );
          }
          return JSON.stringify({ ok: true, data: btoa(binary), size: bytes.length });
        } catch (e) {
          return JSON.stringify({ ok: false, error: String(e) });
        }
      })()` as never,
    ) as Promise<string>).catch(() => null);

    if (fetchOutcomeRaw) {
      type FetchOutcome =
        | { ok: true; data: string; size: number }
        | { ok: false; status?: number; text?: string; error?: string };
      let fetchOutcome: FetchOutcome | null = null;
      try { fetchOutcome = JSON.parse(fetchOutcomeRaw) as FetchOutcome; } catch { /* ignore */ }

      if (fetchOutcome?.ok) {
        const { data, size } = fetchOutcome as { ok: true; data: string; size: number };
        if (size < MIN_PLAUSIBLE_BYTES) {
          log(`resource ${resourceId}: fetch trả về file quá nhỏ (${size} byte) — bỏ qua, thử lại qua CDP`);
        } else if (size > deps.maxBytes) {
          return { status: 'error', detail: `tệp ${size} byte vượt giới hạn ${deps.maxBytes}` };
        } else {
          const fileBuffer = Buffer.from(data, 'base64');
          // Kiểm tra magic bytes: JAR/ZIP luôn bắt đầu bằng 'PK'
          if (fileBuffer.subarray(0, 2).toString() !== 'PK') {
            const text = fileBuffer.subarray(0, 200).toString('utf8');
            // Nhận biết các lỗi Spigot trả về thay vì file thật
            if (/must be logged in|log in to/i.test(text)) {
              log(`resource ${resourceId}: fetch trả về trang đăng nhập — phiên hết hạn`);
              return { status: 'cookie_dead' };
            }
            if (/do not have permission|not have access|must purchase|buy this/i.test(text)) {
              log(`resource ${resourceId}: fetch trả về trang lỗi quyền truy cập`);
              return { status: 'not_owned' };
            }
            if (/just a moment|checking your browser/i.test(text)) {
              log(`resource ${resourceId}: fetch bị chặn bởi Cloudflare`);
              return { status: 'challenged', detail: 'Cloudflare chặn khi tải qua fetch' };
            }
            log(`resource ${resourceId}: fetch trả về nội dung không phải jar (${size} byte) — đầu: ${text.slice(0, 100).replace(/\s+/g, ' ')} — thử CDP`);
            // fall through to CDP fallback
          } else {
            const finalPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar`);
            await writeFile(finalPath, fileBuffer);
            log(`resource ${resourceId}: tải xong ${(size / 1048576).toFixed(2)} MB (qua fetch)`);
            return { status: 'ok', tmpPath: finalPath, bytes: size, rotated: null };
          }
        }
      } else if (fetchOutcome && !fetchOutcome.ok) {
        const fo = fetchOutcome as { ok: false; status?: number; text?: string; error?: string };
        log(`resource ${resourceId}: fetch thất bại (${fo.error ?? `HTTP ${fo.status ?? '?'}`}) — thử CDP`);
        // Check if it's an auth/permission error before falling through
        const errText = (fo.text ?? fo.error ?? '').toLowerCase();
        if (/must be logged in|log in to/.test(errText)) return { status: 'cookie_dead' };
        if (/do not have permission|not have access|must purchase|buy this/.test(errText)) return { status: 'not_owned' };
      }
    }

    // ── Cách 2 (dự phòng): CDP setDownloadBehavior + page.goto() ────────────
    //
    // Dùng khi fetch() trong trình duyệt thất bại (timeout, CORS, v.v.).
    // Lưu ý: cách này kém tin cậy hơn vì Browser.setDownloadBehavior đòi
    // browser-level CDP target, nhưng vẫn để lại để cover edge case.
    log(`resource ${resourceId}: thử tải qua CDP + goto (dự phòng)…`);
    const cdp = await page.createCDPSession();
    let cdpDownloadOk = false;
    try {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      cdpDownloadOk = true;
    } catch (e) {
      log(`resource ${resourceId}: Page.setDownloadBehavior thất bại: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
      cdpDownloadOk = true;
    } catch (e) {
      log(`resource ${resourceId}: Browser.setDownloadBehavior thất bại: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!cdpDownloadOk) {
      log(`resource ${resourceId}: CẢNH BÁO — không set được download path qua CDP`);
    }

    // A file download makes goto() reject; that rejection is the success case.
    const openDownload = (): Promise<unknown> =>
      page.goto(downloadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    if (deps.solver) await deps.solver.prime(page, downloadUrl).catch(() => false);
    await openDownload();

    // Bị chặn ở ĐÚNG lần điều hướng tải: kiểm tra tiêu đề ngay thay vì đợi 3 phút
    let landedTitle = await page.title().catch(() => '');
    if (/just a moment|checking your browser|attention required|cloudflare/i.test(landedTitle)) {
      if (deps.solver) {
        const solved = await deps.solver.solve(page, `https://www.spigotmc.org/resources/${resourceId}/`);
        if (solved.ok) {
          log(
            `resource ${resourceId}: ${solved.reused ? 'dùng lại cf_clearance' : 'đã mua cf_clearance'} — tải lại`,
          );
          try { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); } catch {}
          try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }); } catch {}
          await openDownload();
          landedTitle = await page.title().catch(() => '');
        } else {
          log(`resource ${resourceId}: YesCaptcha không giải được: ${solved.detail}`);
          return { status: 'challenged', detail: `Cloudflare chặn khi tải (${solved.detail})` };
        }
      } else {
        log(`resource ${resourceId}: Cloudflare chặn endpoint tải (chưa cấu hình YesCaptcha)`);
        return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
      }
    }

    // Đọc trang sau khi điều hướng: nếu Spigot từ chối (chưa mua hoặc hết phiên), trả về ngay
    const early = await readPageMessage(page);
    const landedUnowned = await (page.evaluate(`(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (/do not have permission|not have access|must purchase|buy this/i.test(text)) return 'not_owned';
      if (/must be logged in|log in to/i.test(text)) return 'cookie_dead';
      const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price');
      const dl = document.querySelector('a[href*="/download"], label.downloadButton');
      if (buy && !dl) return 'not_owned';
      return null;
    })()` as never) as Promise<string | null>).catch(() => null);

    if (landedUnowned === 'not_owned' || /do not have permission|not have access|must purchase|buy this/i.test(early)) {
      log(`resource ${resourceId}: trang nói không có quyền tải`);
      return { status: 'not_owned' };
    }
    if (landedUnowned === 'cookie_dead' || /must be logged in|log in to/i.test(early)) {
      log(`resource ${resourceId}: trang nói chưa đăng nhập`);
      return { status: 'cookie_dead' };
    }

    const START_TIMEOUT_MS = 25_000;
    const deadline = Date.now() + DOWNLOAD_WAIT_MS;
    const startDeadline = Date.now() + START_TIMEOUT_MS;
    let lastReport = 0;
    let downloadStarted = false;
    const cdpDownloadStarted = false; // CDP event tracking không khả dụng ở đây

    while (Date.now() < deadline) {
      if (deps.signal?.aborted) return { status: 'error', detail: 'đang tắt tiến trình' };
      await sleep(2_000);

      // Kiểm tra kết nối trình duyệt: nếu người dùng tắt Chrome trong lúc tải, dừng ngay lập tức
      try {
        await page.title();
      } catch (err) {
        if (isChromeClosedError(err)) {
          log(`resource ${resourceId}: Chrome đã bị đóng trong lúc chờ tải`);
          return {
            status: 'error',
            detail: `chrome_abruptly_closed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      const partial = await readdir(dir);
      let bytes = 0;
      for (const file of partial) {
        bytes += await stat(join(dir, file)).then(
          (s) => s.size,
          () => 0,
        );
      }

      if (partial.length > 0 || bytes > 0 || cdpDownloadStarted) {
        downloadStarted = true;
      }

      // Báo tiến trình mỗi 10 giây
      if (Date.now() - lastReport > 10_000) {
        lastReport = Date.now();
        const cdpHint = cdpDownloadStarted && bytes === 0 ? ' (CDP báo đang tải nhưng chưa thấy file)' : '';
        log(`resource ${resourceId}: đang tải… ${partial.length} tệp, ${(bytes / 1048576).toFixed(1)} MB${cdpHint}`);
      }

      // Nếu sau 25 giây mà CHƯA CÓ BẤT KỲ TỆP NÀO BẮT ĐẦU TẢI:
      if (!downloadStarted && Date.now() > startDeadline) {
        const title = await page.title().catch(() => '');
        const currentMsg = await readPageMessage(page);
        log(`resource ${resourceId}: không có tệp nào tải về sau 25s — tiêu đề "${title}", trang: ${currentMsg.slice(0, 100)}`);

        if (/just a moment|checking your browser|attention required|cloudflare/i.test(title)) {
          return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
        }
        if (/do not have permission to view this page|not have permission to perform this action|not be found|no longer available|deleted/i.test(currentMsg) || /do not have permission/i.test(title)) {
          return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
        }
        if (/do not have permission|not have access|must purchase|buy this/i.test(currentMsg) || /error\s*\|/i.test(title)) {
          return { status: 'not_owned' };
        }
        return { status: 'incomplete', detail: `trình duyệt không nhận được tệp sau 25s (tiêu đề: "${title}")` };
      }

      const files = (await readdir(dir)).filter((f) => !f.endsWith('.crdownload'));
      if (files.length === 0) continue;

      const path = join(dir, files[0]!);
      const size = (await stat(path)).size;
      if (size < MIN_PLAUSIBLE_BYTES) continue;
      if (size > deps.maxBytes) {
        return { status: 'error', detail: `tệp ${size} byte vượt giới hạn ${deps.maxBytes}` };
      }

      // PK is the zip local file header. Without this an HTML error page saved
      // under a .jar name reaches the vault and surfaces much later as a broken
      // plugin on a live server.
      const head = await readHead(path, 200);
      if (head.subarray(0, 2).toString() !== 'PK') {
        const text = head.toString('utf8').replace(/\s+/g, ' ');
        log(`resource ${resourceId}: tệp không phải jar (${size} byte) — đầu tệp: ${text.slice(0, 120)}`);
        return { status: 'incomplete', detail: `tải về không phải jar (${size} byte)` };
      }

      // Moved out of the per-download directory so the caller owns exactly one
      // file and cleanup stays simple.
      const finalPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar`);
      await rename(path, finalPath);
      log(`resource ${resourceId}: tải xong ${(size / 1048576).toFixed(2)} MB — ${files[0]}`);
      return { status: 'ok', tmpPath: finalPath, bytes: size, rotated: null };
    }

    // Nothing arrived.
    const message = await readPageMessage(page);
    const title = await page.title().catch(() => '');
    log(`resource ${resourceId}: hết thời gian chờ — tiêu đề "${title}", trang nói: ${message.slice(0, 120)}`);

    if (/just a moment|checking your browser/i.test(title)) {
      return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
    }
    if (/must be logged in|log in to/i.test(message)) return { status: 'cookie_dead' };
    if (/do not have permission|not have access|purchase/i.test(message)) return { status: 'not_owned' };
    if (/not be found|no longer available|deleted/i.test(message)) return { status: 'gone' };
    return { status: 'error', detail: message || 'không tải được, không rõ lý do' };
  } catch (err) {
    if (isChromeClosedError(err)) {
      return {
        status: 'error',
        detail: `chrome_abruptly_closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
