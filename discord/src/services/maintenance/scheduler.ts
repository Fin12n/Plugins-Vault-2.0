import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import type { Db } from '../../db/connection.js';
import { getSettings, setSetting } from '../../db/settings-store.js';
import type { Env } from '../../config/env.js';
import { expireStaleOrders } from '../../repositories/orders.js';
import { expireStaleTopups } from '../../repositories/wallet-topups.js';
import { expireStaleOrders as expireStaleOrdersNeon } from '../../repositories/neon-orders.js';
import { expireStaleTopups as expireStaleTopupsNeon } from '../../repositories/neon-wallet-topups.js';
import type { Database } from '../../db/neon.js';
import { isCard2kConfigured, type Card2kConfig } from '../card/card2k-client.js';
import { pollPendingCards } from '../card/submit-card-topup.js';
import { sweepExpiredTokens } from '../delivery/mint-download-token.js';
import { checkPluginUpdates, formatUpdateNotice, type UpdateFinding } from '../upstream/check-plugin-updates.js';
import { enqueueDownload, listAllPendingDownloads, listDueDownloads } from '../../repositories/pending-download.js';
import { findPluginById } from '../../repositories/plugins.js';
import { listVersionsByPlugin } from '../../repositories/versions.js';
import {
  clearScanError,
  findScanRetry,
  forgetScanState,
  listScanStates,
  recordScan,
  selectAccountsDueForScan,
} from '../../repositories/account-scan-state.js';
import { findOwner, findOwners, recordOwnership, listAccountOwnedPlugins } from '../../repositories/resource-ownership.js';
import { listEnabledSpigotAccounts, listSpigotAccounts, updateSpigotAccountSession } from '../../repositories/spigot-accounts.js';
import { exportPluginJar } from '../storage/export-plugin-file.js';
import { countPlugins, listPlugins } from '../../repositories/plugins.js';
import { normalizeName } from '../upstream/sync-purchased-resources.js';
import { autoDownloadVersions, type AutoDownloadOutcome, type SweepResult } from '../upstream/auto-download-versions.js';
import { isChromeClosedError } from '../upstream/chrome-close-detector.js';
import { formatAbortReason, formatDownloadOutcome } from '../upstream/format-download-outcome.js';
import {
  Secret,
  checkAccountsFilePermissions,
  loadSpigotAccounts,
  needsRefresh,
  type SpigotAccount,
} from '../upstream/spigot-account-store.js';
import {
  checkCredentialsFilePermissions,
  enabledSpigotCredentials,
  loadSpigotCredentials,
  type Credential,
} from '../upstream/spigot-credential-store.js';
import { seedImportedPurchasedResources } from '../upstream/seed-imported-purchased-resources.js';
import { autoResolveMissingResourceIds } from '../upstream/auto-resolve-resource-ids.js';
import {
  downloadViaBrowser,
  injectSpigotSessionCookies,
  loginToSpigot,
  tryClickTurnstile,
  type BrowserSession,
  type ChallengeSolver,
  type LoginResult,
} from '../upstream/download-via-browser.js';
import {
  accountProfileDir,
  probeBrowserLauncher,
  pruneOrphanProfiles,
  type LauncherProbe,
} from '../upstream/browser-launcher.js';
import { HierarchicalDeadline } from '../upstream/hierarchical-deadline.js';
import { cloakSessionManager } from '../upstream/cloak-session-manager.js';
import {
  extractAndSaveCookiesFromPage,
  injectCookiesFromAccountFile,
  loadAccountCookiesFromFile,
} from '../upstream/spigot-cookie-files.js';
import { scanPurchasedResources } from '../upstream/scan-purchased-resources.js';
import {
  buildSpigotProxyPool,
  isProxyFailure,
  type ProxyEndpoint,
  type SpigotProxyPool,
} from '../upstream/spigot-proxy-pool.js';
import {
  buildChallengeSolverPool,
  type ChallengeSolverPool,
} from '../upstream/cloudflare-clearance.js';
import { formatSyncOutcome, syncPurchasedResources } from '../upstream/sync-purchased-resources.js';
import type { DownloadOutcome } from '../upstream/download-spigot-resource.js';
import type { SpigotChallengeSessionManager } from '../upstream/spigot-challenge-session.js';
import { SpigotAccountCooldowns } from '../upstream/spigot-account-cooldown.js';
import { SpigetClient } from '../upstream/spiget-client.js';
import { formatPruneLog, pruneOldVersions } from './prune-old-versions.js';
import { sweepLogs } from './sweep-logs.js';
import { instanceTracker } from './instance-tracker.js';

export { sweepLogs } from './sweep-logs.js';
export { instanceTracker } from './instance-tracker.js';

/** Theo dõi toàn bộ các phiên Chrome browser đang hoạt động để đóng sạch khi dừng khẩn cấp. */
const activeSessions = new Map<number, BrowserSession>();

const ORDER_SWEEP_INTERVAL = 60 * 1000;
const TOKEN_SWEEP_INTERVAL = 15 * 60 * 1000;
/** Matches card2k's own client, which polls every 60 seconds. */
const CARD_POLL_INTERVAL = 60 * 1000;
/** Matches the upstream cache lifetime; polling faster would only read cache. */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
const PRUNE_INTERVAL = 24 * 60 * 60 * 1000;
/**
 * Grace period before the first update check.
 *
 * Long enough for the Discord login to settle so results land in the channel
 * rather than only the console, short enough that a restart is a practical way
 * to verify the setup.
 */
const STARTUP_CHECK_DELAY = 30 * 1000;
/**
 * Khoảng cách giữa hai lần quét danh sách đã mua của CÙNG một tài khoản.
 *
 * Danh sách chỉ đổi khi chủ bot mua thêm, nên quét lại mỗi giờ là vô nghĩa và
 * với nhiều tài khoản thì nó chiếm hết thời gian của việc tải.
 */
const PURCHASED_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Chờ trước khi thử lại một tài khoản quét lỗi.
 *
 * Ngắn hơn hẳn chu kỳ thường: nguyên nhân hay gặp là sai mật khẩu hoặc Cloudflare
 * chặn nhất thời, cả hai đều được sửa trong vài phút. Bắt chờ đủ 24 giờ nghĩa là
 * chủ bot sửa xong vẫn phải đợi hết ngày mới thấy kết quả.
 */
const FAILED_SCAN_RETRY_MS = 60 * 60 * 1000;
/**
 * Số tài khoản quét tối đa mỗi lượt.
 *
 * Mỗi tài khoản mất khoảng 45 giây, nên 5 tài khoản là khoảng 4 phút — đủ ngắn
 * để việc tải vẫn kịp chạy trong cùng lượt. Số còn lại chờ lượt sau; với 100 tài
 * khoản thì cần khoảng 20 lượt để đi hết một vòng, tức dưới một ngày.
 */
const MAX_ACCOUNTS_PER_SCAN = 5;
/**
 * Ceiling on how long shutdown waits for an in-flight sweep to release Chrome.
 *
 * Long enough for a download to finish its current step and the browser to flush
 * cookies; short enough that a hung close cannot keep a daemon alive forever.
 */
const SHUTDOWN_GRACE_MS = 15 * 1000;
/**
 * Cookie age at which the owner is warned to re-login.
 *
 * XenForo caps `xf_user` at 30 days and the ceiling is not configurable, so this
 * leaves ten days of margin. Only relevant in cookie mode — with a credentials
 * file the bot re-logins every sweep and never reaches the cliff.
 */
const COOKIE_REFRESH_DAYS = 20;

export type MaintenanceDeps = {
  db: Db;
  neonDb?: Database;
  env: Env;
  vaultDir: string;
  client?: Client;
  challengeSessions?: SpigotChallengeSessionManager;
  challengeCooldowns?: SpigotAccountCooldowns;
  /**
   * Bể proxy dùng cho mọi lần mở trình duyệt.
   *
   * Tiêm vào để test kiểm được việc xoay proxy mà không cần proxy thật; mặc định
   * dựng từ .env một lần lúc khởi động, vì trạng thái "proxy này vừa hỏng" chỉ có
   * ích khi nó sống qua nhiều lượt quét.
   */
  proxyPool?: SpigotProxyPool;
  /**
   * Người mua `cf_clearance` khi Chrome không tự vượt được Cloudflare.
   *
   * Cùng lý do tiêm và sống lâu như `proxyPool`, cộng một lý do riêng: vé mua được sống
   * ~1 giờ còn lượt quét lặp mỗi ~5 phút, nên một bể dựng lại theo từng lượt sẽ mua lại
   * đúng một cái vé chín lần một giờ. `undefined` khi chưa cấu hình YesCaptcha, và lúc
   * đó mọi đường đi giống hệt trước.
   */
  challengeSolvers?: ChallengeSolverPool;
  spiget?: SpigetClient;
  /**
   * card2k credentials. Absent or incomplete means card top-ups never run — the
   * poll sweep checks this every tick rather than only at boot, so a deployment
   * missing the signature formula cannot resolve cards it should not have taken.
   */
  card?: Card2kConfig;
  /**
   * Aborts an in-flight sweep at shutdown.
   *
   * Threaded through the deps rather than added as a parameter to every sweep
   * function: it is ambient for the whole run, and five extra parameters would
   * obscure that.
   */
  signal?: AbortSignal;
};

export type SweepOptions = {
  maxPerSweep?: number;
  continueOnError?: boolean;
  maxRetriesPerFinding?: number;
};

export type MaintenanceOperation = 'idle' | 'scanning' | 'downloading';

export type MaintenanceHandle = {
  stop: () => Promise<void>;
  runUpdateCheck: (options?: { forcePurchasedScan?: boolean }) => Promise<void>;
  triggerUpdateCheck: (forcePurchasedScan?: boolean) => boolean;
  getUpdateStatus: () => UpdateRunStatus;
  getCurrentOperation: () => MaintenanceOperation;
  runPrune: () => Promise<void>;
  runFullBatchDownload: (options?: { autoResolveIds?: boolean }) => Promise<void>;
  triggerFullBatchDownload: (options?: { autoResolveIds?: boolean }) => boolean;
  runScanOnly?: () => Promise<void>;
  triggerScanOnly?: () => boolean;
  runOrderedDownloadNow?: (options?: { targetResourceId?: number }) => Promise<void>;
  triggerOrderedDownload?: (options?: { targetResourceId?: number }) => boolean;
  abortSweep?: () => Promise<boolean>;
  rotateProxy?: () => Promise<{ ok: boolean; currentProxyIp: string | null; error?: string }>;
};

export type UpdateRunStatus = {
  running: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
};

/**
 * Periodic housekeeping.
 *
 * Plain intervals rather than a cron dependency: the cadences are fixed and a
 * missed tick is harmless, since every job is set-based rather than incremental.
 * Each job guards against overlapping runs, and unref() keeps the timers from
 * holding the process open during shutdown.
 */
export function startMaintenance(input: MaintenanceDeps): MaintenanceHandle {
  const spiget = input.spiget ?? new SpigetClient();
  let updateInFlight = false;
  let currentOperation: MaintenanceOperation = 'idle';
  let lastStartedAt: number | null = null;
  let lastFinishedAt: number | null = null;
  let pruneInFlight = false;

  /**
   * Signals an in-flight sweep to stop, and lets `stop()` await it.
   *
   * A sweep holds a browser open for minutes. Clearing timers does not reach it,
   * and the process then exits through `process.exit`, killing Chrome before it
   * flushes its cookie database — which loses the Cloudflare clearance the next
   * sweep would have reused. Tracking the promise is what makes shutdown able to
   * wait for the `finally` that closes the browser.
   */
  const shutdownSignal = new AbortController();
  let inFlightSweep: Promise<void> | null = null;
  /** Follow-up sweep scheduled while a backlog remains; cleared on shutdown. */
  let backlogTimer: NodeJS.Timeout | null = null;
  let currentSweepController: AbortController | null = null;

  // Every downstream call reads the signal from deps, so it is attached once here
  // rather than passed through five call sites.
  const deps: MaintenanceDeps = {
    ...input,
    signal: input.signal ?? shutdownSignal.signal,
    proxyPool: input.proxyPool ?? buildConfiguredProxyPool(input.env),
    challengeSolvers: input.challengeSolvers ?? buildConfiguredSolverPool(input.env),
    challengeCooldowns:
      input.challengeCooldowns ?? new SpigotAccountCooldowns(
        input.env.SPIGOT_CHALLENGE_COOLDOWN_MS,
        Date.now,
        {
          read: (label) => findScanRetry(input.db, label, PURCHASED_SCAN_INTERVAL_MS),
          write: (label, reason, durationMs) => recordScan(input.db, label, 0, reason, {
            retryAfterMs: durationMs,
            intervalMs: PURCHASED_SCAN_INTERVAL_MS,
          }),
          clear: (label) => clearScanError(input.db, label),
        },
      ),
  };

  // Khởi động Cron định kỳ kiểm tra timer SPIGOT_PROXY_COOLDOWN_MS để đổi IP mới
  if (deps.proxyPool) {
    deps.proxyPool.startAutoRotateCron({
      intervalMs: deps.env.SPIGOT_PROXY_COOLDOWN_MS,
      isSweepActive: () => updateInFlight,
      onRotated: (lease, isStaged) => {
        const ip = lease.endpoint.server.replace(/^[a-z]+:\/\//i, '');
        if (!isStaged) {
          sweepLogs.setCurrentProxyIp(ip);
        }
      },
      log: (msg, level) => {
        sweepLogs.add(msg, level ?? 'info');
      },
    });
  }

  const createSweepDeps = (): { sweepDeps: MaintenanceDeps; controller: AbortController } => {
    const controller = new AbortController();
    if (deps.signal) {
      if (deps.signal.aborted) {
        controller.abort();
      } else {
        deps.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    return {
      controller,
      sweepDeps: {
        ...deps,
        signal: controller.signal,
      },
    };
  };

  const runUpdateCheck = async (options: { forcePurchasedScan?: boolean } = {}): Promise<void> => {
    if (updateInFlight) return;
    updateInFlight = true;
    lastStartedAt = Date.now();
    const { controller, sweepDeps } = createSweepDeps();
    currentSweepController = controller;
    sweepLogs.add('Bắt đầu lượt kiểm tra cập nhật & tải plugin...', 'info');
    try {
      // Imported reports are local data, so reconcile them every sweep even while
      // downloads are backlogged. This lets a resource id learned later inherit
      // the account ownership already present in the dashboard import.
      seedImportedInventory(sweepDeps);

      // A queued exact version is immediately actionable. Scanning another
      // account first can park the only browser behind Cloudflare and starve the
      // entire download queue, so inventory discovery resumes only after the
      // backlog has drained.
      const backlogCount = listAllPendingDownloads(sweepDeps.db).length;
      let purchasedAccountsRemaining = 0;
      if (backlogCount > 0 && !options.forcePurchasedScan) {
        sweepLogs.add(`📦 Đang có ${backlogCount} bản nợ trong hàng đợi tải. Ưu tiên xử lý tải trước...`, 'info');
      } else {
        purchasedAccountsRemaining = await tryDiscoverPurchased(sweepDeps, options.forcePurchasedScan === true);
      }

      sweepLogs.add('🔍 Đang kiểm tra phiên bản mới từ Spiget API...', 'info');
      const outcome = await checkPluginUpdates(sweepDeps.db, spiget, console, (idx, total, name) => {
        if (idx === 1 || idx % 5 === 0 || idx === total) {
          sweepLogs.add(`🔍 [${idx}/${total}] Đang đối chiếu Spiget: ${name}...`, 'info');
        }
      });
      if (outcome.failed > 0) {
        console.warn(`Kiểm tra cập nhật: ${outcome.checked} thành công, ${outcome.failed} lỗi`);
      }

      // Replay versions owed from earlier failed sweeps. Without this a single
      // transient failure loses the version permanently: detection has already
      // recorded upstream_state, so it is never re-offered.
      const owed = owedFindings(sweepDeps);

      // Lần đầu với một plugin: lấy cả N bản gần nhất, không chỉ bản mới nhất.
      const keepCount = getSettings(sweepDeps.db, sweepDeps.env).pruneKeepCount;
      sweepLogs.add(`📦 Đang kiểm tra phiên bản để đảm bảo đủ ${keepCount} bản/plugin theo Cài đặt...`, 'info');
      const backfill = await backfillFindings(sweepDeps, spiget, keepCount);

      const seen = new Set<string>();
      const findings: UpdateFinding[] = [];
      for (const finding of [...outcome.findings, ...owed, ...backfill]) {
        const key = `${finding.pluginId}:${finding.upstream.uuid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding);
      }

      // Persist every detected version before any early return or browser work.
      // The VPS may have no usable browser (or be blocked by Cloudflare), while a
      // the next host-browser sweep can still drain this exact-version queue. enqueueDownload
      // is conflict-idempotent, so rediscovery never resets an existing backoff.
      for (const finding of findings) {
        enqueueDownload(sweepDeps.db, {
          pluginId: finding.pluginId,
          versionUuid: finding.upstream.uuid,
          versionName: finding.upstream.name,
        });
      }

      const extra = findings.length - outcome.findings.length;
      if (extra > 0) console.log(`Thêm ${extra} bản: nợ từ lượt trước hoặc bản cũ cần tải`);

      // Always say what the sweep saw. A silent return here is indistinguishable
      // from the scheduler never having run, which sends the owner hunting for a
      // fault when the real answer is "nothing needed downloading" or "no plugin
      // has a resource id yet".
      if (outcome.checked === 0 && findings.length === 0) {
        console.log(
          'Kiểm tra cập nhật: không có plugin nào được theo dõi. ' +
            'Bot lấy mã resource từ trang "đã mua" của Spigot — cần tệp tài khoản, ' +
            'công tắc tự động tải đang bật, và trình duyệt cài xong. ' +
            'Hoặc gán mã tay ở tab Plugin.',
        );
        sweepLogs.add('Kiểm tra cập nhật: Không có plugin nào được theo dõi (cần quét trang đã mua hoặc gán mã tay).', 'warn');
        scheduleFollowUp(purchasedAccountsRemaining);
        return;
      }
      if (findings.length === 0) {
        console.log(`Kiểm tra cập nhật: ${outcome.checked} plugin, tất cả đã là bản mới nhất`);
        sweepLogs.add(`Kiểm tra cập nhật: ${outcome.checked} plugin, tất cả đã là bản mới nhất.`, 'success');
        scheduleFollowUp(purchasedAccountsRemaining);
        return;
      }
      console.log(`Kiểm tra cập nhật: ${outcome.checked} plugin, ${findings.length} bản cần tải`);
      sweepLogs.add(`Kiểm tra cập nhật: ${outcome.checked} plugin, phát hiện ${findings.length} bản cần tải về kho.`, 'info');
      for (const finding of findings) {
        console.log(
          `  → ${finding.pluginName} ${finding.upstream.name} ` +
            `(kho đang có: ${finding.archivedVersion ?? 'chưa có bản nào'})`,
        );
        sweepLogs.add(`  → ${finding.pluginName} ${finding.upstream.name} (kho đang có: ${finding.archivedVersion ?? 'chưa có bản nào'})`, 'info');
      }

      const channel = sweepDeps.client
        ? await sweepDeps.client.channels.fetch(sweepDeps.env.DISCORD_NOTIFY_CHANNEL_ID).catch(() => null)
        : null;

      /**
       * Console always; Discord only when the owner needs to act.
       *
       * A backfill sweep produces one line per queued version — 33 of them on a
       * fresh vault — and sending all of those to Discord buries the two that
       * matter. The terminal keeps everything, because there a silent gap is
       * indistinguishable from a hung sweep.
       */
      const say = async (message: string, toDiscord = true): Promise<void> => {
        console.log(message.replace(/\*\*/g, ''));
        if (toDiscord && channel?.isSendable()) await channel.send(message).catch(() => undefined);
      };

      // Detection has already succeeded and been recorded at this point. Auto
      // download is a strictly additive step wrapped in its own try/catch, so a
      // broken download can never cost the owner the notification.
      let handled = new Set<number>();
      try {
        const result = await tryAutoDownload(sweepDeps, findings);
        if (result) {
          for (const outcome of result.outcomes) {
            // Discord hears about a finished jar, a parked jar, and a dead
            // cookie — the three cases the owner can act on. A retry is
            // bookkeeping: the queue already holds it and the next sweep tries
            // again, so announcing it is pure noise repeated every hour.
            const worthPinging =
              outcome.status === 'archived' || outcome.status === 'parked' || outcome.status === 'cookie_dead';
            const outcomeText = formatDownloadOutcome(outcome);
            await say(outcomeText, worthPinging);
            if (outcome.status === 'archived') {
              sweepLogs.add(`✅ ${outcomeText}`, 'success');
            } else if (outcome.status === 'cookie_dead') {
              sweepLogs.add(`❌ ${outcomeText}`, 'error');
            } else if (outcome.status === 'retrying') {
              sweepLogs.add(`⚠️ ${outcomeText}`, 'warn');
            } else {
              sweepLogs.add(outcomeText, 'info');
            }
          }
          handled = result.handledPluginIds;

          const abort = formatAbortReason(result.sweep);
          if (abort) {
            await say(abort);
            sweepLogs.add(abort, 'warn');
          }

          const archived = result.outcomes.filter((o) => o.status === 'archived').length;
          const retrying = result.outcomes.filter((o) => o.status === 'retrying').length;
          // One summary line instead of N notices. Sent only when something is
          // being retried, so a clean sweep stays quiet.
          if (retrying > 0) {
            const summaryMsg = `📦 Lượt quét: tải được ${archived}, còn ${retrying} bản sẽ thử lại. ` +
              `Còn ${findings.length - result.outcomes.length} bản chờ lượt sau.`;
            await say(summaryMsg);
            sweepLogs.add(summaryMsg, 'info');
          }
        }
      } catch (err) {
        console.error('Lỗi khi tải tự động:', err);
        sweepLogs.add(`Lỗi khi tải tự động: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }

      // Anything the downloader did not resolve still needs a notice — but on the
      // console only. On a fresh vault this is dozens of versions the bot is
      // already working through, and DMing the owner about each one every hour is
      // exactly the spam that made the real results unreadable.
      for (const finding of findings) {
        if (handled.has(finding.pluginId)) continue;
        await say(formatUpdateNotice(finding), false);
      }

      // Re-sweep soon while work remains, instead of waiting out the hourly tick.
      // The hour matches the upstream cache lifetime for CHECKING updates, which
      // is the wrong cadence for draining a backlog: a fresh vault owes dozens of
      // historical versions, and at one batch per hour a large archive takes weeks.
      scheduleFollowUp(purchasedAccountsRemaining);
    } catch (err) {
      console.error('Lỗi khi kiểm tra cập nhật:', err);
      sweepLogs.add(`Lỗi khi kiểm tra cập nhật: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      updateInFlight = false;
      lastFinishedAt = Date.now();
      if (currentSweepController === controller) {
        currentSweepController = null;
      }
      const promoted = deps.proxyPool?.promoteStagedProxy();
      if (promoted) {
        const promotedIp = promoted.endpoint.server.replace(/^[a-z]+:\/\//i, '');
        sweepLogs.setCurrentProxyIp(promotedIp);
        sweepLogs.add(`🔄 Lượt quét hoàn tất — Đã áp dụng IP Proxy mới cho lượt tiếp theo: ${promotedIp} (ID: ${promoted.endpoint.id})`, 'info');
      }
      sweepLogs.add('Hoàn tất lượt quét và tải plugin.', 'info');
    }
  };

  const runPrune = async (): Promise<void> => {
    if (pruneInFlight) return;
    pruneInFlight = true;
    try {
      const keepCount = getSettings(deps.db, deps.env).pruneKeepCount;
      const outcome = await pruneOldVersions({ db: deps.db, vaultDir: deps.vaultDir }, { keepCount });
      for (const line of formatPruneLog(outcome)) console.log(line);
      if (outcome.pruned.length > 0) {
        console.log(`Prune xong: ${outcome.pruned.length} bản, giải phóng ${(outcome.bytesFreed / 1048576).toFixed(1)} MB`);
      }
    } catch (err) {
      console.error('Lỗi khi prune:', err);
    } finally {
      pruneInFlight = false;
    }
  };

  const orders = setInterval(() => {
    try {
      if (deps.neonDb) {
        void expireStaleOrdersNeon(deps.neonDb).then(({ expired, refunded }) => {
          if (expired > 0) {
            const suffix = refunded > 0 ? `, hoàn coin cho ${refunded} đơn` : '';
            console.log(`Đã hết hạn ${expired} đơn chưa thanh toán (Neon)${suffix}`);
          }
        }).catch((err) => {
          console.error('Lỗi khi hết hạn đơn Neon:', err);
        });

        void expireStaleTopupsNeon(deps.neonDb).then((staleTopups) => {
          if (staleTopups > 0) console.log(`Đã hết hạn ${staleTopups} phiếu nạp ví (Neon)`);
        }).catch((err) => {
          console.error('Lỗi khi hết hạn topup Neon:', err);
        });
      } else {
        const { expired, refunded } = expireStaleOrders(deps.db);
        if (expired > 0) {
          const suffix = refunded > 0 ? `, hoàn coin cho ${refunded} đơn` : '';
          console.log(`Đã hết hạn ${expired} đơn chưa thanh toán${suffix}`);
        }
        const staleTopups = expireStaleTopups(deps.db);
        if (staleTopups > 0) console.log(`Đã hết hạn ${staleTopups} phiếu nạp ví`);
      }
    } catch (err) {
      console.error('Lỗi khi hết hạn đơn:', err);
    }
  }, ORDER_SWEEP_INTERVAL);

  const tokens = setInterval(() => {
    try {
      const removed = sweepExpiredTokens(deps.db);
      if (removed > 0) console.log(`Đã dọn ${removed} liên kết tải hết hạn`);
    } catch (err) {
      console.error('Lỗi khi dọn liên kết:', err);
    }
  }, TOKEN_SWEEP_INTERVAL);

  /**
   * card2k poll sweep.
   *
   * card2k sends no callback, so this is the only way a submitted card ever
   * resolves. Guarded against overlap: a sweep that runs longer than the interval
   * would otherwise have two passes checking the same card, and while the credit
   * claim makes that safe it doubles the request rate at a payment provider for no
   * benefit.
   */
  let cardPollInFlight = false;
  const cards = setInterval(() => {
    if (cardPollInFlight) return;
    if (!deps.card || !isCard2kConfigured(deps.card)) return;
    cardPollInFlight = true;
    const cardConfig = deps.card;

    void pollPendingCards(deps.db, cardConfig)
      .then((summary) => {
        if (summary.checked > 0) {
          console.log(
            `Kiểm tra ${summary.checked} thẻ đang chờ: ${summary.settled} xong, ${summary.credited} đã cộng ví`,
          );
        }
      })
      .catch((err: unknown) => {
        console.error('Lỗi khi kiểm tra thẻ:', err);
      })
      .finally(() => {
        cardPollInFlight = false;
      });
  }, CARD_POLL_INTERVAL);

  const runFullBatchDownload = async (options: { autoResolveIds?: boolean } = {}): Promise<void> => {
    if (updateInFlight) {
      sweepLogs.add('⚠️ Một tiến trình quét hoặc tải đang chạy, vui lòng đợi hoàn tất.', 'warn');
      return;
    }
    updateInFlight = true;
    lastStartedAt = Date.now();
    const { controller, sweepDeps } = createSweepDeps();
    currentSweepController = controller;
    sweepLogs.add('🚀 Bắt đầu quy trình TẢI TẤT CẢ & TỰ ĐỘNG GẮN ID...', 'info');

    try {
      const currentSettings = getSettings(sweepDeps.db, sweepDeps.env);
      if (!currentSettings.autoDownloadEnabled) {
        setSetting(sweepDeps.db, 'auto_download_enabled', 'true');
        sweepLogs.add('⚙️ Đã tự động kích hoạt "Tự động tải Spigot" trong Cài đặt.', 'info');
      }

      if (options.autoResolveIds !== false) {
        sweepLogs.add('🔍 Đang tự động quét & gắn mã Resource ID còn thiếu qua Spiget API...', 'info');
        const resolveResult = await autoResolveMissingResourceIds(sweepDeps.db);
        const total = resolveResult.unresolved.length + resolveResult.resolved.length;
        sweepLogs.add(
          `🔍 Kết quả gắn ID: Đã gắn ${resolveResult.resolved.length}/${total} plugin còn thiếu.`,
          resolveResult.resolved.length > 0 ? 'success' : 'info',
        );
      }

      sweepLogs.add('🔄 Đang quét danh sách plugin đã mua và liên kết quyền sở hữu tài khoản...', 'info');
      seedImportedInventory(sweepDeps);
      await tryDiscoverPurchased(sweepDeps, true, true);
      seedImportedInventory(sweepDeps);

      const keepCount = getSettings(sweepDeps.db, sweepDeps.env).pruneKeepCount;
      sweepLogs.add(`📦 Đang kiểm tra cập nhật và gom đủ ${keepCount} phiên bản/plugin theo setting...`, 'info');
      const outcome = await checkPluginUpdates(sweepDeps.db, spiget);
      const owed = owedFindings(sweepDeps, 99999);
      const backfill = await backfillFindings(sweepDeps, spiget, keepCount);

      const seen = new Set<string>();
      const findings: UpdateFinding[] = [];
      let unlinkedPluginsCount = 0;
      for (const finding of [...outcome.findings, ...owed, ...backfill]) {
        const key = `${finding.pluginId}:${finding.upstream.uuid}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const owners = findOwners(sweepDeps.db, finding.resourceId);
        if (owners.length === 0) {
          unlinkedPluginsCount++;
          continue;
        }
        findings.push(finding);
      }

      if (unlinkedPluginsCount > 0) {
        sweepLogs.add(`⚠️ Đã bỏ qua ${unlinkedPluginsCount} phiên bản vì plugin chưa được liên kết với bất kỳ tài khoản sở hữu nào.`, 'warn');
      }

      for (const finding of findings) {
        enqueueDownload(sweepDeps.db, {
          pluginId: finding.pluginId,
          versionUuid: finding.upstream.uuid,
          versionName: finding.upstream.name,
        });
      }

      if (findings.length === 0) {
        sweepLogs.add('✨ Không có phiên bản nào cần tải (hoặc tất cả các plugin cần tải chưa được liên kết với tài khoản sở hữu)! Hãy Quét tài khoản trước.', 'info');
        return;
      }

      sweepLogs.add(`⚡ Chuẩn bị tải ${findings.length} bản đã liên kết tài khoản (tải tuần tự, hạn chế retry trùng lặp)...`, 'info');

      const result = await tryAutoDownload(sweepDeps, findings, {
        maxPerSweep: 9999,
        continueOnError: true,
        maxRetriesPerFinding: 1,
      });

      if (result) {
        for (const out of result.outcomes) {
          const outcomeText = formatDownloadOutcome(out);
          if (out.status === 'archived') {
            sweepLogs.add(`✅ ${outcomeText}`, 'success');
          } else if (out.status === 'cookie_dead') {
            sweepLogs.add(`❌ ${outcomeText}`, 'error');
          } else if (out.status === 'retrying') {
            sweepLogs.add(`⚠️ ${outcomeText}`, 'warn');
          } else {
            sweepLogs.add(outcomeText, 'info');
          }
        }
        const archived = result.outcomes.filter((o) => o.status === 'archived').length;
        const retrying = result.outcomes.filter((o) => o.status === 'retrying').length;
        sweepLogs.add(`🏁 Hoàn tất đợt tải tất cả: Thành công ${archived} bản, ${retrying} bản cần thử lại sau.`, 'info');
      }
    } catch (err) {
      console.error('Lỗi khi chạy tải tất cả:', err);
      sweepLogs.add(`❌ Lỗi khi tải tất cả: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      updateInFlight = false;
      lastFinishedAt = Date.now();
      if (currentSweepController === controller) {
        currentSweepController = null;
      }
      const promoted = deps.proxyPool?.promoteStagedProxy();
      if (promoted) {
        const promotedIp = promoted.endpoint.server.replace(/^[a-z]+:\/\//i, '');
        sweepLogs.setCurrentProxyIp(promotedIp);
        sweepLogs.add(`🔄 Lượt quét hoàn tất — Đã áp dụng IP Proxy mới cho lượt tiếp theo: ${promotedIp} (ID: ${promoted.endpoint.id})`, 'info');
      }
      sweepLogs.add('Hoàn tất lượt quét và tải plugin.', 'info');
    }
  };

  const trackedFullBatchDownload = (autoResolveIds = true): void => {
    inFlightSweep = runFullBatchDownload({ autoResolveIds }).finally(() => {
      inFlightSweep = null;
    });
  };

  /**
   * Run Scan Now: Chỉ quét tài nguyên đã mua từ tất cả các tài khoản Spigot
   * và liên kết quyền sở hữu vào kho, KHÔNG tải file jar.
   */
  /**
   * Run Scan Now: Quét tuần tự từng tài khoản Spigot trong SQLite (ORDER BY id ASC).
   * Mỗi tài khoản chạy 1 browser session ẩn danh mới và XOÁ SẠCH profile tạm (dấu vết)
   * ngay sau khi quét xong.
   * KHÔNG tải file jar.
   */
  const runScanOnly = async (): Promise<void> => {
    if (currentOperation !== 'idle' || updateInFlight) {
      const busyMsg = currentOperation === 'downloading'
        ? '⚠️ Một tiến trình TẢI PLUGIN đang chạy! Chức năng Quét bị khoá để tránh tranh chấp trình duyệt.'
        : '⚠️ Một tiến trình quét hoặc tải đang chạy, vui lòng đợi hoàn tất.';
      sweepLogs.add(busyMsg, 'warn');
      return;
    }
    currentOperation = 'scanning';
    updateInFlight = true;
    lastStartedAt = Date.now();
    const { controller, sweepDeps } = createSweepDeps();
    currentSweepController = controller;
    sweepLogs.add('🔍 Bắt đầu quy trình QUÉT TÀI KHOẢN & TÀI NGUYÊN ĐÃ MUA (Run Scan Now)...', 'info');

    try {
      try {
        sweepDeps.db.prepare("UPDATE account_scan_state SET last_error = '' WHERE last_error != ''").run();
      } catch {}

      // Đọc toàn bộ tài khoản Spigot được kích hoạt từ SQLite (đã ORDER BY id ASC)
      const accounts = listEnabledSpigotAccounts(sweepDeps.db);
      if (accounts.length === 0) {
        sweepLogs.add('⚠️ Không có tài khoản Spigot nào được kích hoạt trong SQLite!', 'warn');
        return;
      }

      sweepLogs.add(
        `📋 Tìm thấy ${accounts.length} tài khoản Spigot. Bắt đầu quét tuần tự từng tài khoản theo ID (1 tab duy nhất, xoá sạch dấu vết sau mỗi phiên)...`,
        'info',
      );

      const isHeadless = sweepDeps.env.CLOAKBROWSER_HEADLESS;
      const launcherOpts = {
        headless: isHeadless,
        showWindow: !isHeadless,
        enableGpu: sweepDeps.env.CHROME_ENABLE_GPU ?? true,
        display: sweepDeps.env.CHROME_DISPLAY,
      };

      const solverFor = sweepDeps.challengeSolvers?.forSweep();
      const proxyEnabled = getSettings(sweepDeps.db, sweepDeps.env).spigotProxyEnabled;

      let scannedCount = 0;
      let totalPurchasedFound = 0;

      for (const acc of accounts) {
        if (sweepDeps.signal?.aborted) {
          sweepLogs.add('🛑 Tiến trình quét đã bị huỷ.', 'warn');
          break;
        }

        sweepLogs.add(`👤 [Tài khoản #${acc.id}: ${acc.label}] Chuẩn bị phiên trình duyệt ẩn danh riêng biệt...`, 'info');

        // Tạo thư mục profile tạm thời ẩn danh cho tài khoản này
        const tempProfileDir = join(sweepDeps.env.TMP_DIR, `ephemeral-scan-${acc.id}-${Date.now()}`);

        const probe = await probeBrowserLauncher(
          sweepDeps.env.CHROME_PATH,
          tempProfileDir,
          undefined,
          launcherOpts,
        );

        if (!probe.available) {
          sweepLogs.add(`❌ [${acc.label}] Không thể khởi tạo trình duyệt: ${probe.reason}`, 'error');
          continue;
        }

        const credential: Credential = {
          label: acc.label,
          username: acc.username,
          password: acc.password.reveal(),
          enabled: acc.isEnabled,
        };

        let session: BrowserSession | null = null;
        try {
          const isGui = !sweepDeps.env.CLOAKBROWSER_HEADLESS;
          const modeNote = isGui ? ' (Cửa sổ GUI: BẬT)' : ' (Headless: BẬT)';

          let scanOk = false;
          let attemptSolver: ChallengeSolver | null = null;

          // Kiểm tra xem đã có Cookie hợp lệ được lưu trong Database từ trước chưa
          const savedXfUser = acc.xfUser.reveal();
          const savedXfSession = acc.xfSession.reveal();
          if (savedXfUser) {
            sweepLogs.add(`🍪 [${acc.label}] Tìm thấy Cookie phiên đã lưu. Khởi tạo Chrome và tiêm Cookie...`, 'info');
            const launched = await launchForAccount(probe, sweepDeps.env, acc.label, sweepDeps.proxyPool, proxyEnabled, 1);
            session = launched.session;
            attemptSolver = solverFor?.(launched.endpoint) ?? null;
            await injectSpigotSessionCookies(session.page, { xfUser: savedXfUser, xfSession: savedXfSession });
            
            // Mở thử trang đã mua xem cookie còn sống không
            sweepLogs.add(`[${acc.label}] Kiểm tra tính hợp lệ của Cookie trên trang đã mua...`, 'info');
            const preScan = await scanPurchasedResources(session.page, {
              solver: attemptSolver ?? undefined,
            });
            if (preScan.ok) {
              sweepLogs.add(`⚡ [${acc.label}] Cookie sống! Đọc thành công ${preScan.resources.length} plugin mà không cần đăng nhập lại!`, 'success');
              recordScan(sweepDeps.db, acc.label, preScan.resources.length);
              for (const resource of preScan.resources) {
                recordOwnership(sweepDeps.db, resource.resourceId, acc.label, 'owned');
              }
              const sync = syncPurchasedResources(sweepDeps.db, preScan.resources, { createMissing: true });
              for (const line of formatSyncOutcome(sync)) {
                sweepLogs.add(line, 'info');
              }
              scannedCount++;
              totalPurchasedFound += preScan.resources.length;
              scanOk = true;
            } else if (preScan.reason === 'logged_out') {
              sweepLogs.add(`⚠️ [${acc.label}] Cookie đã hết hạn, đóng phiên để tự động đăng nhập lại...`, 'warn');
              await session.close().catch(() => undefined);
              session = null;
            }
          }

          if (!scanOk) {
            sweepLogs.add(`[${acc.label}] Đang khởi động Chrome${modeNote} & đăng nhập SpigotMC...`, 'info');
            const attempt = await loginWithProxyRotation(
              probe,
              sweepDeps.env,
              credential,
              sweepDeps.proxyPool,
              solverFor,
              proxyEnabled,
              1,
            );
            session = attempt.session;

            if (!attempt.login.ok) {
              sweepLogs.add(`❌ [${acc.label}] Đăng nhập thất bại: ${attempt.login.detail}`, 'error');
              recordScan(sweepDeps.db, acc.label, 0, attempt.login.detail, {
                retryAfterMs: FAILED_SCAN_RETRY_MS,
                intervalMs: PURCHASED_SCAN_INTERVAL_MS,
              });
              continue;
            }

            // LƯU COOKIE MỚI VÀO DATABASE CHO LẦN SAU
            let newXfUser = (attempt.login as any).cookies?.xfUser;
            let newXfSession = (attempt.login as any).cookies?.xfSession;
            if (!newXfUser && typeof (session.page as any).cookies === 'function') {
              const pageCookies = await (session.page as any).cookies().catch(() => []);
              newXfUser = pageCookies.find((c: any) => c.name === 'xf_user')?.value;
              newXfSession = pageCookies.find((c: any) => c.name === 'xf_session')?.value;
            }
            if (newXfUser) {
              updateSpigotAccountSession(sweepDeps.db, acc.label, {
                xfUser: newXfUser,
                xfSession: newXfSession ?? '',
                issuedAt: new Date().toISOString(),
                lastVerifiedAt: new Date().toISOString(),
                status: 'ok',
              });
              sweepLogs.add(`🔑 [${acc.label}] Đã lưu & cập nhật Cookie xf_user vào database cho các lần sau!`, 'success');
            }

            // Lưu toàn bộ cookies sống vào thư mục ./data/cookie/{account}/*
            try {
              const savedCookies = await extractAndSaveCookiesFromPage(session.page, acc.label, {
                status: 'active',
                xfUser: newXfUser,
                xfSession: newXfSession,
              });
              sweepLogs.add(`💾 [${acc.label}] Đã lưu ${savedCookies.cookieCount} cookies sống vào ./data/cookie/${acc.label}/*`, 'success');
            } catch (saveErr) {
              console.warn(`[Scheduler] Không thể lưu cookies file cho ${acc.label}:`, saveErr);
            }

            sweepLogs.add(`✅ [${acc.label}] Đăng nhập thành công! Đang quét trang tài nguyên đã mua...`, 'success');
            const scan = await scanPurchasedResources(session.page, {
              solver: attempt.solver ?? undefined,
            });

            if (!scan.ok) {
              sweepLogs.add(`⚠️ [${acc.label}] Không đọc được danh sách đã mua: ${scan.detail}`, 'warn');
              recordScan(sweepDeps.db, acc.label, 0, scan.detail, {
                retryAfterMs: FAILED_SCAN_RETRY_MS,
                intervalMs: PURCHASED_SCAN_INTERVAL_MS,
              });
              continue;
            }

            recordScan(sweepDeps.db, acc.label, scan.resources.length);
            sweepLogs.add(`📦 [${acc.label}] Tìm thấy ${scan.resources.length} plugin đã mua. Đang liên kết quyền sở hữu...`, 'success');

            for (const resource of scan.resources) {
              recordOwnership(sweepDeps.db, resource.resourceId, acc.label, 'owned');
            }

            const sync = syncPurchasedResources(sweepDeps.db, scan.resources, { createMissing: true });
            const lines = formatSyncOutcome(sync);
            for (const line of lines) {
              sweepLogs.add(line, 'info');
            }

            scannedCount++;
            totalPurchasedFound += scan.resources.length;
          }
        } catch (scanErr) {
          const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
          sweepLogs.add(`❌ [${acc.label}] Lỗi trong phiên quét: ${msg}`, 'error');
        } finally {
          // Đóng session
          if (session) {
            await session.close().catch(() => undefined);
            session = null;
          }
          // XOÁ SẠCH DẤU VẾT: Xoá toàn bộ thư mục profile tạm thời trên đĩa
          try {
            rmSync(tempProfileDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(`[Cleanup] Không thể xoá profile tạm ${tempProfileDir}:`, rmErr);
          }
          sweepLogs.add(`🧹 [${acc.label}] Đã đóng trình duyệt và xoá sạch dấu vết phiên quét.`, 'info');
        }

        // Giãn cách 2s trước khi chuyển sang tài khoản kế tiếp
        if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      sweepLogs.add(
        `🏁 Hoàn tất quét toàn bộ! Đã quét thành công ${scannedCount}/${accounts.length} tài khoản, tổng cộng ${totalPurchasedFound} plugin đã mua được ghi nhận.`,
        'success',
      );
    } catch (err) {
      console.error('Lỗi khi quét tài khoản:', err);
      sweepLogs.add(`❌ Lỗi khi quét tài khoản: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      currentOperation = 'idle';
      updateInFlight = false;
      lastFinishedAt = Date.now();
      if (currentSweepController === controller) {
        currentSweepController = null;
      }
      sweepLogs.add('Hoàn tất phiên quét tài khoản.', 'info');
    }
  };

  const trackedScanOnly = (): void => {
    inFlightSweep = runScanOnly().finally(() => {
      inFlightSweep = null;
    });
  };

  /**
   * Run Download Now: Quét và tải đủ PRUNE_KEEP_COUNT versions của từng plugin
   * tuần tự theo plugin.id ASC. Chạy duy nhất 1 Browser Session, 1 Tab duy nhất,
   * lưu trữ file tải về vào {STORAGE_URL}/{plugin.id}/{displayName}-v{version}.jar.
   * Xoá sạch profile tạm sau khi hoàn tất.
   */
  const runOrderedDownloadNow = async (options?: { targetResourceId?: number }): Promise<void> => {
    if (currentOperation !== 'idle' || updateInFlight) {
      const busyMsg = currentOperation === 'scanning'
        ? '⚠️ Một tiến trình QUÉT TÀI KHOẢN đang chạy! Chức năng Tải bị khoá để tránh tranh chấp trình duyệt.'
        : '⚠️ Một tiến trình quét hoặc tải đang chạy, vui lòng đợi hoàn tất.';
      sweepLogs.add(busyMsg, 'warn');
      return;
    }
    currentOperation = 'downloading';
    updateInFlight = true;
    lastStartedAt = Date.now();
    const { controller, sweepDeps } = createSweepDeps();
    currentSweepController = controller;
    sweepLogs.add('🚀 Bắt đầu quy trình TẢI PLUGIN TUẦN TỰ THEO PLUGIN.ID (Run Download Now)...', 'info');

    try {
      const currentSettings = getSettings(sweepDeps.db, sweepDeps.env);
      if (!currentSettings.autoDownloadEnabled) {
        setSetting(sweepDeps.db, 'auto_download_enabled', 'true');
        sweepLogs.add('⚙️ Đã tự động kích hoạt "Tự động tải Spigot" trong Cài đặt.', 'info');
      }
      seedImportedInventory(sweepDeps);
      try {
        sweepDeps.db.prepare("UPDATE account_scan_state SET last_error = '' WHERE last_error != ''").run();
      } catch {}

      // 1. Lấy danh sách tài khoản từ SQLite
      const dbAccounts = listEnabledSpigotAccounts(sweepDeps.db);
      let usableCredentials: Credential[] = dbAccounts.map((a) => ({
        label: a.label,
        username: a.username,
        password: a.password.reveal(),
        enabled: a.isEnabled,
      }));

      // Fallback nếu SQLite chưa có thì đọc credentials file cũ (nếu có)
      if (usableCredentials.length === 0) {
        const credentials = loadSpigotCredentials(sweepDeps.env.SPIGOT_CREDENTIALS_FILE);
        if (credentials.ok) {
          usableCredentials = enabledSpigotCredentials(credentials.credentials);
        }
      }

      if (usableCredentials.length === 0) {
        sweepLogs.add('⚠️ Không có tài khoản Spigot nào được kích hoạt để tải! Hãy thêm tài khoản trong Quản lý tài khoản Spigot.', 'warn');
        return;
      }

      for (const c of usableCredentials) {
        sweepDeps.challengeCooldowns?.clear(c.label);
      }

      const keepCount = getSettings(sweepDeps.db, sweepDeps.env).pruneKeepCount || 10;
      sweepLogs.add(`📦 Đang kiểm tra các plugin cần tải (tối đa ${keepCount} bản/plugin)...`, 'info');

      const orderedFindings: UpdateFinding[] = [];
      const seen = new Set<string>();

      // Duyệt qua tất cả các plugin thuộc sở hữu của các tài khoản đã kích hoạt
      for (const cred of usableCredentials) {
        if (sweepDeps.signal?.aborted) break;
        const ownedPlugins = listAccountOwnedPlugins(sweepDeps.db, cred.label);
        if (ownedPlugins.length === 0) continue;

        for (const plugin of ownedPlugins) {
          if (sweepDeps.signal?.aborted) break;
          if (!plugin.resourceId) continue;
          const existingVersions = listVersionsByPlugin(sweepDeps.db, plugin.id);
          if (existingVersions.length >= keepCount) continue;

          try {
            const versions = await spiget.listVersions(plugin.resourceId, keepCount);
            if (versions.length === 0) continue;

            const existingNames = new Set(
              existingVersions
                .map((v) => (v.version ?? '').toLowerCase().trim())
                .filter((name) => name !== ''),
            );
            const byName = new Map<string, (typeof versions)[number]>();
            for (const v of versions) {
              if (!byName.has(v.name)) byName.set(v.name, v);
            }
            const eligible = [...byName.values()].filter((v) => {
              const vName = v.name.toLowerCase().trim();
              const cleanVName = v.name.replace(/^v/i, '').toLowerCase().trim();
              return !existingNames.has(vName) && !existingNames.has(cleanVName);
            });

            const needed = Math.max(0, keepCount - existingVersions.length);
            const toQueue = eligible.slice(0, needed);

            for (const ver of toQueue) {
              const key = `${plugin.id}:${ver.uuid}`;
              if (seen.has(key)) continue;
              seen.add(key);
              orderedFindings.push({
                pluginId: plugin.id,
                pluginName: plugin.displayName,
                resourceId: plugin.resourceId,
                isPremium: plugin.isPremium,
                upstream: ver,
                archivedVersion: existingVersions[0]?.version ?? null,
              });
            }
          } catch (err) {
            console.warn(`Lỗi khi tra Spiget cho ${plugin.displayName}:`, err);
          }
        }
      }

      // Thêm các bản nợ hợp lệ (owed findings)
      const owed = owedFindings(sweepDeps, 99999);
      for (const finding of owed) {
        const key = `${finding.pluginId}:${finding.upstream.uuid}`;
        if (seen.has(key)) continue;
        const owners = findOwners(sweepDeps.db, finding.resourceId);
        if (owners.length === 0) continue;
        seen.add(key);
        orderedFindings.push(finding);
      }

      // Đưa vào danh sách nợ (pending_download)
      for (const finding of orderedFindings) {
        enqueueDownload(sweepDeps.db, {
          pluginId: finding.pluginId,
          versionUuid: finding.upstream.uuid,
          versionName: finding.upstream.name,
        });
      }

      if (orderedFindings.length === 0) {
        sweepLogs.add(`✨ Tất cả plugin của ${usableCredentials.length} tài khoản đã đủ ${keepCount} phiên bản (hoặc chưa có plugin nào được liên kết sở hữu)! Hãy Quét tài khoản trước.`, 'info');
        return;
      }

      // SẮP XẾP TUẦN TỰ THEO PLUGIN.ID ASC (ID nội bộ trong SQLite)
      // Nếu có targetResourceId được chỉ định, ưu tiên plugin đó lên đầu tiên
      orderedFindings.sort((a, b) => {
        if (options?.targetResourceId) {
          if (a.resourceId === options.targetResourceId && b.resourceId !== options.targetResourceId) return -1;
          if (b.resourceId === options.targetResourceId && a.resourceId !== options.targetResourceId) return 1;
        }
        return a.pluginId - b.pluginId;
      });

      const targetText = options?.targetResourceId ? ` (Ưu tiên Spigot Resource #${options.targetResourceId})` : '';
      sweepLogs.add(
        `⚡ Chuẩn bị tải ${orderedFindings.length} bản tuần tự theo ID Plugin nội bộ (plugin.id ASC)${targetText} qua 1 Tab duy nhất...`,
        'info',
      );
      sweepLogs.add(
        `💾 Thư mục lưu trữ: ${sweepDeps.env.STORAGE_URL}/{plugin.id}/{displayName}-v{version}.jar`,
        'info',
      );

      const result = await tryAutoDownload(sweepDeps, orderedFindings, {
        maxPerSweep: 9999,
        continueOnError: true,
        maxRetriesPerFinding: 1,
      });

      if (result) {
        let successCount = 0;
        let failedCount = 0;
        for (const out of result.outcomes) {
          const outcomeText = formatDownloadOutcome(out);
          if (out.status === 'archived') {
            successCount++;
            sweepLogs.add(`✅ ${outcomeText}`, 'success');
          } else if (out.status === 'cookie_dead') {
            failedCount++;
            sweepLogs.add(`❌ ${outcomeText}`, 'error');
          } else {
            failedCount++;
            sweepLogs.add(`⚠️ ${outcomeText} — đã lưu vào danh sách tải sau`, 'warn');
          }
        }
        sweepLogs.add(`🏁 Kết thúc lượt tải: ${successCount} thành công, ${failedCount} bản chưa tải được đã đưa vào danh sách tải sau.`, 'info');
      }
    } catch (err) {
      console.error('Lỗi khi chạy tải plugin:', err);
      sweepLogs.add(`❌ Lỗi khi chạy tải plugin: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      currentOperation = 'idle';
      updateInFlight = false;
      lastFinishedAt = Date.now();
      if (currentSweepController === controller) {
        currentSweepController = null;
      }
      const promoted = deps.proxyPool?.promoteStagedProxy();
      if (promoted) {
        const promotedIp = promoted.endpoint.server.replace(/^[a-z]+:\/\//i, '');
        sweepLogs.setCurrentProxyIp(promotedIp);
        sweepLogs.add(`🔄 Lượt tải hoàn tất — Đã áp dụng IP Proxy mới: ${promotedIp} (ID: ${promoted.endpoint.id})`, 'info');
      }
      sweepLogs.add('Hoàn tất lượt tải.', 'info');
    }
  };

  const trackedOrderedDownload = (options?: { targetResourceId?: number }): void => {
    inFlightSweep = runOrderedDownloadNow(options).finally(() => {
      inFlightSweep = null;
    });
  };

  /** Runs a sweep and keeps a handle on it, so shutdown can await the browser close. */
  const trackedUpdateCheck = (forcePurchasedScan = false): void => {
    inFlightSweep = runUpdateCheck({ forcePurchasedScan }).finally(() => {
      inFlightSweep = null;
    });
  };

  const scheduleFollowUp = (purchasedAccountsRemaining: number): void => {
    const stillOwed = listAllPendingDownloads(deps.db).length;
    if ((stillOwed > 0 || purchasedAccountsRemaining > 0) && !deps.signal?.aborted) {
      const minutes = Math.round(deps.env.SPIGOT_BACKLOG_RESWEEP_MS / 60_000);
      const work = [
        stillOwed > 0 ? `${stillOwed} bản đang nợ` : '',
        purchasedAccountsRemaining > 0 ? `${purchasedAccountsRemaining} tài khoản chưa quét` : '',
      ].filter(Boolean).join(', ');
      console.log(`Xong lượt quét. Còn ${work} — quét tiếp sau ${minutes} phút.`);
      if (backlogTimer) clearTimeout(backlogTimer);
      backlogTimer = setTimeout(() => trackedUpdateCheck(), deps.env.SPIGOT_BACKLOG_RESWEEP_MS);
      backlogTimer.unref();
    } else {
      console.log(`Xong lượt quét. Lượt tiếp theo sau ${UPDATE_CHECK_INTERVAL / 60_000} phút.`);
    }
  };

  const updates = setInterval(() => trackedUpdateCheck(), UPDATE_CHECK_INTERVAL);
  const prune = setInterval(() => void runPrune(), PRUNE_INTERVAL);

  /**
   * One sweep shortly after boot, then hourly.
   *
   * Without this the first check lands a full hour in, so restarting tells the
   * owner nothing about whether their credentials and browser actually work —
   * they would have to wait an hour to find out a password was mistyped.
   *
   * Delayed rather than immediate so the Discord client finishes connecting
   * first; otherwise the notification channel is not resolvable yet and the
   * results would only reach the console.
   */
  const firstRun = setTimeout(() => trackedUpdateCheck(), STARTUP_CHECK_DELAY);

  const timers = [orders, tokens, cards, updates, prune];
  for (const timer of timers) timer.unref();
  // unref so a pending first run cannot hold the process open during shutdown.
  firstRun.unref();

  return {
    stop: async () => {
      deps.proxyPool?.stopAutoRotateCron();
      for (const timer of timers) clearInterval(timer);
      clearTimeout(firstRun);
      if (backlogTimer) clearTimeout(backlogTimer);

      // Tell the running sweep to stop, then wait for it. Its `finally` is what
      // closes the browser; skipping this leaves Chrome to be killed by
      // process.exit before it flushes cookies, and the next sweep starts cold.
      shutdownSignal.abort();
      if (inFlightSweep) {
        // Bounded: a browser close that never resolves must not wedge the daemon.
        // A lost profile is a worse outcome than a slow exit, but a stuck process
        // is worse than both.
        const timeout = new Promise<void>((resolve) => {
          setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
        });
        await Promise.race([inFlightSweep, timeout]);
      }
    },
    runUpdateCheck,
    triggerUpdateCheck: (forcePurchasedScan = false) => {
      if (updateInFlight || deps.signal?.aborted) return false;
      trackedUpdateCheck(forcePurchasedScan);
      return true;
    },
    getUpdateStatus: () => ({ running: updateInFlight, lastStartedAt, lastFinishedAt }),
    getCurrentOperation: () => currentOperation,
    runPrune,
    runFullBatchDownload,
    triggerFullBatchDownload: (options: { autoResolveIds?: boolean } = { autoResolveIds: true }) => {
      if (updateInFlight || deps.signal?.aborted) return false;
      trackedFullBatchDownload(options.autoResolveIds !== false);
      return true;
    },
    runScanOnly,
    triggerScanOnly: () => {
      if (updateInFlight || deps.signal?.aborted) return false;
      trackedScanOnly();
      return true;
    },
    runOrderedDownloadNow,
    triggerOrderedDownload: (options?: { targetResourceId?: number }) => {
      if (updateInFlight || deps.signal?.aborted) return false;
      trackedOrderedDownload(options);
      return true;
    },
    abortSweep: async (): Promise<boolean> => {
      if (!updateInFlight && !currentSweepController) {
        return false;
      }
      sweepLogs.add('🛑 [Khẩn cấp] Đã gửi lệnh dừng khẩn cấp toàn bộ các luồng!', 'warn');
      if (currentSweepController && !currentSweepController.signal.aborted) {
        currentSweepController.abort();
      }
      if (backlogTimer) {
        clearTimeout(backlogTimer);
        backlogTimer = null;
      }
      // Dừng và đóng sạch toàn bộ các session Chrome đang chạy
      for (const [wId, sess] of activeSessions.entries()) {
        try {
          await sess.close();
        } catch {
          // ignore
        }
        instanceTracker.terminateWorker(wId, 'Dừng khẩn cấp');
      }
      activeSessions.clear();
      updateInFlight = false;
      instanceTracker.resetAll();
      return true;
    },
    rotateProxy: async (): Promise<{ ok: boolean; currentProxyIp: string | null; error?: string }> => {
      const pool = deps.proxyPool;
      if (!pool || !pool.configured) {
        sweepLogs.add('⚠️ Không thể xoay proxy: Chưa cấu hình proxy trong hệ thống.', 'warn');
        return { ok: false, currentProxyIp: null, error: 'Chưa cấu hình proxy trong .env' };
      }
      sweepLogs.add('🔄 Đang gửi yêu cầu xoay sang Proxy IP mới...', 'info');
      try {
        try {
          deps.db.prepare("UPDATE account_scan_state SET last_error = '' WHERE last_error != ''").run();
        } catch {}
        const lease = await pool.forceRotate();
        if (lease) {
          const activeCount = pool.getActiveInstances(lease.endpoint.id);
          const countNote = activeCount > 1 ? ` (${activeCount}/3 luồng)` : '';
          const proxyDisplay = `${lease.endpoint.server.replace(/^[a-z]+:\/\//i, '')}${countNote}`;
          sweepLogs.setCurrentProxyIp(proxyDisplay);
          sweepLogs.add(`✅ Đã xoay sang Proxy IP mới: ${proxyDisplay} (ID: ${lease.endpoint.id})`, 'success');
          return { ok: true, currentProxyIp: proxyDisplay };
        }
        sweepLogs.add('⚠️ Không thể xoay proxy mới: Nhà cung cấp từ chối hoặc hết hạn mức.', 'warn');
        return { ok: false, currentProxyIp: null, error: 'Không lấy được proxy mới từ nhà cung cấp' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sweepLogs.add(`❌ Lỗi khi xoay proxy: ${msg}`, 'error');
        return { ok: false, currentProxyIp: null, error: msg };
      }
    },
  };
}

/**
 * Các bản cũ cần tải lần đầu, khi kho chưa có bản nào của plugin đó.
 *
 * Chủ bot muốn giữ N bản gần nhất chứ không chỉ bản mới nhất: khách vẫn chạy
 * server phiên bản cũ và cần đúng bản tương thích. Chỉ chạy khi kho TRỐNG cho
 * plugin đó — sau đó luồng phát hiện cập nhật thông thường lo phần còn lại, nên
 * việc này không lặp lại mỗi giờ.
 *
 * Dùng API versions của Spiget thay vì đọc trang /history: API công khai, không
 * bị Cloudflare, và trả về đúng thứ tự theo ngày phát hành.
 */
async function backfillFindings(
  deps: MaintenanceDeps,
  spiget: SpigetClient,
  keepCount: number,
): Promise<UpdateFinding[]> {
  const total = countPlugins(deps.db);
  const plugins = listPlugins(deps.db, total, 0).filter((p) => p.resourceId !== null);
  const findings: UpdateFinding[] = [];
  const queued = new Set(
    listAllPendingDownloads(deps.db).map((row) => `${row.pluginId}:${row.versionUuid}`),
  );

  for (const plugin of plugins) {
    const existingVersions = listVersionsByPlugin(deps.db, plugin.id);
    // Nếu kho đã có đủ số bản theo keepCount (mặc định 10), bỏ qua
    if (existingVersions.length >= keepCount) continue;

    const versions = await spiget.listVersions(plugin.resourceId!, keepCount);
    if (versions.length === 0) continue;

    const existingNames = new Set(
      existingVersions
        .map((v) => (v.version ?? '').toLowerCase().trim())
        .filter((name) => name !== ''),
    );
    const byName = new Map<string, (typeof versions)[number]>();
    for (const version of versions) {
      if (!byName.has(version.name)) byName.set(version.name, version);
    }
    const unique = [...byName.values()];
    const eligible = unique.filter((version) => {
      const vName = version.name.toLowerCase().trim();
      const cleanVName = version.name.replace(/^v/i, '').toLowerCase().trim();
      if (existingNames.has(vName) || existingNames.has(cleanVName)) return false;
      return !queued.has(`${plugin.id}:${version.uuid}`);
    });
    if (eligible.length === 0) continue;

    const needed = Math.max(0, keepCount - existingVersions.length);
    const toQueue = eligible.slice(0, needed);

    const statusNote =
      existingVersions.length === 0
        ? 'kho trống'
        : `kho đang có ${existingVersions.length}/${keepCount} bản`;
    console.log(`${plugin.displayName}: ${statusNote}, sẽ tải thêm ${toQueue.length} bản gần nhất`);
    for (const version of toQueue) {
      findings.push({
        pluginId: plugin.id,
        pluginName: plugin.displayName,
        resourceId: plugin.resourceId!,
        isPremium: plugin.isPremium,
        upstream: version,
        archivedVersion: existingVersions[0]?.version ?? null,
      });
    }
  }

  return findings;
}

/**
 * Các bản còn nợ từ lượt quét trước, dựng lại thành UpdateFinding.
 *
 * Cần thiết vì phát hiện cập nhật ghi upstream_state TRƯỚC khi tải: nếu tải lỗi,
 * lượt sau thấy uuid đã khớp và báo "đã là bản mới nhất" mãi mãi. Không phát lại
 * hàng chờ thì một lỗi mạng nhất thời làm mất hẳn phiên bản đó.
 *
 * Bỏ qua dòng có plugin đã bị xoá: hàng chờ có thể sống lâu hơn plugin.
 */
function owedFindings(deps: MaintenanceDeps, limit?: number): UpdateFinding[] {
  const due = listDueDownloads(deps.db, limit ?? deps.env.SPIGOT_MAX_DOWNLOADS_PER_SWEEP);
  const findings: UpdateFinding[] = [];

  for (const row of due) {
    const plugin = findPluginById(deps.db, row.pluginId);
    if (!plugin || plugin.resourceId === null) continue;

    findings.push({
      pluginId: plugin.id,
      pluginName: plugin.displayName,
      resourceId: plugin.resourceId,
      isPremium: plugin.isPremium,
      upstream: {
        uuid: row.versionUuid,
        name: row.versionName,
        // The queue stores no release date, so the row's own creation time stands
        // in. Seconds in the database, milliseconds in this field — passing it
        // through unconverted rendered every replayed version as 21/01/1970.
        releaseDateMs: row.createdAt * 1000,
        downloads: 0,
      },
      archivedVersion: listVersionsByPlugin(deps.db, plugin.id, 1)[0]?.version ?? null,
    });
  }

  return findings;
}

/**
 * Mở trình duyệt riêng cho một tài khoản: profile riêng + proxy xoay mới.
 *
 * Xoay qua nhiều proxy trong MỘT lần mở, vì thất bại hay gặp nhất của proxy trả
 * tiền không phải "API lỗi" mà "exit node này đã chết": Chrome trả
 * ERR_PROXY_CONNECTION_FAILED, và trước đây lỗi đó nổi lên thành "Cloudflare chặn"
 * nên tài khoản bị nghỉ 30 phút vì lỗi của proxy. Ở đây proxy hỏng được đánh dấu
 * rồi thử proxy khác ngay; chỉ khi hết proxy rảnh mới chịu chạy IP máy chủ, vì thà
 * chậm còn hơn bỏ cả tài khoản.
 */
async function launchForAccount(
  probe: Extract<LauncherProbe, { available: true }>,
  env: Env,
  label: string,
  pool?: SpigotProxyPool,
  proxyEnabled = true,
  maxConcurrency = 1,
): Promise<{ session: BrowserSession; endpoint: ProxyEndpoint | null }> {
  const profileDir = accountProfileDir(env.CHROME_PROFILE_DIR, label);

  if (!proxyEnabled || !pool?.configured) {
    sweepLogs.setCurrentProxyIp('Direct (IP máy chủ)');
    return {
      session: await probe.launch({
        profileDir,
        ephemeral: true,
        accountLabel: label,
      }),
      endpoint: null,
    };
  }

  const attempts = Math.max(1, env.SPIGOT_PROXY_MAX_ATTEMPTS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lease = await pool.next({ maxInstancesPerProxy: maxConcurrency });
    if (!lease) {
      const apiErr = pool.takeApiError();
      const cooldownMatch = apiErr ? /thử lại sau\s+(\d+)\s+giây/i.exec(apiErr) : null;
      if (cooldownMatch && attempt < attempts - 1) {
        const waitSec = Math.min(Math.max(Number(cooldownMatch[1]), 1), 15);
        sweepLogs.add(`⏳ Proxy xoay chưa đến hạn đổi (${waitSec}s) — đang chờ cấp IP cho ${label}...`, 'info');
        console.warn(`[Proxy] Chờ ${waitSec}s trước khi xin lại proxy cho ${label}...`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000 + 500));
        continue;
      }
      const isPermanentError = apiErr && /hết hạn|không hợp lệ|unauthorized|forbidden|invalid/i.test(apiErr);
      if (isPermanentError) {
        console.warn(`[Proxy] API proxy báo lỗi vĩnh viễn: ${apiErr}`);
        sweepLogs.add(`⚠️ [${label}] Proxy API lỗi: ${apiErr}`, 'warn');
        break;
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      break;
    }

    try {
      const session = await probe.launch({
        profileDir,
        ephemeral: true,
        accountLabel: label,
        proxyServer: lease.endpoint.server,
        ...(lease.endpoint.username !== undefined ? { proxyUsername: lease.endpoint.username } : {}),
        ...(lease.endpoint.password !== undefined ? { proxyPassword: lease.endpoint.password } : {}),
      });
      // Đánh dấu 1 instance đang dùng proxy này (cho phép cả 5 worker cùng ăn 1 IP)
      pool.acquire(lease.endpoint.id);
      const activeCount = pool.getActiveInstances(lease.endpoint.id);
      const countNote = activeCount > 1 ? ` (${activeCount}/${maxConcurrency} luồng)` : '';
      const proxyDisplay = `${lease.endpoint.server.replace(/^[a-z]+:\/\//i, '')}${countNote}`;
      const prevIp = sweepLogs.getCurrentProxyIp();
      sweepLogs.setCurrentProxyIp(proxyDisplay);

      if (prevIp && prevIp !== proxyDisplay && !prevIp.includes('Direct')) {
        sweepLogs.add(`🔄 Đã chuyển sang Proxy IP mới: ${proxyDisplay} (ID: ${lease.endpoint.id})`, 'info');
      } else {
        sweepLogs.add(`🌐 [${label}] Sử dụng Proxy IP: ${proxyDisplay} (ID: ${lease.endpoint.id})`, 'info');
      }

      // Tự động giải phóng proxy khi session đóng (ngăn rò rỉ tăng luồng)
      const proxyEndpointId = lease.endpoint.id;
      const originalClose = session.close.bind(session);
      let released = false;
      session.close = async () => {
        try {
          await originalClose();
        } finally {
          if (!released) {
            released = true;
            pool.release(proxyEndpointId);
            const remaining = pool.getActiveInstances(proxyEndpointId);
            const remNote = remaining > 0 ? ` (${remaining}/${maxConcurrency} luồng)` : '';
            sweepLogs.setCurrentProxyIp(`${lease.endpoint.server.replace(/^[a-z]+:\/\//i, '')}${remNote}`);
          }
        }
      };

      return { session, endpoint: lease.endpoint };
    } catch (err) {
      if (!isProxyFailure(err)) throw err;
      // Chỉ id, không bao giờ địa chỉ: đây là thông tin của gói trả tiền.
      console.warn(`Proxy ${lease.endpoint.id} không mở được — cho nghỉ, thử proxy khác cho ${label}.`);
      sweepLogs.add(`Proxy ${lease.endpoint.id} không kết nối được — đang xoay sang proxy khác...`, 'warn');
      pool.markBad(lease.endpoint.id);
    }
  }

  const apiError = pool.takeApiError();
  if (apiError) {
    console.warn(`Không lấy được proxy xoay (${apiError}) — ${label} sẽ kết nối thẳng.`);
    sweepLogs.add(`⚠️ [${label}] Lỗi Proxy API: ${apiError} — Kết nối thẳng bằng IP máy chủ`, 'warn');
  } else {
    console.warn(`Hết proxy rảnh (${pool.describe()}) — ${label} sẽ kết nối thẳng.`);
    sweepLogs.add(`🌐 [${label}] Không có proxy rảnh, kết nối thẳng bằng IP máy chủ`, 'warn');
  }
  sweepLogs.setCurrentProxyIp('Direct (IP máy chủ)');
  return {
    session: await probe.launch({
      profileDir,
      ephemeral: true,
      accountLabel: label,
    }),
    endpoint: null,
  };
}

/**
 * Mở browser rồi đăng nhập, đổi IP và thử lại khi proxy chết hoặc Cloudflare chặn.
 *
 * Đổi IP NGAY thay vì cho tài khoản nghỉ, vì cái bị chặn là IP chứ không phải tài
 * khoản: cho nghỉ 30 phút rồi mở lại đúng IP đó chỉ lặp lại cú chặn.
 *
 * Bắt lỗi quanh `loginToSpigot`, không chỉ quanh lần mở browser: Chrome KHỞI ĐỘNG
 * BÌNH THƯỜNG với một proxy đã chết — lỗi `ERR_PROXY_CONNECTION_FAILED` chỉ hiện ra
 * ở lần điều hướng đầu tiên, tức bên trong bước đăng nhập. Bắt ở lần mở là bắt sai
 * chỗ và proxy chết sẽ nổi lên thành "không đăng nhập được".
 *
 * Phiên được đóng trước khi ném lỗi ra ngoài: người gọi chỉ nhận được biến session
 * sau khi hàm này trả về, nên một lần ném không đóng sẽ bỏ lại Chrome chạy mãi.
 */
async function loginWithProxyRotation(
  probe: Extract<LauncherProbe, { available: true }>,
  env: Env,
  credential: Credential,
  pool?: SpigotProxyPool,
  solverFor?: (endpoint: ProxyEndpoint | null) => ChallengeSolver | null,
  proxyEnabled = true,
  maxConcurrency = 1,
): Promise<{
  session: BrowserSession;
  login: LoginResult;
  proxyId: string | null;
  solver: ChallengeSolver | null;
}> {
  const attempts = (proxyEnabled && pool?.configured) ? Math.max(1, env.SPIGOT_PROXY_MAX_ATTEMPTS) : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const launched = await launchForAccount(probe, env, credential.label, pool, proxyEnabled, maxConcurrency);
    const proxyId = launched.endpoint?.id ?? null;
    // Solver bám đúng proxy của phiên này, không phải một proxy nào khác trong bể: vé
    // Cloudflare phát ra chỉ dùng được từ IP đã giải nó.
    const solver = solverFor?.(launched.endpoint) ?? null;
    const rotatable = attempt < attempts - 1 && proxyId !== null;
    const canRotate = (): boolean => rotatable && pool!.hasAlternative(proxyId!);

    let login: LoginResult;
    try {
      login = await loginToSpigot(launched.session.page, credential, {}, solver ?? undefined);
    } catch (err) {
      await launched.session.close().catch(() => undefined);
      if (isProxyFailure(err) && proxyId) {
        // Đánh dấu TRƯỚC khi quyết định có đổi hay không: một proxy đã chứng minh là
        // chết ở lượt CUỐI cũng phải được cho nghỉ, nếu không thì danh sách một proxy
        // không bao giờ tích được khoảng nghỉ nào và lượt sau lại đi vào đúng nó.
        pool!.markBad(proxyId);
        console.warn(`Proxy ${proxyId} không vào được Spigot — cho nghỉ.`);
        if (canRotate()) continue;
      }
      throw err;
    }

    if (login.ok) {
      if (proxyId) pool?.markGood(proxyId);
      return { session: launched.session, login, proxyId, solver };
    }

    // 'no_form' cũng là một thất bại đăng nhập, nhưng của TRANG chứ không của IP:
    // đổi proxy không sửa được một form đổi markup, và đánh dấu proxy vì việc đó sẽ
    // dọn sạch cả bể proxy đang lành.
    if (login.reason === 'challenged' && proxyId) {
      pool!.markBad(proxyId);
      console.warn(`Cloudflare chặn ${credential.label} qua proxy ${proxyId} — cho nghỉ.`);
      if (canRotate()) {
        await launched.session.close().catch(() => undefined);
        continue;
      }
    }

    return { session: launched.session, login, proxyId, solver };
  }

  // Vòng lặp luôn trả về ở lượt cuối (canRotate false), nên tới đây là không thể.
  throw new Error('Không mở được phiên Spigot nào');
}

/** Bể proxy từ .env, in ra một lần những dòng cấu hình bị bỏ. */
function buildConfiguredProxyPool(env: Env): SpigotProxyPool {
  const { pool, warnings } = buildSpigotProxyPool({
    ...(env.SPIGOT_PROXY_LIST ? { list: env.SPIGOT_PROXY_LIST } : {}),
    ...(env.SPIGOT_PROXY_FILE ? { file: env.SPIGOT_PROXY_FILE } : {}),
    ...(env.SPIGOT_PROXY_API_URL ? { apiUrl: env.SPIGOT_PROXY_API_URL } : {}),
    ...(env.SPIGOT_PROXY_RENEW_URL ? { renewUrl: env.SPIGOT_PROXY_RENEW_URL } : {}),
    cooldownMs: env.SPIGOT_PROXY_COOLDOWN_MS,
  });
  for (const warning of warnings) console.warn(`Cấu hình proxy — ${warning}`);
  return pool;
}

/**
 * Bể mua `cf_clearance` từ .env, hoặc undefined khi chưa cấu hình YesCaptcha.
 *
 * Undefined chứ không phải một bể luôn thất bại: mọi chỗ gọi đã là `solver?.solve(...)`,
 * nên một deployment không bật tính năng không gọi thêm một lời gọi nào và không sinh
 * thêm một dòng log nào.
 */
function buildConfiguredSolverPool(env: Env): ChallengeSolverPool | undefined {
  if (!env.YESCAPTCHA_CLIENT_KEY) return undefined;
  const pool = buildChallengeSolverPool({
    clientKey: env.YESCAPTCHA_CLIENT_KEY,
    baseUrl: env.YESCAPTCHA_BASE_URL,
    timeoutMs: env.YESCAPTCHA_TIMEOUT_MS,
    clearanceTtlMs: env.YESCAPTCHA_CLEARANCE_TTL_MS,
    maxSolvesPerSweep: env.YESCAPTCHA_MAX_SOLVES_PER_SWEEP,
    log: (message) => console.warn(message),
  });
  if (pool) console.log('YesCaptcha đã bật cho các cú chặn Cloudflare (cần có proxy mới giải được).');
  return pool ?? undefined;
}

/**
 * Học mã resource từ trang "đã mua" của Spigot.
 *
 * Tách riêng khỏi lượt tải vì nó phải chạy được KHI CHƯA CÓ GÌ ĐỂ TẢI: kho mới
 * chưa plugin nào có mã, nên bước kiểm tra cập nhật không thấy gì và thoát sớm.
 * Gộp hai việc lại tạo ra vòng lặp chết — cần mã để tới bước học mã.
 *
 * Im lặng bỏ qua khi tính năng chưa bật hoặc chưa có trình duyệt: đây là tiện
 * ích, không phải điều kiện để phần còn lại của bot hoạt động.
 */
async function tryDiscoverPurchased(
  deps: MaintenanceDeps,
  force = false,
  scanAllAccounts = false,
): Promise<number> {
  if (!getSettings(deps.db, deps.env).autoDownloadEnabled) return 0;
  if (deps.env.SPIGOT_INTERACTIVE_CHALLENGE && deps.challengeSessions?.hasActive()) return 0;

  const dbAccounts = listEnabledSpigotAccounts(deps.db);
  let usableCredentials: Credential[] = [];
  if (dbAccounts.length > 0) {
    usableCredentials = dbAccounts.map((a) => ({
      label: a.label,
      username: a.username,
      password: a.password.reveal(),
      enabled: a.isEnabled,
    }));
  } else {
    const credentials = loadSpigotCredentials(deps.env.SPIGOT_CREDENTIALS_FILE);
    if (!credentials.ok) {
      if (credentials.reason === 'malformed') {
        console.error(`Tệp tài khoản Spigot không đọc được: ${credentials.detail}`);
        sweepLogs.add(`❌ Tệp tài khoản Spigot (${deps.env.SPIGOT_CREDENTIALS_FILE}) không hợp lệ: ${credentials.detail}`, 'error');
      } else {
        sweepLogs.add(`⚠️ Bỏ qua quét tài khoản: Không có tài khoản Spigot trong SQLite và không tìm thấy tệp tài khoản (${deps.env.SPIGOT_CREDENTIALS_FILE}).`, 'warn');
      }
      return 0;
    }
    usableCredentials = enabledSpigotCredentials(credentials.credentials);
  }

  const isHeadless = deps.env.CLOAKBROWSER_HEADLESS;
  const launcherOpts = {
    headless: isHeadless,
    showWindow: !isHeadless,
    enableGpu: deps.env.CHROME_ENABLE_GPU ?? true,
    display: deps.env.CHROME_DISPLAY,
  };
  const probe = await probeBrowserLauncher(
    deps.env.CHROME_PATH,
    deps.env.CHROME_PROFILE_DIR,
    undefined,
    launcherOpts,
  );
  if (!probe.available) {
    console.error(`Không đọc được danh sách đã mua: ${probe.reason}`);
    sweepLogs.add(`Không đọc được danh sách đã mua: ${probe.reason}`, 'error');
    return 0;
  }

  // Trần số lượt mua vé được đặt lại cho lượt quét này; cache vé thì sống xuyên lượt.
  const solverFor = deps.challengeSolvers?.forSweep();

  // Bỏ trạng thái của tài khoản đã rời khỏi hệ thống, để bảng không phình theo thời
  // gian và tài khoản đổi tên được quét lại.
  const known = new Set<string>(usableCredentials.map((c) => c.label));
  for (const state of listScanStates(deps.db)) {
    if (!known.has(state.accountLabel)) forgetScanState(deps.db, state.accountLabel);
  }

  // Xoá profile Chrome của tài khoản đã rời khỏi tệp: mỗi tài khoản giữ một
  // profile bền (vài chục MB), bỏ đi thì rác lại nằm mãi trên đĩa.
  const prunedProfiles = pruneOrphanProfiles(deps.env.CHROME_PROFILE_DIR, known);
  if (prunedProfiles > 0) console.log(`Đã xoá ${prunedProfiles} profile Chrome của tài khoản không còn trong tệp.`);

  if (force) {
    for (const credential of usableCredentials) {
      forgetScanState(deps.db, credential.label);
      deps.challengeCooldowns?.clear(credential.label);
    }
    console.log(`Quét thủ công: đặt lại lịch của ${usableCredentials.length} tài khoản để kiểm tra ngay.`);
  }

  // Chỉ quét tài khoản đến hạn. Đây là điểm khiến 100 tài khoản dùng được: quét
  // hết mỗi lượt sẽ mất hơn một giờ và chặn luôn việc tải jar.
  const allDue = selectAccountsDueForScan(
    deps.db,
    usableCredentials,
    PURCHASED_SCAN_INTERVAL_MS,
    usableCredentials.length,
  );
  const due = scanAllAccounts ? usableCredentials : allDue.slice(0, MAX_ACCOUNTS_PER_SCAN);

  if (due.length === 0) {
    // Said out loud, because the alternative is silence that reads as "the scan
    // step is broken". A label with a recorded failure is the common case here.
    const states = listScanStates(deps.db);
    const failed = states.filter((s) => s.lastError !== '');
    const retrying = failed.filter(
      (state) => findScanRetry(deps.db, state.accountLabel, PURCHASED_SCAN_INTERVAL_MS) !== null,
    ).length;
    console.log(
      `Danh sách đã mua: chưa tài khoản nào đến hạn quét lại (mỗi tài khoản 1 lần/ngày)` +
        (failed.length > 0
          ? `. Lần trước lỗi: ${failed.map((s) => `${s.accountLabel} (${s.lastError})`).join('; ')}` +
            `. Chạy \`npm run rescan-purchased\` để quét lại ngay.`
          : ''),
    );
    return retrying;
  }
  const waiting = usableCredentials.length - due.length;
  console.log(
    `Quét danh sách đã mua: ${due.length} tài khoản lần này` +
      (waiting > 0 ? `, ${waiting} tài khoản chờ lượt sau` : ''),
  );
  sweepLogs.add(
    `Quét danh sách đã mua: ${due.length} tài khoản lần này${waiting > 0 ? ` (${waiting} tài khoản chờ lượt sau)` : ''}`,
    'info',
  );

  // Quét theo TỪNG tài khoản: mỗi tài khoản mua những plugin khác nhau, và chỉ
  // lấy của tài khoản đầu sẽ bỏ sót phần còn lại.
  //
  // Mỗi tài khoản một trình duyệt + profile riêng, KHÔNG dùng chung rồi đăng
  // xuất giữa chừng. Dùng chung buộc phải logout, mà trang tái dùng sau logout
  // mất focus bàn phía nên tài khoản thứ hai trở đi luôn báo "ô tên rỗng" dù mật
  // khẩu đúng. Trình duyệt mới thì mỗi lần đăng nhập đều là lần đầu — đúng trường
  // hợp vốn luôn thành công. Profile bền theo tài khoản nên chỉ lần đầu tiên của
  // tài khoản đó phải vượt Cloudflare, các lượt sau tái dùng vé của chính nó.
  let anySuccess = false;
  let attempted = 0;
  for (const credential of due) {
    // Each account costs ~45 seconds, so shutdown must be able to cut in
    // between them rather than waiting out the whole list.
    if (deps.signal?.aborted) {
      console.log('Đang tắt, dừng quét danh sách đã mua giữa chừng.');
      sweepLogs.add('Đang tắt dịch vụ, dừng quét giữa chừng.', 'warn');
      break;
    }

    const cooldown = (force || scanAllAccounts) ? null : deps.challengeCooldowns?.get(credential.label);
    if (cooldown) {
      const minutes = Math.max(1, Math.ceil(cooldown.remainingMs / 60_000));
      console.log(`Skipping ${credential.label}: Cloudflare cooldown has about ${minutes} minute(s) left.`);
      sweepLogs.add(`Bỏ qua ${credential.label}: Đang trong thời gian chờ Cloudflare (còn khoảng ${minutes} phút)`, 'warn');
      recordScan(deps.db, credential.label, 0, cooldown.reason, {
        retryAfterMs: cooldown.remainingMs,
        intervalMs: PURCHASED_SCAN_INTERVAL_MS,
      });
      continue;
    }

    attempted++;

    let session: BrowserSession | null = null;
    try {
      const isGui = !deps.env.CLOAKBROWSER_HEADLESS;
      const modeNote = isGui
        ? ` (Cửa sổ GUI: BẬT)`
        : ' (Headless: BẬT)';
      const proxyEnabled = getSettings(deps.db, deps.env).spigotProxyEnabled;
      const proxyNote = proxyEnabled ? '' : ' [Direct IP]';
      let attemptSolver: ChallengeSolver | null = null;
      // 1. Thử dùng cookie sống đã lưu trong ./data/cookie/{account}/* hoặc DB
      const savedFromFile = loadAccountCookiesFromFile(credential.label);
      const dbAccounts = listSpigotAccounts(deps.db);
      const matchedAcc = dbAccounts.find((a) => a.label === credential.label);
      const hasSavedCookie = Boolean(savedFromFile || matchedAcc?.xfUser.reveal());

      if (hasSavedCookie) {
        try {
          sweepLogs.add(`🍪 [${credential.label}] Thử kích hoạt bằng Cookie đã lưu trước...`, 'info');
          const quick = await launchForAccount(probe, deps.env, credential.label, deps.proxyPool, proxyEnabled, 1);
          session = quick.session;
          attemptSolver = solverFor?.(quick.endpoint) ?? null;
          if (matchedAcc?.xfUser.reveal()) {
            await injectSpigotSessionCookies(session.page, {
              xfUser: matchedAcc.xfUser.reveal()!,
              xfSession: matchedAcc.xfSession.reveal() ?? '',
            });
          }
          await session.page.goto('https://www.spigotmc.org/resources/purchased', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
          const pageTitle = await session.page.title().catch(() => '');
          if (/just a moment|checking your browser/i.test(pageTitle)) {
            const waitMs = process.env.VITEST ? 50 : 3000;
            await new Promise((r) => setTimeout(r, waitMs));
            await tryClickTurnstile(session.page, { skipWait: true });
            await new Promise((r) => setTimeout(r, process.env.VITEST ? 50 : 2000));
          }
          const hasUser = await session.page.evaluate(
            `(() => !!(document.querySelector('.accountUsername, a[href*="/members/"], a[href*="logout"]') || document.title.includes('Purchased')))` as never
          ).catch(() => false);
          if (hasUser) {
            sweepLogs.add(`⚡ [${credential.label}] Cookie phiên sống! Đăng nhập thành công ngay lập tức!`, 'success');
            anySuccess = true;
          } else {
            await session.close().catch(() => undefined);
            session = null;
          }
        } catch {
          await session?.close().catch(() => undefined);
          session = null;
        }
      }

      if (!session) {
        sweepLogs.add(`[${credential.label}] Đang khởi động Chrome${modeNote}${proxyNote} & đăng nhập SpigotMC...`, 'info');
        const attempt = await loginWithProxyRotation(probe, deps.env, credential, deps.proxyPool, solverFor, proxyEnabled);
        session = attempt.session;
        attemptSolver = attempt.solver;

        const login = attempt.login;
        if (!login.ok) {
          console.warn(`Đăng nhập ${credential.label} thất bại: ${login.detail}`);
          sweepLogs.add(`[${credential.label}] Đăng nhập thất bại: ${login.detail}`, 'error');
          // Ghi cả lần thất bại, nhưng chỉ chờ một chu kỳ ngắn: không ghi gì thì tài
          // khoản lỗi bị thử mỗi giờ và chiếm suất của tài khoản chưa quét bao giờ,
          // còn ghi như một lần thành công thì một lần trượt khoá nó suốt 24 giờ —
          // kể cả sau khi chủ bot đã sửa mật khẩu.
          const retryAfterMs =
            login.reason === 'challenged' ? deps.env.SPIGOT_CHALLENGE_COOLDOWN_MS : FAILED_SCAN_RETRY_MS;
          recordScan(deps.db, credential.label, 0, login.detail, {
            retryAfterMs,
            intervalMs: PURCHASED_SCAN_INTERVAL_MS,
          });
          if (login.reason === 'challenged') {
            deps.challengeCooldowns?.block(credential.label, login.detail);
          }
          if (
            login.reason === 'challenged' &&
            deps.env.SPIGOT_INTERACTIVE_CHALLENGE &&
            deps.challengeSessions
          ) {
            const heldSession = session;
            await deps.challengeSessions.hold({
              accountLabel: credential.label,
              credential,
              reason: login.detail,
              session: heldSession,
              retryLogin: async () => {
                const retried = await loginToSpigot(heldSession.page, credential, {}, attempt.solver ?? undefined);
                if (!retried.ok) return retried;
                const purchased = await scanPurchasedResources(heldSession.page, {
                  solver: attempt.solver ?? undefined,
                });
                if (!purchased.ok) {
                  recordScan(deps.db, credential.label, 0, purchased.detail, {
                    retryAfterMs: FAILED_SCAN_RETRY_MS,
                    intervalMs: PURCHASED_SCAN_INTERVAL_MS,
                  });
                  return { ok: false, reason: 'challenged', detail: purchased.detail };
                }
                for (const resource of purchased.resources) {
                  recordOwnership(deps.db, resource.resourceId, credential.label, 'owned');
                }
                const sync = syncPurchasedResources(deps.db, purchased.resources, { createMissing: true });
                recordScan(deps.db, credential.label, purchased.resources.length);
                deps.challengeCooldowns?.clear(credential.label);
                for (const line of formatSyncOutcome(sync)) console.log(line);
                return retried;
              },
            });
            session = null;
            console.warn(`Đang chờ admin xác minh Cloudflare trên browser VPS cho ${credential.label}.`);
          }
          // Nếu CHƯA tài khoản nào vào được thì Cloudflare đang chặn toàn cục — dừng
          // lại. Khi đã có tài khoản thành công thì mỗi tài khoản có profile riêng
          // nên một cú chặn không lan sang tài khoản khác; cứ đi tiếp.
          if (login.reason === 'challenged' && deps.env.SPIGOT_INTERACTIVE_CHALLENGE && !anySuccess) break;
          continue;
        }
      }

      deps.challengeCooldowns?.clear(credential.label);
      anySuccess = true;
      sweepLogs.add(`[${credential.label}] Đăng nhập thành công! Đang đọc trang danh sách plugin đã mua...`, 'success');

      // Tự động trích xuất và lưu cookies tài khoản vào ./data/cookie/{account}/*
      try {
        const savedCookies = await extractAndSaveCookiesFromPage(session.page, credential.label, {
          status: 'active',
        });
        sweepLogs.add(`💾 [${credential.label}] Đã lưu ${savedCookies.cookieCount} cookies vào ./data/cookie/${credential.label}/*`, 'success');
        if (savedCookies.xfUser) {
          updateSpigotAccountSession(deps.db, credential.label, {
            xfUser: savedCookies.xfUser,
            xfSession: savedCookies.xfSession ?? '',
            issuedAt: new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
            status: 'ok',
          });
        }
      } catch (saveErr) {
        console.warn(`[Scheduler] Lưu cookies thất bại cho ${credential.label}:`, saveErr);
      }

      const scan = await scanPurchasedResources(session.page, {
        solver: attemptSolver ?? undefined,
      });
      if (!scan.ok) {
        console.warn(`Không đọc được danh sách đã mua (${scan.reason}): ${scan.detail}`);
        sweepLogs.add(`[${credential.label}] Không đọc được danh sách đã mua: ${scan.detail}`, 'warn');
        if (scan.reason === 'challenged') deps.challengeCooldowns?.block(credential.label, scan.detail);
        recordScan(deps.db, credential.label, 0, scan.detail, {
          retryAfterMs:
            scan.reason === 'challenged' ? deps.env.SPIGOT_CHALLENGE_COOLDOWN_MS : FAILED_SCAN_RETRY_MS,
          intervalMs: PURCHASED_SCAN_INTERVAL_MS,
        });
        continue;
      }
      recordScan(deps.db, credential.label, scan.resources.length);
      sweepLogs.add(`[${credential.label}] Đọc được ${scan.resources.length} plugin đã mua từ Spigot.`, 'success');

      // The purchased list IS an ownership statement, so record it. Without this
      // the download sweep has no idea who owns what and always starts with the
      // first account — so a plugin bought only on the second account was opened
      // with an account that cannot see its version table, which reads as "version
      // missing" rather than "wrong account". Feeding the cache here means the
      // right account is tried FIRST, usually making it the only one tried.
      for (const resource of scan.resources) {
        recordOwnership(deps.db, resource.resourceId, credential.label, 'owned');
      }

      const sync = syncPurchasedResources(deps.db, scan.resources, { createMissing: true });
      const lines = formatSyncOutcome(sync);
      for (const line of lines) {
        console.log(line);
        sweepLogs.add(line, 'info');
      }
      if (lines.length === 0) {
        console.log(
          `Danh sách đã mua (${credential.label}): ${scan.resources.length} plugin, tất cả đã có mã resource`,
        );
        sweepLogs.add(`[${credential.label}] Tất cả ${scan.resources.length} plugin đã có trong kho dữ liệu.`, 'info');
      }
    } catch (err) {
      console.warn('Lỗi khi đọc danh sách đã mua:', err instanceof Error ? err.message : String(err));
    } finally {
      await session?.close();
    }
  }
  return Math.max(0, allDue.length - attempted);
}

/** Reconciles the dashboard import without opening a browser or reaching Spigot. */
function seedImportedInventory(deps: MaintenanceDeps): void {
  if (!getSettings(deps.db, deps.env).autoDownloadEnabled) return;
  const dbAccounts = listEnabledSpigotAccounts(deps.db);
  if (dbAccounts.length > 0) {
    const creds: Credential[] = dbAccounts.map((a) => ({
      label: a.label,
      username: a.username,
      password: a.password.reveal(),
      enabled: a.isEnabled,
    }));
    seedImportedPurchasedResources(deps.db, creds);
    return;
  }
  const credentials = loadSpigotCredentials(deps.env.SPIGOT_CREDENTIALS_FILE);
  if (!credentials.ok) return;
  seedImportedPurchasedResources(deps.db, credentials.credentials);
}

/**
 * Runs one auto-download sweep, or returns null when the feature is not in play.
 *
 * Returns which plugins it resolved so the caller can skip the manual
 * "go download this" notice for those and still send it for the rest.
 */
async function tryAutoDownload(
  deps: MaintenanceDeps,
  findings: UpdateFinding[],
  options?: SweepOptions,
): Promise<{ outcomes: AutoDownloadOutcome[]; sweep: SweepResult; handledPluginIds: Set<number> } | null> {
  if (!getSettings(deps.db, deps.env).autoDownloadEnabled) {
    sweepLogs.add('⚠️ Tính năng tự động tải đang tắt trong Cài đặt.', 'warn');
    return null;
  }

  // 1. Ưu tiên đọc tài khoản từ bảng spigot_accounts trong SQLite
  const dbAccounts = listEnabledSpigotAccounts(deps.db);
  if (dbAccounts.length > 0) {
    const usable: Credential[] = dbAccounts.map((a) => ({
      label: a.label,
      username: a.username,
      password: a.password.reveal(),
      enabled: a.isEnabled,
    }));
    return runBrowserSweep(deps, findings, usable, options);
  }

  // 2. Fallback sang đọc tệp JSON nếu SQLite chưa có
  const credentials = loadSpigotCredentials(deps.env.SPIGOT_CREDENTIALS_FILE);
  const cookies = loadSpigotAccounts(deps.env.SPIGOT_ACCOUNTS_FILE);

  if (credentials.ok) {
    const usable = enabledSpigotCredentials(credentials.credentials);
    if (usable.length === 0) {
      sweepLogs.add('⚠️ Có tệp tài khoản Spigot nhưng không có tài khoản nào được bật (enabled: true)!', 'warn');
      return null;
    }
    const warning = checkCredentialsFilePermissions(deps.env.SPIGOT_CREDENTIALS_FILE);
    if (warning) console.warn(warning);
    return runBrowserSweep(deps, findings, usable, options);
  }
  if (credentials.reason === 'malformed') {
    // The owner's typo must be loud, or it looks like nothing needed doing.
    console.error(`Tệp tài khoản Spigot không đọc được: ${credentials.detail}`);
    sweepLogs.add(`❌ Tệp tài khoản Spigot (${deps.env.SPIGOT_CREDENTIALS_FILE}) không hợp lệ: ${credentials.detail}`, 'error');
    return null;
  }

  if (!cookies.ok) {
    if (cookies.reason === 'malformed') {
      console.error(`Tệp cookie Spigot không đọc được: ${cookies.detail}`);
      sweepLogs.add(`❌ Tệp cookie Spigot không hợp lệ: ${cookies.detail}`, 'error');
    } else {
      sweepLogs.add(
        `⚠️ Không tìm thấy tệp tài khoản Spigot (${deps.env.SPIGOT_CREDENTIALS_FILE}) để tải tự động! Vui lòng thêm tài khoản ở tab "Tài khoản Spigot".`,
        'warn',
      );
    }
    return null;
  }
  const warning = checkAccountsFilePermissions(deps.env.SPIGOT_ACCOUNTS_FILE);
  if (warning) console.warn(warning);

  // Warn BEFORE the cliff, not after. XenForo caps the xf_user remember token at
  // 30 days and nothing announces the lapse: in cookie mode the system works for a
  // month and then every download fails at once. Naming the accounts and the exact
  // command turns that into a two-minute chore.
  const stale = cookies.accounts.filter((account) => needsRefresh(account, COOKIE_REFRESH_DAYS));
  if (stale.length > 0) {
    console.warn(
      `Cookie sắp hết hạn (${stale.length} tài khoản): ${stale.map((a) => a.label).join(', ')}. ` +
        'Chạy `npm run spigot-refresh` để xem, rồi `npm run spigot-login -- <tên>` để làm mới.',
    );
  }

  return runSweep(deps, findings, cookies.accounts, undefined, undefined, options);
}

/**
 * Credential sweep: one browser, one login, many downloads.
 *
 * The browser is the expensive part, so it is launched once per sweep rather
 * than per plugin. Login happens once too — a fresh page per download would
 * discard the session and re-trigger the challenge every time.
 */
/**
 * Credential sweep: one browser, many accounts, many downloads.
 *
 * The browser is the expensive part, so it is launched once per sweep rather
 * than per plugin. Accounts are signed in ON DEMAND and only when the requested
 * one is not already active — a fresh page per download would discard the
 * session and re-trigger the challenge every time.
 *
 * Every account is offered to the orchestrator, not just the first that logs in.
 * With a single account the orchestrator's per-account fallback is dead code, so
 * a plugin bought on the second account was reported as "nobody owns this" and
 * never fetched.
 */
async function runBrowserSweep(
  deps: MaintenanceDeps,
  findings: UpdateFinding[],
  credentials: Credential[],
  options?: SweepOptions,
): Promise<{ outcomes: AutoDownloadOutcome[]; sweep: SweepResult; handledPluginIds: Set<number> } | null> {
  const isHeadless = deps.env.CLOAKBROWSER_HEADLESS;
  const launcherOpts = {
    headless: isHeadless,
    showWindow: !isHeadless,
    enableGpu: deps.env.CHROME_ENABLE_GPU ?? true,
    display: deps.env.CHROME_DISPLAY,
  };
  const probe: LauncherProbe = await probeBrowserLauncher(
    deps.env.CHROME_PATH,
    deps.env.CHROME_PROFILE_DIR,
    undefined,
    launcherOpts,
  );
  if (deps.challengeSessions?.hasActive()) {
    if (deps.env.SPIGOT_INTERACTIVE_CHALLENGE) return null;
    await deps.challengeSessions.close();
  }
  if (!probe.available) {
    console.error(`Không tải tự động được: ${probe.reason}`);
    sweepLogs.add(`Không tải tự động được: ${probe.reason}`, 'error');
    return null;
  }

  // Nhóm các bản tải theo plugin: các version của cùng 1 plugin thường do cùng 1 tài khoản sở hữu
  // Gom theo plugin giúp mỗi worker tái sử dụng session của tài khoản đó hiệu quả nhất.
  const findingsByPlugin = new Map<number, UpdateFinding[]>();
  for (const finding of findings) {
    const list = findingsByPlugin.get(finding.pluginId) ?? [];
    list.push(finding);
    findingsByPlugin.set(finding.pluginId, list);
  }
  const pluginBatches = Array.from(findingsByPlugin.values());
  if (pluginBatches.length === 0) {
    return { outcomes: [], sweep: { outcomes: [], aborted: false }, handledPluginIds: new Set() };
  }

  const isSingleWorker = true;
  sweepLogs.add(
    '🐢 Khởi động trình duyệt tải SpigotMC (Chế độ 1 Browser siêu ổn định, chống Cloudflare)...',
    'info',
  );

  instanceTracker.registerWorker(1);
  instanceTracker.updateWorker(1, {
    status: 'idle',
    progressText: 'Chờ nhận nhiệm vụ...',
  });

  const byLabel = new Map(credentials.map((c) => [c.label, c]));
  const solverFor = deps.challengeSolvers?.forSweep();

  const stubs: SpigotAccount[] = credentials.map((c) => ({
    label: c.label,
    xfUser: new Secret(''),
    xfSession: new Secret(''),
    issuedAt: null,
    lastVerifiedAt: null,
    status: 'ok',
  }));

  // Hàng đợi chia sẻ an toàn giữa các worker
  let batchIndex = 0;
  const getNextBatch = (): UpdateFinding[] | null => {
    if (batchIndex >= pluginBatches.length) return null;
    const batch = pluginBatches[batchIndex] ?? null;
    batchIndex++;
    return batch;
  };

  const allOutcomes: AutoDownloadOutcome[] = [];
  const allHandledPluginIds = new Set<number>();

  const runWorker = async (workerId: number): Promise<void> => {
    let session: BrowserSession | null = null;
    let active: string | null = null;
    let activeProxyId: string | null = null;
    let activeEpoch = 0;
    let activeSolver: ChallengeSolver | null = null;
    let activeProxyDisplay: string | null = null;
    const unusable = new Set<string>();
    const activationFailures = new Map<string, string>();
    let chromeClosedAbruptly = false;
    let consecutiveCrashes = 0;
    const MAX_CONSECUTIVE_CRASHES = 2;
    let unsubscribeAbruptClose: (() => void) | null = null;

    const detachCurrentSession = async () => {
      if (unsubscribeAbruptClose) {
        try { unsubscribeAbruptClose(); } catch { }
        unsubscribeAbruptClose = null;
      }
      if (session) {
        activeSessions.delete(workerId);
        await session.close().catch(() => undefined);
        session = null;
        active = null;
        activeProxyId = null;
        activeSolver = null;
        activeProxyDisplay = null;
      }
      await cloakSessionManager.releaseLock().catch(() => undefined);
    };

    const handleCrash = (reason: string) => {
      consecutiveCrashes++;
      sweepLogs.addForWorker(
        workerId,
        `🛑 Trình duyệt Chrome bị tắt đột ngột: ${reason} (lần ${consecutiveCrashes}/3)`,
        consecutiveCrashes > MAX_CONSECUTIVE_CRASHES ? 'error' : 'warn',
      );
      if (consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
        chromeClosedAbruptly = true;
        instanceTracker.stopWorker(workerId, `Chrome bị tắt đột ngột (${consecutiveCrashes} lần) — dừng luồng!`);
      }
    };

    const attachSessionAbruptClose = (s: BrowserSession) => {
      if (unsubscribeAbruptClose) {
        try { unsubscribeAbruptClose(); } catch { }
        unsubscribeAbruptClose = null;
      }
      if (typeof s.onAbruptClose === 'function') {
        const unsub = s.onAbruptClose((reason) => {
          handleCrash(`abrupt close: ${reason}`);
        });
        unsubscribeAbruptClose = typeof unsub === 'function' ? unsub : null;
      }
    };

    const activate = async (label: string): Promise<boolean> => {
      if (chromeClosedAbruptly) return false;
      const poolEpoch = deps.proxyPool?.getRotationEpoch() ?? 0;
      const isIpExpired = deps.proxyPool?.isCurrentIpExpired() ?? false;
      const poolProxyId = deps.proxyPool?.getActiveProxyId() ?? null;
      const isSameProxy = activeProxyId === poolProxyId;
      const isSameEpoch = activeEpoch === poolEpoch;

      // Tái sử dụng session cũ CHỈ KHI cùng tài khoản, cùng proxy, cùng epoch và IP CHƯA hết hạn!
      if (active === label && isSameProxy && isSameEpoch && !isIpExpired) {
        return true;
      }

      // Khi IP proxy đã đổi sang IP mới (Epoch mới): Cho phép các tài khoản thử lại trên IP mới
      if (!isSameEpoch && activeEpoch !== 0) {
        unusable.clear();
      }

      if (unusable.has(label)) return false;

      // Bảo vệ tài khoản: Không cho phép 2 worker cùng dùng 1 tài khoản cùng lúc
      if (instanceTracker.isAccountLocked(label, workerId)) {
        instanceTracker.updateWorker(workerId, {
          progressText: `Tài khoản ${label} đang được Worker khác dùng, chờ...`,
        });
        return false;
      }

      const credential = byLabel.get(label);
      if (!credential) return false;

      const cooldown = deps.challengeCooldowns?.get(label);
      if (cooldown) {
        unusable.add(label);
        activationFailures.set(label, cooldown.reason);
        return false;
      }

      if (session) {
        await detachCurrentSession();
      }

      // Nếu IP proxy đã hết hạn sống hoặc bị lỗi (dead), tự động forceRotate để chuyển sang IP mới
      if (deps.proxyPool?.isCurrentIpExpired()) {
        sweepLogs.addForWorker(workerId, '⏱️ IP proxy đã hết hạn sống hoặc bị lỗi — tự động chuyển sang IP mới...', 'info');
        await deps.proxyPool.forceRotate({ maxInstancesPerProxy: 1 });
      }

      // Nếu là 1 Worker: làm việc từ tốn, nghỉ 2s trước khi mở Chrome mới để socket giải phóng êm ái
      if (isSingleWorker && !process.env.VITEST && process.env.NODE_ENV !== 'test') {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      instanceTracker.updateWorker(workerId, {
        status: 'logging_in',
        accountLabel: label,
        progressText: `[${label}] Đang khởi động Chrome & đăng nhập SpigotMC...`,
      });

      const isGui = !deps.env.CLOAKBROWSER_HEADLESS;
      const modeNote = isGui
        ? ` (Cửa sổ GUI: BẬT)`
        : ' (Headless: BẬT)';
      const proxyEnabled = getSettings(deps.db, deps.env).spigotProxyEnabled;
      const proxyNote = proxyEnabled ? '' : ' [Direct IP]';
      sweepLogs.addForWorker(workerId, `[${label}] Khởi động Chrome${modeNote}${proxyNote}...`, 'info');

      // 1. Kiểm tra xem tài khoản có Cookie hợp lệ đã lưu trong file ./data/cookie/{account}/* hoặc DB không
      const savedFromFile = loadAccountCookiesFromFile(label);
      const dbAccounts = listSpigotAccounts(deps.db);
      const matchedAccount = dbAccounts.find((a) => a.label === label);
      const savedXfUser = matchedAccount?.xfUser.reveal() ?? savedFromFile?.metadata?.xfUser;
      const savedXfSession = matchedAccount?.xfSession.reveal() ?? savedFromFile?.metadata?.xfSession;

      if (savedXfUser || savedFromFile) {
        sweepLogs.addForWorker(workerId, `🍪 [${label}] Tìm thấy Cookie phiên đã lưu. Khởi tạo Chrome và tiêm Cookie...`, 'info');
        let candidateSession: BrowserSession | null = null;
        let adopted = false;
        try {
          const launched = await launchForAccount(probe, deps.env, label, deps.proxyPool, proxyEnabled, 1);
          candidateSession = launched.session;
          if (savedXfUser) {
            await injectSpigotSessionCookies(candidateSession.page, { xfUser: savedXfUser, xfSession: savedXfSession ?? '' });
          }

          await candidateSession.page.goto('https://www.spigotmc.org/resources/purchased', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
          const title = await candidateSession.page.title().catch(() => '');
          if (/just a moment|checking your browser/i.test(title)) {
            const waitMs = process.env.VITEST ? 50 : 3000 + Math.floor(Math.random() * 2000);
            sweepLogs.addForWorker(workerId, `🛡️ [${label}] Phát hiện Cloudflare Turnstile, dừng chờ từ từ ${(waitMs / 1000).toFixed(1)}s trước khi ấn...`, 'info');
            await new Promise((r) => setTimeout(r, waitMs));
            await tryClickTurnstile(candidateSession.page, { skipWait: true });
            await new Promise((r) => setTimeout(r, process.env.VITEST ? 50 : 3000));
          }
          const hasUser = await candidateSession.page.evaluate(
            `(() => !!(document.querySelector('.accountUsername, a[href*="/members/"], a[href*="logout"]') || document.title.includes('Purchased')))` as never
          ).catch(() => false);

          if (hasUser) {
            sweepLogs.addForWorker(workerId, `⚡ [${label}] Cookie phiên sống! Kích hoạt thành công tức thì không cần điền mật khẩu!`, 'success');
            // Cập nhật lại cookie vào file ./data/cookie/{account}/*
            try {
              const res = await extractAndSaveCookiesFromPage(candidateSession.page, label, { status: 'active', xfUser: savedXfUser, xfSession: savedXfSession });
              sweepLogs.addForWorker(workerId, `💾 [${label}] Đã cập nhật ${res.cookieCount} cookies sống vào ./data/cookie/${label}/*`, 'success');
            } catch { }
            session = candidateSession;
            adopted = true;
            candidateSession = null;
            activeSessions.set(workerId, session);
            attachSessionAbruptClose(session);
            activeProxyId = launched.endpoint?.id ?? null;
            activeEpoch = deps.proxyPool?.getRotationEpoch() ?? 0;
            activeSolver = solverFor?.(launched.endpoint) ?? null;
            activeProxyDisplay = launched.endpoint
              ? (sweepLogs.getCurrentProxyIp() || 'Proxy')
              : 'Direct (IP máy chủ)';
            deps.challengeCooldowns?.clear(label);
            activationFailures.delete(label);
            active = label;
            instanceTracker.updateWorker(workerId, {
              status: 'idle',
              accountLabel: label,
              proxy: activeProxyDisplay,
              progressText: `Đã kích hoạt tài khoản ${label} (qua Cookie)`,
            });
            return true;
          } else {
            sweepLogs.addForWorker(workerId, `⚠️ [${label}] Cookie đã hết hạn, chuyển sang đăng nhập tự động...`, 'info');
          }
        } catch (cookieErr) {
          console.warn(`[Worker #${workerId}] Thử cookie phiên thất bại:`, cookieErr);
        } finally {
          if (!adopted && candidateSession) {
            await candidateSession.close().catch(() => undefined);
            candidateSession = null;
          }
        }
      }

      let attempt: {
        session: BrowserSession;
        login: LoginResult;
        proxyId: string | null;
        solver: ChallengeSolver | null;
      };
      try {
        attempt = await loginWithProxyRotation(
          probe,
          deps.env,
          credential,
          deps.proxyPool,
          solverFor,
          proxyEnabled,
          1,
        );
      } catch (err) {
        if (isChromeClosedError(err)) {
          const detail = err instanceof Error ? err.message : String(err);
          handleCrash(`đăng nhập: ${detail}`);
          await detachCurrentSession();
          if (consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES) {
            const backoffMs = consecutiveCrashes === 1 ? (process.env.VITEST ? 20 : 1000) : (process.env.VITEST ? 50 : 3000);
            await new Promise((r) => setTimeout(r, backoffMs));
          }
          return false;
        }
        throw err;
      }

      session = attempt.session;
      if (session) {
        activeSessions.set(workerId, session);
        attachSessionAbruptClose(session);
      }
      activeProxyId = attempt.proxyId;
      activeEpoch = deps.proxyPool?.getRotationEpoch() ?? 0;
      activeSolver = attempt.solver;
      activeProxyDisplay = attempt.proxyId
        ? (sweepLogs.getCurrentProxyIp() || 'Proxy')
        : 'Direct (IP máy chủ)';

      const result = attempt.login;
      if (result.ok) {
        deps.challengeCooldowns?.clear(label);
        activationFailures.delete(label);
        active = label;

        // Lưu Cookie mới vào Database cho lần sau
        let newXfUser = (result as any).cookies?.xfUser;
        let newXfSession = (result as any).cookies?.xfSession;
        if (!newXfUser && typeof (session.page as any).cookies === 'function') {
          const pageCookies = await (session.page as any).cookies().catch(() => []);
          newXfUser = pageCookies.find((c: any) => c.name === 'xf_user')?.value;
          newXfSession = pageCookies.find((c: any) => c.name === 'xf_session')?.value;
        }
        if (newXfUser) {
          updateSpigotAccountSession(deps.db, label, {
            xfUser: newXfUser,
            xfSession: newXfSession ?? '',
            issuedAt: new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
            status: 'ok',
          });
          sweepLogs.addForWorker(workerId, `🔑 [${label}] Đã lưu & cập nhật Cookie xf_user vào database cho các lần sau!`, 'success');
        }

        // Lưu toàn bộ cookies sống vào thư mục ./data/cookie/{label}/*
        try {
          const savedResult = await extractAndSaveCookiesFromPage(session.page, label, {
            status: 'active',
            xfUser: newXfUser,
            xfSession: newXfSession,
          });
          sweepLogs.addForWorker(workerId, `💾 [${label}] Đã lưu ${savedResult.cookieCount} cookies sống vào ./data/cookie/${label}/*`, 'success');
        } catch (saveErr) {
          console.warn(`[Worker #${workerId}] Lỗi lưu cookies file:`, saveErr);
        }

        instanceTracker.updateWorker(workerId, {
          status: 'idle',
          accountLabel: label,
          proxy: activeProxyDisplay,
          progressText: `Đã đăng nhập tài khoản ${label}`,
        });
        sweepLogs.addForWorker(workerId, `Đã đăng nhập Spigot thành công với tài khoản @${label}`, 'success');
        return true;
      }

      console.warn(`[Worker #${workerId}] Đăng nhập ${label} thất bại: ${result.detail}`);
      unusable.add(label);
      activationFailures.set(label, result.detail);
      instanceTracker.updateWorker(workerId, {
        status: 'error',
        progressText: `Đăng nhập ${label} thất bại: ${result.detail}`,
      });
      sweepLogs.addForWorker(workerId, `Đăng nhập ${label} thất bại: ${result.detail}`, 'error');
      if (result.reason === 'challenged') deps.challengeCooldowns?.block(label, result.detail);
      if (
        result.reason === 'challenged' &&
        deps.env.SPIGOT_INTERACTIVE_CHALLENGE &&
        deps.challengeSessions
      ) {
        const heldSession = session;
        activeSessions.delete(workerId);
        await deps.challengeSessions.hold({
          accountLabel: label,
          credential,
          reason: result.detail,
          session: heldSession,
          retryLogin: async () => {
            const retried = await loginToSpigot(heldSession.page, credential, {}, attempt.solver ?? undefined);
            if (retried.ok) {
              deps.challengeCooldowns?.clear(label);
              try {
                const saved = await extractAndSaveCookiesFromPage(heldSession.page, label, { status: 'active' });
                if (saved.xfUser) {
                  updateSpigotAccountSession(deps.db, label, {
                    xfUser: saved.xfUser,
                    xfSession: saved.xfSession ?? '',
                    issuedAt: new Date().toISOString(),
                    lastVerifiedAt: new Date().toISOString(),
                    status: 'ok',
                  });
                }
              } catch { }
            }
            return retried;
          },
        });
        session = null;
        sweepLogs.addForWorker(workerId, `Chờ admin xác minh Cloudflare trên VPS cho @${label}.`, 'warn');
        return false;
      }
      if (session) {
        await detachCurrentSession();
      }
      return false;
    };

    try {
      while (!deps.signal?.aborted && !chromeClosedAbruptly) {
        const batch = getNextBatch();
        if (!batch || batch.length === 0) break;

        const pluginName = batch[0]?.pluginName ?? 'Plugin';
        const resourceId = batch[0]?.resourceId ?? 0;

        // Xác định tài khoản sở hữu cho plugin này
        let assignedOwner = findOwner(deps.db, resourceId);
        if (!assignedOwner && credentials.length > 0) {
          const pNorm = normalizeName(pluginName);
          for (const c of credentials) {
            if (c.enabled === false) continue;
            const match = (c.purchasedResources ?? []).some((r) => {
              const rNorm = normalizeName(r);
              return rNorm && (rNorm === pNorm || rNorm.includes(pNorm) || pNorm.includes(rNorm));
            });
            if (match) {
              recordOwnership(deps.db, resourceId, c.label, 'owned');
              assignedOwner = c.label;
              break;
            }
          }
        }

        if (!assignedOwner) {
          sweepLogs.addForWorker(
            workerId,
            `⚠️ [${pluginName} #${resourceId}] Chưa xác định tài khoản Spigot sở hữu — Bỏ qua tải để tránh tải sai tài khoản`,
            'warn',
          );
        } else if (unusable.has(assignedOwner)) {
          sweepLogs.addForWorker(
            workerId,
            `⚠️ [${pluginName} #${resourceId}] Tài khoản sở hữu @${assignedOwner} đã gặp lỗi trong phiên này — Bỏ qua ${batch.length} phiên bản`,
            'warn',
          );
          continue;
        } else {
          sweepLogs.addForWorker(
            workerId,
            `Bắt đầu xử lý ${batch.length} phiên bản của ${pluginName} (Tài khoản sở hữu: @${assignedOwner})`,
            'info',
          );
        }

        instanceTracker.updateWorker(workerId, {
          pluginName,
          status: 'starting',
          progressText: assignedOwner
            ? `Bắt đầu tải ${batch.length} phiên bản của ${pluginName} bằng tài khoản @${assignedOwner}`
            : `Bỏ qua ${pluginName}: Chưa có tài khoản sở hữu`,
        });

        const fetchJar = async (
          account: SpigotAccount,
          resourceId: number,
          versionName: string,
        ): Promise<DownloadOutcome> => {
          let outcome: DownloadOutcome | null = null;
          let fetchAttempts = 0;

          while (fetchAttempts < 3) {
            fetchAttempts++;
            instanceTracker.heartbeat(workerId, `Chuẩn bị tải ${pluginName} v${versionName}...`);
            if (chromeClosedAbruptly) {
              return { status: 'error', detail: 'chrome_abruptly_closed: Chrome đã bị tắt đột ngột' };
            }

            // Kiểm tra nếu IP proxy đã chết (dead) hoặc hết hạn sống 1800s
            if (deps.proxyPool?.isCurrentIpExpired()) {
              sweepLogs.addForWorker(
                workerId,
                '⏱️ IP proxy đã hết hạn sống hoặc bị lỗi kết nối — bắt buộc đổi IP mới trước khi tải',
                'info',
              );
              await deps.proxyPool.forceRotate({ maxInstancesPerProxy: 1 });
            }

            // Chế độ 1 Worker: Tăng tối đa độ ổn định (thời gian lâu => ổn định cao, làm việc từ tốn)
            if (isSingleWorker && !process.env.VITEST && process.env.NODE_ENV !== 'test') {
              sweepLogs.addForWorker(workerId, '🐢 [Chế độ 1 Worker] Nghỉ 3.5s giãn cách thao tác an toàn...', 'info');
              instanceTracker.heartbeat(workerId, 'Đang nghỉ giãn cách thao tác...');
              await new Promise((resolve) => setTimeout(resolve, 3500));
            }

            if (!(await activate(account.label)) || !session) {
              const challenge = deps.challengeSessions?.getStatus();
              if (challenge?.active) {
                return {
                  status: 'challenged',
                  detail: challenge.reason ?? `Cloudflare chặn tài khoản ${account.label}`,
                };
              }
              if (consecutiveCrashes > 0 && consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES && !chromeClosedAbruptly) {
                continue;
              }
              return {
                status: 'incomplete',
                detail: activationFailures.get(account.label) ?? `không đăng nhập được ${account.label}`,
              };
            }

            instanceTracker.updateWorker(workerId, {
              status: 'downloading',
              pluginName,
              versionName,
              taskStartedAt: Date.now(),
              progressText: `Đang tải ${pluginName} v${versionName}...`,
            });
            sweepLogs.addForWorker(workerId, `Đang tải ${pluginName} v${versionName}...`, 'info');

            const jobDeadline = new HierarchicalDeadline({
              jobTimeoutMs: 180_000,
              parentSignal: deps.signal,
            });
            const downloadDeadline = jobDeadline.createChildSignal(120_000);

            const workerTab = session.page;
            try {
              outcome = await downloadViaBrowser(
                {
                  tmpDir: deps.env.TMP_DIR,
                  maxBytes: deps.env.UPLOAD_MAX_FILE_BYTES,
                  signal: downloadDeadline.signal,
                  ...(activeProxyId === null ? { fetchImpl: fetch } : {}),
                  ...(activeSolver ? { solver: activeSolver } : {}),
                  onHeartbeat: () => {
                    instanceTracker.heartbeat(workerId);
                  },
                  onProgress: (bytes, status) => {
                    const mb = (bytes / 1048576).toFixed(1);
                    instanceTracker.heartbeat(workerId, `Đang tải: ${mb} MB (${status ?? 'in_progress'})`);
                  },
                  log: (message) => {
                    const msg = message.trim();
                    const isErr =
                      msg.includes('lỗi') ||
                      msg.includes('thất bại') ||
                      msg.includes('Error') ||
                      msg.includes('hết thời gian');
                    const isOk = msg.includes('thành công') || msg.includes('xong') || msg.includes('OK');
                    instanceTracker.heartbeat(workerId, msg);
                    sweepLogs.addForWorker(workerId, msg, isErr ? 'error' : isOk ? 'success' : 'info');
                  },
                },
                workerTab,
                resourceId,
                versionName,
              );
            } finally {
              downloadDeadline.cleanup();
            }

            // Cập nhật thống kê worker
            const currentWorker = instanceTracker.getAll().find((w) => w.id === workerId);
            if (outcome.status === 'ok') {
              consecutiveCrashes = 0; // Reset crash counter after successful acquisition!
              instanceTracker.updateWorker(workerId, {
                successCount: (currentWorker?.successCount ?? 0) + 1,
                progressText: `Đã tải thành công ${pluginName} v${versionName}`,
              });
              sweepLogs.addForWorker(workerId, `Đã tải thành công ${pluginName} v${versionName}`, 'success');
              break;
            } else if (outcome.status !== 'incomplete' && outcome.status !== 'not_owned') {
              const detailText = 'detail' in outcome ? (outcome.detail ?? outcome.status) : outcome.status;
              instanceTracker.updateWorker(workerId, {
                failCount: (currentWorker?.failCount ?? 0) + 1,
                progressText: `Tải thất bại (${detailText})`,
              });
              sweepLogs.addForWorker(workerId, `Tải thất bại (${detailText})`, 'error');
            }

            if (outcome.status === 'error') {
              if (isChromeClosedError(outcome.detail)) {
                handleCrash(outcome.detail ?? 'Chrome crash');
                await detachCurrentSession();
                if (consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES) {
                  const backoffMs = consecutiveCrashes === 1
                    ? (process.env.VITEST ? 20 : 1000)
                    : (process.env.VITEST ? 50 : 3000);
                  sweepLogs.addForWorker(
                    workerId,
                    `🔄 Chrome bị tắt đột ngột (lần ${consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}). Đang tự động khởi động lại sau ${backoffMs}ms...`,
                    'warn',
                  );
                  instanceTracker.heartbeat(workerId, `Đang khởi động lại sau crash (${consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES})...`);
                  await new Promise((r) => setTimeout(r, backoffMs));
                  chromeClosedAbruptly = false;
                  continue;
                }
                return { status: 'error', detail: outcome.detail };
              }

              if (activeProxyId && isProxyFailure(new Error(outcome.detail ?? ''))) {
                deps.proxyPool?.markBad(activeProxyId);
                sweepLogs.addForWorker(workerId, `Proxy ${activeProxyId} bị lỗi — mở lại bằng IP khác`, 'warn');
                activationFailures.set(account.label, 'proxy chết giữa lượt tải');
                await detachCurrentSession();
                return { status: 'incomplete', detail: 'proxy chết giữa lượt tải' };
              }
            }

            if (outcome.status === 'challenged' && session) {
              if (activeProxyId) {
                deps.proxyPool?.markBad(activeProxyId);
                sweepLogs.addForWorker(workerId, `Proxy ${activeProxyId} bị Cloudflare chặn`, 'warn');
              }
              activationFailures.set(account.label, outcome.detail);
              unusable.add(account.label);
              const credential = byLabel.get(account.label);
              if (credential && deps.env.SPIGOT_INTERACTIVE_CHALLENGE && deps.challengeSessions) {
                const heldSession = session;
                const heldSolver = activeSolver;
                activeSessions.delete(workerId);
                if (unsubscribeAbruptClose) {
                  try { unsubscribeAbruptClose(); } catch { }
                  unsubscribeAbruptClose = null;
                }
                session = null;
                await deps.challengeSessions.hold({
                  accountLabel: account.label,
                  credential,
                  reason: outcome.detail,
                  session: heldSession,
                  retryLogin: async () => {
                    const retried = await loginToSpigot(heldSession.page, credential, {}, heldSolver ?? undefined);
                    if (retried.ok) {
                      deps.challengeCooldowns?.clear(account.label);
                      try {
                        const saved = await extractAndSaveCookiesFromPage(heldSession.page, account.label, { status: 'active' });
                        if (saved.xfUser) {
                          updateSpigotAccountSession(deps.db, account.label, {
                            xfUser: saved.xfUser,
                            xfSession: saved.xfSession ?? '',
                            issuedAt: new Date().toISOString(),
                            lastVerifiedAt: new Date().toISOString(),
                            status: 'ok',
                          });
                        }
                      } catch { }
                    }
                    return retried;
                  },
                });
                return outcome;
              }
              await detachCurrentSession();
              return outcome;
            }

            break;
          }

          if (!outcome) {
            return { status: 'error', detail: 'Quá trình tải thất bại sau nhiều lần thử' };
          }

          // Trong chế độ 1 Worker: Cho phép nghỉ 2s để file xả xuống đĩa và session ổn định
          if (isSingleWorker && !process.env.VITEST && process.env.NODE_ENV !== 'test' && outcome.status === 'ok') {
            sweepLogs.addForWorker(workerId, '🐢 [Chế độ 1 Worker] Nghỉ 2s sau khi tải xong để ổn định kết nối...', 'info');
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }

          return outcome;
        };

        const sweep = await runSweep(deps, batch, stubs, fetchJar, () => active, options);
        for (const out of sweep.outcomes) allOutcomes.push(out);
        for (const id of sweep.handledPluginIds) allHandledPluginIds.add(id);

        if (sweep.sweep.abortReason === 'chrome_closed') {
          handleCrash('chrome_closed during sweep');
          await detachCurrentSession();
          if (consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES) {
            const backoffMs = consecutiveCrashes === 1 ? (process.env.VITEST ? 20 : 1000) : (process.env.VITEST ? 50 : 3000);
            sweepLogs.addForWorker(workerId, `🔄 Khởi động lại luồng #${workerId} sau sự cố Chrome (lần ${consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES})...`, 'info');
            await new Promise((r) => setTimeout(r, backoffMs));
            chromeClosedAbruptly = false;
            continue;
          } else {
            chromeClosedAbruptly = true;
            sweepLogs.addForWorker(workerId, `🛑 Đã dừng hoàn toàn luồng #${workerId} do Chrome bị tắt đột ngột.`, 'warn');
            instanceTracker.stopWorker(workerId, 'Chrome bị tắt đột ngột — đã dừng luồng!');
            break;
          }
        }

        if (chromeClosedAbruptly) {
          sweepLogs.addForWorker(workerId, `🛑 Đã dừng hoàn toàn luồng #${workerId} do Chrome bị tắt đột ngột.`, 'warn');
          instanceTracker.stopWorker(workerId, 'Chrome bị tắt đột ngột — đã dừng luồng!');
          break;
        }
      }
    } catch (err) {
      if (isChromeClosedError(err)) {
        const errMsg = err instanceof Error ? err.message : String(err);
        handleCrash(`tiến trình worker: ${errMsg}`);
        await detachCurrentSession();
        if (consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
          chromeClosedAbruptly = true;
          sweepLogs.addForWorker(workerId, `🛑 Trình duyệt Chrome bị tắt đột ngột: ${errMsg} — Dừng luồng #${workerId}!`, 'error');
          instanceTracker.stopWorker(workerId, `Chrome bị tắt đột ngột: ${errMsg}`);
        }
      } else {
        console.error(`[Worker #${workerId}] Lỗi tiến trình worker:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);
        instanceTracker.updateWorker(workerId, {
          status: 'error',
          lastError: errMsg,
          progressText: `Lỗi: ${errMsg}`,
        });
        sweepLogs.addForWorker(workerId, `Lỗi tiến trình worker: ${errMsg}`, 'error');
      }
    } finally {
      await detachCurrentSession();
      if (!chromeClosedAbruptly) {
        instanceTracker.releaseWorker(workerId);
      }
    }
  };

  // Khởi động watchdog định kỳ 15s kiểm tra các luồng bị treo / không phản hồi
  const watchdogTimer = setInterval(() => {
    const stalled = instanceTracker.checkWatchdog(90_000);
    for (const wId of stalled) {
      sweepLogs.addForWorker(wId, '⚠️ Watchdog cảnh báo: Luồng không phản hồi trong hơn 90 giây', 'warn');
    }
  }, 15_000);
  watchdogTimer.unref();

  try {
    await runWorker(1);

    const isAborted = deps.signal?.aborted ?? false;
    return {
      outcomes: allOutcomes,
      sweep: {
        outcomes: allOutcomes,
        aborted: isAborted,
        ...(isAborted ? { abortReason: 'shutdown' } : {}),
      },
      handledPluginIds: allHandledPluginIds,
    };
  } catch (err) {
    console.error('Lỗi khi chạy tổng thể các worker:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearInterval(watchdogTimer);
    for (const [wId, sess] of activeSessions.entries()) {
      await sess.close().catch(() => undefined);
    }
    activeSessions.clear();
    instanceTracker.resetAll();
  }
}

/** Shared sweep body: identical regardless of how bytes are obtained. */
async function runSweep(
  deps: MaintenanceDeps,
  findings: UpdateFinding[],
  accounts: SpigotAccount[],
  fetchJar: ((account: SpigotAccount, resourceId: number, versionName: string) => Promise<DownloadOutcome>) | undefined,
  activeAccount?: () => string | null,
  options?: SweepOptions,
): Promise<{ outcomes: AutoDownloadOutcome[]; sweep: SweepResult; handledPluginIds: Set<number> }> {
  const sweep = await autoDownloadVersions(
    {
      db: deps.db,
      ingest: { db: deps.db, vaultDir: deps.vaultDir, tmpDir: deps.env.TMP_DIR },
      accounts,
      accountsFile: deps.env.SPIGOT_ACCOUNTS_FILE,
      storageUrl: deps.env.STORAGE_URL,
      download: {
        tmpDir: deps.env.TMP_DIR,
        // Reuses the upload cap: "the biggest jar we accept" is one question,
        // and a second knob would let the two disagree.
        maxBytes: deps.env.UPLOAD_MAX_FILE_BYTES,
      },
      minIntervalMs: deps.env.SPIGOT_DOWNLOAD_MIN_INTERVAL_MS,
      maxPerSweep: options?.maxPerSweep ?? deps.env.SPIGOT_MAX_DOWNLOADS_PER_SWEEP,
      continueOnError: options?.continueOnError ?? false,
      maxRetriesPerFinding: options?.maxRetriesPerFinding ?? 1,
      // Read per download, not once per sweep: a long sweep must stop promptly
      // when the owner flips the toggle off.
      isEnabled: () => getSettings(deps.db, deps.env).autoDownloadEnabled,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(fetchJar ? { fetchJar } : {}),
      ...(activeAccount ? { activeAccount } : {}),
    },
    findings,
  );

  // A retrying outcome is not resolved — the owner should still get the manual
  // notice so a broken download never leaves them waiting on nothing.
  const handledPluginIds = new Set(
    findings
      .filter((finding) =>
        sweep.outcomes.some(
          (outcome) =>
            outcome.pluginName === finding.pluginName &&
            outcome.versionName === finding.upstream.name &&
            outcome.status !== 'retrying',
        ),
      )
      .map((finding) => finding.pluginId),
  );

  return { outcomes: sweep.outcomes, sweep, handledPluginIds };
}
