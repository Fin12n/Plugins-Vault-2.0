import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { cloakSessionManager } from '../src/services/upstream/cloak-session-manager.js';
import { createAbruptCloseTracker } from '../src/services/upstream/chrome-close-detector.js';

function countOrphanBrowsers(): number {
  try {
    if (process.platform === 'win32') {
      const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
      const matches = output.match(/chrome\.exe/gi);
      return matches ? matches.length : 0;
    } else {
      const output = execSync('pgrep -c -x chrome || true', { encoding: 'utf8' });
      return parseInt(output.trim() || '0', 10);
    }
  } catch {
    return 0;
  }
}

function countTempDirs(): number {
  const tmp = tmpdir();
  try {
    const list = readdirSync(tmp);
    return list.filter((f) => f.startsWith('cloak-')).length;
  } catch {
    return 0;
  }
}

async function runBenchmark() {
  console.log('====================================================');
  console.log('PHASE 4A BASELINE BENCHMARK');
  console.log('====================================================');

  const rssBefore = process.memoryUsage().rss / (1024 * 1024);
  const orphanBefore = countOrphanBrowsers();
  const tempDirsBefore = countTempDirs();

  console.log(`Initial RSS: ${rssBefore.toFixed(2)} MB`);
  console.log(`Initial Chrome processes: ${orphanBefore}`);
  console.log(`Initial Cloak temp dirs: ${tempDirsBefore}`);

  const probe = await probeBrowserLauncher();
  let launchMs = 0;
  let activationMs = 0;
  let totalAcquisitionMs = 0;
  let activeCdpCount = 0;

  if (probe.available) {
    console.log('[CloakBrowser Available] Running live browser benchmark...');
    const t0 = performance.now();
    const session = await probe.launch({ headless: true, ephemeral: true });
    const t1 = performance.now();
    launchMs = t1 - t0;

    const t2 = performance.now();
    const cdp = await session.page.createCDPSession();
    activeCdpCount = 1;
    await cdp.send('Page.enable');
    const t3 = performance.now();
    activationMs = t3 - t2;

    await cdp.detach?.();
    activeCdpCount = 0;

    await session.close();
    const t4 = performance.now();
    totalAcquisitionMs = t4 - t0;
  } else {
    console.log(`[CloakBrowser Not Available locally: ${probe.reason}]`);
    console.log('Benchmarking Session Management & Lifecycle Engine directly...');

    const t0 = performance.now();
    const lock = await cloakSessionManager.acquireLock('benchmark-task');
    const tracker = createAbruptCloseTracker();
    const t1 = performance.now();
    launchMs = t1 - t0;

    const t2 = performance.now();
    // Simulate CDP initialization and cookie session setup
    activeCdpCount = 1; // 1 active
    await new Promise((r) => setTimeout(r, 10)); // simulate roundtrip
    activeCdpCount = 0; // detached
    const t3 = performance.now();
    activationMs = t3 - t2;

    tracker.dispose();
    await lock.release();
    const t4 = performance.now();
    totalAcquisitionMs = t4 - t0;
  }

  const rssAfter = process.memoryUsage().rss / (1024 * 1024);
  const orphanAfter = countOrphanBrowsers();
  const tempDirsAfter = countTempDirs();

  const report = {
    browserLaunchMs: Math.round(launchMs),
    sessionActivationMs: Math.round(activationMs),
    acquisitionTotalMs: Math.round(totalAcquisitionMs),
    rssBeforeMB: Number(rssBefore.toFixed(2)),
    rssAfterMB: Number(rssAfter.toFixed(2)),
    rssDeltaMB: Number((rssAfter - rssBefore).toFixed(2)),
    activeCdpSessions: activeCdpCount,
    orphanBrowserCountBefore: orphanBefore,
    orphanBrowserCountAfter: orphanAfter,
    orphanBrowserDelta: orphanAfter - orphanBefore,
    tempDirectoryCountBefore: tempDirsBefore,
    tempDirectoryCountAfter: tempDirsAfter,
    tempDirectoryDelta: tempDirsAfter - tempDirsBefore,
  };

  console.log('\n--- BASELINE METRICS RESULT ---');
  console.log(JSON.stringify(report, null, 2));
  console.log('====================================================\n');
}

runBenchmark().catch(console.error);
