import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import YAML from 'yaml';
import { eq, desc, pendingIngest, plugins, versions, manualUploads } from '@vault/db';

import { db } from '../db/neon.js';
import { env } from '../config/env.js';

function ensureDir(dirPath: string) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

type ExtractedDescriptor = {
  name: string;
  version: string | null;
  rawVersion: string | null;
  kind: 'paper' | 'spigot' | 'velocity' | 'bungee';
};

async function inspectJar(filePath: string): Promise<ExtractedDescriptor | null> {
  const zip = new StreamZip.async({ file: filePath });
  try {
    const entries = await zip.entries();

    // Check non-plugin markers
    if (entries['META-INF/versions.list'] || entries['fabric.mod.json'] || entries['META-INF/mods.toml']) {
      return null;
    }

    const probes: { entry: string; kind: ExtractedDescriptor['kind']; isYaml: boolean }[] = [
      { entry: 'velocity-plugin.json', kind: 'velocity', isYaml: false },
      { entry: 'paper-plugin.yml', kind: 'paper', isYaml: true },
      { entry: 'bungee.yml', kind: 'bungee', isYaml: true },
      { entry: 'plugin.yml', kind: 'spigot', isYaml: true },
    ];

    for (const probe of probes) {
      if (entries[probe.entry]) {
        const buf = await zip.entryData(probe.entry);
        const text = buf.toString('utf8');

        if (probe.isYaml) {
          const parsed = YAML.parse(text) as { name?: string; version?: unknown };
          if (parsed && typeof parsed.name === 'string') {
            const rawVer = parsed.version !== undefined ? String(parsed.version).trim() : null;
            return {
              name: parsed.name.trim(),
              version: rawVer,
              rawVersion: rawVer,
              kind: probe.kind,
            };
          }
        } else {
          const parsed = JSON.parse(text) as { id?: string; name?: string; version?: string };
          const name = parsed.name || parsed.id;
          if (name) {
            return {
              name: name.trim(),
              version: parsed.version?.trim() ?? null,
              rawVersion: parsed.version?.trim() ?? null,
              kind: probe.kind,
            };
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await zip.close().catch(() => {});
  }
}

export function registerUploadRoutes(app: FastifyInstance) {
  const storageRoot = resolve(env.STORAGE_DIR);
  const tempDir = join(storageRoot, 'temp');
  const vaultDir = join(storageRoot, 'vault');
  ensureDir(tempDir);
  ensureDir(vaultDir);

  // Danh sách pending ingests
  app.get('/api/pending', async () => {
    const rows = await db
      .select()
      .from(pendingIngest)
      .orderBy(desc(pendingIngest.createdAt));

    return rows.map((r: typeof pendingIngest.$inferSelect) => ({
      id: r.id,
      uploadedBy: r.uploadedBy,
      originalFilename: r.originalFilename,
      sha256: r.sha256,
      tmpPath: r.tmpPath,
      fileSize: r.fileSize,
      detectedPluginName: r.detectedPluginName,
      detectedVersion: r.detectedVersion,
      detectedPlatform: r.detectedPlatform,
      status: r.status,
      errorReason: r.errorReason,
      errorDetail: r.errorDetail,
      createdAt: r.createdAt.getTime(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.getTime() : null,
    }));
  });

  // Gán pending ingest vào plugin đã có
  app.post('/api/pending/:id/assign', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const { pluginId, version, isStable } = z
      .object({
        pluginId: z.number().int(),
        version: z.string().optional(),
        isStable: z.boolean().optional().default(true),
      })
      .parse(request.body);

    const [pending] = await db
      .select()
      .from(pendingIngest)
      .where(eq(pendingIngest.id, id))
      .limit(1);
    if (!pending) return reply.code(404).send({ error: 'Mục chờ không tồn tại' });

    const [p] = await db
      .select()
      .from(plugins)
      .where(eq(plugins.id, pluginId))
      .limit(1);
    if (!p) return reply.code(404).send({ error: 'Plugin chỉ định không tồn tại' });

    // Tạo bản ghi version
    const [createdVersion] = await db
      .insert(versions)
      .values({
        pluginId: p.id,
        version: version || '1.0.0',
        rawVersion: version || null,
        sha256: pending.sha256,
        relPath: pending.tmpPath,
        bytes: pending.fileSize,
        originalName: pending.originalFilename,
        descriptorKind: pending.detectedPlatform || 'spigot',
        isStable: isStable ?? true,
        versionFlag: 'manual',
        source: 'manual',
        changeLogs: '',
      })
      .returning();

    if (!createdVersion) return reply.code(500).send({ error: 'Không thể tạo bản ghi phiên bản' });

    // Ghi nhật ký manualUploads
    await db.insert(manualUploads).values({
      versionId: createdVersion.id,
      pluginId: p.id,
      uploadedBy: pending.uploadedBy,
      originalName: pending.originalFilename,
      adminNote: 'Duyệt và chỉ định từ hàng đợi pending_ingest',
    });

    // Cập nhật trạng thái pending
    await db
      .update(pendingIngest)
      .set({
        status: 'approved',
        resolvedAt: new Date(),
      })
      .where(eq(pendingIngest.id, id));

    return { ok: true, versionId: createdVersion.id };
  });

  // Hủy file pending
  app.delete('/api/pending/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const [pending] = await db.select().from(pendingIngest).where(eq(pendingIngest.id, id)).limit(1);
    if (!pending) return reply.code(404).send({ error: 'Mục chờ không tồn tại' });

    await db.delete(pendingIngest).where(eq(pendingIngest.id, id));
    if (existsSync(pending.tmpPath)) {
      await unlink(pending.tmpPath).catch(() => {});
    }

    return { ok: true };
  });

  // Upload file jar
  app.post('/api/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'Yêu cầu phải ở định dạng multipart/form-data' });
    }

    const parts = request.files();
    const results: Array<{
      status: 'added' | 'duplicate' | 'pending' | 'failed';
      originalName: string;
      pluginName?: string;
      version?: string | null;
      versionFlag?: string;
      createdPlugin?: boolean;
      existingPluginName?: string;
      existingVersion?: string | null;
      reason?: string;
      detail?: string;
      pendingId?: number;
      code?: string;
    }> = [];

    const summary = { added: 0, duplicate: 0, pending: 0, failed: 0 };

    for await (const part of parts) {
      const originalName = part.filename;
      const tmpFilePath = join(tempDir, `${Date.now()}_${originalName}`);

      try {
        const hashStream = createHash('sha256');
        const fileStream = createWriteStream(tmpFilePath);

        let totalBytes = 0;
        for await (const chunk of part.file) {
          totalBytes += (chunk as Buffer).length;
          hashStream.update(chunk as Buffer);
          fileStream.write(chunk);
        }
        fileStream.end();

        const sha256 = hashStream.digest('hex');

        // 1. Kiểm tra duplicate trong versions
        const [existing] = await db
          .select({
            vId: versions.id,
            version: versions.version,
            pName: plugins.displayName,
          })
          .from(versions)
          .innerJoin(plugins, eq(versions.pluginId, plugins.id))
          .where(eq(versions.sha256, sha256))
          .limit(1);

        if (existing) {
          await unlink(tmpFilePath).catch(() => {});
          summary.duplicate++;
          results.push({
            status: 'duplicate',
            originalName,
            existingPluginName: existing.pName,
            existingVersion: existing.version,
          });
          continue;
        }

        // 2. Chuyển file vào kho vault
        const shardDir = join(vaultDir, sha256.slice(0, 2));
        ensureDir(shardDir);
        const finalPath = join(shardDir, `${sha256}.jar`);
        const relPath = join('vault', sha256.slice(0, 2), `${sha256}.jar`);

        // Di chuyển file
        const { rename } = await import('node:fs/promises');
        await rename(tmpFilePath, finalPath);

        // 3. Phân tích descriptor
        const descriptor = await inspectJar(finalPath);

        const uploadedBy = (request.headers['x-user-id'] as string) || 'admin';

        if (!descriptor) {
          // Đưa vào pending_ingest
          const [pend] = await db
            .insert(pendingIngest)
            .values({
              uploadedBy,
              originalFilename: originalName,
              sha256,
              tmpPath: finalPath,
              fileSize: totalBytes,
              detectedPluginName: null,
              detectedVersion: null,
              detectedPlatform: null,
              status: 'needs_review',
              errorReason: 'no-descriptor',
              errorDetail: 'Không tìm thấy plugin.yml hoặc descriptor hỗ trợ',
            })
            .returning();

          if (!pend) {
            summary.failed++;
            results.push({
              status: 'failed',
              originalName,
              code: 'INGEST_FAILED',
              detail: 'Không thể ghi nhận hàng đợi chờ duyệt',
            });
            continue;
          }

          summary.pending++;
          results.push({
            status: 'pending',
            originalName,
            reason: 'no-descriptor',
            detail: 'Không tìm thấy plugin.yml hoặc descriptor hỗ trợ',
            pendingId: pend.id,
          });
          continue;
        }

        // 4. Tìm plugin hoặc tạo mới
        const [matchedPlugin] = await db
          .select()
          .from(plugins)
          .where(eq(plugins.descriptorName, descriptor.name))
          .limit(1);

        let targetPluginId: number;
        let createdPlugin = false;
        let pluginDisplayName = descriptor.name;

        if (matchedPlugin) {
          targetPluginId = matchedPlugin.id;
          pluginDisplayName = matchedPlugin.displayName;
        } else {
          // Tạo plugin mới
          const slugBase = descriptor.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
            .slice(0, 60);

          const [newP] = await db
            .insert(plugins)
            .values({
              pluginId: `manual-${slugBase}-${Date.now().toString().slice(-4)}`,
              slug: `${slugBase}-${Date.now().toString().slice(-4)}`,
              displayName: descriptor.name,
              descriptorName: descriptor.name,
              aliases: [],
              platform: descriptor.kind,
              depositPrice: 0,
              isPremium: false,
              spigotLink: '',
            })
            .returning();

          if (!newP) {
            summary.failed++;
            results.push({
              status: 'failed',
              originalName,
              code: 'PLUGIN_CREATE_FAILED',
              detail: 'Không thể khởi tạo plugin mới',
            });
            continue;
          }

          targetPluginId = newP.id;
          createdPlugin = true;
        }

        // 5. Thêm version mới
        const [createdVersion] = await db
          .insert(versions)
          .values({
            pluginId: targetPluginId,
            version: descriptor.version,
            rawVersion: descriptor.rawVersion,
            sha256,
            relPath,
            bytes: totalBytes,
            originalName,
            descriptorKind: descriptor.kind,
            isStable: true,
            versionFlag: descriptor.version ? 'ok' : 'unresolved-placeholder',
            source: 'manual',
            changeLogs: '',
          })
          .returning();

        // Ghi log manualUploads
        if (createdVersion) {
          await db.insert(manualUploads).values({
            versionId: createdVersion.id,
            pluginId: targetPluginId,
            uploadedBy,
            originalName,
            adminNote: 'Upload thủ công trực tiếp từ Web Dashboard',
          });
        }

        summary.added++;
        results.push({
          status: 'added',
          originalName,
          pluginName: pluginDisplayName,
          version: descriptor.version,
          versionFlag: descriptor.version ? 'ok' : 'unresolved-placeholder',
          createdPlugin,
        });
      } catch (err) {
        await unlink(tmpFilePath).catch(() => {});
        summary.failed++;
        results.push({
          status: 'failed',
          originalName,
          code: 'INGEST_ERROR',
          detail: err instanceof Error ? err.message : 'Lỗi không xác định',
        });
      }
    }

    return { results, summary };
  });
}
