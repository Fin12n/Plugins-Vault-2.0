import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Project root, located by walking up from this module to the nearest
 * package.json.
 *
 * A fixed hop count ('../..') would be wrong in one of the two layouts: this
 * file lives at src/config/ during development but at dist/src/config/ once
 * compiled, so counting levels resolves to dist/ in production and silently
 * creates a second, empty database there.
 *
 * Relative paths must not resolve against the CWD either: a systemd unit with
 * WorkingDirectory=/ would create /data/vault.db, boot cleanly, and report that
 * every plugin has vanished while the real vault sits untouched.
 */
function findProjectRoot(startDir: string): string {
  const { root } = parse(startDir);
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === root) return startDir;
    dir = dirname(dir);
  }
}

const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)));

/** Resolves a possibly-relative path against the project root. */
const projectPath = (fallback: string) =>
  z
    .string()
    .min(1)
    .default(fallback)
    .transform((p) => (isAbsolute(p) ? p : resolve(projectRoot, p)));

/**
 * Comma-separated Discord snowflake list, e.g. "123456789,987654321".
 * Snowflakes are numeric strings 17-20 digits long.
 */
const snowflakeListSchema = z
  .string()
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((ids) => ids.length > 0, 'phải có ít nhất một ID')
  .refine((ids) => ids.every((id) => /^\d{17,20}$/.test(id)), 'mỗi ID phải là Discord snowflake');

const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'phải là Discord snowflake');

/**
 * Secret that must not be left at an example value. .env.example ships these
 * empty so boot fails, but a copied-and-half-edited file is still caught here.
 * Anchored on whole placeholder words rather than loose substrings, so a random
 * secret that happens to contain them is not rejected.
 */
const PLACEHOLDER_SECRET = /^(change[-_]?me|your[-_]|placeholder|example|todo|secret|password)\b|^(changeme|xxxx+)$/i;

const secretSchema = (minLength: number) =>
  z
    .string()
    .min(minLength, `phải dài ít nhất ${minLength} ký tự`)
    .refine((s) => !PLACEHOLDER_SECRET.test(s.trim()), 'vẫn đang là giá trị mẫu — hãy đổi');

/** Integer from an env string, with a default when the var is absent or blank. */
const intWithDefault = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= min && n <= max, `phải là số nguyên trong khoảng ${min}-${max}`);

export const envSchema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflakeSchema,
  DISCORD_GUILD_ID: snowflakeSchema,
  // Seeds the config table on first boot; the dashboard owns it afterwards.
  DISCORD_ADMIN_ROLE_IDS: snowflakeListSchema,
  DISCORD_OWNER_ID: snowflakeSchema,
  DISCORD_NOTIFY_CHANNEL_ID: snowflakeSchema,
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),

  // HTTP
  PORT: intWithDefault(3000, 1, 65535),
  /**
   * Externally reachable origin used to build download links. Trailing slashes
   * are stripped — "https://host/" would otherwise yield "https://host//download/x",
   * which some proxies 404, wasting a one-shot token the admin already paid for.
   */
  PUBLIC_BASE_URL: z
    .string()
    .url('phải là URL hợp lệ')
    .refine((u) => /^https?:\/\//i.test(u), 'phải dùng http hoặc https')
    .transform((u) => u.replace(/\/+$/, '')),
  /**
   * Fastify trustProxy. Enumerated rather than loosely coerced: TRUST_PROXY=yes
   * silently meaning false would make every audit_log.ip read 127.0.0.1 and
   * collapse the login rate-limit onto a single key.
   */
  TRUST_PROXY: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Storage & Database
  DATABASE_URL: z.string().optional().default(process.env.DATABASE_URL || ''),
  VAULT_DIR: projectPath('./vault'),
  TMP_DIR: projectPath('./tmp'),
  DB_PATH: projectPath('./data/vault.db'),
  STORAGE_URL: projectPath('./data/plugins'),

  // Dashboard auth
  DASHBOARD_PASSWORD: secretSchema(12),
  SESSION_SECRET: secretSchema(32),

  // SePay — see plans phase-05 for the exact webhook contract
  SEPAY_WEBHOOK_SECRET: secretSchema(8),
  SEPAY_ACCOUNT_NUMBER: z.string().min(1),
  SEPAY_BANK_CODE: z.string().min(1),
  // 2-5 letters, uppercased by SePay when the template is saved.
  SEPAY_CODE_PREFIX: z
    .string()
    .regex(/^[A-Za-z]{2,5}$/, 'phải là 2-5 chữ cái')
    .transform((s) => s.toUpperCase()),
  /**
   * Length of the random suffix appended to the prefix. SePay allows a
   * configured minimum anywhere in 1-30 (its own default is 6), so the range
   * here is deliberately wide; the binding constraint is whatever is set at
   * my.sepay.vn. Too short and SePay silently extracts an empty code.
   */
  SEPAY_CODE_SUFFIX_LENGTH: intWithDefault(8, 1, 30),

  // Behavior — these three seed the config table and are editable at runtime
  ORDER_TTL_MINUTES: intWithDefault(15, 1, 1440),
  DOWNLOAD_TOKEN_TTL_MINUTES: intWithDefault(15, 1, 1440),
  PRUNE_KEEP_COUNT: intWithDefault(10, 1, 1000),
  /**
   * Safety margin below Discord's per-file cap. Discord's free tier is 10 MiB
   * and DMs get no boost benefit, so anything larger goes out as a link.
   */
  ATTACH_MAX_BYTES: intWithDefault(8 * 1024 * 1024, 0, 100 * 1024 * 1024),
  UPLOAD_MAX_FILE_BYTES: intWithDefault(300 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
  UPLOAD_MAX_FILES: intWithDefault(50, 1, 500),

  // Spigot auto-download. Off unless the accounts file exists AND the dashboard
  // toggle is on; see plans phase-07 for the accepted risks.
  SPIGOT_ACCOUNTS_FILE: projectPath('./spigot-accounts.json'),
  /**
   * Spigot usernames and passwords, for unattended re-login. Plaintext by
   * necessity — the login step types them into a real browser. Preferred over
   * the cookie file when present, because cookies cannot be renewed without a
   * human.
   */
  SPIGOT_CREDENTIALS_FILE: projectPath('./spigot-credentials.json'),
  /**
   * Floor between downloads. Bursts are the clearest lockout signal, so this is
   * a minimum gap rather than a rate: downloads are serial regardless.
   */
  SPIGOT_DOWNLOAD_MIN_INTERVAL_MS: intWithDefault(20_000, 1_000, 600_000),
  /**
   * Bounds one sweep so a large backlog cannot turn into a burst.
   *
   * Raised from 5: a fresh vault owes dozens of historical versions, and at 5 per
   * hourly tick a 50-account archive takes weeks to fill. The real throttle is
   * SPIGOT_DOWNLOAD_MIN_INTERVAL_MS between downloads — this cap only stops one
   * sweep running unbounded.
   */
  SPIGOT_MAX_DOWNLOADS_PER_SWEEP: intWithDefault(25, 1, 500),
  /**
   * Gap before re-sweeping while versions are still owed.
   *
   * The hourly interval exists to match the upstream cache lifetime for CHECKING
   * updates; it is the wrong cadence for draining a backlog. When work remains,
   * the next sweep starts after this instead — still spaced, but in minutes rather
   * than hours, so a fresh vault fills in an evening rather than over weeks.
   */
  SPIGOT_BACKLOG_RESWEEP_MS: intWithDefault(5 * 60_000, 30_000, 60 * 60_000),
  /**
   * Optional operator-assisted challenge mode.
   *
   * Off by default: unattended production must close a challenged browser,
   * cool that account down, and continue trying other accounts instead of
   * waiting for dashboard input forever.
   */
  SPIGOT_INTERACTIVE_CHALLENGE: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** Avoid re-opening the same challenged profile every backlog tick. */
  SPIGOT_CHALLENGE_COOLDOWN_MS: intWithDefault(30 * 60_000, 60_000, 24 * 60 * 60_000),
  /**
   * Optional manual override path for a custom browser binary.
   *
   * By default, this is unset because CloakBrowser manages its own custom stealth
   * Chromium binary with 87 C++ anti-bot patches. Only set this if you explicitly
   * wish to override CloakBrowser with a custom executable.
   */
  CHROME_PATH: z.string().min(1).optional(),
  /**
   * Persistent Chrome profile for the download sweep.
   *
   * Lives under the already-gitignored `data/` so no gitignore change is needed,
   * and is created 0700 because its cookie database holds a live Spigot session —
   * a credential store that never passes through `Secret`.
   *
   * Every account receives a stable subdirectory under this base. That keeps its
   * own Spigot login and `cf_clearance` without logging another account out.
   */
  CHROME_PROFILE_DIR: projectPath('./data/chrome-profile'),
  /**
   * Chạy CloakBrowser ở chế độ headless (ẩn cửa sổ).
   * Mặc định: true (chạy ngầm, phù hợp nhất cho server, VPS, Docker).
   * Đặt false nếu muốn hiển thị cửa sổ trình duyệt (khi cần xem trực tiếp giao diện).
   */
  CLOAKBROWSER_HEADLESS: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Legacy fallback for CHROME_SHOW_WINDOW (nếu có, đảo ngược lại CLOAKBROWSER_HEADLESS) */
  CHROME_SHOW_WINDOW: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Legacy fallback for CHROME_ENABLE_GPU */
  CHROME_ENABLE_GPU: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Legacy fallback for CHROME_DISPLAY */
  CHROME_DISPLAY: z.string().optional(),
  /**
   * Khoá bản quyền CloakBrowser Pro (tuỳ chọn). Bỏ trống để dùng bản miễn phí tự động.
   */
  CLOAKBROWSER_LICENSE_KEY: z.string().optional(),
  /**
   * Bật mô phỏng hành vi chuột và gõ phím tự nhiên (Bézier curve, human typing) qua CloakBrowser.
   * Mặc định: true.
   */
  CLOAKBROWSER_HUMANIZE: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * Rotating-proxy provider endpoint, one proxy per account launch.
   *
   * Optional. When set, every browser launch asks this URL for a fresh proxy so
   * each account reaches Spigot from a different residential IP — far less likely
   * to trip Cloudflare than a datacenter VPS IP reused for 28 accounts. The
   * response must be JSON `{ success, data: { proxyHttp: "host:port" } }`.
   *
   * The value carries an api_key query parameter, so it is treated like a secret:
   * read from `.env` only, never logged. Unset means direct connection, exactly
   * the previous behavior.
   */
  SPIGOT_PROXY_API_URL: z.string().min(1).optional(),
  /**
   * Endpoint ĐÚC proxy mới, chỉ gọi khi `SPIGOT_PROXY_API_URL` báo không còn proxy sống.
   *
   * Cần hai biến vì đo được nhà cung cấp phân biệt rõ hai việc, và dùng lẫn thì hỏng theo
   * hai cách khác nhau:
   *   `get-current-proxy` — trả đúng proxy đang có, gọi lại bao nhiêu lần cũng được, KHÔNG
   *     đổi IP. Đúng thứ `cf_clearance` cần vì vé bị buộc vào IP. Nhưng proxy chỉ sống 30
   *     phút, và hết hạn thì endpoint này từ chối vĩnh viễn ("Xoay key … để lấy proxy") —
   *     đặt một mình thì bot đứng hẳn 30 phút sau lần xoay tay cuối cùng.
   *   `get-new-proxy` — đúc IP mới, giới hạn 1 lần/60 giây. Đặt một mình thì mỗi lần gọi
   *     lại đổi IP, tức mỗi lần lại phải mua một cái vé 25 điểm.
   * Đặt cả hai: giữ bằng cái thứ nhất, chỉ đúc lại bằng cái thứ hai khi không còn gì để
   * giữ. Cùng chứa api_key nên cùng là bí mật, chỉ đặt trong .env.
   */
  SPIGOT_PROXY_RENEW_URL: z.string().min(1).optional(),
  /**
   * Danh sách proxy tĩnh, phân cách bằng dấu phẩy hoặc xuống dòng.
   *
   * Dạng mỗi phần tử: `host:port`, `scheme://host:port`, `user:pass@host:port`
   * hoặc `host:port:user:pass` — nhà cung cấp nào cũng dùng một trong bốn dạng đó.
   *
   * Khác `SPIGOT_PROXY_API_URL` ở chỗ bể proxy BIẾT còn bao nhiêu IP rảnh, nên khi
   * một lượt bị Cloudflare chặn nó mới quyết định được là thử lại bằng IP khác hay
   * cho tài khoản nghỉ. Cả hai có thể cùng đặt: danh sách dùng trước, API dùng khi
   * mọi proxy trong danh sách đang nghỉ.
   *
   * Là thông tin của gói trả tiền nên không bao giờ được log; log chỉ nêu id ngắn.
   */
  SPIGOT_PROXY_LIST: z.string().optional(),
  /** Tệp danh sách proxy, mỗi dòng một proxy. Tiện hơn .env khi có vài chục cái. */
  SPIGOT_PROXY_FILE: z.string().optional(),
  /**
   * Proxy vừa hỏng thì nghỉ bao lâu trước khi được chọn lại. Lần hỏng kế tiếp
   * nhân đôi khoảng nghỉ, nên một proxy đã hết hạn tự rơi ra khỏi vòng chọn.
   */
  SPIGOT_PROXY_COOLDOWN_MS: intWithDefault(10 * 60_000, 10_000, 24 * 60 * 60_000),
  /**
   * Số proxy được thử cho MỘT lần mở trình duyệt trước khi chịu chạy thẳng.
   *
   * Chặn trên cho việc thử lại: mỗi lần mở Chrome tốn vài giây, nên thử vô hạn qua
   * một danh sách proxy chết sẽ treo cả lượt quét thay vì báo lỗi.
   */
  SPIGOT_PROXY_MAX_ATTEMPTS: intWithDefault(3, 1, 10),

  /**
   * Khoá YesCaptcha để mua `cf_clearance` khi Chrome không tự vượt được Cloudflare.
   *
   * Trống — mặc định — nghĩa là không mua gì, và mọi cú chặn được xử lý y như trước:
   * báo challenged, cho proxy nghỉ, đổi IP. Đo được rằng Chrome trong container của host
   * đứng ở "Just a moment..." suốt 90 giây mà không hiện widget nào, trong khi cùng
   * code / cùng Chrome / cùng account trên VPS thì sạch trong ~12 giây; biến gây ra khác
   * biệt chưa cô lập được, nên đây là đường đi tắt: mua sẵn cái vé mà thử thách phát ra.
   *
   * QUAN TRỌNG: chỉ có khoá là chưa đủ. Loại task Cloudflare của YesCaptcha bắt buộc
   * phải có proxy, và Cloudflare buộc vé vào ĐÚNG IP đã giải — nên cần thêm
   * SPIGOT_PROXY_LIST hoặc SPIGOT_PROXY_API_URL, nếu không thì bot chỉ ghi một dòng
   * cảnh báo rồi bỏ qua.
   *
   * Là bí mật trả tiền: chỉ đặt trong .env, không bao giờ vào log.
   */
  YESCAPTCHA_CLIENT_KEY: z.string().min(1).optional(),
  /** Node quốc tế; `https://cn.yescaptcha.com` là node trong nước. */
  YESCAPTCHA_BASE_URL: z
    .string()
    .url('phải là URL hợp lệ')
    .default('https://api.yescaptcha.com')
    .transform((u) => u.replace(/\/+$/, '')),
  /** Trần chờ một lời giải. Tài liệu nhà cung cấp: kết quả về sau 10–80 giây, trần 120. */
  YESCAPTCHA_TIMEOUT_MS: intWithDefault(120_000, 30_000, 300_000),
  /**
   * Vé mua được giữ lại bao lâu trước khi mua vé mới.
   *
   * 45 phút, dưới mốc ~1 giờ mà tài liệu hứa: một vé hết hạn giữa lượt tải trông giống
   * hệt một vé sai, nên chừa biên còn hơn tiết kiệm thêm mươi phút.
   */
  YESCAPTCHA_CLEARANCE_TTL_MS: intWithDefault(45 * 60_000, 60_000, 2 * 60 * 60_000),
  /**
   * Số lượt GIẢI tối đa cho một lượt quét — lượt dùng lại vé không tính.
   *
   * 25 điểm mỗi lượt, nên đây là cái phanh cho hoá đơn khi Cloudflare siết và mọi lượt
   * đều bị chặn. Cache theo (proxy, UA) là cái phanh còn lại.
   */
  YESCAPTCHA_MAX_SOLVES_PER_SWEEP: intWithDefault(10, 1, 200),

  // card2k scratch-card exchange. Off unless every field below is supplied.
  //
  // Two of these have no public documentation: the signature field order and the
  // command values. They must come from the partner dashboard. They are
  // deliberately NOT given working defaults — a guessed signature fails
  // indistinguishably from every other error while consuming a real card, so an
  // unconfigured deployment must refuse to submit rather than try.
  CARD2K_BASE_URL: z
    .string()
    .url('phải là URL hợp lệ')
    .default('https://card2k.com')
    // card2k.com serves the API; card2k.net 302s and drops the POST body.
    .transform((u) => u.replace(/\/+$/, '')),
  CARD2K_PARTNER_ID: z.string().default(''),
  CARD2K_PARTNER_KEY: z.string().default(''),
  /**
   * Comma-separated md5 field order, e.g. "partner_key,code,serial".
   * Recognised names: partner_key, partner_id, code, serial, amount, telco,
   * request_id. Empty disables card top-ups.
   */
  CARD2K_SIGN_FIELDS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  CARD2K_COMMAND_CHARGE: z.string().default(''),
  CARD2K_COMMAND_CHECK: z.string().default(''),
  CARD2K_TIMEOUT_MS: intWithDefault(20_000, 1_000, 120_000),
});

export type Env = z.infer<typeof envSchema>;

/** Formats validation issues as one line per offending variable. */
export function formatEnvIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return `Cấu hình không hợp lệ (${lines.length} lỗi):\n${lines.join('\n')}\n\nXem .env.example để biết danh sách biến cần thiết.`;
}

/**
 * Parses process.env, exiting with a readable message naming every offending
 * variable. Config errors must fail at boot, not at first use.
 *
 * Kept separate from envSchema so tests can assert validation without the
 * process.exit side effect.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error(formatEnvIssues(result.error));
    process.exit(1);
  }
  return result.data;
}
