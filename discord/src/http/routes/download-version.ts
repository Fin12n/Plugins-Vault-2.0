import contentDisposition from 'content-disposition';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import type { Database } from '../../db/neon.js';
import { findVersionWithPlugin } from '../../repositories/versions.js';
import { findVersionById } from '../../repositories/neon-versions.js';
import { findPluginById } from '../../repositories/neon-plugins.js';
import { suggestFilename } from '../../services/delivery/deliver-version.js';
import { redeemDownloadToken } from '../../services/delivery/mint-download-token.js';
import {
  claimDownloadToken,
  unclaimDownloadToken,
} from '../../repositories/neon-download-tokens.js';

/**
 * One-shot jar download with atomic claim and unclaim compensation.
 *
 * Not under /api, and deliberately unauthenticated: possession of the token is
 * the authorization. The token was minted for a specific user and version and is
 * consumed atomically on first use.
 */
export function registerDownloadRoute(
  app: FastifyInstance,
  deps: { db: Db; neonDb?: Database; env: Env }
): void {
  app.get<{ Params: { token: string } }>('/download/:token', async (request, reply) => {
    const rawToken = request.params.token;
    const tokenHashHex = createHash('sha256').update(rawToken).digest('hex');

    let versionId: number;
    let discordUserId: string;
    let relPath: string;
    let filename: string;

    if (deps.neonDb) {
      // 1. Neon Authority Flow: Atomic Claim
      const claimed = await claimDownloadToken(deps.neonDb, tokenHashHex);
      if (!claimed) {
        return reply.code(410).send({ error: 'Liên kết không hợp lệ, đã dùng hoặc đã hết hạn' });
      }

      versionId = claimed.versionId;
      discordUserId = claimed.discordUserId;

      const version = await findVersionById(deps.neonDb, claimed.versionId);
      if (!version) {
        return reply.code(410).send({ error: 'Phiên bản không còn tồn tại' });
      }

      relPath = version.relPath;
      const plugin = await findPluginById(deps.neonDb, version.pluginId);
      const pluginSlug = plugin?.slug ?? String(version.pluginId);
      filename = suggestFilename(pluginSlug, version.version, version.originalName);

      const path = join(deps.env.VAULT_DIR, relPath);
      const stats = await stat(path).catch(() => null);

      if (!stats) {
        // Compensation Unclaim: Tệp không có trong kho local -> giải phóng token
        await unclaimDownloadToken(deps.neonDb, tokenHashHex, 'file_missing_in_vault');
        return reply.code(410).send({ error: 'Tệp không còn trong kho' });
      }

      reply.header('content-type', 'application/java-archive');
      reply.header('content-disposition', contentDisposition(filename));
      reply.header('content-length', String(stats.size));
      reply.header('cache-control', 'no-store');

      const stream = createReadStream(path);
      stream.on('error', () => {
        request.log.error({ path }, 'lỗi khi đọc tệp trong kho');
        reply.raw.destroy();
      });

      request.log.info(
        { versionId, discordUserId, ip: request.ip },
        'đã tải tệp qua liên kết (Neon)',
      );

      return reply.send(stream);
    } else {
      // 2. Legacy SQLite Flow
      const redeemed = redeemDownloadToken(deps.db, rawToken);
      if (!redeemed) {
        return reply.code(410).send({ error: 'Liên kết không hợp lệ, đã dùng hoặc đã hết hạn' });
      }

      const version = findVersionWithPlugin(deps.db, redeemed.versionId);
      if (!version) return reply.code(410).send({ error: 'Phiên bản không còn tồn tại' });

      const path = join(deps.env.VAULT_DIR, version.relPath);
      const stats = await stat(path).catch(() => null);
      if (!stats) return reply.code(410).send({ error: 'Tệp không còn trong kho' });

      filename = suggestFilename(version.pluginSlug, version.version, version.originalName);

      reply.header('content-type', 'application/java-archive');
      reply.header('content-disposition', contentDisposition(filename));
      reply.header('content-length', String(stats.size));
      reply.header('cache-control', 'no-store');

      const stream = createReadStream(path);
      stream.on('error', () => {
        request.log.error({ path }, 'lỗi khi đọc tệp trong kho');
        reply.raw.destroy();
      });

      request.log.info(
        { versionId: version.id, discordUserId: redeemed.discordUserId, ip: request.ip },
        'đã tải tệp qua liên kết (SQLite)',
      );

      return reply.send(stream);
    }
  });
}
