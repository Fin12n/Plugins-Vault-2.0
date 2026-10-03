import type { DescriptorKind, VersionFlag } from './plugin.js';

/**
 * Why a jar could not be identified. Typed so a batch never aborts on one bad
 * file. Mirrored by a CHECK constraint on pending_ingest.reason.
 */
export const INGEST_FAILURE_REASONS = [
  'no-descriptor',
  'unreadable-zip',
  'invalid-yaml',
  'missing-fields',
  'not-a-plugin',
  'too-large',
] as const;
export type IngestFailureReason = (typeof INGEST_FAILURE_REASONS)[number];

/**
 * Machine-readable cause of a hard ingest failure, so the dashboard can show a
 * Vietnamese message instead of surfacing a raw SQLite or Node error string.
 */
export const INGEST_ERROR_CODES = ['read-failed', 'storage-failed', 'db-failed', 'unknown'] as const;
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/**
 * Descriptor read result. A union rather than a throw: one malformed jar in a
 * 20-file batch must not stop the other 19.
 */
export type DescriptorResult =
  | {
      ok: true;
      kind: DescriptorKind;
      name: string;
      /** Null where the platform allows it (Velocity, BungeeCord). */
      version: string | null;
      rawVersion: string;
      descriptorEntry: string;
      versionFlag: VersionFlag;
    }
  | { ok: false; reason: IngestFailureReason; detail: string };

/** Per-file outcome of a batch ingest, reported back to the dashboard. */
export type IngestResult =
  | {
      status: 'added';
      originalName: string;
      pluginId: number;
      pluginName: string;
      versionId: number;
      version: string | null;
      versionFlag: VersionFlag;
      createdPlugin: boolean;
    }
  | {
      status: 'duplicate';
      originalName: string;
      sha256: string;
      existingPluginName: string;
      existingVersion: string | null;
    }
  | {
      status: 'pending';
      originalName: string;
      reason: IngestFailureReason;
      detail: string;
      pendingId: number;
    }
  | { status: 'failed'; originalName: string; code: IngestErrorCode; detail: string };

export type PendingIngest = {
  id: number;
  uploadedBy?: string;
  originalFilename: string;
  sha256: string;
  tmpPath: string;
  fileSize?: number;
  bytes?: number;
  detectedPluginName?: string | null;
  detectedVersion?: string | null;
  detectedPlatform?: string | null;
  status?: 'needs_review' | 'approved' | 'rejected' | string;
  errorReason?: IngestFailureReason | string;
  reason?: IngestFailureReason;
  errorDetail?: string;
  detail?: string;
  createdAt: Date | number;
  resolvedAt?: Date | number | null;
};


