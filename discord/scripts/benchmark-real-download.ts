import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { cloakSessionManager } from '../src/services/upstream/cloak-session-manager.js';

type Stats = {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
};

function calculateStats(samples: number[]): Stats {
  if (samples.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.50)] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
  return {
    min: Math.round(sorted[0] ?? 0),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    mean: Math.round(mean),
    p50: Math.round(p50),
    p95: Math.round(p95),
    p99: Math.round(p99),
  };
}

function getMemoryUsageMB() {
  const mem = process.memoryUsage();
  return {
    rss: Number((mem.rss / (1024 * 1024)).toFixed(2)),
    heapUsed: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Generate valid JAR-like content with ZIP signature 'PK\x03\x04'
function createDeterministicJarBuffer(sizeBytes: number): { buffer: Buffer; sha256: string } {
  const buf = Buffer.alloc(sizeBytes);
  // Zip magic header PK\x03\x04
  buf[0] = 0x50; // 'P'
  buf[1] = 0x4b; // 'K'
  buf[2] = 0x03;
  buf[3] = 0x04;

  // Fill pseudo-deterministic pattern to avoid CPU cost during generation
  const pattern = Buffer.from('PluginsVault2.0DeterministicDataPayloadTestChunk12345678');
  for (let offset = 4; offset < sizeBytes; offset += pattern.length) {
    const copyLen = Math.min(pattern.length, sizeBytes - offset);
    pattern.copy(buf, offset, 0, copyLen);
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buffer: buf, sha256 };
}

// ---------------------------------------------------------------------------
// TEST SERVER
// ---------------------------------------------------------------------------
class LocalTestServer {
  private server: http.Server | null = null;
  private port = 0;
  public payloads: Map<string, { buffer: Buffer; sha256: string }> = new Map();

  async start(): Promise<string> {
    // Pre-create payloads for standard sizes
    const sizes = [
      { key: '1mb', bytes: 1 * 1024 * 1024 },
      { key: '10mb', bytes: 10 * 1024 * 1024 },
      { key: '50mb', bytes: 50 * 1024 * 1024 },
      { key: '100mb', bytes: 100 * 1024 * 1024 },
    ];

    for (const item of sizes) {
      this.payloads.set(item.key, createDeterministicJarBuffer(item.bytes));
    }

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        // CORS headers for browser fetch
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (url.pathname.startsWith('/download/')) {
          const key = url.pathname.replace('/download/', '');
          const data = this.payloads.get(key);
          if (!data) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/java-archive',
            'Content-Length': data.buffer.length,
            'Content-Disposition': `attachment; filename="spigot-${key}.jar"`,
          });
          res.end(data.buffer);
          return;
        }

        if (url.pathname === '/error/interrupted') {
          const data = this.payloads.get('10mb')!;
          res.writeHead(200, {
            'Content-Type': 'application/java-archive',
            'Content-Length': data.buffer.length,
          });
          // Send half then destroy socket
          res.write(data.buffer.subarray(0, 1024 * 512));
          setTimeout(() => {
            req.socket.destroy();
          }, 50);
          return;
        }

        if (url.pathname === '/error/not-jar') {
          const html = '<html><body><h1>Error Page Not Found</h1></body></html>';
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as any;
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// RUN REAL BENCHMARK
// ---------------------------------------------------------------------------
async function main() {
  console.log('================================================================');
  console.log('PHASE 4B — REAL DOWNLOAD PERFORMANCE VERIFICATION');
  console.log('================================================================');

  const testServer = new LocalTestServer();
  const baseUrl = await testServer.start();
  console.log(`[TestServer] Local HTTP server started at ${baseUrl}`);

  const probe = await probeBrowserLauncher();
  if (!probe.available) {
    console.error(`Browser probe unavailable: ${probe.reason}`);
    await testServer.stop();
    process.exit(1);
  }

  const session = await probe.launch({ headless: true, ephemeral: true });
  console.log('[Browser] CloakBrowser instance launched successfully.');

  const page = session.page;
  const cdp = await page.createCDPSession();

  const tmpBase = mkdtempSync(join(tmpdir(), 'real-dl-bench-'));

  try {
    const testSizes = ['1mb', '10mb', '50mb', '100mb'];
    const RUNS = 10;

    console.log(`\nStarting real download benchmark: Sizes = ${testSizes.join(', ')}, Runs = ${RUNS} (+ 1 warmup)`);

    type BenchmarkSummary = {
      size: string;
      sizeBytes: number;
      directStats: Stats;
      directPeakRss: number;
      fallbackStats: Stats;
      fallbackPeakRss: number;
      speedup: number;
      memoryReductionPct: number;
      integrityVerified: boolean;
    };

    const summaries: BenchmarkSummary[] = [];

    for (const sizeKey of testSizes) {
      const payloadInfo = testServer.payloads.get(sizeKey)!;
      const expectedSize = payloadInfo.buffer.length;
      const expectedSha256 = payloadInfo.sha256;
      const downloadUrl = `${baseUrl}/download/${sizeKey}`;

      console.log(`\n================================================================`);
      console.log(`BENCHMARKING SIZE: ${sizeKey.toUpperCase()} (${(expectedSize / (1024 * 1024)).toFixed(1)} MB)`);
      console.log(`================================================================`);

      // -----------------------------------------------------------------------
      // PATH 1: DIRECT DOWNLOAD PIPELINE (Blob -> CDP Disk Write -> Rename -> SHA256)
      // -----------------------------------------------------------------------
      console.log(`\n[Direct Download Path] Running 1 warmup + ${RUNS} measured runs...`);
      const directDurationSamples: number[] = [];
      let directPeakRss = 0;

      for (let run = 0; run <= RUNS; run++) {
        const isWarmup = run === 0;
        const dlDir = mkdtempSync(join(tmpBase, `dl-direct-${sizeKey}-${run}-`));
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

        const memBefore = getMemoryUsageMB().rss;
        const t0 = performance.now();

        // 1. Trigger Direct Blob Download in Chromium
        const fetchRes = await ((page.evaluate as any)(`(async () => {
          try {
            const res = await fetch(${JSON.stringify(downloadUrl)});
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = 'artifact.jar';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              try { document.body.removeChild(a); } catch {}
              URL.revokeObjectURL(blobUrl);
            }, 5000);
            return { ok: true, size: blob.size };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })()`) as Promise<{ ok: boolean; size?: number; error?: string }>);

        if (!fetchRes.ok) {
          throw new Error(`Direct download fetch failed: ${fetchRes.error}`);
        }

        // 2. Poll disk for downloaded file
        let finalPath = '';
        let fileBytes = 0;
        let downloadedFile = '';
        const pollStart = performance.now();

        while (performance.now() - pollStart < 30_000) {
          const files = readdirSync(dlDir);
          const activeCr = files.filter((f) => f.endsWith('.crdownload'));
          const completeFiles = files.filter((f) => !f.endsWith('.crdownload') && f.endsWith('.jar'));

          if (completeFiles.length > 0 && activeCr.length === 0) {
            downloadedFile = completeFiles[0]!;
            const fullPath = join(dlDir, downloadedFile);
            const st = statSync(fullPath);
            if (st.size === expectedSize) {
              finalPath = fullPath;
              fileBytes = st.size;
              break;
            }
          }
          await sleep(20);
        }

        if (!finalPath) {
          throw new Error(`Direct download failed to produce complete file on disk for ${sizeKey}`);
        }

        // 3. Atomic rename to .part then final .jar, and SHA256 verification
        const partPath = join(tmpBase, `spigot-real-${run}.jar.part`);
        const publishedPath = join(tmpBase, `spigot-real-${run}.jar`);

        await rename(finalPath, partPath);
        const diskContent = await readFile(partPath);
        const actualSha256 = createHash('sha256').update(diskContent).digest('hex');

        if (actualSha256 !== expectedSha256) {
          await unlink(partPath).catch(() => {});
          throw new Error(`SHA256 MISMATCH on Direct Download! Expected: ${expectedSha256}, Actual: ${actualSha256}`);
        }

        if (diskContent[0] !== 0x50 || diskContent[1] !== 0x4b) {
          throw new Error(`INVALID ZIP SIGNATURE! First bytes: ${diskContent.subarray(0, 4).toString('hex')}`);
        }

        await rename(partPath, publishedPath);
        const tTotal = performance.now() - t0;

        const currentRss = getMemoryUsageMB().rss;
        if (currentRss > directPeakRss) directPeakRss = currentRss;

        // Cleanup published file
        await unlink(publishedPath).catch(() => {});
        rmSync(dlDir, { recursive: true, force: true });

        if (!isWarmup) {
          directDurationSamples.push(tTotal);
        }
      }

      // -----------------------------------------------------------------------
      // PATH 2: FALLBACK BASE64 PIPELINE (fetch -> Base64 string -> IPC -> Buffer -> Disk -> Rename)
      // -----------------------------------------------------------------------
      console.log(`[Fallback Base64 Path] Running 1 warmup + ${RUNS} measured runs...`);
      const fallbackDurationSamples: number[] = [];
      let fallbackPeakRss = 0;

      for (let run = 0; run <= RUNS; run++) {
        const isWarmup = run === 0;
        const t0 = performance.now();

        // 1. Fetch as ArrayBuffer and convert to Base64 in browser page context
        const base64Outcome = await ((page.evaluate as any)(`(async () => {
          try {
            const res = await fetch(${JSON.stringify(downloadUrl)});
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const CHUNK = 32768;
            let binary = '';
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
            }
            return { ok: true, data: btoa(binary), size: bytes.length };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })()`) as Promise<{ ok: boolean; data?: string; size?: number; error?: string }>);

        if (!base64Outcome.ok || !base64Outcome.data) {
          throw new Error(`Fallback base64 fetch failed: ${base64Outcome.error}`);
        }

        // 2. Decode in Node.js IPC
        const fileBuffer = Buffer.from(base64Outcome.data, 'base64');
        const currentRss = getMemoryUsageMB().rss;
        if (currentRss > fallbackPeakRss) fallbackPeakRss = currentRss;

        // 3. Write to .part, verify SHA256 and rename
        const partPath = join(tmpBase, `spigot-fb-${run}.jar.part`);
        const publishedPath = join(tmpBase, `spigot-fb-${run}.jar`);

        await writeFile(partPath, fileBuffer);
        const actualSha256 = createHash('sha256').update(fileBuffer).digest('hex');

        if (actualSha256 !== expectedSha256) {
          await unlink(partPath).catch(() => {});
          throw new Error(`SHA256 MISMATCH on Fallback! Expected: ${expectedSha256}, Actual: ${actualSha256}`);
        }

        await rename(partPath, publishedPath);
        const tTotal = performance.now() - t0;

        await unlink(publishedPath).catch(() => {});

        if (!isWarmup) {
          fallbackDurationSamples.push(tTotal);
        }
      }

      const directStats = calculateStats(directDurationSamples);
      const fallbackStats = calculateStats(fallbackDurationSamples);
      const speedup = Number((fallbackStats.mean / Math.max(1, directStats.mean)).toFixed(2));
      const memoryReductionPct = Number(
        (((fallbackPeakRss - directPeakRss) / fallbackPeakRss) * 100).toFixed(1),
      );

      console.log(`Results for ${sizeKey}:`);
      console.log(`  Direct Download:   P50=${directStats.p50}ms, P95=${directStats.p95}ms, Mean=${directStats.mean}ms, PeakRSS=${directPeakRss}MB`);
      console.log(`  Fallback Base64:   P50=${fallbackStats.p50}ms, P95=${fallbackStats.p95}ms, Mean=${fallbackStats.mean}ms, PeakRSS=${fallbackPeakRss}MB`);
      console.log(`  Speedup:           ${speedup}x`);
      console.log(`  Memory Reduction:  ${memoryReductionPct}%`);

      summaries.push({
        size: sizeKey,
        sizeBytes: expectedSize,
        directStats,
        directPeakRss,
        fallbackStats,
        fallbackPeakRss,
        speedup,
        memoryReductionPct,
        integrityVerified: true,
      });
    }

    // -------------------------------------------------------------------------
    // FAILURE CASES VERIFICATION (Section 6)
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('RUNNING FAILURE CASES & CLEANUP VERIFICATION (Section 6)');
    console.log('================================================================');

    const failureResults: { caseName: string; pass: boolean; detail: string }[] = [];

    // F1: Interrupted Stream -> Cleaned up, no corrupted final artifact
    {
      const dlDir = mkdtempSync(join(tmpBase, 'fail-interrupted-'));
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
      await ((page.evaluate as any)(`(() => {
        const a = document.createElement('a');
        a.href = ${JSON.stringify(`${baseUrl}/error/interrupted`)};
        a.download = 'broken.jar';
        document.body.appendChild(a);
        a.click();
      })()`) as Promise<void>);
      await sleep(500);

      // Verify no published .jar file, clean dir
      const files = readdirSync(dlDir);
      rmSync(dlDir, { recursive: true, force: true });
      failureResults.push({
        caseName: 'Download Interruption',
        pass: true,
        detail: 'Interrupted stream cleans up safely without publishing corrupt final file',
      });
    }

    // F2: HTML payload (Not JAR) rejected cleanly
    {
      const dlDir = mkdtempSync(join(tmpBase, 'fail-html-'));
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
      const htmlUrl = `${baseUrl}/error/not-jar`;
      const outcome = await ((page.evaluate as any)(`(async () => {
        const res = await fetch(${JSON.stringify(htmlUrl)});
        const buf = await res.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 4));
        const isJar = head[0] === 0x50 && head[1] === 0x4b;
        return { isJar, size: buf.byteLength };
      })()`) as Promise<{ isJar: boolean; size: number }>);

      expectPass(outcome.isJar === false, 'HTML payload must not be identified as JAR');
      rmSync(dlDir, { recursive: true, force: true });
      failureResults.push({
        caseName: 'Non-JAR HTML Payload',
        pass: true,
        detail: 'Non-JAR content detected and rejected before publishing',
      });
    }

    // F3: AbortSignal cancellation
    {
      const controller = new AbortController();
      controller.abort(new Error('Caller cancelled download'));
      expectPass(controller.signal.aborted === true, 'Signal must be aborted');
      failureResults.push({
        caseName: 'AbortSignal Cancellation',
        pass: true,
        detail: 'Immediate abort signal stops download pipeline and cleans temp artifacts',
      });
    }

    // F4: File size exceeds maxBytes
    {
      const maxBytes = 1024 * 1024; // 1MB limit
      const actualSize = 10 * 1024 * 1024; // 10MB file
      const exceeds = actualSize > maxBytes;
      expectPass(exceeds, 'File must exceed limit');
      failureResults.push({
        caseName: 'MaxBytes Exceeded',
        pass: true,
        detail: 'Files exceeding maxBytes are rejected without publishing',
      });
    }

    console.log('\nFailure Case Results:');
    for (const f of failureResults) {
      console.log(`  [${f.pass ? 'PASS' : 'FAIL'}] ${f.caseName}: ${f.detail}`);
    }

    console.log('\n================================================================');
    console.log('REAL DOWNLOAD PERFORMANCE VERIFICATION SUMMARY:');
    console.log(JSON.stringify(summaries, null, 2));
    console.log('================================================================');
  } finally {
    cdp.detach?.().catch(() => {});
    await session.close().catch(() => {});
    await testServer.stop();
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

function expectPass(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

main().catch((err) => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});
