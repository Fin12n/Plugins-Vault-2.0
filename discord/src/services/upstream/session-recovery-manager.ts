import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  copyFileSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  accountMutexManager,
  type AccountLockHandle,
} from './account-mutex-manager.js';
import type { SpigotCookieItem, SpigotSessionMetadata } from './spigot-cookie-files.js';

/*
 * ============================================================================
 * PHASE 4C-3: SESSION RECOVERY & ATOMIC COOKIE STORAGE
 *
 * 1. SESSION STATE MACHINE:
 *    VALID        -> Session authenticated và usable
 *    UNKNOWN      -> Chưa đủ evidence để kết luận session chết
 *    NEEDS_LOGIN  -> Có bằng chứng authentication/session đã mất
 *    CORRUPTED    -> Cookie/session storage không parse/validate được
 *    QUARANTINED  -> Session artifact đã bị cô lập an toàn
 *    RECOVERING   -> Đang tạo/rebuild session
 *    READY        -> Recovery thành công và session usable
 *
 * 2. NGUYÊN TẮC:
 *    - Tuyệt đối không biến mọi network error thành NEEDS_LOGIN
 *    - HTTP 403 không mặc định là NEEDS_LOGIN (chỉ khi có auth evidence)
 *    - Ghi cookie nguyên tử (Atomic write via temp + fsync + atomic replace)
 *    - Cô lập file hỏng (Quarantine) không ghi đè và không rò rỉ secret
 *    - Đồng bộ hóa recovery cùng tài khoản (1 recovery owner duy nhất)
 * ============================================================================
 */

export type SessionState =
  | 'VALID'
  | 'UNKNOWN'
  | 'NEEDS_LOGIN'
  | 'CORRUPTED'
  | 'QUARANTINED'
  | 'RECOVERING'
  | 'READY';

export interface SessionFailureContext {
  url?: string;
  targetUrl?: string;
  statusCode?: number;
  errorMessage?: string;
  error?: unknown;
  headers?: Record<string, string | string[] | undefined> | Headers;
  bodySnippet?: string;
  hasAuthMarker?: boolean;
  redirectLocation?: string;
  isCorrupted?: boolean;
}

export type FailureClassification =
  | { type: 'NEEDS_LOGIN'; reason: string }
  | { type: 'CORRUPTED'; reason: string }
  | { type: 'TRANSIENT'; reason: string }
  | { type: 'UNKNOWN'; reason: string };

/**
 * Kiểm tra các dấu hiệu định danh đã đăng nhập thành công của XenForo/Spigot.
 */
export function hasAuthenticatedMarker(body: string): boolean {
  if (!body) return false;
  return (
    /data-logged-in="true"/i.test(body) ||
    /\/logout\/\?/.test(body) ||
    /class="[^"]*p-navgroup--member/i.test(body) ||
    /class="[^"]*accountUsername/i.test(body)
  );
}

/**
 * Phân loại nguyên nhân lỗi phiên làm việc theo ma trận chuẩn tắc:
 * - Explicit login redirect hoặc auth check thất bại -> NEEDS_LOGIN
 * - Hỏng cấu trúc dữ liệu tệp lưu trữ -> CORRUPTED
 * - Lỗi mạng tạm thời, timeout, reset, CDP, crash -> TRANSIENT (giữ nguyên session)
 * - HTTP 403 đơn thuần -> TRANSIENT / UNKNOWN (không suy diễn ra NEEDS_LOGIN nếu không có bằng chứng)
 */
export function classifySessionFailure(ctx: SessionFailureContext): FailureClassification {
  const errStr = (
    ctx.errorMessage ??
    (ctx.error instanceof Error ? ctx.error.message : String(ctx.error ?? ''))
  ).toLowerCase();

  // 1. Kiểm tra lỗi hỏng tệp cookie / session storage
  if (
    ctx.isCorrupted ||
    errStr.includes('unexpected token') ||
    errStr.includes('unexpected end of json') ||
    errStr.includes('json.parse') ||
    errStr.includes('corrupted') ||
    errStr.includes('truncated') ||
    errStr.includes('empty cookie file') ||
    errStr.includes('invalid cookie structure')
  ) {
    return { type: 'CORRUPTED', reason: 'Tệp cookie lưu trữ bị hỏng hoặc sai cấu trúc JSON' };
  }

  // 2. Kiểm tra Explicit Login Redirect
  const location = (ctx.redirectLocation ?? '').toLowerCase();
  const currentUrl = (ctx.url ?? ctx.targetUrl ?? '').toLowerCase();
  const isLoginRedirect =
    /\/login\b/.test(location) ||
    location.includes('spigotmc.org/login') ||
    /\/login\b/.test(currentUrl) ||
    currentUrl.includes('spigotmc.org/login');

  if (isLoginRedirect) {
    return { type: 'NEEDS_LOGIN', reason: 'Chuyển hướng rõ ràng tới trang đăng nhập (/login)' };
  }

  // 3. Xử lý HTTP 403 Forbidden:
  // KHÔNG được mặc định 403 là NEEDS_LOGIN! Chỉ khi có additional auth evidence!
  if (ctx.statusCode === 403) {
    if (ctx.hasAuthMarker === false || isLoginRedirect) {
      return { type: 'NEEDS_LOGIN', reason: 'HTTP 403 kèm theo xác thực danh tính người dùng thất bại' };
    }
    return {
      type: 'TRANSIENT',
      reason: 'HTTP 403 không có bằng chứng mất session (có thể do Cloudflare / WAF / Challenge)',
    };
  }

  // 4. Kiểm tra kết quả xác thực người dùng đã đăng nhập (Explicit Auth Verification)
  if (ctx.hasAuthMarker === false) {
    return { type: 'NEEDS_LOGIN', reason: 'Kiểm tra phần tử người dùng đăng nhập thất bại (không có marker đăng nhập)' };
  }

  if (ctx.statusCode === 401) {
    return { type: 'NEEDS_LOGIN', reason: 'Mã phản hồi HTTP 401 Unauthorized' };
  }

  // 5. Kiểm tra lỗi mạng tạm thời / Transport / Browser crash
  const isTransient =
    errStr.includes('timeout') ||
    errStr.includes('timed out') ||
    errStr.includes('navigation timeout') ||
    errStr.includes('etimedout') ||
    errStr.includes('net::err_timed_out') ||
    errStr.includes('econnreset') ||
    errStr.includes('net::err_connection_reset') ||
    errStr.includes('socket hang up') ||
    errStr.includes('socket reset') ||
    errStr.includes('protocol error') ||
    errStr.includes('target closed') ||
    errStr.includes('session closed') ||
    errStr.includes('browser disconnected') ||
    errStr.includes('browser has been disconnected') ||
    errStr.includes('page crashed') ||
    errStr.includes('target crashed') ||
    errStr.includes('chrome process exited') ||
    errStr.includes('net::err_name_not_resolved') ||
    errStr.includes('enotfound') ||
    errStr.includes('fetch failed') ||
    ctx.statusCode === 429 ||
    ctx.statusCode === 502 ||
    ctx.statusCode === 503 ||
    ctx.statusCode === 504;

  if (isTransient) {
    return { type: 'TRANSIENT', reason: `Sự cố tạm thời (mạng, timeout, hoặc browser crash): ${errStr || `HTTP ${ctx.statusCode}`}` };
  }

  return { type: 'UNKNOWN', reason: `Chưa đủ bằng chứng để xác định trạng thái phiên: ${errStr || `HTTP ${ctx.statusCode ?? 'unknown'}`}` };
}

/**
 * Ghi tệp JSON nguyên tử (Atomic Write via Temp File + Fsync + Atomic Rename).
 * Đảm bảo trên Windows & POSIX không bao giờ có trạng thái zero-byte, truncated, hay partially-written.
 */
export function atomicWriteJsonFile(targetPath: string, data: unknown): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const jsonContent = JSON.stringify(data, null, 2);
  const tempPath = join(
    dir,
    `.tmp.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`
  );

  // 1. Ghi tệp tạm cùng thư mục / filesystem
  const fd = openSync(tempPath, 'w', 0o600);
  try {
    writeSync(fd, jsonContent, 0, 'utf-8');
    try {
      fsyncSync(fd);
    } catch {
      // Bỏ qua nếu filesystem không hỗ trợ fsync
    }
  } finally {
    closeSync(fd);
  }

  // 2. Thay thế nguyên tử (Atomic Replacement)
  let replaced = false;
  let lastErr: unknown = null;

  // Retry tối đa 5 lần với busy-wait ngắn trên Windows (đề phòng AntiVirus/Indexer khóa tạm)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tempPath, targetPath);
      replaced = true;
      break;
    } catch (err: any) {
      lastErr = err;
      if (err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') {
        const waitUntil = Date.now() + 10;
        while (Date.now() < waitUntil) {
          // busy wait ngắn
        }
        continue;
      }
      break;
    }
  }

  if (!replaced) {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    throw new Error(
      `[AtomicStorage] Không thể thay thế nguyên tử tệp "${targetPath}": ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }
}

/**
 * Xác thực cú pháp và cấu trúc dữ liệu danh sách cookie.
 */
export function validateAndParseCookies(raw: string): {
  valid: boolean;
  cookies?: SpigotCookieItem[];
  error?: string;
} {
  if (!raw || raw.trim().length === 0) {
    return { valid: false, error: 'Tệp cookie rỗng (zero-byte / empty)' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { valid: false, error: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, error: 'Dữ liệu cookie không phải là một danh sách (Array)' };
  }

  for (const item of parsed) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as any).name !== 'string' ||
      typeof (item as any).value !== 'string'
    ) {
      return { valid: false, error: 'Cấu trúc phần tử cookie không hợp lệ (thiếu name/value)' };
    }
  }

  return { valid: true, cookies: parsed as SpigotCookieItem[] };
}

/**
 * Di chuyển tệp bị hỏng sang artifact cách ly (Quarantine).
 * Đảm bảo:
 * - Tên tệp duy nhất, chống ghi đè khi bị trùng tên (Anti-collision).
 * - Tệp hỏng gốc bị gỡ bỏ để không tiếp tục được nạp.
 * - Tuyệt đối không đưa nội dung cookie hay secret vào tên tệp hoặc log.
 */
export function quarantineCorruptedFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = Date.now();

  let quarantinePath = '';
  for (let attempt = 0; attempt < 1000; attempt++) {
    const randomSuffix = randomBytes(4).toString('hex');
    const candidate = join(dir, `${base}.corrupt.${timestamp}.${randomSuffix}`);
    if (!existsSync(candidate)) {
      quarantinePath = candidate;
      break;
    }
  }

  if (!quarantinePath) {
    quarantinePath = join(dir, `${base}.corrupt.${timestamp}.${randomUUID()}`);
  }

  try {
    renameSync(filePath, quarantinePath);
    console.warn(`[CookieStorage] ⚠️ Đã cô lập tệp bị lỗi vào "${basename(quarantinePath)}". Tệp gốc đã được gỡ bỏ an toàn.`);
    return quarantinePath;
  } catch (err) {
    try {
      copyFileSync(filePath, quarantinePath);
      unlinkSync(filePath);
      return quarantinePath;
    } catch {
      return null;
    }
  }
}

export interface RecoverSessionOptions {
  customBaseDir?: string;
  signal?: AbortSignal;
  jobId?: string;
  timeoutMs?: number;
  force?: boolean;
}

/**
 * Singleton SessionRecoveryManager quản trị máy trạng thái phiên và điều phối phục hồi session đồng thời.
 */
export class SessionRecoveryManager {
  private states = new Map<string, SessionState>();

  /**
   * Lấy trạng thái phiên hiện tại của một tài khoản.
   */
  public getState(accountLabel: string): SessionState {
    return this.states.get(accountLabel) ?? 'UNKNOWN';
  }

  /**
   * Cập nhật trạng thái phiên của tài khoản.
   */
  public setState(accountLabel: string, state: SessionState): void {
    this.states.set(accountLabel, state);
  }

  /**
   * Đặt lại trạng thái (dùng trong kiểm thử).
   */
  public reset(): void {
    this.states.clear();
  }

  /**
   * Điều phối quy trình phục hồi phiên làm việc (Session Recovery):
   * 1. Bảo vệ bằng Account Mutex (Phase 4C-2): Đảm bảo DUY NHẤT 1 Job làm recovery owner.
   * 2. Nếu Job B chờ Job A và Job A đã phục hồi thành công -> Job B dùng lại session READY mà không tạo trùng lặp.
   * 3. Nếu phục hồi thất bại giữa chừng -> Không hủy hoại tệp cookie hợp lệ cũ.
   */
  public async recoverSession(
    accountLabel: string,
    recoveryWorker: () => Promise<SpigotCookieItem[]>,
    options: RecoverSessionOptions = {},
  ): Promise<{
    ok: boolean;
    state: SessionState;
    cookies?: SpigotCookieItem[];
    quarantinedPath?: string | null;
  }> {
    // 1. Chiếm giữ Account Mutex (chống race condition giữa các job cùng tài khoản)
    let accountLock: AccountLockHandle | null = null;
    try {
      accountLock = await accountMutexManager.acquire(accountLabel, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        jobId: options.jobId,
      });

      // 2. Kiểm tra nếu một job trước đó vừa phục hồi xong (READY) trong cùng hàng đợi
      const currentState = this.getState(accountLabel);
      if (!options.force && currentState === 'READY') {
        const { loadAccountCookiesFromFile } = await import('./spigot-cookie-files.js');
        const loaded = loadAccountCookiesFromFile(accountLabel, options.customBaseDir);
        if (loaded && loaded.cookies.length > 0) {
          return { ok: true, state: 'READY', cookies: loaded.cookies };
        }
      }

      // 3. Bắt đầu chuyển trạng thái sang RECOVERING
      this.setState(accountLabel, 'RECOVERING');

      // 4. Chạy tác vụ phục hồi
      let newCookies: SpigotCookieItem[];
      try {
        newCookies = await recoveryWorker();
      } catch (workerErr) {
        // Phục hồi thất bại giữa chừng -> Không được destroy tệp cookie cũ còn nguyên vẹn!
        console.warn(`[SessionRecovery] Phục hồi session thất bại giữa chừng cho "${accountLabel}":`, workerErr instanceof Error ? workerErr.message : String(workerErr));
        this.setState(accountLabel, 'NEEDS_LOGIN');
        throw workerErr;
      }

      // 5. Xác thực và lưu trữ nguyên tử
      const { saveAccountCookiesToFile } = await import('./spigot-cookie-files.js');
      saveAccountCookiesToFile(
        accountLabel,
        newCookies,
        { status: 'active' },
        options.customBaseDir,
      );

      this.setState(accountLabel, 'READY');
      return { ok: true, state: 'READY', cookies: newCookies };
    } finally {
      if (accountLock) {
        await accountLock.release().catch(() => undefined);
      }
    }
  }
}

export const sessionRecoveryManager = new SessionRecoveryManager();
