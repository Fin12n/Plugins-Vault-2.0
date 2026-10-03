/** Typed fetch wrapper. Cookies carry the session, so credentials must be sent. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Phiên đã hết hạn.
 *
 * Phát ra một sự kiện thay vì để từng trang tự xử: cookie phiên sống 12 giờ, nên một
 * dashboard mở qua đêm sáng ra sẽ nhận 401 ở MỌI trang, và trước đây mỗi trang chỉ in
 * một dòng đỏ "Chưa đăng nhập" — người dùng phải tự đoán rằng cần tải lại trang. Vỏ
 * ứng dụng nghe sự kiện này và hiện lại màn hình đăng nhập.
 */
export const SESSION_EXPIRED_EVENT = 'vault:session-expired';

/**
 * Thời gian chờ tối đa cho một request.
 *
 * Có hạn vì một request treo và một request chậm trông giống nhau trên giao diện:
 * không có hạn thì chữ "Đang tải..." nằm đó vĩnh viễn và không ai biết là mạng chết.
 * 20 giây đủ rộng cho máy chủ nhỏ đang quét, đủ ngắn để người dùng không chờ vô vọng.
 */
const TIMEOUT_MS = 20_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Lỗi mạng và quá hạn KHÔNG được lẫn với lỗi máy chủ: câu trả lời cho người dùng
    // khác nhau hoàn toàn ("kiểm tra mạng" so với "máy chủ đang lỗi").
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ApiError(0, timedOut ? 'Máy chủ không trả lời sau 20 giây' : 'Không kết nối được tới máy chủ');
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Non-JSON error body; use the raw text.
    }
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      throw new ApiError(401, 'Phiên đã hết hạn — hãy đăng nhập lại');
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),

  /**
   * Uploads jars as multipart, reporting real progress.
   *
   * XMLHttpRequest chứ không fetch: fetch không có sự kiện tiến trình khi GỬI, nên một
   * lô 200 MB trên đường lên chậm hiện ra y như một trang bị treo — người dùng chờ vài
   * phút không biết còn sống hay không rồi thả lại lần nữa.
   *
   * Không đặt thời gian chờ: một lô lớn có thể mất nhiều phút, và huỷ giữa đường là
   * mất công tải lại từ đầu.
   */
  upload(files: File[], onProgress?: (sentBytes: number, totalBytes: number) => void): Promise<UploadResponse> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);

    return new Promise<UploadResponse>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/upload');
      request.withCredentials = true;

      if (onProgress) {
        request.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) onProgress(event.loaded, event.total);
        });
      }

      request.addEventListener('error', () => reject(new ApiError(0, 'Mất kết nối khi đang tải lên')));
      request.addEventListener('abort', () => reject(new ApiError(0, 'Đã huỷ tải lên')));

      request.addEventListener('load', () => {
        if (request.status === 401) {
          window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
          reject(new ApiError(401, 'Phiên đã hết hạn — hãy đăng nhập lại'));
          return;
        }

        // Reverse proxy trả trang HTML cho 413/502, và JSON.parse trên đó ném ra một
        // câu lỗi cú pháp tiếng Anh — thứ vô nghĩa với người đang tải tệp lên.
        let json: (UploadResponse & { error?: string }) | null = null;
        try {
          json = JSON.parse(request.responseText) as UploadResponse & { error?: string };
        } catch {
          reject(
            new ApiError(
              request.status,
              request.status === 413
                ? 'Tệp quá lớn — máy chủ hoặc proxy từ chối'
                : `Máy chủ trả về phản hồi không đọc được (HTTP ${request.status})`,
            ),
          );
          return;
        }

        const ok = request.status >= 200 && request.status < 300;
        if (!ok && !json.results) {
          reject(new ApiError(request.status, json.error ?? 'Tải lên thất bại'));
          return;
        }
        resolve(json);
      });

      request.send(form);
    });
  },
};

export type IngestResultView =
  | { status: 'added'; originalName: string; pluginName: string; version: string | null; versionFlag: string; createdPlugin: boolean }
  | { status: 'duplicate'; originalName: string; existingPluginName: string; existingVersion: string | null }
  | { status: 'pending'; originalName: string; reason: string; detail: string; pendingId: number }
  | { status: 'failed'; originalName: string; code: string; detail: string };

export type UploadResponse = {
  results: IngestResultView[];
  summary: { added: number; duplicate: number; pending: number; failed: number };
};

export type PluginView = {
  id: number;
  slug: string;
  displayName: string;
  descriptorName: string;
  platform: string;
  resourceId: number | null;
  depositPrice: number;
  isPremium: boolean;
  description?: string;
  externalLink?: string;
  aliases: string[];
  versionCount: number;
};

export type VersionView = {
  id: number;
  version: string | null;
  rawVersion: string | null;
  bytes: number;
  originalName: string;
  isStable: boolean;
  versionFlag: string;
  uploadedAt: number;
};

export type PendingView = {
  id: number;
  originalFilename: string;
  bytes: number;
  reason: string;
  detail: string;
  createdAt: number;
};

export type OrderView = {
  id: number;
  code: string;
  discordUserId: string;
  versionId: number | null;
  pluginName: string;
  versionLabel: string;
  amount: number;
  /** Coins held for this order, already deducted from the wallet. */
  walletPaid: number;
  /** Still owed by transfer. */
  bankDue: number;
  status: string;
  paidAmount: number | null;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
  deliveredAt: number | null;
};

export type DiscordUserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type AuditView = {
  id: number;
  discordUserId: string;
  userProfile?: DiscordUserProfile;
  pluginName: string;
  versionLabel: string;
  amount: number;
  deliveryMethod: string;
  deliveredAt: number;
};

export type Paginated<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };

export type StatsView = {
  month: string;
  totalDownloads: number;
  totalAmount: number;
  perPlugin: { pluginName: string; downloads: number; amount: number }[];
  perUser: {
    discordUserId: string;
    userProfile?: DiscordUserProfile;
    downloads: number;
    amount: number;
  }[];
};

export type SettingsView = {
  adminRoleIds: string[];
  pruneKeepCount: number;
  attachMaxBytes: number;
  orderTtlMinutes: number;
  downloadTokenTtlMinutes: number;
  autoDownloadEnabled: boolean;
};

/**
 * Spigot account health. A separate shape from SettingsView on purpose: cookie
 * values must not be reachable through the settings payload, so this carries
 * labels only.
 */
export type SpigotAccountsView = {
  configured: boolean;
  reason?: 'missing' | 'malformed';
  accounts: SpigotAccountView[];
};

export type OwnedPluginSummary = {
  id: number;
  slug: string;
  displayName: string;
  resourceId: number;
  state: 'owned' | 'not_owned';
  checkedAt: number;
};

export type SpigotAccountView = {
  label: string;
  username: string;
  enabled: boolean;
  purchasedResources: string[];
  importedStatus: string;
  exclusionReason: string;
  liveScan: SpigotLiveScanView;
  ownedPlugins?: OwnedPluginSummary[];
};

export type SpigotOwnershipOverview = {
  ok: boolean;
  accounts: {
    label: string;
    username: string;
    enabled: boolean;
    purchasedCount: number;
    ownedPlugins: OwnedPluginSummary[];
  }[];
  unassignedPlugins: {
    id: number;
    slug: string;
    displayName: string;
    resourceId: number;
  }[];
  allPlugins: {
    id: number;
    slug: string;
    displayName: string;
    resourceId: number;
  }[];
};

export type SpigotLiveScanView =
  | { status: 'never'; lastScanAt: null; resourceCount: null; error: null }
  | { status: 'ok'; lastScanAt: number; resourceCount: number; error: null }
  | { status: 'error'; lastScanAt: number; resourceCount: number; error: string };

export type SpigotCredentialPreviewAccount = Omit<SpigotAccountView, 'liveScan'>;

export type SpigotCredentialPreview = {
  ok: true;
  accounts: SpigotCredentialPreviewAccount[];
  summary: { total: number; enabled: number; excluded: number; resources: number };
};

export type SpigotRunStatus = {
  running: boolean;
  currentOperation?: 'idle' | 'scanning' | 'downloading';
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
};

export type SweepLogLevel = 'info' | 'success' | 'warn' | 'error';

export type SweepLogEntry = {
  id: number;
  timestamp: number;
  level: SweepLogLevel;
  message: string;
};

export type SweepLogsResponse = SpigotRunStatus & {
  proxyEnabled?: boolean;
  currentProxyIp?: string | null;
  activeWorkers?: number[];
  logs: SweepLogEntry[];
};

export type WorkerStatus =
  | 'idle'
  | 'starting'
  | 'logging_in'
  | 'navigating'
  | 'downloading'
  | 'solving_challenge'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'stalled';

export type InstanceWorkerState = {
  id: number;
  status: WorkerStatus;
  accountLabel: string | null;
  proxy: string | null;
  pluginName: string | null;
  versionName: string | null;
  progressText: string;
  bytesDownloaded: number;
  startedAt: number | null;
  updatedAt: number;
  lastHeartbeatAt?: number;
  taskStartedAt?: number | null;
  lastError?: string | null;
  isStalled?: boolean;
  successCount: number;
  failCount: number;
};

export type InstancesResponse = {
  concurrency: number;
  activeWorkers: number;
  instances: InstanceWorkerState[];
};

export type SpigotChallengeStatus = {
  active: boolean;
  accountLabel: string | null;
  reason: string | null;
  startedAt: number | null;
  expiresAt: number | null;
};

export type WalletView = {
  discordUserId: string;
  /** VND, not coins. */
  balance: number;
  createdAt: number;
  updatedAt: number;
};

/** A wallet whose stored balance disagrees with its ledger. Always expected empty. */
export type BalanceDriftView = { discordUserId: string; balance: number; ledgerSum: number };

export type LedgerView = {
  id: number;
  discordUserId: string;
  delta: number;
  balanceAfter: number;
  kind: string;
  refType: string;
  refId: number | null;
  note: string;
  createdAt: number;
};

export type CardTopupView = {
  id: number;
  discordUserId: string;
  telco: string;
  serial: string;
  declaredValue: number;
  actualValue: number | null;
  netAmount: number | null;
  status: string;
  providerStatus: number | null;
  providerMessage: string;
  attempts: number;
  creditedAt: number | null;
  createdAt: number;
};

/** What was credited versus what card2k paid — the fee the owner absorbs. */
export type CardCostView = { credited: number; received: number; cost: number };

export type SessionUser = {
  userId?: string;
  role: 'owner' | 'staff';
  username?: string;
  displayName: string;
  avatar?: string | null;
  authMethod: 'password' | 'discord';
};

export type SessionResponse = {
  ok: boolean;
  user: SessionUser;
};

export type StaffItem = {
  discordUserId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  addedBy: string;
  createdAt: number;
};

export type StaffListResponse = {
  ownerId: string;
  items: StaffItem[];
};
