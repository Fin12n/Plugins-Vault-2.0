import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadViaBrowser, type BrowserSession } from '../src/services/upstream/download-via-browser.js';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';

describe('Phase 4B-2 — Real CloakBrowser E2E Reliability Pipeline', { timeout: 60_000 }, () => {
  let server: http.Server;
  let baseUrl: string;
  let validPayload: Buffer;
  let validSha256: string;
  let corruptedPayload: Buffer;
  let tempBaseDir: string;
  const activeSockets = new Set<Socket>();

  let session: BrowserSession;
  let page: BrowserSession['page'];

  beforeAll(async () => {
    // 1. Tạo payload JAR chuẩn (có magic header PK\x03\x04)
    validPayload = Buffer.concat([
      Buffer.from('PK\x03\x04'),
      Buffer.from('RealCloakBrowserDeterministicPayloadE2EVerificationChunk'),
      Buffer.alloc(150 * 1024, 0x65), // 150KB
    ]);
    validSha256 = createHash('sha256').update(validPayload).digest('hex');

    // 2. Tạo corrupted payload (cùng size nhưng byte bên trong bị thay đổi)
    corruptedPayload = Buffer.from(validPayload);
    corruptedPayload[60] = corruptedPayload[60]! ^ 0xff;

    // 3. Khởi tạo HTTP Test Server thật
    server = http.createServer((req, res) => {
      const url = req.url ?? '';

      // Resource page HTML thật để CloakBrowser điều hướng vào và tìm link
      if (url.startsWith('/resource/demo')) {
        const html = `<!DOCTYPE html>
<html>
<head><title>CloakBrowser Test Resource</title></head>
<body>
  <h1>Test Resource</h1>
  <div id="content">
    <a href="${baseUrl}/download/valid" class="downloadButton">Download Plugin</a>
  </div>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Kịch bản 1: Interrupted socket (gửi header + 2KB rồi ngắt kết nối TCP đột ngột)
      if (url === '/download/interrupted') {
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': '1048576',
        });
        res.write(Buffer.from('PK\x03\x04BrokenStreamHeaderData'));
        setTimeout(() => {
          res.socket?.destroy();
        }, 60);
        return;
      }

      // Kịch bản 2: Slow stream để test mid-flight abort
      if (url === '/download/slow') {
        const slowData = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(30 * 1024, 0x73)]);
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': String(slowData.length),
        });
        let offset = 0;
        const interval = setInterval(() => {
          if (offset >= slowData.length || res.writableEnded || res.destroyed) {
            clearInterval(interval);
            if (!res.writableEnded && !res.destroyed) res.end();
            return;
          }
          const chunk = slowData.subarray(offset, offset + 1024);
          res.write(chunk);
          offset += 1024;
        }, 50);
        req.on('close', () => clearInterval(interval));
        return;
      }

      // Kịch bản 3: Oversized payload (3 MB > 1 MB maxBytes)
      if (url === '/download/oversized') {
        const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(3 * 1024 * 1024, 0x5a)]);
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': String(big.length),
        });
        res.end(big);
        return;
      }

      // Kịch bản 4: Non-JAR HTML payload (>= 1024 bytes)
      if (url === '/download/not-a-jar') {
        const html = Buffer.concat([
          Buffer.from('<!DOCTYPE html><html><body><h1>Error 403 Forbidden - Spigot Resource</h1></body></html>'),
          Buffer.alloc(2048, 0x20),
        ]);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(html.length),
        });
        res.end(html);
        return;
      }

      // Kịch bản 5: Corrupted Artifact (SHA256 mismatch)
      if (url === '/download/corrupted') {
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': String(corruptedPayload.length),
        });
        res.end(corruptedPayload);
        return;
      }

      // Kịch bản chuẩn: Valid JAR Payload
      if (url.startsWith('/download/valid')) {
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': String(validPayload.length),
          'Content-Disposition': 'attachment; filename="PluginArtifact.jar"',
        });
        res.end(validPayload);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('connection', (sock) => {
      activeSockets.add(sock);
      sock.on('close', () => activeSockets.delete(sock));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 4. Khởi chạy TRUE CloakBrowser instance
    const probe = await probeBrowserLauncher();
    if (!probe.available) {
      throw new Error(`CloakBrowser launcher probe unavailable: ${probe.reason}`);
    }

    session = await probe.launch({ headless: true, ephemeral: true });
    page = session.page;
  });

  afterAll(async () => {
    // Đóng browser thật
    if (session) {
      await session.close().catch(() => {});
    }

    // Đóng server
    for (const sock of activeSockets) {
      sock.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'cloak-e2e-dl-'));
  });

  afterEach(() => {
    if (existsSync(tempBaseDir)) {
      rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. REAL INTERRUPTED SOCKET
  // =========================================================================
  it('1. REAL INTERRUPTED SOCKET: Chromium receives abrupt TCP socket termination, cleans up without publishing corrupt .jar', async () => {
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/interrupted`,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // Production pipeline must not report success
    expect(outcome.status).not.toBe('ok');

    // ASSERT: No final .jar in tmpDir
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);

    // ASSERT: No leftover .part or .crdownload
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
    expect(files.some((f) => f.endsWith('.crdownload'))).toBe(false);

    // Browser Health verification: page is still responsive
    const title = await page.title().catch(() => '');
    expect(typeof title).toBe('string');
    const evalRes = await ((page.evaluate as any)('1 + 1'));
    expect(evalRes).toBe(2);
  });

  // =========================================================================
  // 2. REAL ABORT SIGNAL (Mid-Flight)
  // =========================================================================
  it('2. REAL ABORT SIGNAL: aborts mid-flight on real CloakBrowser, cleans up, and subsequent download succeeds on same page', async () => {
    const controller = new AbortController();

    // Trigger abort sau 40ms khi browser đang stream
    setTimeout(() => {
      controller.abort('pipeline_aborted_by_operator');
    }, 40);

    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/slow`,
        signal: controller.signal,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Pipeline aborted cleanly
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toContain('đang tắt tiến trình');

    // ASSERT: Zero artifacts in tmpDir
    expect(readdirSync(tempBaseDir)).toHaveLength(0);

    // ASSERT: Subsequent download on the EXACT SAME real page succeeds
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/valid`,
        downloadWaitMs: 5_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
    if (nextOutcome.status === 'ok') {
      expect(existsSync(nextOutcome.tmpPath)).toBe(true);
      const content = readFileSync(nextOutcome.tmpPath);
      expect(createHash('sha256').update(content).digest('hex')).toBe(validSha256);
    }
  });

  // =========================================================================
  // 3. REAL MAX BYTES
  // =========================================================================
  it('3. REAL MAX BYTES: Chromium rejects payload exceeding maxBytes, next valid download succeeds', async () => {
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 1024 * 1024, // 1MB < 3MB
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/oversized`,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Rejected exceeding maxBytes
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toContain('vượt giới hạn');

    // ASSERT: No artifacts published
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);

    // Next download on same page succeeds
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/valid`,
        downloadWaitMs: 5_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
  });

  // =========================================================================
  // 4. REAL NON-JAR PAYLOAD
  // =========================================================================
  it('4. REAL NON-JAR PAYLOAD: HTML payload rejected without publishing, page remains usable', async () => {
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/not-a-jar`,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Rejected as not a jar
    expect(outcome.status).toBe('incomplete');
    expect(outcome.detail).toContain('không phải jar');

    // ASSERT: Zero published jars
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);

    // Browser health check
    const evalRes = await ((page.evaluate as any)('document.title'));
    expect(typeof evalRes).toBe('string');
  });

  // =========================================================================
  // 5. REAL CORRUPTED ARTIFACT (SHA256 Mismatch)
  // =========================================================================
  it('5. REAL CORRUPTED ARTIFACT: bit-flipped payload causes SHA256 mismatch on real Chromium, cleans up', async () => {
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/corrupted`,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Rejected due to hash mismatch
    expect(outcome.status).toBe('incomplete');
    expect(outcome.detail).toContain('SHA256 không khớp');

    // ASSERT: No final .jar and no leftover .part
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith('.part'))).toHaveLength(0);

    // Success afterwards
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/valid`,
        downloadWaitMs: 5_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
  });

  // =========================================================================
  // 6. REAL DISK FAILURE
  // =========================================================================
  it('6. REAL DISK FAILURE: invalid destination classifies error cleanly without partial artifact', async () => {
    const invalidTmpDir = join(tempBaseDir, 'blocking-file-e2e.txt');
    writeFileSync(invalidTmpDir, 'i-am-a-file-not-a-directory');

    const outcome = await downloadViaBrowser(
      {
        tmpDir: invalidTmpDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/valid`,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Caught disk failure
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toBeDefined();

    // No artifact published
    const remainingFiles = readdirSync(tempBaseDir);
    expect(remainingFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
  });

  // =========================================================================
  // 7. REAL SUCCESS AFTER FAILURE & BROWSER HEALTH
  // =========================================================================
  it('7. REAL SUCCESS AFTER FAILURE: executes sequence of failures then succeeds on ONE real CloakBrowser page', async () => {
    // 1. Thất bại: Oversized
    const fail1 = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 500,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/oversized`,
        downloadWaitMs: 2_000,
      },
      page,
      83626,
    );
    expect(fail1.status).toBe('error');

    // 2. Thất bại: Non-JAR
    const fail2 = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/not-a-jar`,
        downloadWaitMs: 2_000,
      },
      page,
      83626,
    );
    expect(fail2.status).toBe('incomplete');

    // 3. Thất bại: Corrupted Hash
    const fail3 = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/corrupted`,
        downloadWaitMs: 2_000,
      },
      page,
      83626,
    );
    expect(fail3.status).toBe('incomplete');

    // 4. Thành công: Valid Download trên CÙNG page đó mà KHÔNG restart browser
    const success = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        resourcePageUrl: `${baseUrl}/resource/demo`,
        downloadUrl: `${baseUrl}/download/valid`,
        downloadWaitMs: 5_000,
      },
      page,
      83626,
    );

    expect(success.status).toBe('ok');
    if (success.status === 'ok') {
      expect(existsSync(success.tmpPath)).toBe(true);
      expect(success.bytes).toBe(validPayload.length);
      const published = readFileSync(success.tmpPath);
      expect(createHash('sha256').update(published).digest('hex')).toBe(validSha256);
    }

    // Verify temp directory contains ONLY the published artifact
    const finalFiles = readdirSync(tempBaseDir);
    expect(finalFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(1);
    expect(finalFiles.filter((f) => f.endsWith('.part'))).toHaveLength(0);
    expect(finalFiles.filter((f) => f.endsWith('.crdownload'))).toHaveLength(0);

    // Verify final browser health
    const cdp = await page.createCDPSession();
    expect(cdp).toBeDefined();
    await cdp.detach?.().catch(() => {});
  });
});
