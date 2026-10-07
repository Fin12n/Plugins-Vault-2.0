import { normalizePluginVersion } from './version-normalizer.js';
import {
  type PluginSourceAdapter,
  type PluginSourceIdentity,
  type RemoteVersionMetadata,
  SourceAdapterError,
} from './source-adapter.js';

export type SpigetAdapterOptions = {
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
};

type RawSpigetVersionResponse = {
  uuid?: string;
  id?: number;
  name?: string;
  releaseDate?: number;
  downloads?: number;
  rating?: {
    count?: number;
    average?: number;
  };
  [key: string]: unknown;
};

export class SpigetPluginSourceAdapter implements PluginSourceAdapter {
  public readonly platform = 'spigot';

  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SpigetAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.spiget.org/v2').replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? 'plugin-vault-bot/2.0 (registry-scanner)';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Lấy phiên bản mới nhất của plugin từ Spiget.
   * Sử dụng endpoint chính xác: /resources/{id}/versions/latest
   */
  public async getLatestVersion(
    identity: PluginSourceIdentity,
  ): Promise<RemoteVersionMetadata | null> {
    if (!identity.resourceId || identity.resourceId <= 0) {
      throw new SourceAdapterError(
        `Invalid source resource ID: ${identity.resourceId}`,
        'PERMANENT',
        { statusCode: 400 },
      );
    }

    const path = `/resources/${identity.resourceId}/versions/latest`;
    const data = await this.executeWithRetry<RawSpigetVersionResponse>(path);
    if (!data) {
      return null; // 404 Not Found từ Spiget
    }

    return this.validateAndTransform(data, identity.resourceId);
  }

  /**
   * Lấy danh sách các phiên bản đã phát hành từ Spiget (mới nhất xếp trước).
   */
  public async listVersions(
    identity: PluginSourceIdentity,
    limit = 20,
  ): Promise<RemoteVersionMetadata[]> {
    if (!identity.resourceId || identity.resourceId <= 0) {
      throw new SourceAdapterError(
        `Invalid source resource ID: ${identity.resourceId}`,
        'PERMANENT',
        { statusCode: 400 },
      );
    }

    const path = `/resources/${identity.resourceId}/versions?size=${limit}&sort=-releaseDate`;
    const list = await this.executeWithRetry<RawSpigetVersionResponse[]>(path);
    if (!list || !Array.isArray(list)) {
      return [];
    }

    const results: RemoteVersionMetadata[] = [];
    for (const item of list) {
      try {
        results.push(this.validateAndTransform(item, identity.resourceId));
      } catch (err) {
        // Bỏ qua từng bản ghi lỗi cục bộ trong danh sách
        continue;
      }
    }
    return results;
  }

  /**
   * Xác thực cấu trúc dữ liệu trả về từ Spiget API và chuẩn hóa thành RemoteVersionMetadata.
   */
  private validateAndTransform(
    raw: RawSpigetVersionResponse,
    resourceId: number,
  ): RemoteVersionMetadata {
    if (!raw || typeof raw !== 'object') {
      throw new SourceAdapterError(
        'Phản hồi từ Spiget không phải đối tượng JSON hợp lệ',
        'INVALID_RESPONSE',
      );
    }

    // 1. Kiểm tra trường version name bắt buộc
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new SourceAdapterError(
        'Phản hồi từ Spiget thiếu trường "name" của phiên bản',
        'INVALID_RESPONSE',
      );
    }

    // 2. Kiểm tra trường releaseDate bắt buộc (UNIX timestamp theo giây)
    if (typeof raw.releaseDate !== 'number' || isNaN(raw.releaseDate) || raw.releaseDate <= 0) {
      throw new SourceAdapterError(
        'Phản hồi từ Spiget thiếu hoặc sai định dạng trường "releaseDate"',
        'INVALID_RESPONSE',
      );
    }

    // 3. Trích xuất ID ổn định của version (uuid hoặc id)
    const sourceVersionId =
      typeof raw.uuid === 'string' && raw.uuid.trim() !== ''
        ? raw.uuid.trim()
        : typeof raw.id === 'number'
          ? String(raw.id)
          : '';

    if (!sourceVersionId) {
      throw new SourceAdapterError(
        'Phản hồi từ Spiget không có định danh phiên bản hợp lệ (cả "uuid" và "id" đều trống)',
        'INVALID_RESPONSE',
      );
    }

    const rawVersion = raw.name.trim();
    const versionNormalized = normalizePluginVersion(rawVersion);

    // 4. Khử khuẩn và giới hạn metadata đính kèm
    const sanitizedMetadata: Record<string, unknown> = {
      spigetVersionId: raw.id,
      spigetUuid: raw.uuid,
      downloads: typeof raw.downloads === 'number' ? raw.downloads : 0,
      rating: raw.rating ?? null,
    };

    return {
      source: 'spigot',
      sourceResourceId: resourceId,
      sourceVersionId,
      sourceReleaseId: raw.id !== undefined ? String(raw.id) : undefined,
      rawVersion,
      versionNormalized,
      releasedAt: new Date(raw.releaseDate * 1000),
      downloads: typeof raw.downloads === 'number' ? raw.downloads : 0,
      metadata: sanitizedMetadata,
    };
  }

  /**
   * Thực hiện yêu cầu HTTP kèm quản lý Timeout, Phân loại lỗi và Retry theo lũy thừa.
   */
  private async executeWithRetry<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // 404: Resource hoặc version không tồn tại trên Spiget
        if (response.status === 404) {
          return null;
        }

        // 429: Bị giới hạn tần suất (Rate Limited)
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfterMs = parseRetryAfter(retryAfterHeader);
          const err = new SourceAdapterError(
            `Spiget API giới hạn tần suất (HTTP 429 Rate Limited)`,
            'RATE_LIMITED',
            { statusCode: 429, retryAfterMs },
          );

          if (attempt < this.maxRetries) {
            const waitMs = Math.min(
              retryAfterMs ?? this.calculateBackoff(attempt),
              this.maxDelayMs,
            );
            await delay(waitMs);
            continue;
          }
          throw err;
        }

        // 5xx / 408: Lỗi máy chủ tạm thời (Transient Server Error)
        if (response.status === 408 || response.status >= 500) {
          const err = new SourceAdapterError(
            `Spiget API gặp sự cố tạm thời (HTTP ${response.status})`,
            'TRANSIENT',
            { statusCode: response.status },
          );

          if (attempt < this.maxRetries) {
            await delay(this.calculateBackoff(attempt));
            continue;
          }
          throw err;
        }

        // 4xx khác (400, 401, 403): Lỗi vĩnh viễn không thể retry
        if (!response.ok) {
          throw new SourceAdapterError(
            `Spiget API từ chối yêu cầu (HTTP ${response.status})`,
            'PERMANENT',
            { statusCode: response.status },
          );
        }

        // Đọc nội dung phản hồi JSON
        try {
          const json = await response.json();
          return json as T;
        } catch (parseErr) {
          throw new SourceAdapterError(
            'Không thể phân tích phản hồi JSON từ Spiget API (Malformed JSON)',
            'INVALID_RESPONSE',
            { cause: parseErr },
          );
        }
      } catch (err: unknown) {
        if (err instanceof SourceAdapterError) {
          if (!err.isRetryable() || attempt >= this.maxRetries) {
            throw err;
          }
          await delay(this.calculateBackoff(attempt));
          continue;
        }

        // Xử lý Timeout (AbortSignal.timeout hoặc DOMException TimeoutError)
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('timeout'));

        if (isTimeout) {
          const timeoutErr = new SourceAdapterError(
            `Hết thời gian chờ yêu cầu tới Spiget (${this.timeoutMs}ms)`,
            'TIMEOUT',
            { cause: err },
          );
          if (attempt < this.maxRetries) {
            await delay(this.calculateBackoff(attempt));
            continue;
          }
          throw timeoutErr;
        }

        // Xử lý lỗi kết nối mạng (Network failure / Reset)
        const networkErr = new SourceAdapterError(
          `Lỗi kết nối mạng tới Spiget API: ${err instanceof Error ? err.message : String(err)}`,
          'NETWORK_ERROR',
          { cause: err },
        );

        if (attempt < this.maxRetries) {
          await delay(this.calculateBackoff(attempt));
          continue;
        }
        throw networkErr;
      }
    }

    return null;
  }

  /**
   * Tính toán thời gian chờ theo hàm mũ kèm jitter ngẫu nhiên để chống cộng hưởng.
   */
  private calculateBackoff(attempt: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * (this.baseDelayMs / 2));
    return Math.min(exponential + jitter, this.maxDelayMs);
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  // Số giây nguyên
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  // Định dạng HTTP Date
  const parsedDate = Date.parse(header);
  if (!isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 1000;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
