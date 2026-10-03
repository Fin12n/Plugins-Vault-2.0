/**
 * Bể proxy cho trình duyệt Spigot: chọn vòng tròn, tự cho proxy hỏng nghỉ.
 *
 * Vì sao cần một bể chứ không chỉ một lời gọi API như trước: Cloudflare chặn theo
 * IP, nên khi một lượt bị chặn thì thứ phải đổi là IP — mà muốn đổi được thì phải
 * còn proxy khác để đổi sang, phải biết proxy nào vừa hỏng, và phải không quay lại
 * ngay proxy đó. Một lời gọi API "cho tôi proxy mới" không trả lời được câu nào
 * trong ba câu đó: API lỗi thì lượt quét âm thầm chạy bằng IP máy chủ, và một exit
 * node đã chết vẫn được phát lại ngay lượt sau.
 *
 * Hai nguồn được gộp lại vì chủ bot thường chỉ có một trong hai: danh sách proxy
 * tĩnh (mua theo tháng, dán vào .env) hoặc endpoint xoay của nhà cung cấp. Danh
 * sách tĩnh được ưu tiên vì nó cho biết CÒN BAO NHIÊU proxy — thông tin mà lượt
 * quét cần để quyết định có thử lại hay cho account nghỉ.
 *
 * Giá trị proxy KHÔNG BAO GIỜ được log: nó là thông tin của gói dịch vụ trả tiền,
 * và URL API còn chứa api_key. Mọi thông báo chỉ nêu id ngắn (`p-3f2a`) do module
 * này sinh ra, đủ để đối chiếu hai dòng log với nhau mà không tiết lộ gì.
 */
import { readFileSync, statSync } from 'node:fs';
import { fetchSpigotProxy } from './proxy-provider.js';
import { sanitizeProviderError } from './sanitize-provider-error.js';

export type ProxyEndpoint = {
  /** Id ngắn, ổn định, an toàn để log. Không suy ra được host từ nó. */
  id: string;
  /** Dạng `scheme://host:port` để truyền vào `--proxy-server` của Chrome. */
  server: string;
  /** Chrome bỏ qua user:pass trong `--proxy-server`, nên tách riêng ra đây. */
  username?: string;
  password?: string;
  /** Thời gian sống của proxy tính bằng giây (vd: 1800 = 30 phút) */
  timeLive?: number;
  /** Thời gian chờ tối thiểu giữa các lần đổi IP (giây, vd: 15) */
  timeChangeRemain?: number;
  /** Timestamp (ms) khi proxy hết hạn sống */
  expireAt?: number;
  /** Timestamp (ms) sớm nhất có thể đổi IP tiếp theo */
  nextChangeAt?: number;
};

export type ProxyLease = { endpoint: ProxyEndpoint; source: 'static' | 'api' };

/** Nghỉ cơ sở sau một lần hỏng; lần sau nhân đôi, chặn trên ở maxCooldownMs. */
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 60 * 60_000;
/** Số lần xin lại khi API trả đúng proxy đang nghỉ. */
const API_RETRIES = 2;
/** Bảng sức khoẻ chỉ được dọn khi đã vượt mức này, để dọn không thành việc thường xuyên. */
const HEALTH_ENTRY_LIMIT = 500;
/** Proxy không nghỉ và lâu hơn khoảng này không dùng thì không cần nhớ nữa. */
const HEALTH_ENTRY_TTL_MS = 6 * 60 * 60_000;

/**
 * Câu báo lỗi của nhà cung cấp trước khi đưa vào log.
 *
 * Bộ lọc nằm ở `sanitize-provider-error.ts` vì YesCaptcha cũng in nguyên văn câu lỗi
 * của nó ra log và cần đúng bộ lọc này — hai bản sao thì lần vá sau chỉ vá được một nửa.
 *
 * `apiUrl` được truyền vào làm bí mật ĐÃ BIẾT, và đây không phải sự thận trọng suông: đo
 * thật trên suiproxy, câu từ chối của họ là `"Xoay key <API_KEY> để lấy proxy"` — chữ
 * "key" trần, không có `api_key=` phía trước, nên lọc theo MẪU không bắt được và khoá đã
 * lọt nguyên văn vào một dòng log. Che theo GIÁ TRỊ thì không phụ thuộc vào việc nhà cung
 * cấp gọi nó là gì.
 */
function sanitizeApiError(message: string, apiUrl?: string): string {
  return sanitizeProviderError(message, secretsFromApiUrl(apiUrl));
}

/**
 * Những chuỗi trong URL API phải coi là bí mật: cả URL, và riêng từng giá trị query.
 *
 * Riêng từng giá trị là phần quan trọng: nhà cung cấp đọc lại api_key một mình, không kèm
 * phần còn lại của URL, nên che nguyên URL thôi thì không khớp gì cả.
 */
function secretsFromApiUrl(apiUrl?: string): string[] {
  if (!apiUrl) return [];
  const secrets = [apiUrl];
  try {
    for (const value of new URL(apiUrl).searchParams.values()) {
      if (value.length >= 6) secrets.push(value);
    }
  } catch {
    // URL không đọc được thì che cả chuỗi vẫn còn hơn không che gì.
  }
  return secrets;
}

/**
 * Giải %-encode, nhưng không bao giờ ném lỗi.
 *
 * `decodeURIComponent` ném URIError khi gặp một dấu % lẻ — và `100%pass` là mật khẩu
 * hoàn toàn có thật. Ném ở đây sẽ nổ ngay trong `buildSpigotProxyPool`, tức là sập
 * lúc khởi động SAU khi bot Discord đã đăng nhập. Một mật khẩu không phải dạng
 * %-encode thì dùng nguyên văn là đúng.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Id ngắn từ chuỗi proxy.
 *
 * Băm chứ không cắt chuỗi: `p-103.x.x.x` vẫn là địa chỉ, còn `p-3f2a` thì không.
 * Không cần chống tấn công, chỉ cần hai proxy khác nhau ra hai id khác nhau.
 *
 * Băm cả tên đăng nhập: nhà cung cấp sticky-session bán nhiều phiên trên CÙNG một
 * host:port và phân biệt bằng user, nên băm riêng địa chỉ sẽ gộp cả gói mười phiên
 * thành một proxy duy nhất.
 */
function shortId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return `p-${hash.toString(36).slice(-5).padStart(4, '0')}`;
}

/**
 * Đọc một dòng proxy ở bất kỳ dạng nào nhà cung cấp hay dùng.
 *
 * Bốn dạng đều gặp thật, và ba trong bốn dạng sẽ bị Chrome nhận sai nếu đưa
 * nguyên chuỗi vào `--proxy-server`:
 *   host:port                    → thêm http://
 *   scheme://host:port           → giữ nguyên
 *   user:pass@host:port          → Chrome KHÔNG đọc user:pass ở đây, phải tách
 *   host:port:user:pass          → dạng của nhiều gói proxy Việt Nam
 *
 * Trả null thay vì ném lỗi: một dòng sai trong danh sách không được làm mất cả
 * danh sách, và người dán vào .env cần biết còn lại mấy proxy dùng được.
 */
export function parseProxyEndpoint(raw: string): ProxyEndpoint | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  const scheme = schemeMatch ? schemeMatch[1]!.toLowerCase() : 'http';
  const rest = schemeMatch ? schemeMatch[2]! : trimmed;
  if (rest === '') return null;

  let credentials = '';
  let address = rest;
  const parts = rest.split(':');

  // Thử dạng host:port:user:pass TRƯỚC, và nhận ra nó bằng cụm thứ hai là số cổng.
  // Phải trước vì tách theo dấu @ sẽ phá dạng này khi mật khẩu có ký tự @:
  // `1.2.3.4:8000:user:p@ssword` từng bị đọc thành địa chỉ "ssword" rồi bỏ cả dòng.
  // Ghép lại phần đuôi thay vì lấy đúng hai cụm, để mật khẩu chứa dấu hai chấm cũng
  // còn nguyên.
  if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1]!)) {
    address = `${parts[0]}:${parts[1]}`;
    credentials = parts.slice(2).join(':');
  } else {
    const at = rest.lastIndexOf('@');
    if (at !== -1) {
      credentials = rest.slice(0, at);
      address = rest.slice(at + 1);
    }
    if (address.split(':').length !== 2) return null;
  }

  const [host, port] = address.split(':');
  if (!host || !port || !/^\d{1,5}$/.test(port) || Number(port) === 0 || Number(port) > 65535) return null;

  const server = `${scheme}://${host}:${port}`;
  const endpoint: ProxyEndpoint = { id: shortId(server), server };

  if (credentials !== '') {
    const split = credentials.indexOf(':');
    // Không có dấu hai chấm nghĩa là dòng bị thiếu mật khẩu. Bỏ luôn phần đăng
    // nhập còn hơn gửi tên không kèm mật khẩu rồi nhận 407 ở mọi request.
    if (split > 0) {
      endpoint.username = safeDecode(credentials.slice(0, split));
      endpoint.password = safeDecode(credentials.slice(split + 1));
      endpoint.id = shortId(`${server}#${endpoint.username}`);
    }
  }

  return endpoint;
}

/** Đọc danh sách proxy phân cách bằng dấu phẩy, xuống dòng hoặc khoảng trắng. */
export function parseProxyList(raw: string): ProxyEndpoint[] {
  const endpoints: ProxyEndpoint[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/[\s,]+/)) {
    const endpoint = parseProxyEndpoint(line);
    // Trùng thì bỏ: một proxy nằm hai lần trong danh sách sẽ được chọn hai lần
    // liền nhau, đúng thứ mà cách chọn "ít dùng nhất" cố tránh.
    if (endpoint && !seen.has(endpoint.id)) {
      seen.add(endpoint.id);
      endpoints.push(endpoint);
    }
  }
  return endpoints;
}

/**
 * Lỗi này là của proxy, không phải của Cloudflare.
 *
 * Phân biệt được hai thứ mới là điểm chính: trước đây một exit node chết làm
 * navigation thất bại, lượt quét quy cho "Cloudflare chặn" và cho account nghỉ 30
 * phút — phạt tài khoản vì lỗi của proxy, trong khi việc đúng phải làm là đổi
 * proxy và thử lại ngay.
 */
export function isProxyFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH_REQUESTED|ERR_PROXY_AUTH_UNSUPPORTED|ERR_NO_SUPPORTED_PROXIES|ERR_SOCKS_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_HOST_UNREACHABLE|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|ERR_UNEXPECTED_PROXY_AUTH/i.test(
    message,
  );
}

export type ProxyPoolOptions = {
  endpoints?: ProxyEndpoint[];
  /** Endpoint xoay của nhà cung cấp; dùng khi danh sách tĩnh hết proxy rảnh. */
  apiUrl?: string;
  /**
   * Endpoint ĐÚC proxy mới, chỉ gọi khi `apiUrl` báo không còn proxy nào đang sống.
   *
   * Với suiproxy: `apiUrl` là `get-current-proxy` (giữ nguyên IP, gọi bao nhiêu lần cũng
   * được) còn cái này là `get-new-proxy` (đổi IP, giới hạn 1 lần/60 giây).
   */
  renewUrl?: string;
  fetchImpl?: typeof fetch;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
};

type Health = { failures: number; cooledUntil: number; lastUsedAt: number };

/**
 * Bể proxy dùng chung cho mọi lần mở trình duyệt.
 *
 * Dựng một lần rồi truyền đi, không dựng theo từng lượt: trạng thái "proxy này
 * vừa hỏng" chỉ có giá trị khi nó sống lâu hơn một lượt quét.
 */
export class SpigotProxyPool {
  private readonly endpoints: ProxyEndpoint[];
  private readonly health = new Map<string, Health>();
  private readonly apiUrl?: string;
  private readonly renewUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;
  /** Lý do lần xin proxy API gần nhất thất bại, để log một dòng có ích. */
  private lastApiError: string | null = null;
  /** Lần xin API gần nhất có phải là một proxy đang nghỉ hay không. */
  private lastApiLeaseWasCooling = false;
  /**
   * Proxy cuối cùng API phát ra, giữ lại để dùng khi nhà cung cấp từ chối phát mới.
   *
   * Endpoint xoay của nhà cung cấp thường chỉ cho đổi IP mỗi N giây, còn một lượt
   * quét mở hàng chục trình duyệt: mọi lần gọi giữa hai lần đổi đều bị từ chối. Không
   * nhớ lại thì một proxy đang sống bị bỏ ở gần như mọi lần mở, và bot rơi về IP máy
   * chủ — đúng thứ mà việc trả tiền cho proxy nhằm tránh.
   */
  private lastApiEndpoint: ProxyEndpoint | null = null;
  /** Lần xin API gần nhất có phải là proxy cũ dùng lại vì bị từ chối hay không. */
  private lastApiLeaseWasReused = false;
  /** Theo dõi số lượng instances trình duyệt đang cùng sử dụng một proxy endpoint. */
  private readonly activeInstances = new Map<string, number>();

  /** Thời điểm cấp IP hiện tại (timestamp ms), dùng để kiểm tra cooldown */
  private currentIpAcquiredAt: number = 0;
  /** Thời điểm IP hiện tại hết hạn sống (timestamp ms, mặc định 30 phút sau khi cấp) */
  private currentProxyExpiresAt: number = 0;
  /** Thời điểm sớm nhất có thể gọi API đổi IP (cooldown rate-limit ms) */
  private currentProxyNextChangeAt: number = 0;
  /** Thế hệ IP (tăng lên mỗi khi đổi sang IP mới để các worker nhận biết và đổi Chrome) */
  private rotationEpoch: number = 0;
  /** Promise single-flight tránh trường hợp cả 5 worker cùng spam request đổi IP lên nhà cung cấp */
  private rotateInFlightPromise: Promise<ProxyLease | null> | null = null;

  /**
   * Proxy mới đã được Cron đúc sẵn, chờ lượt quét hiện tại hoàn tất để áp dụng.
   */
  private stagedLease: ProxyLease | null = null;
  /** Timer chạy cron tự động đổi IP mới theo chu kỳ SPIGOT_PROXY_COOLDOWN_MS */
  private autoRotateTimer: NodeJS.Timeout | null = null;
  private autoRotateInFlight = false;

  constructor(options: ProxyPoolOptions = {}) {
    this.endpoints = options.endpoints ?? [];
    if (options.apiUrl) this.apiUrl = options.apiUrl;
    if (options.renewUrl) this.renewUrl = options.renewUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    // Trần không bao giờ được thấp hơn khoảng nghỉ cơ sở: đặt
    // SPIGOT_PROXY_COOLDOWN_MS=2 giờ mà trần cứng 1 giờ thì ngay lần hỏng đầu đã bị
    // cắt còn một nửa — cấu hình bị bỏ qua trong im lặng.
    this.maxCooldownMs = Math.max(options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS, this.cooldownMs);
    this.now = options.now ?? Date.now;
  }

  /** Có nguồn proxy nào không. False nghĩa là mọi lần mở đều chạy IP thật. */
  get configured(): boolean {
    return this.endpoints.length > 0 || this.apiUrl !== undefined || this.renewUrl !== undefined;
  }

  get size(): number {
    return this.endpoints.length;
  }

  /** Lấy ID của proxy đang được sử dụng hiện tại */
  getActiveProxyId(): string | null {
    if (this.lastApiEndpoint) return this.lastApiEndpoint.id;
    const activeStatic = this.endpoints.find((e) => !this.isCooling(e.id));
    return activeStatic?.id ?? null;
  }

  /** Lấy thế hệ IP hiện tại (tăng lên mỗi lần đổi IP mới) */
  getRotationEpoch(): number {
    return this.rotationEpoch;
  }

  /** Thời gian IP hiện tại đã được sử dụng (ms) */
  getCurrentIpAgeMs(): number {
    if (this.currentIpAcquiredAt === 0) return 0;
    return Math.max(0, this.now() - this.currentIpAcquiredAt);
  }

  /**
   * Cập nhật thời điểm cấp và thời hạn sống của IP hiện tại.
   * TTL mặc định là 30 phút (1800s), TUYỆT ĐỐI không ép xoay mỗi 30s.
   */
  private updateCurrentProxyMeta(endpoint: ProxyEndpoint): void {
    const now = this.now();
    this.currentIpAcquiredAt = now;
    const ttlMs = (endpoint.timeLive && endpoint.timeLive > 0 ? endpoint.timeLive * 1000 : undefined)
      ?? (endpoint.expireAt && endpoint.expireAt > now ? endpoint.expireAt - now : undefined)
      ?? (30 * 60_000); // 30 phút (1800s) mặc định
    this.currentProxyExpiresAt = now + Math.max(ttlMs, 60_000);

    const rateLimitMs = (endpoint.timeChangeRemain !== undefined && endpoint.timeChangeRemain > 0
      ? endpoint.timeChangeRemain * 1000
      : this.cooldownMs);
    this.currentProxyNextChangeAt = now + rateLimitMs;
  }

  /** Timestamp (ms) khi IP hiện tại hết hạn sống */
  getCurrentProxyExpiresAt(): number {
    return this.currentProxyExpiresAt;
  }

  /** Số giây sống còn lại của IP hiện tại */
  getTimeLiveRemaining(): number {
    if (this.currentProxyExpiresAt === 0) return 0;
    return Math.max(0, Math.round((this.currentProxyExpiresAt - this.now()) / 1000));
  }

  /**
   * Kiểm tra xem IP hiện tại đã hết hạn sống hoặc bị hỏng (dead) chưa.
   *
   * Chỉ trả về true khi:
   * 1. Proxy bị chết (dead): đã bị đánh dấu hỏng (isCooling) do lỗi kết nối proxy, Cloudflare block, v.v.
   * 2. Hoặc proxy đã hết thời gian sống thật sự (timeLive 1800s = 30 phút).
   *
   * TUYỆT ĐỐI KHÔNG đổi IP mỗi 30s! Chỉ đổi khi proxy dead hoặc hết hạn 30 phút.
   */
  isCurrentIpExpired(): boolean {
    if (this.currentIpAcquiredAt === 0) return false;
    // 1. Proxy hiện tại bị đánh dấu hỏng (cooling/dead):
    const activeId = this.getActiveProxyId();
    if (activeId && this.isCooling(activeId)) {
      return true;
    }
    // 2. Hết hạn sống thực sự (sau 1800s = 30 phút):
    if (this.currentProxyExpiresAt > 0 && this.now() >= this.currentProxyExpiresAt) {
      return true;
    }
    return false;
  }

  /** Lấy địa chỉ IP/Host proxy đang dùng gần nhất (hoặc null nếu chưa có/không dùng). */
  getActiveProxyServer(): string | null {
    if (this.lastApiEndpoint) {
      return this.lastApiEndpoint.server.replace(/^[a-z]+:\/\//i, '');
    }
    if (this.endpoints.length > 0) {
      const active = this.endpoints.find((e) => !this.isCooling(e.id));
      if (active) return active.server.replace(/^[a-z]+:\/\//i, '');
    }
    return null;
  }

  /** Lấy địa chỉ IP proxy mới đã được đổi sẵn trong bộ đệm Cron (chờ hết lượt quét để áp dụng). */
  getStagedProxyServer(): string | null {
    return this.stagedLease ? this.stagedLease.endpoint.server.replace(/^[a-z]+:\/\//i, '') : null;
  }

  /** Lấy thông tin lease đang được staged */
  getStagedLease(): ProxyLease | null {
    return this.stagedLease;
  }

  /**
   * Áp dụng ngay proxy mới trong bộ đệm staged vào luồng chính (gọi khi hết lượt quét).
   */
  promoteStagedProxy(): ProxyLease | null {
    if (!this.stagedLease) return null;
    const promoted = this.stagedLease;
    this.stagedLease = null;
    this.lastApiEndpoint = promoted.endpoint;
    this.lastApiLeaseWasCooling = false;
    this.lastApiLeaseWasReused = false;
    this.touch(promoted.endpoint.id);
    this.updateCurrentProxyMeta(promoted.endpoint);
    this.rotationEpoch++;
    return promoted;
  }

  /**
   * Bắt đầu Cron tự động kiểm tra timer theo chu kỳ SPIGOT_PROXY_COOLDOWN_MS để đổi IP mới.
   *
   * Quy tắc bắt buộc:
   * - Sau mỗi chu kỳ SPIGOT_PROXY_COOLDOWN_MS, BẮT BUỘC đổi sang IP mới ngay lập tức.
   * - Cả 5 worker cùng nhận diện IP mới và chuyển sang IP mới.
   */
  startAutoRotateCron(options?: {
    intervalMs?: number;
    isSweepActive?: () => boolean;
    onRotated?: (lease: ProxyLease, isStaged: boolean) => void;
    log?: (message: string, level?: 'info' | 'warn' | 'error' | 'success') => void;
  }): void {
    if (this.autoRotateTimer) return;
    if (!this.renewUrl) return;

    const interval = options?.intervalMs ?? this.cooldownMs;
    this.autoRotateTimer = setInterval(() => {
      void this.autoRotateTick(options);
    }, interval);
    this.autoRotateTimer.unref();
  }

  stopAutoRotateCron(): void {
    if (this.autoRotateTimer) {
      clearInterval(this.autoRotateTimer);
      this.autoRotateTimer = null;
    }
  }

  async autoRotateTick(options?: {
    isSweepActive?: () => boolean;
    onRotated?: (lease: ProxyLease, isStaged: boolean) => void;
    log?: (message: string, level?: 'info' | 'warn' | 'error' | 'success') => void;
  }): Promise<ProxyLease | null> {
    if (options?.isSweepActive && !options.isSweepActive()) return null;
    if (this.autoRotateInFlight) return null;
    if (!this.renewUrl) return null;

    // CHỈ ĐỔI KHI PROXY ĐÃ EXPIRED (DEAD HOẶC HẾT HẠN 30 PHÚT)
    // Nếu proxy vẫn đang sống tốt: KHÔNG ĐƯỢC TỰ ĐỘNG ĐỔI!
    if (!this.isCurrentIpExpired()) {
      return null;
    }

    this.autoRotateInFlight = true;
    try {
      const endpoint = await this.fetchRenewEndpoint();
      if (!endpoint) {
        if (this.lastApiError) {
          options?.log?.(`[Proxy Cron] Chưa thể đổi IP mới: ${this.lastApiError}`, 'warn');
        }
        return null;
      }

      const serverIp = endpoint.server.replace(/^[a-z]+:\/\//i, '');
      const lease: ProxyLease = { endpoint, source: 'api' };

      this.lastApiEndpoint = endpoint;
      this.lastApiLeaseWasCooling = this.isCooling(endpoint.id);
      this.lastApiLeaseWasReused = false;
      this.lastApiError = null;
      this.touch(endpoint.id);
      this.updateCurrentProxyMeta(endpoint);
      this.rotationEpoch++;
      this.stagedLease = null;

      options?.log?.(
        `🔄 [Proxy Rotated] Đã đổi sang IP mới: ${serverIp} (Epoch #${this.rotationEpoch}) do IP cũ đã hết hạn hoặc bị lỗi kết nối.`,
        'success',
      );
      options?.onRotated?.(lease, false);
      return lease;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options?.log?.(`[Proxy Cron] Lỗi khi đổi IP: ${msg}`, 'error');
      return null;
    } finally {
      this.autoRotateInFlight = false;
    }
  }

  /**
   * Còn proxy khác đang rảnh để đổi sang hay không.
   *
   * Lượt quét hỏi câu này khi bị Cloudflare chặn: còn IP khác thì thử lại đáng
   * giá, hết rồi thì thử lại chỉ là mở đúng một IP đã bị chặn lần nữa.
   *
   * Với nguồn API, câu trả lời dựa vào lần xin gần nhất: nếu API vừa phát lại đúng
   * proxy đang nghỉ thì nhà cung cấp đang xoay theo thời gian chứ không theo lượt
   * gọi, nên xin thêm cũng ra đúng IP đó — trả true ở đó là mở Chrome ba lần trên
   * cùng một IP đã bị chặn. Dùng lại proxy cũ vì bị từ chối cũng vậy: nhà cung cấp
   * đã nói thẳng là chưa đến hạn đổi.
   */
  hasAlternative(excludeId?: string): boolean {
    if (this.endpoints.some((endpoint) => endpoint.id !== excludeId && !this.isCooling(endpoint.id))) return true;
    return this.apiUrl !== undefined && !this.lastApiLeaseWasCooling && !this.lastApiLeaseWasReused;
  }

  /**
   * Đánh dấu 1 instance trình duyệt bắt đầu sử dụng proxy này.
   */
  acquire(id: string): number {
    const current = this.activeInstances.get(id) ?? 0;
    const next = current + 1;
    this.activeInstances.set(id, next);
    return next;
  }

  /**
   * Giải phóng 1 instance trình duyệt khi đóng hoặc xoay sang proxy khác.
   */
  release(id: string): void {
    const current = this.activeInstances.get(id) ?? 0;
    if (current <= 1) {
      this.activeInstances.delete(id);
    } else {
      this.activeInstances.set(id, current - 1);
    }
  }

  /**
   * Lấy số lượng instances đang cùng chạy trên proxy này.
   */
  getActiveInstances(id: string): number {
    return this.activeInstances.get(id) ?? 0;
  }

  /** Một dòng trạng thái an toàn để log: không có host, không có api_key. */
  describe(): string {
    if (!this.configured) return 'không dùng proxy (chạy IP máy chủ)';
    const parts: string[] = [];
    if (this.endpoints.length > 0) {
      const resting = this.endpoints.filter((endpoint) => this.isCooling(endpoint.id)).length;
      parts.push(`${this.endpoints.length} proxy tĩnh${resting > 0 ? ` (${resting} đang nghỉ)` : ''}`);
    }
    if (this.apiUrl) parts.push('API xoay proxy');
    return parts.join(' + ');
  }

  /**
   * Proxy tiếp theo, hoặc null khi không còn gì rảnh — null nghĩa là chạy thẳng.
   *
   * Chạy thẳng thay vì bỏ lượt quét là lựa chọn có ý thức: một IP máy chủ dễ bị
   * chặn hơn, nhưng bị chặn còn có đường xử lý, còn không quét thì kho không bao
   * giờ đầy.
   *
   * @param options.maxInstancesPerProxy Giới hạn số instance chung 1 IP proxy (mặc định 1)
   */
  async next(options?: { maxInstancesPerProxy?: number }): Promise<ProxyLease | null> {
    const maxPerProxy = options?.maxInstancesPerProxy ?? 1;
    const fromList = this.pickFromList(maxPerProxy);
    if (fromList) {
      if (this.currentIpAcquiredAt === 0) {
        this.updateCurrentProxyMeta(fromList);
        this.rotationEpoch = Math.max(1, this.rotationEpoch);
      }
      return { endpoint: fromList, source: 'static' };
    }

    // Nếu Cron đã đúc sẵn một IP mới và không có instance nào đang gánh trên IP cũ:
    // Tự động nâng cấp lên IP mới ngay cho lượt quét này!
    if (this.stagedLease) {
      const activeCurrent = this.lastApiEndpoint ? this.getActiveInstances(this.lastApiEndpoint.id) : 0;
      if (activeCurrent === 0) {
        const promoted = this.promoteStagedProxy();
        if (promoted) return promoted;
      }
    }

    // Nếu có renewUrl (cơ chế IP cố định như Suiproxy):
    // Cả 5 worker cùng ăn chung 1 IP proxy hiện tại cho đến khi proxy dead hoặc hết hạn sống (timeLive 1800s)!
    if (
      this.renewUrl &&
      this.lastApiEndpoint &&
      !this.isCurrentIpExpired() &&
      !this.isCooling(this.lastApiEndpoint.id) &&
      this.getActiveInstances(this.lastApiEndpoint.id) < maxPerProxy
    ) {
      this.touch(this.lastApiEndpoint.id);
      return { endpoint: this.lastApiEndpoint, source: 'api' };
    }

    // Nếu proxy API hiện tại đã chết (dead) hoặc hết hạn sống 1800s:
    // BẮT BUỘC đổi sang IP mới ngay lập tức!
    if (this.renewUrl && this.lastApiEndpoint && this.isCurrentIpExpired()) {
      const renewed = await this.renew();
      if (renewed) return renewed;
    }

    // Nếu proxy API cũ đang sống nhưng đã đạt tối đa số instance cho phép (5 instances):
    if (this.lastApiEndpoint && this.getActiveInstances(this.lastApiEndpoint.id) >= maxPerProxy) {
      const renewed = await this.renew();
      if (renewed) return renewed;
      // Nếu đúc proxy mới thất bại (ví dụ chưa hết hạn cooldown của nhà cung cấp),
      // nhưng proxy cũ vẫn đang sống tốt và không bị đánh dấu hỏng:
      // Tái sử dụng proxy này (chia sẻ thêm instance) thay vì trả về null khiến worker rơi về Direct VPS IP.
      if (!this.isCooling(this.lastApiEndpoint.id)) {
        this.lastApiLeaseWasReused = true;
        this.lastApiLeaseWasCooling = false;
        this.lastApiError = null;
        this.touch(this.lastApiEndpoint.id);
        if (this.currentIpAcquiredAt === 0) {
          this.updateCurrentProxyMeta(this.lastApiEndpoint);
          this.rotationEpoch = Math.max(1, this.rotationEpoch);
        }
        return { endpoint: this.lastApiEndpoint, source: 'api' };
      }
      return null;
    }

    // Chỉ cấu hình endpoint đúc mà không có endpoint giữ: vẫn dùng được, chỉ là mỗi lần
    // gọi lại đổi IP.
    if (!this.apiUrl) return this.renew();

    for (let attempt = 0; attempt <= API_RETRIES; attempt++) {
      const fetched = await fetchSpigotProxy(this.apiUrl, this.fetchImpl);
      if (!fetched.ok) {
        // Bị từ chối phát proxy mới KHÔNG có nghĩa là không có proxy: proxy phát lần
        // trước vẫn còn hạn cho tới lần đổi kế tiếp. Dùng lại nó, trừ khi chính nó
        // vừa hỏng và đang nghỉ — lúc đó IP máy chủ còn hơn một exit node đã chết.
        const reusable =
          fetched.reason === 'refused' && this.lastApiEndpoint !== null && !this.isCooling(this.lastApiEndpoint.id)
            ? this.lastApiEndpoint
            : null;
        if (reusable) {
          this.lastApiLeaseWasReused = true;
          this.lastApiLeaseWasCooling = false;
          this.lastApiError = null;
          this.touch(reusable.id);
          if (this.currentIpAcquiredAt === 0) {
            this.updateCurrentProxyMeta(reusable);
            this.rotationEpoch = Math.max(1, this.rotationEpoch);
          }
          return { endpoint: reusable, source: 'api' };
        }
        // Không còn proxy nào để dùng lại: xin nhà cung cấp phát một cái MỚI, nếu chủ bot
        // đã cấu hình endpoint đó.
        const renewed = await this.renew();
        if (renewed) return renewed;
        this.lastApiError = sanitizeApiError(fetched.detail ?? fetched.reason, this.apiUrl);
        return null;
      }
      const endpoint = parseProxyEndpoint(fetched.proxy.server);
      if (!endpoint) {
        this.lastApiError = 'API proxy trả địa chỉ không đọc được';
        return null;
      }
      endpoint.timeLive = fetched.proxy.timeLive;
      endpoint.timeChangeRemain = fetched.proxy.timeChangeRemain;
      endpoint.expireAt = fetched.proxy.expireAt;
      endpoint.nextChangeAt = fetched.proxy.nextChangeAt;

      // Xin lại khi API phát đúng proxy vừa hỏng: nhà cung cấp xoay theo lượt gọi,
      // nên lần gọi sau thường ra IP khác. Xin hết lượt mà vẫn ra nó thì DÙNG luôn —
      // khác đường danh sách tĩnh, ở đây không có cái thứ hai để chọn, và một IP
      // từng hỏng vẫn hơn là bỏ về IP máy chủ đã bị đánh dấu từ lâu. Nhưng ghi lại
      // việc đó, để hasAlternative() thôi hứa một IP khác mà nhà cung cấp không có.
      const cooling = this.isCooling(endpoint.id);
      if (cooling && attempt < API_RETRIES) continue;
      this.lastApiLeaseWasCooling = cooling;
      this.lastApiLeaseWasReused = false;
      this.lastApiEndpoint = endpoint;
      this.lastApiError = null;
      this.touch(endpoint.id);
      if (this.currentIpAcquiredAt === 0) {
        this.updateCurrentProxyMeta(endpoint);
        this.rotationEpoch = Math.max(1, this.rotationEpoch);
      }
      return { endpoint, source: 'api' };
    }
    return null;
  }

  /** Lý do lần xin proxy gần nhất thất bại, đã lược bỏ api_key. */
  takeApiError(): string | null {
    const error = this.lastApiError;
    this.lastApiError = null;
    return error;
  }

  /**
   * Gọi API để lấy địa chỉ endpoint proxy mới (chưa gắn vào lastApiEndpoint).
   */
  private async fetchRenewEndpoint(): Promise<ProxyEndpoint | null> {
    if (!this.renewUrl) return null;

    const fetched = await fetchSpigotProxy(this.renewUrl, this.fetchImpl);
    if (!fetched.ok) {
      this.lastApiError = sanitizeApiError(fetched.detail ?? fetched.reason, this.renewUrl);
      return null;
    }
    const endpoint = parseProxyEndpoint(fetched.proxy.server);
    if (!endpoint) {
      this.lastApiError = 'API đúc proxy trả địa chỉ không đọc được';
      return null;
    }
    endpoint.timeLive = fetched.proxy.timeLive;
    endpoint.timeChangeRemain = fetched.proxy.timeChangeRemain;
    endpoint.expireAt = fetched.proxy.expireAt;
    endpoint.nextChangeAt = fetched.proxy.nextChangeAt;
    return endpoint;
  }

  /**
   * Đúc một proxy mới khi không còn cái nào đang sống hoặc khi hết hạn cooldown.
   */
  private async renew(): Promise<ProxyLease | null> {
    const endpoint = await this.fetchRenewEndpoint();
    if (!endpoint) return null;

    this.lastApiLeaseWasCooling = this.isCooling(endpoint.id);
    this.lastApiLeaseWasReused = false;
    this.lastApiEndpoint = endpoint;
    this.lastApiError = null;
    this.touch(endpoint.id);
    this.updateCurrentProxyMeta(endpoint);
    this.rotationEpoch++;
    this.stagedLease = null;
    return { endpoint, source: 'api' };
  }

  /**
   * Proxy này vừa làm hỏng một lượt: cho nghỉ, lần hỏng sau nghỉ gấp đôi.
   *
   * Luỹ tiến chứ không cố định, vì hai kiểu hỏng trông giống nhau ở lần đầu: một
   * exit node quá tải sẽ dùng lại được sau mươi phút, còn một proxy đã hết hạn thì
   * không bao giờ dùng lại được — nhân đôi khiến cái thứ hai tự rơi ra khỏi vòng
   * chọn mà không cần ai xoá nó khỏi danh sách.
   */
  markBad(id: string): void {
    const health = this.healthFor(id);
    health.failures++;
    const backoff = Math.min(this.cooldownMs * 2 ** (health.failures - 1), this.maxCooldownMs);
    health.cooledUntil = this.now() + backoff;
  }

  /** Proxy này vừa dùng tốt: xoá lịch sử hỏng để nó trở lại vòng chọn bình thường. */
  markGood(id: string): void {
    const health = this.healthFor(id);
    health.failures = 0;
    health.cooledUntil = 0;
  }

  /**
   * Ép xoay sang một Proxy IP mới ngay lập tức theo yêu cầu hoặc khi hết hạn cooldown.
   * Sử dụng single-flight promise để ngăn việc 5 worker cùng gọi spam API đúc IP.
   */
  async forceRotate(options?: { maxInstancesPerProxy?: number }): Promise<ProxyLease | null> {
    if (this.rotateInFlightPromise) {
      return this.rotateInFlightPromise;
    }

    this.rotateInFlightPromise = (async () => {
      try {
        this.stagedLease = null;
        if (this.lastApiEndpoint) {
          this.markBad(this.lastApiEndpoint.id);
          this.lastApiEndpoint = null;
        }
        const currentStatic = this.endpoints.find((e) => !this.isCooling(e.id));
        if (currentStatic && this.endpoints.length > 1) {
          this.markBad(currentStatic.id);
        }
        const renewed = await this.renew();
        if (renewed) return renewed;
        return this.next({ maxInstancesPerProxy: options?.maxInstancesPerProxy ?? 1 });
      } finally {
        this.rotateInFlightPromise = null;
      }
    })();

    return this.rotateInFlightPromise;
  }

  /**
   * Proxy tĩnh rảnh hoặc ít instance đang gánh nhất.
   *
   * Mặc định chia sẻ cho tối đa 5 worker cùng sử dụng chung 1 IP proxy.
   * 1. Ưu tiên các proxy có số instance đang dùng < maxInstancesPerProxy (mặc định 5).
   * 2. Trong các proxy đủ điều kiện, chọn proxy có số instance ít nhất.
   * 3. Nếu số instance bằng nhau, chọn proxy lâu chưa dùng nhất (LRU).
   */
  private pickFromList(maxInstancesPerProxy = 1): ProxyEndpoint | null {
    let best: ProxyEndpoint | null = null;
    let bestUsedAt = Number.POSITIVE_INFINITY;
    let minInstances = Number.POSITIVE_INFINITY;

    const available = this.endpoints.filter((e) => !this.isCooling(e.id));
    if (available.length === 0) return null;

    // Lọc các endpoint chưa vượt quá trần maxInstancesPerProxy (2-3 instances)
    const underCap = available.filter((e) => this.getActiveInstances(e.id) < maxInstancesPerProxy);
    if (underCap.length === 0) return null;

    for (const endpoint of underCap) {
      const instances = this.getActiveInstances(endpoint.id);
      const usedAt = this.health.get(endpoint.id)?.lastUsedAt ?? 0;

      if (instances < minInstances || (instances === minInstances && usedAt < bestUsedAt)) {
        best = endpoint;
        minInstances = instances;
        bestUsedAt = usedAt;
      }
    }

    if (best) this.touch(best.id);
    return best;
  }

  private isCooling(id: string): boolean {
    return (this.health.get(id)?.cooledUntil ?? 0) > this.now();
  }

  private touch(id: string): void {
    this.healthFor(id).lastUsedAt = this.now();
  }

  private healthFor(id: string): Health {
    let health = this.health.get(id);
    if (!health) {
      // Nguồn API phát một IP mới mỗi lần mở, nên bảng này lớn dần suốt đời tiến
      // trình nếu không dọn. Chỉ dọn khi đã nhiều, và chỉ những proxy vừa không nghỉ
      // vừa lâu không dùng — trạng thái đang nghỉ là thứ duy nhất đáng giữ.
      if (this.health.size >= HEALTH_ENTRY_LIMIT) this.forgetStaleHealth();
      health = { failures: 0, cooledUntil: 0, lastUsedAt: 0 };
      this.health.set(id, health);
    }
    return health;
  }

  private forgetStaleHealth(): void {
    const staleBefore = this.now() - HEALTH_ENTRY_TTL_MS;
    for (const [id, health] of this.health) {
      if (health.cooledUntil <= this.now() && health.lastUsedAt < staleBefore) this.health.delete(id);
    }
  }
}

export type ProxyPoolConfig = {
  /** Danh sách dán thẳng vào .env. */
  list?: string;
  /** Tệp danh sách, mỗi dòng một proxy — dạng tiện hơn khi có vài chục proxy. */
  file?: string;
  apiUrl?: string;
  renewUrl?: string;
  cooldownMs?: number;
  /** Trần khoảng nghỉ. Không thể thấp hơn cooldownMs — xem hàm dựng. */
  maxCooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readFile?: (path: string) => string;
  /** Tiêm vào để test không phụ thuộc quyền tệp thật trên máy chạy test. */
  checkPermissions?: (path: string) => string | null;
};

/** Cảnh báo khi tệp proxy để người khác trên máy đọc được. */
export function proxyFilePermissionWarning(path: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${path} có quyền ${mode.toString(8)} — nên đặt 0600, tệp này chứa thông tin proxy trả tiền`;
    }
  } catch {
    // Không đọc được quyền thì phần đọc nội dung ở trên đã báo rồi.
  }
  return null;
}

/**
 * Dựng bể proxy từ cấu hình, kèm những cảnh báo cần nói ra một lần lúc khởi động.
 *
 * Cảnh báo được trả về chứ không tự in: hàm này còn được script dùng, và một
 * script cần in theo cách của nó. Dòng nào bỏ được đều được đếm — dán mười proxy
 * mà chỉ nhận ba thì đó là điều chủ bot phải biết ngay, không phải phát hiện ra
 * sau ba tuần thấy hay bị chặn.
 */
export function buildSpigotProxyPool(config: ProxyPoolConfig): { pool: SpigotProxyPool; warnings: string[] } {
  const warnings: string[] = [];
  const endpoints: ProxyEndpoint[] = [];
  const seen = new Set<string>();

  const absorb = (raw: string, origin: string): void => {
    // Bỏ dòng chú thích TRƯỚC khi tách token: một dòng "# ghi chú" tách theo khoảng
    // trắng sẽ thành ba token và bị đếm thành ba dòng lỗi.
    const tokens = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .split(/[\s,]+/)
      .filter((token) => token.trim() !== '');

    let rejected = 0;
    for (const token of tokens) {
      const endpoint = parseProxyEndpoint(token);
      if (!endpoint) {
        rejected++;
        continue;
      }
      // Trùng thì bỏ im lặng — đó không phải dòng sai, chỉ là dán hai lần.
      if (seen.has(endpoint.id)) continue;
      seen.add(endpoint.id);
      endpoints.push(endpoint);
    }
    if (rejected > 0) {
      warnings.push(`${origin}: bỏ ${rejected} dòng không đúng dạng (host:port, kèm user:pass nếu có)`);
    }
  };

  if (config.list) absorb(config.list, 'SPIGOT_PROXY_LIST');

  if (config.file) {
    const read = config.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    try {
      absorb(read(config.file), config.file);
      // Tệp này chứa tên và mật khẩu của gói proxy trả tiền, đúng loại bí mật mà
      // tệp tài khoản Spigot được cảnh báo về quyền — nên cảnh báo giống nhau, chứ
      // không để một loại được kiểm còn loại kia thì không.
      const permission = config.checkPermissions ?? proxyFilePermissionWarning;
      const warning = permission(config.file);
      if (warning) warnings.push(warning);
    } catch {
      // Tệp thiếu không được làm sập tiến trình: tính năng proxy là tuỳ chọn, và
      // chạy thẳng vẫn tốt hơn là không khởi động được bot.
      warnings.push(`không đọc được tệp proxy ${config.file} — bỏ qua`);
    }
  }

  const options: ProxyPoolOptions = { endpoints };
  if (config.apiUrl) options.apiUrl = config.apiUrl;
  if (config.renewUrl) {
    options.renewUrl = config.renewUrl;
  } else if (config.apiUrl && config.apiUrl.includes('get-current-proxy')) {
    options.renewUrl = config.apiUrl.replace('get-current-proxy', 'get-new-proxy');
  }
  if (config.cooldownMs !== undefined) options.cooldownMs = config.cooldownMs;
  if (config.maxCooldownMs !== undefined) options.maxCooldownMs = config.maxCooldownMs;
  if (config.fetchImpl) options.fetchImpl = config.fetchImpl;
  if (config.now) options.now = config.now;

  return { pool: new SpigotProxyPool(options), warnings };
}
