import type { Database } from '../../db/neon.js';
import type { Plugin, Version } from '@vault/db';
import {
  findPluginById,
  listEligiblePluginsForScan,
  updatePluginScanResult,
} from '../../repositories/neon-plugins.js';
import {
  findVersionByNormalized,
  getOrCreatePluginVersion,
} from '../../repositories/neon-versions.js';
import { normalizePluginVersion } from './version-normalizer.js';
import {
  type PluginSourceAdapter,
  type RemoteVersionMetadata,
  SourceAdapterError,
} from './source-adapter.js';
import { SpigetPluginSourceAdapter } from './spiget-source-adapter.js';

/**
 * Phase 5B: Canonical Plugin Scanner Service
 *
 * Nhiệm vụ duy nhất:
 * Plugin Registry -> Scheduler -> Source Adapter (Spiget) -> Remote Version Detection
 * -> Compare -> Create missing Plugin Version -> Update scan metadata.
 *
 * RANH GIỚI BẤT BIẾN:
 * 1. Scanner CHỈ PHÁT HIỆN và đăng ký danh tính Plugin Version canonical.
 * 2. Scanner TUYỆT ĐỐI KHÔNG tải xuống artifact (không tạo/sửa đổi plugin_artifacts).
 * 3. Scanner TUYỆT ĐỐI KHÔNG cấp entitlement cho người dùng.
 * 4. Scanner TUYỆT ĐỐI KHÔNG sửa đổi đơn hàng/giao dịch tài chính (orders/purchases).
 * 5. Scanner TUYỆT ĐỐI KHÔNG xóa dữ liệu lịch sử khi nguồn ngoài 404 hoặc version biến mất.
 */

export type ScannerOptions = {
  maxConcurrentScans?: number;
  scanIntervalSeconds?: number;
  jitterMaxSeconds?: number;
  cooldownOnRateLimitMs?: number;
};

export type SingleScanResult = {
  status:
    | 'SUCCESS'
    | 'SKIPPED_ALREADY_RUNNING'
    | 'DISABLED'
    | 'NO_SOURCE_IDENTITY'
    | 'NOT_FOUND'
    | 'RATE_LIMITED'
    | 'INVALID_RESPONSE'
    | 'FAILED';
  pluginId: number;
  remoteVersion?: string;
  versionNormalized?: string;
  isNewVersion?: boolean;
  versionId?: number;
  error?: string;
  durationMs?: number;
};

export type SweepSummary = {
  totalEligible: number;
  scanned: number;
  successful: number;
  newVersionsFound: number;
  failed: number;
  rateLimited: number;
  skipped: number;
  results: SingleScanResult[];
};

export class PluginScannerService {
  private readonly maxConcurrentScans: number;
  private readonly defaultScanIntervalSeconds: number;
  private readonly jitterMaxSeconds: number;
  private readonly cooldownOnRateLimitMs: number;
  private readonly adapters = new Map<string, PluginSourceAdapter>();

  // Mutex per-plugin: cùng 1 plugin chỉ có tối đa 1 tiến trình scan hoạt động
  private readonly activeScans = new Set<number>();

  constructor(options: ScannerOptions = {}, defaultAdapter?: PluginSourceAdapter) {
    this.maxConcurrentScans = Math.max(options.maxConcurrentScans ?? 5, 1);
    this.defaultScanIntervalSeconds = options.scanIntervalSeconds ?? 3600;
    this.jitterMaxSeconds = options.jitterMaxSeconds ?? 60;
    this.cooldownOnRateLimitMs = options.cooldownOnRateLimitMs ?? 30_000;

    // Đăng ký Spiget adapter mặc định
    const spiget = defaultAdapter ?? new SpigetPluginSourceAdapter();
    this.registerAdapter(spiget);
  }

  public registerAdapter(adapter: PluginSourceAdapter): void {
    this.adapters.set(adapter.platform.toLowerCase(), adapter);
  }

  public isScanning(pluginId: number): boolean {
    return this.activeScans.has(pluginId);
  }

  public getActiveScanCount(): number {
    return this.activeScans.size;
  }

  /**
   * Tính toán thời điểm quét tiếp theo dựa trên chu kỳ và bounded jitter.
   * Luôn tính từ thời điểm hiện tại (now) để tránh hiệu ứng dồn toa (runaway catch-up).
   */
  public calculateNextScanAt(intervalSeconds?: number, pluginId?: number): Date {
    const sec = intervalSeconds && intervalSeconds > 0 ? intervalSeconds : this.defaultScanIntervalSeconds;
    const baseMs = Math.max(sec, 60) * 1000;

    let jitterMs = 0;
    if (this.jitterMaxSeconds > 0) {
      if (pluginId !== undefined) {
        // Jitter tất định dựa trên pluginId để test ổn định và phân bổ đều
        jitterMs = (Math.abs(pluginId * 17) % this.jitterMaxSeconds) * 1000;
      } else {
        jitterMs = Math.floor(Math.random() * this.jitterMaxSeconds * 1000);
      }
    }

    return new Date(Date.now() + baseMs + jitterMs);
  }

  /**
   * Thực hiện quét một plugin cụ thể.
   * Đảm bảo tính tuần tự hóa (serialization) cho cùng một plugin và cô lập lỗi hoàn toàn.
   */
  public async scanPlugin(db: Database, pluginId: number): Promise<SingleScanResult> {
    // 1. Kiểm tra khóa Mutex cùng plugin
    if (this.activeScans.has(pluginId)) {
      return {
        status: 'SKIPPED_ALREADY_RUNNING',
        pluginId,
      };
    }

    this.activeScans.add(pluginId);
    const startMs = Date.now();

    try {
      // 2. Đọc thông tin Plugin từ DB
      const plugin = await findPluginById(db, pluginId);
      if (!plugin) {
        return {
          status: 'FAILED',
          pluginId,
          error: `Plugin ID ${pluginId} không tồn tại`,
          durationMs: Date.now() - startMs,
        };
      }

      // 3. Kiểm tra cờ kích hoạt (enabled)
      if (!plugin.enabled) {
        // Plugin bị tắt -> Tuyệt đối không gọi mạng
        return {
          status: 'DISABLED',
          pluginId,
          durationMs: Date.now() - startMs,
        };
      }

      // 4. Kiểm tra nguồn nhận diện ngoài (platform + resourceId)
      if (!plugin.platform || !plugin.resourceId) {
        return {
          status: 'NO_SOURCE_IDENTITY',
          pluginId,
          error: `Plugin thiếu platform hoặc resourceId`,
          durationMs: Date.now() - startMs,
        };
      }

      // 5. Chọn adapter phù hợp
      const platformKey = plugin.platform.toLowerCase();
      const adapter = this.adapters.get(platformKey);
      if (!adapter) {
        const err = `Không tìm thấy adapter cho platform: ${plugin.platform}`;
        await updatePluginScanResult(db, pluginId, {
          lastScanAt: new Date(),
          lastScanStatus: 'FAILED',
          lastScanError: err,
          nextScanAt: this.calculateNextScanAt(plugin.scanIntervalSeconds, pluginId),
        });

        return {
          status: 'FAILED',
          pluginId,
          error: err,
          durationMs: Date.now() - startMs,
        };
      }

      // 6. Truy vấn metadata từ xa qua Adapter
      let remoteMetadata: RemoteVersionMetadata | null = null;
      try {
        remoteMetadata = await adapter.getLatestVersion({
          platform: plugin.platform,
          resourceId: plugin.resourceId,
        });
      } catch (adapterErr) {
        return await this.handleScanError(db, plugin, adapterErr, startMs);
      }

      // 7. Xử lý trường hợp 404 (Không tìm thấy trên nguồn từ xa)
      if (remoteMetadata === null) {
        // Ghi nhận trạng thái NOT_FOUND, KHÔNG xóa dữ liệu lịch sử
        const nextScanAt = this.calculateNextScanAt(plugin.scanIntervalSeconds, pluginId);
        await updatePluginScanResult(db, pluginId, {
          lastScanAt: new Date(),
          lastScanStatus: 'NOT_FOUND',
          lastScanError: 'Không tìm thấy tài nguyên hoặc phiên bản trên nguồn từ xa (HTTP 404)',
          nextScanAt,
        });

        return {
          status: 'NOT_FOUND',
          pluginId,
          durationMs: Date.now() - startMs,
        };
      }

      // 8. Chuẩn hóa version và đối soát với DB
      const rawVersion = remoteMetadata.rawVersion;
      const versionNormalized = remoteMetadata.versionNormalized || normalizePluginVersion(rawVersion);

      if (!versionNormalized) {
        const err = 'Chuỗi phiên bản từ xa rỗng sau khi chuẩn hóa';
        await updatePluginScanResult(db, pluginId, {
          lastScanAt: new Date(),
          lastScanStatus: 'INVALID_RESPONSE',
          lastScanError: err,
          nextScanAt: this.calculateNextScanAt(plugin.scanIntervalSeconds, pluginId),
        });

        return {
          status: 'INVALID_RESPONSE',
          pluginId,
          error: err,
          durationMs: Date.now() - startMs,
        };
      }

      // 9. Kiểm tra xem phiên bản canonical đã tồn tại chưa (Idempotency)
      const existing = await findVersionByNormalized(db, plugin.id, versionNormalized);
      let versionRecord: Version;
      let isNewVersion = false;

      if (existing) {
        // Đã tồn tại -> Tái sử dụng, không tạo trùng lặp
        versionRecord = existing;
      } else {
        // Chưa tồn tại -> Chèn bản ghi canonical Plugin Version mới!
        // CHỈ tạo version identity, TUYỆT ĐỐI KHÔNG tạo artifact hoặc entitlement
        versionRecord = await getOrCreatePluginVersion(db, {
          pluginId: plugin.id,
          version: rawVersion,
          rawVersion,
          versionNormalized,
          sourceVersionId: remoteMetadata.sourceVersionId,
          sourceReleaseId: remoteMetadata.sourceReleaseId,
          releasedAt: remoteMetadata.releasedAt,
          metadata: remoteMetadata.metadata,
          status: 'active',
          isStable: true,
          // Placeholder an toàn cho schema cũ để không vi phạm NOT NULL
          sha256: `discovered:${plugin.id}:${versionNormalized}`,
          relPath: `discovered/${plugin.id}/${versionNormalized}.jar`,
          bytes: 0,
          originalName: `${versionNormalized}.jar`,
          descriptorKind: plugin.platform,
        });
        isNewVersion = true;
      }

      // 10. Cập nhật scan metadata và thời điểm quét kế tiếp
      const nextScanAt = this.calculateNextScanAt(plugin.scanIntervalSeconds, pluginId);
      await updatePluginScanResult(db, pluginId, {
        lastScanAt: new Date(),
        lastScanStatus: 'SUCCESS',
        lastScanError: null,
        nextScanAt,
      });

      return {
        status: 'SUCCESS',
        pluginId,
        remoteVersion: rawVersion,
        versionNormalized,
        isNewVersion,
        versionId: versionRecord.id,
        durationMs: Date.now() - startMs,
      };
    } finally {
      this.activeScans.delete(pluginId);
    }
  }

  /**
   * Quét toàn bộ danh sách các plugin đủ điều kiện với cơ chế Bounded Concurrency.
   */
  public async scanEligiblePlugins(db: Database, limit = 50): Promise<SweepSummary> {
    const eligible = await listEligiblePluginsForScan(db, new Date(), limit);

    const summary: SweepSummary = {
      totalEligible: eligible.length,
      scanned: 0,
      successful: 0,
      newVersionsFound: 0,
      failed: 0,
      rateLimited: 0,
      skipped: 0,
      results: [],
    };

    if (eligible.length === 0) {
      return summary;
    }

    // Bounded concurrency pool: chạy song song tối đa maxConcurrentScans tác vụ
    const pool = new Set<Promise<void>>();

    for (const plugin of eligible) {
      const task = (async () => {
        const res = await this.scanPlugin(db, plugin.id);
        summary.results.push(res);
        summary.scanned++;

        if (res.status === 'SUCCESS') {
          summary.successful++;
          if (res.isNewVersion) summary.newVersionsFound++;
        } else if (res.status === 'SKIPPED_ALREADY_RUNNING') {
          summary.skipped++;
        } else if (res.status === 'RATE_LIMITED') {
          summary.rateLimited++;
        } else {
          summary.failed++;
        }
      })();

      pool.add(task);
      task.finally(() => pool.delete(task));

      if (pool.size >= this.maxConcurrentScans) {
        await Promise.race(pool);
      }
    }

    // Đợi các tác vụ còn lại hoàn tất
    await Promise.all(pool);
    return summary;
  }

  /**
   * Xử lý lỗi scan có phân loại an toàn.
   */
  private async handleScanError(
    db: Database,
    plugin: Plugin,
    error: unknown,
    startMs: number,
  ): Promise<SingleScanResult> {
    let status: SingleScanResult['status'] = 'FAILED';
    let nextScanAt = this.calculateNextScanAt(plugin.scanIntervalSeconds, plugin.id);
    let errorMessage = 'Lỗi không xác định khi quét phiên bản';

    if (error instanceof SourceAdapterError) {
      errorMessage = error.message;

      if (error.classification === 'RATE_LIMITED') {
        status = 'RATE_LIMITED';
        const cooldown = error.retryAfterMs ?? this.cooldownOnRateLimitMs;
        nextScanAt = new Date(Date.now() + cooldown);
      } else if (error.classification === 'INVALID_RESPONSE') {
        status = 'INVALID_RESPONSE';
      } else {
        status = 'FAILED';
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    // Cắt ngắn thông báo lỗi để tránh phình dữ liệu DB
    const sanitizedError = errorMessage.slice(0, 500);

    await updatePluginScanResult(db, plugin.id, {
      lastScanAt: new Date(),
      lastScanStatus: status,
      lastScanError: sanitizedError,
      nextScanAt,
    });

    return {
      status,
      pluginId: plugin.id,
      error: sanitizedError,
      durationMs: Date.now() - startMs,
    };
  }
}
