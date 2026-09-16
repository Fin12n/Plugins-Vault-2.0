import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Db } from '../../db/connection.js';
import type { UpdateFinding } from './check-plugin-updates.js';
import type { SpigotAccount } from './spigot-account-store.js';
import { saveSpigotAccounts } from './spigot-account-store.js';
import { downloadSpigotResource, type DownloadDeps, type DownloadOutcome } from './download-spigot-resource.js';
import { probeSpigotAuth, type AuthVerdict } from './probe-spigot-auth.js';
import { fileSource, ingestJarBatch, type IngestContext } from '../ingest/ingest-jar-batch.js';
import { deferDownload, enqueueDownload, keepDownloadDue, resolveDownload } from '../../repositories/pending-download.js';
import { findNonOwners, findOwners, forgetAccount, listOwnership, orderAccountsFor, recordOwnership } from '../../repositories/resource-ownership.js';
import { findPluginById, updatePlugin } from '../../repositories/plugins.js';
import { loadSpigotCredentials } from './spigot-credential-store.js';
import { normalizeName } from './sync-purchased-resources.js';
import { isChromeClosedError } from './chrome-close-detector.js';

/**
 * Fetches jars for versions the watcher found, using the owner's own sessions.
 *
 * Detection stays in check-plugin-updates: this consumes its findings. Keeping
 * acquisition out of that module preserves its stated contract — notification
 * only — and means a broken download can never stop detection from working.
 */

export type AutoDownloadOutcome = {
  pluginName: string;
  versionName: string;
  status:
    | 'archived'
    | 'duplicate'
    | 'parked'
    | 'not_owned'
    | 'cookie_dead'
    | 'challenged'
    | 'retrying'
    | 'failed';
  detail: string;
  /** Label of the account that succeeded, for the owner's notification. */
  accountLabel?: string;
};

export type AutoDownloadDeps = {
  db: Db;
  ingest: IngestContext;
  accounts: SpigotAccount[];
  accountsFile: string;
  download: Omit<DownloadDeps, 'signal'>;
  minIntervalMs: number;
  maxPerSweep: number;
  /** Re-read before every download so the toggle is a real kill switch. */
  isEnabled: () => boolean;
  /**
   * How bytes are fetched. Defaults to the plain-fetch downloader; a
   * browser-backed one is injected when the host has Chrome, since Spigot's
   * download endpoint only answers a real page navigation. Everything after
   * this point — retry classification, throttling, ingest, notification — is
   * identical either way, so it lives here once.
   */
  fetchJar?: (account: SpigotAccount, resourceId: number, versionName: string) => Promise<DownloadOutcome>;
  /**
   * Which account is signed in right now, when a session is held outside this
   * module.
   *
   * Read per finding rather than passed once: the browser sweep changes it as it
   * goes, and a stale value would send the ordering to the wrong account. Absent
   * in cookie mode, where every account is equally "signed in" and switching
   * costs nothing.
   */
  activeAccount?: () => string | null;
  signal?: AbortSignal;
  logger?: { warn: (message: string) => void };
  /** Injected so tests do not sleep in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Khi bật, không dừng cả lượt quét nếu một plugin bị lỗi hoặc gặp challenge */
  continueOnError?: boolean;
  /** Số lần thử lại tối đa cho mỗi phiên bản plugin khi gặp sự cố */
  maxRetriesPerFinding?: number;
};

export type SweepResult = {
  outcomes: AutoDownloadOutcome[];
  /** True when the sweep stopped early — challenge, dead cookie, or shutdown. */
  aborted: boolean;
  abortReason?: string;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Marks a verdict that could not be probed because the session lives in a
 * browser rather than in a cookie this process holds.
 *
 * A sentinel rather than a boolean flag threaded through the call chain: the
 * verdict already travels as a string, and only one call site needs to tell this
 * case apart from a genuine challenge.
 */
const BROWSER_SESSION = 'phiên do trình duyệt giữ';

/**
 * Runs one download sweep.
 *
 * Serial on purpose. Parallel downloads across accounts or plugins are the
 * clearest lockout signal, and the whole point of the throttle is to look like a
 * person occasionally fetching an update.
 */
export async function autoDownloadVersions(
  deps: AutoDownloadDeps,
  findings: UpdateFinding[],
): Promise<SweepResult> {
  const outcomes: AutoDownloadOutcome[] = [];
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.logger ?? { warn: console.warn };

  // Queue every finding before fetching anything: if the process dies mid-sweep,
  // the remaining versions are still owed rather than lost to upstream_state.
  for (const finding of findings) {
    enqueueDownload(deps.db, {
      pluginId: finding.pluginId,
      versionUuid: finding.upstream.uuid,
      versionName: finding.upstream.name,
    });
  }

  if (deps.accounts.length === 0) {
    return { outcomes, aborted: true, abortReason: 'no-accounts' };
  }

  // A label removed or renamed in the credentials file must stop steering the
  // ordering, or a stale row would keep sending the sweep to an account that no
  // longer exists.
  const known = new Set(deps.accounts.map((a) => a.label));
  for (const label of new Set(listOwnership(deps.db).map((r) => r.accountLabel))) {
    if (!known.has(label)) forgetAccount(deps.db, label);
  }

  // One verdict per account per sweep. Probing per finding would multiply
  // traffic by the plugin count for no extra information.
  const authCache = new Map<string, AuthVerdict>();
  const verdictFor = async (account: SpigotAccount): Promise<AuthVerdict> => {
    // A browser sweep owns its session inside Chrome and passes placeholder
    // accounts with empty cookies. Probing those sends `cookie: xf_user=`, which
    // reads as logged out and aborts the WHOLE sweep over a plugin that simply is
    // not owned — and, worse, /account/ is Cloudflare-challenged so a plain fetch
    // there can never succeed anyway. Nothing to probe means nothing to conclude.
    if (account.xfUser.length === 0) return { state: 'indeterminate', detail: BROWSER_SESSION };

    const cached = authCache.get(account.label);
    if (cached) return cached;
    const verdict = await probeSpigotAuth(
      { fetchImpl: deps.download.fetchImpl, signal: deps.signal },
      account,
    );
    authCache.set(account.label, verdict);
    return verdict;
  };

  let accounts = [...deps.accounts];
  let processed = 0;

  for (const finding of findings) {
    if (processed >= deps.maxPerSweep) {
      // Logged rather than silent: a bounded sweep that says nothing reads as
      // "everything is up to date".
      log.warn(
        `Đã đạt giới hạn ${deps.maxPerSweep} lượt tải mỗi lần quét; ` +
          `${findings.length - processed} bản còn lại sẽ tải ở lần sau`,
      );
      break;
    }
    if (deps.signal?.aborted) return { outcomes, aborted: true, abortReason: 'shutdown' };
    if (!deps.isEnabled()) return { outcomes, aborted: true, abortReason: 'disabled' };

    // Paces outbound requests. Tunable through SPIGOT_DOWNLOAD_MIN_INTERVAL_MS,
    // but not removable: bursts are the clearest lockout signal, and the account
    // at risk is the one holding every plugin the owner has bought.
    if (processed > 0) await sleep(deps.minIntervalMs);
    processed++;

    let result = await downloadForFinding(deps, finding, accounts, verdictFor, log);
    const maxRetries = deps.maxRetriesPerFinding ?? 1;
    let retries = 0;

    while (
      result.outcome.status !== 'archived' &&
      result.outcome.status !== 'duplicate' &&
      result.outcome.status !== 'not_owned' &&
      result.outcome.status !== 'failed' &&
      !result.abort &&
      !result.outcome.detail?.includes('không thấy bản') &&
      retries < maxRetries - 1
    ) {
      if (deps.signal?.aborted || !deps.isEnabled()) break;
      retries++;
      log.warn(`⚠️ [Retry ${retries}/${maxRetries - 1}] Thử lại tải "${finding.pluginName}" (${finding.upstream.name})...`);
      await sleep(2000);
      result = await downloadForFinding(deps, finding, accounts, verdictFor, log);
    }

    outcomes.push(result.outcome);
    if (result.rotatedAccounts) accounts = result.rotatedAccounts;

    // A challenge or dead cookie is almost certainly shared across the remaining
    // work, so continuing would just hammer a wall and look like an attack.
    if (result.abort) {
      if (isChromeClosedError(result.outcome.detail)) {
        return { outcomes, aborted: true, abortReason: 'chrome_closed' };
      }
      if (deps.continueOnError) {
        log.warn(`⚠️ Bỏ qua sự cố của "${finding.pluginName}" và tiếp tục tải các plugin tiếp theo theo yêu cầu.`);
        continue;
      }
      return { outcomes, aborted: true, abortReason: result.outcome.status };
    }
  }

  return { outcomes, aborted: false };
}

async function downloadForFinding(
  deps: AutoDownloadDeps,
  finding: UpdateFinding,
  accounts: SpigotAccount[],
  verdictFor: (account: SpigotAccount) => Promise<AuthVerdict>,
  log: { warn: (message: string) => void },
): Promise<{ outcome: AutoDownloadOutcome; abort: boolean; rotatedAccounts?: SpigotAccount[] }> {
  const base = { pluginName: finding.pluginName, versionName: finding.upstream.name };
  // Known owner first, never-tried next, known non-owners last. After the first
  // sweep this makes the common case one request instead of N, which is both
  // faster and far less like credential stuffing.
  //
  // The account already signed in outranks all of them WHEN it also owns the
  // resource: switching costs a logout plus login, and any owning account serves
  // the jar equally well.
  let working = orderAccountsFor(deps.db, finding.resourceId, accounts, deps.activeAccount?.() ?? null);
  let knownOwners = findOwners(deps.db, finding.resourceId);
  const nonOwners = findNonOwners(deps.db, finding.resourceId);

  // Tự động tìm kiếm chủ sở hữu từ tệp credentials nếu chưa ghi nhận trong CSDL
  if (knownOwners.length === 0 && deps.accountsFile && existsSync(deps.accountsFile)) {
    try {
      const creds = loadSpigotCredentials(deps.accountsFile);
      if (creds.ok) {
        const pluginNameNorm = normalizeName(finding.pluginName);
        for (const cred of creds.credentials) {
          if (cred.enabled === false) continue;
          const match = (cred.purchasedResources ?? []).some((res) => {
            const resNorm = normalizeName(res);
            return (
              resNorm &&
              (resNorm === pluginNameNorm ||
                resNorm.includes(pluginNameNorm) ||
                pluginNameNorm.includes(resNorm))
            );
          });
          if (match) {
            recordOwnership(deps.db, finding.resourceId, cred.label, 'owned');
            knownOwners = [cred.label];
            break;
          }
        }
      }
    } catch {
      // Bỏ qua lỗi đọc file credentials
    }
  }

  // Strict Account Targeting:
  // Mỗi tài khoản chỉ sở hữu plugin nhất định. BẮT BUỘC chỉ tải bằng tài khoản đã xác nhận sở hữu!
  if (knownOwners.length > 0) {
    const ownerSet = new Set(knownOwners);
    working = working.filter((a) => ownerSet.has(a.label));
  } else {
    // Nếu chưa có tài khoản nào sở hữu:
    // Trong môi trường có file credentials, nếu plugin này không nằm trong danh sách mua của bất kỳ tài khoản nào,
    // TUYỆT ĐỐI KHÔNG thử tải bừa bằng tài khoản khác (tránh bị 403 / Spigot khóa nick)!
    let hasLoadedCredentials = false;
    if (deps.accountsFile && existsSync(deps.accountsFile)) {
      try {
        const creds = loadSpigotCredentials(deps.accountsFile);
        if (creds.ok && creds.credentials.length > 0) {
          hasLoadedCredentials = true;
        }
      } catch {
        // Bỏ qua
      }
    }

    if (hasLoadedCredentials) {
      resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
      return {
        outcome: {
          ...base,
          status: 'not_owned',
          detail: 'chưa xác định tài khoản sở hữu plugin này (vui lòng gán tài khoản trong Quản lý Spigot)',
        },
        abort: false,
      };
    }

    // Môi trường test không có accountsFile: loại bỏ tài khoản đã xác nhận không sở hữu
    working = working.filter((a) => !nonOwners.has(a.label));
  }

  if (working.length === 0) {
    resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
    return {
      outcome: { ...base, status: 'not_owned', detail: 'không tài khoản nào đã mua' },
      abort: false,
    };
  }
  let rotated = false;
  let sawIndeterminate = '';
  /** A retryable snag from some account, kept so the last word is not silence. */
  let lastSoftFailure = '';

  for (const account of working) {
    const outcome = deps.fetchJar
      ? await deps.fetchJar(account, finding.resourceId, finding.upstream.name)
      : await downloadSpigotResource({ ...deps.download, signal: deps.signal }, account, finding.resourceId);

    if (outcome.status === 'ok' && outcome.rotated) {
      working = working.map((a) => (a.label === account.label ? outcome.rotated! : a));
      rotated = true;
    }

    switch (outcome.status) {
      case 'ok': {
        recordOwnership(deps.db, finding.resourceId, account.label, 'owned');
        const ingested = await archive(deps, finding, outcome.tmpPath, account.label);
        if (rotated) persistRotation(deps, working, log);
        return { outcome: ingested, abort: false, rotatedAccounts: rotated ? working : undefined };
      }

      case 'not_owned': {
        // 403 is ambiguous: it means either "did not buy it" or "session gone".
        // Only the probe can tell, and getting this backwards would walk every
        // account against one shared cause.
        const verdict = await verdictFor(account);
        if (verdict.state === 'logged_out') {
          deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, 'cookie hết hiệu lực');
          return {
            outcome: { ...base, status: 'cookie_dead', detail: `tài khoản ${account.label}`, },
            abort: true,
            rotatedAccounts: rotated ? working : undefined,
          };
        }
        if (verdict.state === 'indeterminate') {
          // Unprobeable is not the same as challenged. In browser mode the refusal
          // came from Spigot's own "you do not have permission" page, read inside a
          // live session — that is authoritative ownership evidence, so record it
          // and move on. Treating it as a challenge aborted the sweep on the first
          // unowned plugin and left the remaining accounts untried.
          if (verdict.detail === BROWSER_SESSION) {
            recordOwnership(deps.db, finding.resourceId, account.label, 'not_owned');
            continue;
          }
          sawIndeterminate = verdict.detail;
          continue;
        }
        // Authenticated and still refused, so the pairing is settled: remember it
        // and skip this account for this resource from now on. Only recorded on
        // the authenticated branch — a challenge or dead session says nothing
        // about ownership and must not poison the cache.
        recordOwnership(deps.db, finding.resourceId, account.label, 'not_owned');
        continue;
      }

      case 'cookie_dead':
        deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, 'cookie bị thu hồi');
        return {
          outcome: { ...base, status: 'cookie_dead', detail: `tài khoản ${account.label}` },
          abort: true,
          rotatedAccounts: rotated ? working : undefined,
        };

      case 'challenged':
        // The held browser can be released at any moment. Keep this exact
        // version due so the resolve handler can resume it immediately instead
        // of waiting through the normal transient-error backoff.
        keepDownloadDue(deps.db, finding.pluginId, finding.upstream.uuid, outcome.detail);
        return {
          outcome: { ...base, status: 'challenged', detail: outcome.detail },
          abort: true,
          rotatedAccounts: rotated ? working : undefined,
        };

      case 'gone':
        // Terminal: retrying a deleted resource forever accomplishes nothing.
        resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
        if (
          outcome.detail?.includes('xoá') ||
          outcome.detail?.includes('không còn tồn tại') ||
          outcome.detail?.includes('deleted')
        ) {
          deps.db.prepare('DELETE FROM pending_download WHERE plugin_id = ?').run(finding.pluginId);
          updatePlugin(deps.db, finding.pluginId, { resourceId: null });
          log.warn(
            `⚠️ [${finding.pluginName}] Plugin đã bị xoá trên SpigotMC. Đã gỡ liên kết resource ID ${finding.resourceId} để ngừng quét lặp lại.`,
          );
        }
        return {
          outcome: { ...base, status: 'failed', detail: outcome.detail ?? 'không còn tồn tại trên Spigot' },
          abort: false,
          rotatedAccounts: rotated ? working : undefined,
        };

      case 'incomplete':
        // Try the NEXT account before giving up. A premium resource's version
        // table is only visible to an account that owns it, so an account without
        // the purchase sees a page with no version rows — which looks exactly like
        // "this version is missing". Returning here meant a plugin bought on the
        // second account was never attempted with it.
        lastSoftFailure = outcome.detail;
        continue;

      case 'error':
        if (isChromeClosedError(outcome.detail)) {
          deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, 'Trình duyệt Chrome bị tắt đột ngột');
          return {
            outcome: { ...base, status: 'failed', detail: 'Trình duyệt Chrome bị tắt đột ngột' },
            abort: true,
            rotatedAccounts: rotated ? working : undefined,
          };
        }
        deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, outcome.detail);
        return {
          outcome: { ...base, status: 'retrying', detail: outcome.detail },
          abort: false,
          rotatedAccounts: rotated ? working : undefined,
        };
    }
  }

  if (rotated) persistRotation(deps, working, log);

  // Every account probed indeterminate — classify nothing, retry later.
  if (sawIndeterminate !== '') {
    deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, sawIndeterminate);
    return {
      outcome: { ...base, status: 'challenged', detail: sawIndeterminate },
      abort: true,
      rotatedAccounts: rotated ? working : undefined,
    };
  }

  // Every account was tried and at least one hit a retryable snag — a version
  // table that did not load, a transient page error. Keep it queued: unlike
  // not_owned this is not a settled answer, and resolving it would discard the
  // version permanently.
  if (lastSoftFailure !== '') {
    deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, lastSoftFailure);
    return {
      outcome: { ...base, status: 'retrying', detail: lastSoftFailure },
      abort: false,
      rotatedAccounts: rotated ? working : undefined,
    };
  }

  // Genuinely unowned everywhere. Terminal, and reported once — leaving it queued
  // would DM the owner about the same plugin every sweep forever.
  resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
  return {
    outcome: { ...base, status: 'not_owned', detail: 'không tài khoản nào đã mua' },
    abort: false,
    rotatedAccounts: rotated ? working : undefined,
  };
}

/** Hands a downloaded jar to the existing ingest path and maps its verdict. */
async function archive(
  deps: AutoDownloadDeps,
  finding: UpdateFinding,
  tmpPath: string,
  accountLabel: string,
): Promise<AutoDownloadOutcome> {
  const base = { pluginName: finding.pluginName, versionName: finding.upstream.name, accountLabel };
  const name = `${finding.pluginName}-${finding.upstream.name}.jar`;

  try {
    // pluginId is passed explicitly: the descriptor name inside the jar is the
    // code name ("Vulcan") while the tracked entry carries the marketplace title
    // ("Vulcan Anti-Cheat"). Letting ingest match by name files the download
    // under a second, untracked plugin — so the tracked one stays empty and the
    // same version is re-downloaded every sweep.
    const [result] = await ingestJarBatch(deps.ingest, [fileSource(tmpPath, name, finding.pluginId)]);
    if (!result) {
      deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, 'ingest không trả kết quả');
      return { ...base, status: 'retrying', detail: 'ingest không trả kết quả' };
    }

    switch (result.status) {
      case 'added':
      case 'duplicate':
        resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
        if (finding.resourceId) {
          const currentPlugin = findPluginById(deps.db, finding.pluginId);
          if (currentPlugin && (!currentPlugin.externalLink || currentPlugin.externalLink.trim() === '')) {
            updatePlugin(deps.db, finding.pluginId, {
              externalLink: `https://www.spigotmc.org/resources/${finding.resourceId}/`,
            });
          }
        }
        if (result.status === 'added') {
          return { ...base, status: 'archived', detail: result.version ?? finding.upstream.name };
        }
        return { ...base, status: 'duplicate', detail: result.existingVersion ?? '' };

      case 'pending':
        // Descriptor unreadable. Terminal here — it now needs the owner in the
        // pending queue, and retrying the download would only queue it twice.
        resolveDownload(deps.db, finding.pluginId, finding.upstream.uuid);
        return { ...base, status: 'parked', detail: result.detail };

      case 'failed':
        deferDownload(deps.db, finding.pluginId, finding.upstream.uuid, result.detail);
        return { ...base, status: 'retrying', detail: result.detail };
    }
  } finally {
    // ingestJarBatch streams into its own temp before committing, so this copy is
    // ours to remove on every path.
    await unlink(tmpPath).catch(() => {
      // Already gone.
    });
  }
}

/** Writes rotated cookies back, tolerating a failure without losing the jar. */
function persistRotation(
  deps: AutoDownloadDeps,
  accounts: SpigotAccount[],
  log: { warn: (message: string) => void },
): void {
  // Never write placeholder accounts over the real file. In browser mode the
  // accounts carry empty cookies while accountsFile still points at the genuine
  // one, so a single rotation here would blank every stored xf_user — and since
  // an entry without xf_user is rejected on load, that reads afterwards as a
  // corrupt file rather than as data loss.
  if (accounts.some((account) => account.xfUser.length === 0)) return;

  try {
    saveSpigotAccounts(deps.accountsFile, accounts);
  } catch (err) {
    // Not fatal: the in-memory cookies still work for this sweep. Losing the
    // download over a failed bookkeeping write would be the worse trade.
    log.warn(`Không lưu được cookie mới: ${err instanceof Error ? err.message : String(err)}`);
  }
}
