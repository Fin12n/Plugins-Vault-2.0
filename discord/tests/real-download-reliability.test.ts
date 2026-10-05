import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadViaBrowser, type BrowserPage } from '../src/services/upstream/download-via-browser.js';

describe('Phase 4B-2 — Real Download Reliability Pipeline', { timeout: 25_000 }, () => {
  let server: http.Server;
  let baseUrl: string;
  let validPayload: Buffer;
  let validSha256: string;
  let corruptedPayload: Buffer;
  let tempBaseDir: string;
  const activeSockets = new Set<Socket>();

  beforeAll(async () => {
    // 1. Tạo payload JAR chuẩn (có ZIP magic header PK\x03\x04)
    validPayload = Buffer.concat([
      Buffer.from('PK\x03\x04'),
      Buffer.from('RealDeterministicPayloadForPhase4B2ReliabilityTesting'),
      Buffer.alloc(200 * 1024, 0x61), // 200KB payload
    ]);
    validSha256 = createHash('sha256').update(validPayload).digest('hex');

    // 2. Tạo corrupted payload (cùng độ dài nhưng byte bên trong bị thay đổi)
    corruptedPayload = Buffer.from(validPayload);
    corruptedPayload[100] = corruptedPayload[100]! ^ 0xff; // flip bits

    // 3. Khởi tạo HTTP Test Server thật
    server = http.createServer((req, res) => {
      const url = req.url ?? '';

      // Kịch bản 1: Interrupted Download (gửi 4KB rồi forcibly destroy socket)
      if (url === '/download/interrupted') {
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': '1048576',
        });
        res.write(Buffer.from('PK\x03\x04BrokenStreamHeader'));
        setTimeout(() => {
          res.socket?.destroy();
        }, 50);
        return;
      }

      // Kịch bản 2: Slow stream để test mid-flight AbortSignal
      if (url === '/download/slow') {
        const slowPayload = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(20 * 1024, 0x73)]);
        res.writeHead(200, {
          'Content-Type': 'application/java-archive',
          'Content-Length': String(slowPayload.length),
        });
        let offset = 0;
        const interval = setInterval(() => {
          if (offset >= slowPayload.length || res.writableEnded || res.destroyed) {
            clearInterval(interval);
            if (!res.writableEnded && !res.destroyed) res.end();
            return;
          }
          const chunk = slowPayload.subarray(offset, offset + 2048);
          res.write(chunk);
          offset += 2048;
        }, 60);
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

      // Kịch bản 4: Non-JAR HTML Error Page (độ dài >= 1024 bytes)
      if (url === '/download/not-a-jar') {
        const html = Buffer.concat([
          Buffer.from('<!DOCTYPE html><html><body><h1>Error 403 Forbidden</h1><p>Not a valid JAR file</p></body></html>'),
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
          'Content-Disposition': 'attachment; filename="RealPlugin.jar"',
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
  });

  afterAll(async () => {
    for (const sock of activeSockets) {
      sock.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'real-dl-rel-'));
  });

  afterEach(() => {
    if (existsSync(tempBaseDir)) {
      rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper tạo mock BrowserPage kết nối thật với local HTTP test server
   */
  function createTestBrowserPage(downloadEndpoint: string) {
    let activeDownloadDir = '';

    const page: BrowserPage = {
      goto: async () => undefined,
      title: async () => 'Download Resource Page',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Page.setDownloadBehavior' || method === 'Browser.setDownloadBehavior') {
            activeDownloadDir = String(params?.downloadPath ?? '');
          }
          return undefined;
        },
        detach: async () => undefined,
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
      evaluate: (async (source: unknown) => {
        const src = String(source ?? '');

        // 1. Spigot resource metadata / selectors
        if (src.includes('a[href*="download"]')) {
          return `${baseUrl}${downloadEndpoint}`;
        }
        if (src.includes('#cf-chl-widget-container') || src.includes('challenge-running')) {
          return false;
        }
        if (src.includes('form[data-vault-form]')) {
          return JSON.stringify({ login: '', passwordLength: 0 });
        }
        if (src.includes('isResourceStatus') || src.includes('/do not have permission/')) {
          return null;
        }

        // 2. Browser evaluate fetch logic -> Thực hiện fetch HTTP thật đến test server
        if (src.includes('fetch(')) {
          const targetUrl = `${baseUrl}${downloadEndpoint}`;
          try {
            const res = await fetch(targetUrl);
            if (!res.ok) {
              return JSON.stringify({ ok: false, status: res.status });
            }
            const arrayBuf = await res.arrayBuffer();
            const buf = Buffer.from(arrayBuf);

            // Giả lập Chromium stream ghi file nhị phân vào downloadPath
            if (activeDownloadDir && buf.length >= 1024) {
              writeFileSync(join(activeDownloadDir, 'download.jar'), buf);
              return JSON.stringify({ ok: true, directStream: true, size: buf.length });
            }

            // Fallback base64
            return JSON.stringify({ ok: true, data: buf.toString('base64'), size: buf.length });
          } catch (fetchErr) {
            return JSON.stringify({ ok: false, error: String(fetchErr) });
          }
        }

        return null;
      }) as never,
    };

    return { page, setEndpoint: (ep: string) => { downloadEndpoint = ep; } };
  }

  // =========================================================================
  // 1. INTERRUPTED DOWNLOAD
  // =========================================================================
  it('1. INTERRUPTED DOWNLOAD: pipeline cleans up without publishing corrupt file or leaving .crdownload/.part', async () => {
    let activeDownloadDir = '';
    const page: BrowserPage = {
      goto: async () => undefined,
      title: async () => 'Download Resource Page',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Page.setDownloadBehavior' || method === 'Browser.setDownloadBehavior') {
            activeDownloadDir = String(params?.downloadPath ?? '');
          }
          return undefined;
        },
        detach: async () => undefined,
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
      evaluate: (async (source: unknown) => {
        const src = String(source ?? '');
        if (src.includes('a[href*="download"]')) {
          return `${baseUrl}/download/interrupted`;
        }
        if (src.includes('fetch(')) {
          // Khi server ngắt kết nối giữa chừng, Chromium để lại file .crdownload và fetch ném lỗi
          if (activeDownloadDir) {
            writeFileSync(join(activeDownloadDir, 'broken.jar.crdownload'), Buffer.from('partial-data'));
          }
          return JSON.stringify({ ok: false, error: 'TypeError: fetch failed - socket hang up' });
        }
        return null;
      }) as never,
    };

    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 1_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // Pipeline must detect failure/incomplete
    expect(outcome.status).not.toBe('ok');

    // ASSERT: No final .jar in tmpDir
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);

    // ASSERT: No leftover .part or .crdownload
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
    expect(files.some((f) => f.endsWith('.crdownload'))).toBe(false);

    // ASSERT: No internal temporary directories leaked
    expect(files.filter((f) => f.startsWith('spigot-dl-'))).toHaveLength(0);
  });

  // =========================================================================
  // 2. ABORT SIGNAL (Mid-Flight)
  // =========================================================================
  it('2. ABORT SIGNAL: mid-flight abort immediately terminates, cleans up, and subsequent download succeeds', async () => {
    const { page, setEndpoint } = createTestBrowserPage('/download/slow');
    const controller = new AbortController();

    // Trigger abort 30ms sau khi pipeline bắt đầu chạy
    setTimeout(() => {
      controller.abort('job_cancelled_by_user');
    }, 30);

    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        signal: controller.signal,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Pipeline rejects with error detail
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toContain('đang tắt tiến trình');

    // ASSERT: Zero artifacts in tmpDir
    const filesAfterAbort = readdirSync(tempBaseDir);
    expect(filesAfterAbort).toHaveLength(0);

    // ASSERT: Subsequent download on SAME page succeeds immediately
    setEndpoint('/download/valid');
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 3_000,
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
  // 3. MAX BYTES
  // =========================================================================
  it('3. MAX BYTES: oversized payload (> maxBytes) is rejected without publishing, next download succeeds', async () => {
    const { page, setEndpoint } = createTestBrowserPage('/download/oversized');

    // Giới hạn 1 MB nhưng payload là 3 MB
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 1024 * 1024,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Pipeline rejects with exceeding message
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toContain('vượt giới hạn');

    // ASSERT: No final .jar published
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith('.part'))).toHaveLength(0);

    // ASSERT: Next download with normal size on SAME page succeeds
    setEndpoint('/download/valid');
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
    if (nextOutcome.status === 'ok') {
      expect(existsSync(nextOutcome.tmpPath)).toBe(true);
      expect(nextOutcome.bytes).toBe(validPayload.length);
    }
  });

  // =========================================================================
  // 4. NON-JAR PAYLOAD (HTML Error Page)
  // =========================================================================
  it('4. NON-JAR PAYLOAD: HTML payload rejected, no publish, cleanup completes, page remains usable', async () => {
    const { page, setEndpoint } = createTestBrowserPage('/download/not-a-jar');

    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Rejected as not a jar
    expect(outcome.status).toBe('incomplete');
    expect(outcome.detail).toContain('không phải jar');

    // ASSERT: Zero published artifacts
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);

    // ASSERT: Subsequent download on SAME page succeeds
    setEndpoint('/download/valid');
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
  });

  // =========================================================================
  // 5. CORRUPTED ARTIFACT (SHA256 Mismatch)
  // =========================================================================
  it('5. CORRUPTED ARTIFACT: bit-flipped payload causes SHA256 mismatch, no .jar published, temp cleaned', async () => {
    const { page, setEndpoint } = createTestBrowserPage('/download/corrupted');

    // Client mong đợi validSha256, nhưng server trả về corruptedPayload
    const outcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Pipeline rejects with SHA256 mismatch
    expect(outcome.status).toBe('incomplete');
    expect(outcome.detail).toContain('SHA256 không khớp');

    // ASSERT: No final .jar and no leftover .part
    const files = readdirSync(tempBaseDir);
    expect(files.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith('.part'))).toHaveLength(0);

    // ASSERT: Subsequent download with valid payload succeeds
    setEndpoint('/download/valid');
    const nextOutcome = await downloadViaBrowser(
      {
        tmpDir: tempBaseDir,
        maxBytes: 10_000_000,
        expectedSha256: validSha256,
        downloadWaitMs: 3_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    expect(nextOutcome.status).toBe('ok');
    if (nextOutcome.status === 'ok') {
      expect(existsSync(nextOutcome.tmpPath)).toBe(true);
    }
  });

  // =========================================================================
  // 6. DISK FAILURE
  // =========================================================================
  it('6. DISK FAILURE: invalid destination classifies error cleanly without partial artifact', async () => {
    const { page } = createTestBrowserPage('/download/valid');

    // Tạo một tệp tin bình thường và dùng nó làm tmpDir để ép fs.mkdirSync / fs.writeFile ném ENOTDIR / EEXIST
    const invalidTmpDir = join(tempBaseDir, 'blocking-file.txt');
    writeFileSync(invalidTmpDir, 'i-am-a-plain-file-not-a-directory');

    const outcome = await downloadViaBrowser(
      {
        tmpDir: invalidTmpDir,
        maxBytes: 10_000_000,
        downloadWaitMs: 2_000,
        log: () => undefined,
      },
      page,
      83626,
    );

    // ASSERT: Pipeline catches filesystem error and classifies as error status
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toBeDefined();

    // ASSERT: No corrupted artifact published
    const remainingFiles = readdirSync(tempBaseDir);
    expect(remainingFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
  });

  // =========================================================================
  // 7. SUCCESS AFTER FAILURE & RESOURCE VERIFICATION
  // =========================================================================
  it('7. SUCCESS AFTER FAILURE: executes all failure scenarios sequentially on a single page session', async () => {
    const { page, setEndpoint } = createTestBrowserPage('/download/oversized');

    // Bước 1: Thất bại do Oversized
    const fail1 = await downloadViaBrowser(
      { tmpDir: tempBaseDir, maxBytes: 500, downloadWaitMs: 1_000 },
      page,
      83626,
    );
    expect(fail1.status).toBe('error');

    // Bước 2: Thất bại do Non-JAR
    setEndpoint('/download/not-a-jar');
    const fail2 = await downloadViaBrowser(
      { tmpDir: tempBaseDir, maxBytes: 10_000_000, downloadWaitMs: 1_000 },
      page,
      83626,
    );
    expect(fail2.status).toBe('incomplete');

    // Bước 3: Thất bại do Corrupted Hash
    setEndpoint('/download/corrupted');
    const fail3 = await downloadViaBrowser(
      { tmpDir: tempBaseDir, maxBytes: 10_000_000, expectedSha256: validSha256, downloadWaitMs: 1_000 },
      page,
      83626,
    );
    expect(fail3.status).toBe('incomplete');

    // Bước 4: Thành công ngay lập tức sau 3 failures liên tiếp mà KHÔNG cần restart page/browser
    setEndpoint('/download/valid');
    const success = await downloadViaBrowser(
      { tmpDir: tempBaseDir, maxBytes: 10_000_000, expectedSha256: validSha256, downloadWaitMs: 3_000 },
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

    // Verify temp directory contains ONLY the one published jar
    const finalFiles = readdirSync(tempBaseDir);
    expect(finalFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(1);
    expect(finalFiles.filter((f) => f.endsWith('.part'))).toHaveLength(0);
    expect(finalFiles.filter((f) => f.endsWith('.crdownload'))).toHaveLength(0);
  });
});
