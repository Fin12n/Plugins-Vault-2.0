/**
 * Trả lời đúng một câu: **ở chính môi trường này**, mua `cf_clearance` từ YesCaptcha rồi
 * nhét vào Chrome có đi qua được trang đăng nhập Spigot không?
 *
 * Có mặt vì câu hỏi đó chỉ trả lời được bằng cách đo thật, và đo bằng cả lượt quét thì
 * mất nhiều phút và trộn lẫn với chục nguyên nhân khác. Đo được rằng Chrome trong
 * container của host đứng ở "Just a moment..." suốt 90 giây trong khi cùng Chrome trên
 * VPS thì sạch trong ~12 giây — nên chạy lệnh này ở CẢ HAI nơi: VPS là đối chứng, và
 * container là phép thử thật.
 *
 * Không cần tài khoản Spigot: câu hỏi là Cloudflare có mở trang không, chứ không phải
 * mật khẩu có đúng không. Thành công nghĩa là trang hiện ra form đăng nhập.
 *
 * Không in số dư ra ngoài phạm vi cần thiết, và KHÔNG BAO GIỜ in địa chỉ proxy hay khoá
 * — chỉ id ngắn `p-xxxx`, đúng kỷ luật của bể proxy.
 *
 * Dùng: npm run spigot-probe-captcha
 */
import { mkdirSync, rmSync } from 'node:fs';
import { config } from '../src/config/index.js';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { buildSpigotProxyPool } from '../src/services/upstream/spigot-proxy-pool.js';
import { buildChallengeSolverPool } from '../src/services/upstream/cloudflare-clearance.js';
import { downloadViaBrowser } from '../src/services/upstream/download-via-browser.js';
import type { BrowserPage, ChallengeSolver } from '../src/services/upstream/download-via-browser.js';

const LOGIN_URL = 'https://www.spigotmc.org/login';
/** PlaceholderAPI: bản miễn phí, nên đo được Cloudflare mà không cần tài khoản nào. */
const PROBE_RESOURCE_ID = 6245;
/** Cùng trần với đường thật, để kết quả ở đây nói được điều gì về đường thật. */
const CHALLENGE_TIMEOUT_MS = 90_000;
const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Trang đã mở ra thật chưa: có form đăng nhập là mở, tiêu đề chặn là chưa. */
async function inspect(page: BrowserPage): Promise<{ title: string; hasForm: boolean; challenged: boolean }> {
  const title = await page.title().catch(() => '');
  const hasForm = await (page.evaluate(
    `document.querySelectorAll('input[name=login]').length > 0` as never,
  ) as Promise<unknown>).catch(() => false);
  return {
    title,
    hasForm: hasForm === true,
    challenged: /just a moment|checking your browser/i.test(title),
  };
}

/** Chờ trang tự sạch, đúng như đường thật làm, rồi báo lại trạng thái cuối. */
async function waitOutChallenge(page: BrowserPage): Promise<{ title: string; hasForm: boolean; challenged: boolean }> {
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  let state = await inspect(page);
  while (Date.now() < deadline && state.challenged) {
    await sleep(POLL_MS);
    state = await inspect(page);
  }
  return state;
}

/**
 * Bước cuối và là bước duy nhất trả lời được câu hỏi thật: **tải được jar chưa?**
 *
 * Dùng CHÍNH `downloadViaBrowser` của production kèm solver, không phải một bản mô phỏng
 * — nếu bước này xong thì đường tải thật xong, không cần suy luận thêm. Resource 6245
 * (PlaceholderAPI) là bản miễn phí nên không cần tài khoản: câu hỏi ở đây là Cloudflare
 * có cho tải hay không, chứ không phải account có mua hay chưa.
 */
async function probeDownload(
  env: { TMP_DIR: string },
  page: BrowserPage,
  solver: ChallengeSolver,
  how: string,
): Promise<void> {
  mkdirSync(env.TMP_DIR, { recursive: true, mode: 0o750 });
  console.log(`\n[3] Tải thử resource ${PROBE_RESOURCE_ID} (PlaceholderAPI, bản miễn phí)…`);

  const outcome = await downloadViaBrowser(
    { tmpDir: env.TMP_DIR, maxBytes: 100 * 1024 * 1024, solver, log: (m) => console.log(`    ${m}`) },
    page,
    PROBE_RESOURCE_ID,
  );

  if (outcome.status === 'ok') {
    console.log(`\nKết luận: TẢI ĐƯỢC (${(outcome.bytes / 1048576).toFixed(2)} MB, ${how}).`);
    // Không để lại tệp: probe là phép đo, không phải một lượt nạp kho.
    rmSync(outcome.tmpPath, { force: true });
    return;
  }

  console.error(`\nKết luận: KHÔNG tải được — ${outcome.status}${'detail' in outcome ? `: ${outcome.detail}` : ''}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Lệnh này chỉ được chạy trong Linux host/container; không mở phiên Spigot trên máy cá nhân.');
  }
  const env = config();

  if (!env.YESCAPTCHA_CLIENT_KEY) {
    console.error('Chưa đặt YESCAPTCHA_CLIENT_KEY trong .env — không có gì để kiểm.');
    process.exit(1);
  }

  const solvers = buildChallengeSolverPool({
    clientKey: env.YESCAPTCHA_CLIENT_KEY,
    baseUrl: env.YESCAPTCHA_BASE_URL,
    timeoutMs: env.YESCAPTCHA_TIMEOUT_MS,
    clearanceTtlMs: env.YESCAPTCHA_CLEARANCE_TTL_MS,
    maxSolvesPerSweep: env.YESCAPTCHA_MAX_SOLVES_PER_SWEEP,
    log: (message) => console.warn(message),
  });
  if (!solvers) {
    console.error('Không dựng được bể solver dù đã có khoá — kiểm lại YESCAPTCHA_* trong .env.');
    process.exit(1);
  }

  // Số dư trước tiên: hết điểm là nguyên nhân số một khiến việc giải im lặng ngừng
  // chạy, và biết nó trước khi mở Chrome tiết kiệm cả phút chờ vô ích.
  const balance = await solvers.balance();
  console.log(balance.ok ? `Số dư YesCaptcha: ${balance.balance} điểm` : `Không đọc được số dư: ${balance.detail}`);
  if (balance.ok && balance.balance < 25) {
    console.error('Dưới 25 điểm — không đủ cho một lượt giải. Nạp thêm rồi chạy lại.');
    process.exit(1);
  }

  // Đúng bể proxy bot dùng, không phải một proxy dựng riêng cho script: vé Cloudflare bị
  // buộc vào IP, nên kiểm bằng một IP khác thì kết quả không nói được gì về đường thật.
  const { pool, warnings } = buildSpigotProxyPool({
    ...(env.SPIGOT_PROXY_LIST ? { list: env.SPIGOT_PROXY_LIST } : {}),
    ...(env.SPIGOT_PROXY_FILE ? { file: env.SPIGOT_PROXY_FILE } : {}),
    ...(env.SPIGOT_PROXY_API_URL ? { apiUrl: env.SPIGOT_PROXY_API_URL } : {}),
    ...(env.SPIGOT_PROXY_RENEW_URL ? { renewUrl: env.SPIGOT_PROXY_RENEW_URL } : {}),
  });
  for (const warning of warnings) console.warn(`Cấu hình proxy — ${warning}`);
  console.log(`Bể proxy: ${pool.describe()}`);

  const lease = await pool.next();
  if (!lease) {
    const apiError = pool.takeApiError();
    console.error(
      `Không có proxy nào dùng được${apiError ? ` (${apiError})` : ''}. ` +
        'Loại task Cloudflare của YesCaptcha bắt buộc phải có proxy, và vé chỉ dùng được từ ' +
        'đúng IP đã giải — nên cần SPIGOT_PROXY_LIST hoặc SPIGOT_PROXY_API_URL.',
    );
    process.exit(1);
  }
  console.log(`Dùng proxy ${lease.endpoint.id} (nguồn: ${lease.source})`);

  const solver = solvers.forSweep()(lease.endpoint);
  if (!solver) {
    console.error('Bể solver từ chối dựng solver cho proxy này — xem cảnh báo ở trên.');
    process.exit(1);
  }

  const probe = await probeBrowserLauncher(env.CHROME_PATH);
  if (!probe.available) {
    console.error(`Không mở được trình duyệt: ${probe.reason}`);
    process.exit(1);
  }

  const session = await probe.launch({
    proxyServer: lease.endpoint.server,
    ...(lease.endpoint.username !== undefined ? { proxyUsername: lease.endpoint.username } : {}),
    ...(lease.endpoint.password !== undefined ? { proxyPassword: lease.endpoint.password } : {}),
  });

  try {
    const page = session.page as BrowserPage;

    console.log(`\n[1] Mở ${LOGIN_URL} như bình thường…`);
    const startedAt = Date.now();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
    const before = await waitOutChallenge(page);
    console.log(
      `    sau ${((Date.now() - startedAt) / 1000).toFixed(1)}s — tiêu đề "${before.title}", ` +
        `form đăng nhập: ${before.hasForm ? 'CÓ' : 'không'}, bị chặn: ${before.challenged ? 'CÓ' : 'không'}`,
    );

    if (before.hasForm && !before.challenged) {
      console.log('    môi trường này TỰ vượt được Cloudflare ở trang đăng nhập.');
      await probeDownload(env, page, solver, 'không cần vé');
      return;
    }

    console.log('\n[2] Bị chặn. Mua cf_clearance rồi mở lại…');
    const solved = await solver.solve(page, LOGIN_URL);
    if (!solved.ok) {
      console.error(`    YesCaptcha không giải được: ${solved.detail}`);
      console.error('\nKết luận: KHÔNG đi qua được. Xem lý do ngay trên.');
      process.exitCode = 1;
      return;
    }
    console.log(`    ${solved.reused ? 'dùng lại vé còn hạn' : 'đã mua vé mới'}`);

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
    const after = await waitOutChallenge(page);
    console.log(
      `    tiêu đề "${after.title}", form đăng nhập: ${after.hasForm ? 'CÓ' : 'không'}, ` +
        `bị chặn: ${after.challenged ? 'CÓ' : 'không'}`,
    );

    if (after.hasForm && !after.challenged) {
      console.log('    ĐI QUA ĐƯỢC trang đăng nhập bằng cf_clearance mua từ YesCaptcha.');
      await probeDownload(env, page, solver, 'bằng vé đã mua');
      return;
    }

    console.error(
      '\nKết luận: vé mua được nhưng trang VẪN bị chặn. Nghĩa là thứ sai không phải cái vé — ' +
        'thử một proxy khác (tốt nhất là proxy tĩnh, IP không đổi), và nếu vẫn vậy thì ' +
        'môi trường này bị chặn ở mức mà cf_clearance không sửa được.',
    );
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err: unknown) => {
  // Message thôi, không stack: stack có thể mang theo request đã chứa proxy hoặc khoá.
  console.error('Probe thất bại:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
