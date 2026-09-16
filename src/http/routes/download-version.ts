import contentDisposition from 'content-disposition';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import { findVersionWithPlugin } from '../../repositories/versions.js';
import { suggestFilename } from '../../services/delivery/deliver-version.js';
import { redeemDownloadToken } from '../../services/delivery/mint-download-token.js';

/**
 * One-shot jar download.
 *
 * Not under /api, and deliberately unauthenticated: possession of the token is
 * the authorization. The token was minted for a specific user and version and is
 * consumed atomically on first use.
 */
export function registerDownloadRoute(app: FastifyInstance, deps: { db: Db; env: Env }): void {
  app.get<{ Params: { token: string } }>('/download/:token', async (request, reply) => {
    const redeemed = redeemDownloadToken(deps.db, request.params.token);
    // Unknown, used, and expired all answer the same way; distinguishing them
    // would let an attacker probe for valid tokens.
    if (!redeemed) {
      return reply.code(410).send({ error: 'Liên kết không hợp lệ, đã dùng hoặc đã hết hạn' });
    }

    const version = findVersionWithPlugin(deps.db, redeemed.versionId);
    if (!version) return reply.code(410).send({ error: 'Phiên bản không còn tồn tại' });

    const path = join(deps.env.VAULT_DIR, version.relPath);
    const stats = await stat(path).catch(() => null);
    if (!stats) return reply.code(410).send({ error: 'Tệp không còn trong kho' });

    const filename = suggestFilename(version.pluginSlug, version.version, version.originalName);

    reply.header('content-type', 'application/java-archive');
    // The library handles RFC 8187 encoding: hand-rolling it with
    // encodeURIComponent leaves an apostrophe unescaped, and the apostrophe is
    // the charset delimiter, so a name like "Bob's Plugin.jar" produces a header
    // strict parsers reject.
    reply.header('content-disposition', contentDisposition(filename));
    // Taken from the filesystem rather than the stored byte count so a stale row
    // cannot truncate or hang the response.
    reply.header('content-length', String(stats.size));
    reply.header('cache-control', 'no-store');

    const stream = createReadStream(path);
    // Stream errors fire after headers are already sent, so setErrorHandler
    // cannot intercept them; destroy the socket rather than hanging the client.
    stream.on('error', () => {
      request.log.error({ path }, 'lỗi khi đọc tệp trong kho');
      reply.raw.destroy();
    });

    // No audit row here. deliverVersion already recorded this delivery when it
    // handed over the link, and the monthly report counts audit rows — writing a
    // second one would double the download count for every link delivery. The
    // fetch itself goes to the app log, where the address is useful for support
    // without polluting the fund figures.
    request.log.info(
      { versionId: version.id, discordUserId: redeemed.discordUserId, ip: request.ip },
      'đã tải tệp qua liên kết',
    );

    return reply.send(stream);
  });
}
