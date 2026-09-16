import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import type { IngestResult } from '../../domain/ingest.js';
import { ingestJarBatch, type IngestSource } from '../../services/ingest/ingest-jar-batch.js';

/** Multipart limit codes @fastify/multipart raises, mapped to 413. */
const LIMIT_CODES = new Set(['FST_FILES_LIMIT', 'FST_REQ_FILE_TOO_LARGE', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT']);

export function registerUploadRoute(app: FastifyInstance, deps: { db: Db; env: Env }): void {
  /**
   * Batch jar upload.
   *
   * Every part must be consumed or the async iterator never settles and the
   * request hangs. Parts are handed to the ingest service as lazily-opened
   * streams so nothing is buffered: @fastify/multipart's toBuffer() is the
   * documented in-memory path and would exhaust the heap on a 200 MB jar.
   */
  app.post('/api/upload', async (request, reply) => {
    const results: IngestResult[] = [];

    try {
      for await (const part of request.files()) {
        if (part.type !== 'file') continue;

        // Ingest one file at a time: the part stream is only readable during this
        // iteration, so collecting them all first and ingesting later would read
        // from streams Fastify has already advanced past.
        const single: IngestSource = { originalName: part.filename, open: () => part.file };
        const [result] = await ingestJarBatch(
          { db: deps.db, vaultDir: deps.env.VAULT_DIR, tmpDir: deps.env.TMP_DIR },
          [single],
        );

        if (result) results.push(result);

        // When fileSize trips, @fastify/multipart leaves a truncated stream and
        // sets this flag. The ingest above will have hashed the partial content,
        // so the result must be replaced rather than trusted.
        if (part.file.truncated) {
          results[results.length - 1] = {
            status: 'failed',
            originalName: part.filename,
            code: 'read-failed',
            detail: `vượt quá ${deps.env.UPLOAD_MAX_FILE_BYTES} bytes`,
          };
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && LIMIT_CODES.has(code)) {
        return reply.code(413).send({
          error: 'Tệp quá lớn hoặc quá nhiều tệp',
          code,
          results,
        });
      }
      throw err;
    }

    if (results.length === 0) {
      return reply.code(400).send({ error: 'Không có tệp nào được gửi' });
    }

    return reply.send({ results, summary: summarize(results) });
  });
}

export function summarize(results: IngestResult[]): Record<string, number> {
  const summary = { added: 0, duplicate: 0, pending: 0, failed: 0 };
  for (const r of results) summary[r.status]++;
  return summary;
}
