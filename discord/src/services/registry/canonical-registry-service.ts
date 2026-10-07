import type { Database } from '../../db/neon.js';
import type {
  Plugin,
  NewPlugin,
  Version,
  NewVersion,
  PluginArtifact,
  NewPluginArtifact,
  PluginEntitlement,
  ArtifactStatus,
  EntitlementStatus,
} from '@vault/db';
import {
  getOrCreatePlugin as repoGetOrCreatePlugin,
  findPluginById,
  findPluginBySlug,
  findPluginBySourceIdentity,
} from '../../repositories/neon-plugins.js';
import {
  getOrCreatePluginVersion as repoGetOrCreatePluginVersion,
  findVersionById,
  findVersionByNormalized,
} from '../../repositories/neon-versions.js';
import {
  getOrCreateArtifact as repoGetOrCreateArtifact,
  findCanonicalArtifactByVersionId,
  updateArtifactStatus as repoUpdateArtifactStatus,
  isArtifactUsable,
} from '../../repositories/neon-artifacts.js';
import {
  grantEntitlement as repoGrantEntitlement,
  hasUserVersionEntitlement as repoHasUserVersionEntitlement,
  getUserVersionEntitlement as repoGetUserVersionEntitlement,
  revokeEntitlement as repoRevokeEntitlement,
} from '../../repositories/neon-entitlements.js';
import { normalizePluginVersion } from './version-normalizer.js';

/*
 * ============================================================================
 * PHASE 5A: CANONICAL REGISTRY DOMAIN SERVICE
 *
 * QUY TẮC NGHIỆP VỤ BẤT BIẾN:
 * PLUGIN ≠ PLUGIN VERSION ≠ ARTIFACT ≠ PURCHASE/ENTITLEMENT
 *
 * 1. User mua MỘT VERSION cụ thể của plugin.
 * 2. User KHÔNG tự động sở hữu các version tương lai.
 * 3. Artifact là file vật lý riêng biệt của một Version, có chu trình sống rõ ràng.
 * 4. Chỉ Artifact ở trạng thái READY mới được coi là hợp lệ để tải xuống.
 * 5. Hoàn tiền/thu hồi KHÔNG xóa lịch sử Plugin, Version, hay Artifact.
 * ============================================================================
 */

export class VersionAccessDeniedError extends Error {
  constructor(userId: string, versionId: number) {
    super(`[Entitlement] Người dùng "${userId}" không có quyền truy cập phiên bản ID ${versionId}`);
    this.name = 'VersionAccessDeniedError';
  }
}

export class CanonicalRegistryService {
  /**
   * Đăng ký hoặc lấy Plugin canonical.
   */
  public async getOrCreatePlugin(
    db: Database,
    input: NewPlugin,
  ): Promise<Plugin> {
    return await repoGetOrCreatePlugin(db, input);
  }

  /**
   * Tìm plugin theo ID.
   */
  public async getPluginById(db: Database, id: number): Promise<Plugin | null> {
    return await findPluginById(db, id);
  }

  /**
   * Tìm plugin theo slug.
   */
  public async getPluginBySlug(db: Database, slug: string): Promise<Plugin | null> {
    return await findPluginBySlug(db, slug);
  }

  /**
   * Tìm plugin theo source identity (platform + resourceId).
   */
  public async getPluginBySourceIdentity(
    db: Database,
    platform: string,
    resourceId: number,
  ): Promise<Plugin | null> {
    return await findPluginBySourceIdentity(db, platform, resourceId);
  }

  /**
   * Đăng ký hoặc lấy Version canonical của một plugin.
   * Tự động chuẩn hóa version string bằng normalizePluginVersion().
   */
  public async getOrCreatePluginVersion(
    db: Database,
    params: {
      pluginId: number;
      version: string;
      rawVersion?: string;
      sourceVersionId?: string;
      sourceReleaseId?: string;
      releasedAt?: Date;
      metadata?: Record<string, unknown>;
      sha256: string;
      relPath: string;
      bytes: number;
      originalName: string;
      descriptorKind?: string;
      isStable?: boolean;
    },
  ): Promise<Version> {
    const rawVersion = params.rawVersion ?? params.version;
    const versionNormalized = normalizePluginVersion(rawVersion);

    const versionInput: NewVersion = {
      pluginId: params.pluginId,
      version: params.version,
      rawVersion,
      versionNormalized,
      sourceVersionId: params.sourceVersionId,
      sourceReleaseId: params.sourceReleaseId,
      releasedAt: params.releasedAt,
      metadata: params.metadata ?? {},
      status: 'active',
      sha256: params.sha256,
      relPath: params.relPath,
      bytes: params.bytes,
      originalName: params.originalName,
      descriptorKind: params.descriptorKind ?? 'spigot',
      isStable: params.isStable ?? true,
    };

    return await repoGetOrCreatePluginVersion(db, versionInput);
  }

  /**
   * Tìm phiên bản theo version_normalized.
   */
  public async getVersionByNormalized(
    db: Database,
    pluginId: number,
    rawVersion: string,
  ): Promise<Version | null> {
    const normalized = normalizePluginVersion(rawVersion);
    return await findVersionByNormalized(db, pluginId, normalized);
  }

  /**
   * Đăng ký hoặc lấy canonical Artifact cho một phiên bản cụ thể.
   * Đảm bảo tính duy nhất: 1 Version có tối đa 1 canonical artifact.
   */
  public async getOrCreateArtifact(
    db: Database,
    input: NewPluginArtifact,
  ): Promise<PluginArtifact> {
    return await repoGetOrCreateArtifact(db, input);
  }

  /**
   * Cập nhật trạng thái chu trình sống của artifact.
   */
  public async updateArtifactStatus(
    db: Database,
    versionId: number,
    status: ArtifactStatus,
    patch?: Partial<NewPluginArtifact>,
  ): Promise<PluginArtifact | null> {
    return await repoUpdateArtifactStatus(db, versionId, status, patch);
  }

  /**
   * Kiểm tra xem artifact của phiên bản có ở trạng thái READY để tải xuống hay không.
   */
  public async isVersionArtifactReady(
    db: Database,
    versionId: number,
  ): Promise<boolean> {
    const artifact = await findCanonicalArtifactByVersionId(db, versionId);
    return isArtifactUsable(artifact);
  }

  /**
   * Cấp quyền sở hữu (Entitlement) cho một User đối với MỘT PHIÊN BẢN cụ thể.
   */
  public async grantVersionEntitlement(
    db: Database,
    params: {
      userId: string;
      pluginVersionId: number;
      orderId?: number | null;
      status?: EntitlementStatus;
    },
  ): Promise<PluginEntitlement> {
    return await repoGrantEntitlement(db, params);
  }

  /**
   * Kiểm tra tính hợp lệ của quyền sở hữu phiên bản.
   * Trả về true nếu user có entitlement ACTIVE cho chính xác version này.
   */
  public async checkUserVersionAccess(
    db: Database,
    params: {
      userId: string;
      pluginVersionId: number;
    },
  ): Promise<boolean> {
    return await repoHasUserVersionEntitlement(db, params.userId, params.pluginVersionId);
  }

  /**
   * Lấy chi tiết entitlement của user đối với version.
   */
  public async getUserVersionEntitlement(
    db: Database,
    userId: string,
    pluginVersionId: number,
  ): Promise<PluginEntitlement | null> {
    return await repoGetUserVersionEntitlement(db, userId, pluginVersionId);
  }

  /**
   * Thu hồi quyền truy cập phiên bản (ví dụ khi hoàn tiền).
   */
  public async revokeVersionEntitlement(
    db: Database,
    params: {
      userId: string;
      pluginVersionId: number;
      reason?: string;
    },
  ): Promise<PluginEntitlement | null> {
    return await repoRevokeEntitlement(db, params.userId, params.pluginVersionId, params.reason);
  }
}

export const canonicalRegistryService = new CanonicalRegistryService();
