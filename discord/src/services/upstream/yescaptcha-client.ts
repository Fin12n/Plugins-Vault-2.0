/**
 * Mua lời giải thử thách Cloudflare từ YesCaptcha.
 *
 * Chỉ là tầng vận chuyển: tệp này không biết gì về Spigot, về Chrome, hay về việc
 * cookie mua được sẽ dùng ở đâu. Chính sách (cache, trần chi phí, tiêm vào trình
 * duyệt) nằm ở `cloudflare-clearance.ts`.
 *
 * Dùng `CloudFlareTaskS2`, KHÔNG dùng `TurnstileTaskProxyless`. Hai loại khác nhau và
 * YesCaptcha nói rõ điều đó: Turnstile là một widget rời nằm trong trang thật (đánh dấu
 * xong trang không nhảy), còn thứ Spigot dựng lên là "5s盾" — cả trang là thử thách,
 * tự nhảy sang trang thật khi xong, `cf-mitigated: challenge` kèm tiêu đề "Just a
 * moment...". Loại Turnstile còn đòi `websiteKey`, thứ mà trang chặn không phát ra.
 *
 * Ba điều kiện của Cloudflare mà tầng trên PHẢI tôn trọng, tài liệu nhà cung cấp nói
 * thẳng: lời giải chỉ dùng được khi request sau đó đi từ CÙNG IP (chính là proxy đã gửi
 * cho YesCaptcha), với CÙNG User-Agent, và bằng một client có dấu vân tay TLS của
 * Chrome. Vì thế `proxy` là trường bắt buộc, không phải tuỳ chọn.
 *
 * `clientKey` và chuỗi proxy KHÔNG BAO GIỜ nằm trong giá trị trả về: mọi `detail` ở đây
 * đều đi vào log, và chuỗi proxy chứa mật khẩu của gói trả tiền.
 */
import { sanitizeProviderError } from './sanitize-provider-error.js';

const CLOUDFLARE_TASK_TYPE = 'CloudFlareTaskS2';
/** Cookie duy nhất đáng mua: nó là vé chứng minh thử thách đã qua. */
const DEFAULT_REQUIRED_COOKIES = ['cf_clearance'];
/** Tài liệu: kết quả về sau 10–80 giây. Hỏi sớm hơn chỉ tốn một lượt gọi vô ích. */
const FIRST_POLL_MS = 6_000;
const POLL_MS = 3_000;
/**
 * Trần cho MỘT lời gọi HTTP.
 *
 * Tách khỏi ngân sách tổng vì hai thứ hỏng khác nhau: một socket treo phải bị cắt để
 * còn hỏi lại, còn ngân sách tổng mới là thứ quyết định lúc nào bỏ cuộc.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export type YesCaptchaConfig = {
  clientKey: string;
  /** Gốc API, không có dấu / ở cuối. Node quốc tế hoặc node trong nước. */
  baseUrl: string;
  /** Ngân sách tổng cho một lượt giải, tính cả tạo task và chờ kết quả. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Tiêm vào để test không phải ngủ thật. */
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type CloudflareSolveRequest = {
  /** Đúng URL đang bị chặn. Trang không bị chặn thì nhà cung cấp không có gì để giải. */
  websiteURL: string;
  /**
   * `scheme://host:port` hoặc `scheme://user:pass@host:port`.
   *
   * Bắt buộc, và phải là ĐÚNG proxy mà trình duyệt sẽ dùng sau đó: Cloudflare buộc
   * `cf_clearance` vào IP đã giải. Không dùng được proxy nội bộ (127.0.0.1, 192.168.x.x)
   * vì máy của nhà cung cấp không với tới, và không dùng được socks5 kèm mật khẩu.
   */
  proxy: string;
  /**
   * UA của chính Chrome sẽ dùng cookie này.
   *
   * Gửi lên thay vì để nhà cung cấp tự chọn, vì như vậy lời giải khớp sẵn với trình
   * duyệt và tầng trên không phải ghi đè UA — một lần ghi đè UA là một chỗ nữa để lệch
   * giữa `navigator.userAgent` và header thật.
   */
  userAgent?: string;
  /** Mặc định chỉ `cf_clearance`. Tài liệu không hứa lấy được mọi cookie yêu cầu. */
  requiredCookies?: readonly string[];
};

export type CloudflareSolution = {
  cookies: Record<string, string>;
  /** UA mà lời giải bị buộc vào. Có thể khác UA đã gửi lên, nên phải đọc lại. */
  userAgent: string;
};

/**
 * Vì sao tách năm loại: mỗi loại đòi một cách xử lý khác nhau.
 *
 * `out_of_credit` phải tắt hẳn việc gọi cho tới khi chủ bot nạp thêm — thử lại chỉ
 * sinh log rác. `unsolvable` là chuyện của proxy, nên đổi IP rồi thử lại. `timeout` và
 * `create_failed` là tạm thời. `bad_shape` nghĩa là nhà cung cấp đổi cấu trúc trả về,
 * tức phải sửa code chứ không phải sửa cấu hình.
 */
export type SolveFailureReason = 'out_of_credit' | 'unsolvable' | 'create_failed' | 'timeout' | 'bad_shape';

export type SolveResult =
  | { ok: true; solution: CloudflareSolution }
  | { ok: false; reason: SolveFailureReason; detail: string };

export type BalanceResult = { ok: true; balance: number } | { ok: false; detail: string };

/** Phần vỏ giống nhau ở mọi phản hồi của nhà cung cấp. */
type ApiEnvelope = {
  errorId?: unknown;
  errorCode?: unknown;
  errorDescription?: unknown;
  status?: unknown;
  taskId?: unknown;
  balance?: unknown;
  solution?: unknown;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Một lời gọi POST JSON, không bao giờ ném lỗi ra ngoài.
 *
 * Ném ở đây sẽ bốc `err.message` lên log, và message của một lỗi fetch chứa nguyên URL
 * — tức chứa gốc API và, với vài runtime, cả thân request đã gửi. Trả về `detail` đã
 * lọc là đường duy nhất an toàn.
 */
async function postJson(
  config: YesCaptchaConfig,
  path: string,
  body: object,
): Promise<{ ok: true; body: ApiEnvelope } | { ok: false; detail: string }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, detail: `không gọi được ${path}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, detail: `${path} trả về không phải JSON (mã ${response.status})` };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, detail: `${path} trả về JSON không đúng dạng` };
  }
  const envelope = parsed as ApiEnvelope;

  // Đọc thân TRƯỚC khi xét mã HTTP, cùng lý do như bên bể proxy: nhà cung cấp trả câu
  // giải thích dùng được kèm mã lỗi, nên bỏ theo mã sẽ đổi một lý do cụ thể thành
  // "không gọi được API".
  if (!response.ok && envelope.errorId === undefined) {
    return { ok: false, detail: `${path} trả mã ${response.status}` };
  }
  return { ok: true, body: envelope };
}

/** Câu lỗi của nhà cung cấp, đã che khoá và proxy, kèm mã lỗi khi có. */
function describeError(envelope: ApiEnvelope, secrets: readonly string[]): string {
  const code = typeof envelope.errorCode === 'string' ? envelope.errorCode : '';
  const description = typeof envelope.errorDescription === 'string' ? envelope.errorDescription : '';
  const raw = [code, description].filter((part) => part !== '').join(': ');
  return sanitizeProviderError(raw === '' ? 'nhà cung cấp từ chối, không nói lý do' : raw, secrets);
}

/**
 * Mã lỗi của nhà cung cấp thành một loại tầng trên xử lý được.
 *
 * Hết điểm được tách riêng vì đó là loại duy nhất mà thử lại chắc chắn vô ích; đọc sai
 * nó thành lỗi tạm thời sẽ sinh ra một vòng mua thất bại chạy suốt đêm trong log.
 */
function classifyErrorCode(envelope: ApiEnvelope): SolveFailureReason {
  const code = (typeof envelope.errorCode === 'string' ? envelope.errorCode : '').toUpperCase();
  if (code.includes('ZERO_BALANCE') || code.includes('INSUFFICIENT')) return 'out_of_credit';
  if (code.includes('UNSOLVABLE')) return 'unsolvable';
  return 'create_failed';
}

/**
 * Cookie từ lời giải, nhận cả hai dạng có thể gặp.
 *
 * Tài liệu ghi là Object (`{cf_clearance: "..."}`), nhưng chính tài liệu đó nói giao
 * diện "còn trong nội bộ thử nghiệm", nên một danh sách `{name, value}` cũng được đọc.
 * Rẻ hơn nhiều so với việc cả tính năng chết vì nhà cung cấp đổi dạng.
 */
function readCookies(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const { name, value } = entry as { name?: unknown; value?: unknown };
      if (typeof name === 'string' && typeof value === 'string') out[name] = value;
    }
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[name] = value;
    }
  }
  return out;
}

/**
 * Mua một `cf_clearance` cho URL đang bị chặn.
 *
 * Trả về lỗi có phân loại thay vì ném: mọi chỗ gọi đều là đường tải đang chạy, và một
 * lần nhà cung cấp lỗi không được phép làm sập lượt quét.
 */
export async function solveCloudflareChallenge(
  config: YesCaptchaConfig,
  request: CloudflareSolveRequest,
): Promise<SolveResult> {
  const delay = config.delay ?? sleep;
  const now = config.now ?? Date.now;
  // Hai giá trị này đã được gửi đi, nên nhà cung cấp có thể đọc lại chúng trong câu lỗi.
  const secrets = [config.clientKey, request.proxy];
  const deadline = now() + config.timeoutMs;

  const created = await postJson(config, '/createTask', {
    clientKey: config.clientKey,
    task: {
      type: CLOUDFLARE_TASK_TYPE,
      websiteURL: request.websiteURL,
      proxy: request.proxy,
      // Chờ trang dựng xong. Thiếu nó thì lời giải có thể về lúc cookie chưa được đặt,
      // và một cookie thiếu trông giống hệt một lượt giải thất bại — tốn điểm mà không
      // biết vì sao.
      waitLoad: true,
      requiredCookies: [...(request.requiredCookies ?? DEFAULT_REQUIRED_COOKIES)],
      ...(request.userAgent ? { userAgent: request.userAgent } : {}),
    },
  });
  if (!created.ok) return { ok: false, reason: 'create_failed', detail: created.detail };

  // Không có taskId thì task không tồn tại, bất kể errorId nói gì: đó là dấu hiệu chắc
  // chắn nhất, và vài phản hồi lỗi của nhà cung cấp không kèm errorId.
  const rawTaskId = created.body.taskId;
  const taskId = typeof rawTaskId === 'string' || typeof rawTaskId === 'number' ? String(rawTaskId) : '';
  if (taskId === '') {
    return { ok: false, reason: classifyErrorCode(created.body), detail: describeError(created.body, secrets) };
  }

  let lastDetail = 'chưa nhận được kết quả nào';
  let wait = FIRST_POLL_MS;
  while (now() < deadline) {
    await delay(wait);
    wait = POLL_MS;

    const polled = await postJson(config, '/getTaskResult', { clientKey: config.clientKey, taskId });
    // Lỗi mạng giữa lúc chờ không phải câu trả lời: task vẫn đang chạy ở phía nhà cung
    // cấp, nên hỏi lại cho tới khi hết ngân sách. Bỏ ở đây là bỏ một lượt đã trả tiền.
    if (!polled.ok) {
      lastDetail = polled.detail;
      continue;
    }
    if (Number(polled.body.errorId ?? 0) !== 0) {
      return { ok: false, reason: classifyErrorCode(polled.body), detail: describeError(polled.body, secrets) };
    }

    const status = typeof polled.body.status === 'string' ? polled.body.status : '';
    if (status === 'processing') continue;
    if (status !== 'ready') {
      lastDetail = `trạng thái lạ "${sanitizeProviderError(status, secrets)}"`;
      continue;
    }

    const solution = (polled.body.solution ?? {}) as { cookies?: unknown; user_agent?: unknown };
    const cookies = readCookies(solution.cookies);
    if (!cookies['cf_clearance']) {
      const names = Object.keys(cookies);
      return {
        ok: false,
        reason: 'bad_shape',
        detail:
          names.length === 0
            ? 'lời giải không kèm cookie nào'
            : `lời giải không có cf_clearance (chỉ có ${names.join(', ')})`,
      };
    }
    // UA trả về thắng UA đã gửi: nhà cung cấp có thể đã dùng UA khác, và lúc đó
    // `cf_clearance` bị buộc vào UA của họ chứ không phải của mình.
    const returnedUa = typeof solution.user_agent === 'string' ? solution.user_agent : '';
    return { ok: true, solution: { cookies, userAgent: returnedUa || (request.userAgent ?? '') } };
  }

  return {
    ok: false,
    reason: 'timeout',
    detail: `hết ${Math.round(config.timeoutMs / 1000)}s chờ lời giải (${lastDetail})`,
  };
}

/**
 * Số điểm còn lại.
 *
 * Có mặt vì hết điểm là nguyên nhân số một khiến việc giải im lặng ngừng chạy, và đọc
 * được nó từ dòng lệnh nhanh hơn nhiều so với mở trang web của nhà cung cấp trong lúc
 * đang chẩn đoán một lượt quét đang chạy.
 */
export async function fetchYesCaptchaBalance(config: YesCaptchaConfig): Promise<BalanceResult> {
  const response = await postJson(config, '/getBalance', { clientKey: config.clientKey });
  if (!response.ok) return { ok: false, detail: response.detail };
  if (Number(response.body.errorId ?? 0) !== 0) {
    return { ok: false, detail: describeError(response.body, [config.clientKey]) };
  }
  const balance = Number(response.body.balance);
  if (!Number.isFinite(balance)) return { ok: false, detail: 'phản hồi không có số dư đọc được' };
  return { ok: true, balance };
}
