/**
 * Phase 5B: Plugin Source Adapter Abstraction
 *
 * Định nghĩa ranh giới trừu tượng cho việc tương tác với các nguồn metadata phiên bản từ xa
 * (Spiget, Hangar, Modrinth, v.v.). Toàn bộ chi tiết HTTP và định dạng nguồn được cô lập bên trong Adapter.
 */

export type SourceErrorClass =
  | 'TRANSIENT'
  | 'PERMANENT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class SourceAdapterError extends Error {
  public readonly classification: SourceErrorClass;
  public readonly statusCode?: number;
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    classification: SourceErrorClass,
    options?: { statusCode?: number; retryAfterMs?: number; cause?: unknown }
  ) {
    super(message);
    this.name = 'SourceAdapterError';
    this.classification = classification;
    this.statusCode = options?.statusCode;
    this.retryAfterMs = options?.retryAfterMs;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  public isRetryable(): boolean {
    return this.classification === 'TRANSIENT' || this.classification === 'RATE_LIMITED' || this.classification === 'TIMEOUT' || this.classification === 'NETWORK_ERROR';
  }
}

export type RemoteVersionMetadata = {
  /** Nguồn bên ngoài (ví dụ 'spigot') */
  source: string;
  /** ID tài nguyên trên nguồn ngoài (ví dụ 12345) */
  sourceResourceId: number;
  /** ID phiên bản trên nguồn ngoài (ví dụ UUID hoặc version ID số) */
  sourceVersionId: string;
  /** ID đợt phát hành nếu có */
  sourceReleaseId?: string;
  /** Chuỗi version nguyên bản (ví dụ "v1.20.4-RELEASE") */
  rawVersion: string;
  /** Chuỗi version đã chuẩn hóa loại bỏ tiền tố thừa (ví dụ "1.20.4-RELEASE") */
  versionNormalized: string;
  /** Thời điểm phát hành của phiên bản */
  releasedAt: Date;
  /** Số lượt tải (nếu nguồn cung cấp) */
  downloads?: number;
  /** Metadata JSON mở rộng được khử khuẩn (sanitized) */
  metadata: Record<string, unknown>;
};

export type PluginSourceIdentity = {
  platform: string;
  resourceId: number;
};

export interface PluginSourceAdapter {
  readonly platform: string;

  /**
   * Truy vấn thông tin phiên bản mới nhất của plugin từ nguồn từ xa.
   * Trả về null nếu không tìm thấy (404) hoặc tài nguyên không có phiên bản nào.
   */
  getLatestVersion(
    identity: PluginSourceIdentity,
  ): Promise<RemoteVersionMetadata | null>;

  /**
   * Lấy danh sách các phiên bản đã phát hành từ xa (tùy chọn).
   */
  listVersions?(
    identity: PluginSourceIdentity,
    limit?: number,
  ): Promise<RemoteVersionMetadata[]>;
}
