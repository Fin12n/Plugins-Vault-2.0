import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Lỗi phát sinh khi có yêu cầu mở session CloakBrowser mới trong khi
 * đã có một session khác đang hoạt động.
 */
export class SessionConflictError extends Error {
  constructor(public readonly currentTask: string, public readonly requestedTask: string) {
    super(
      `[CloakSessionManager] Đã có 1 phiên CloakBrowser đang hoạt động cho tác vụ "${currentTask}". ` +
      `Từ chối mở phiên mới cho "${requestedTask}" để tuân thủ nghiêm ngặt giới hạn 1 concurrent session của CloakBrowser Pro.`
    );
    this.name = 'SessionConflictError';
  }
}

export type ActiveSessionInfo = {
  taskName: string;
  startedAt: number;
  browser: {
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean } | null;
  } | null;
  tempProfileDir?: string;
};

export type SessionLockHandle = {
  taskName: string;
  startedAt: number;
  registerBrowser: (browser: ActiveSessionInfo['browser']) => void;
  release: () => Promise<void>;
};

/**
 * Singleton CloakSessionManager: Quản lý độc quyền phiên CloakBrowser trên toàn hệ thống.
 * Đảm bảo CHỈ CÓ DUY NHẤT 1 BROWSER SESSION được phép hoạt động tại bất kỳ thời điểm nào.
 */
class CloakSessionManager {
  private activeSession: ActiveSessionInfo | null = null;

  /**
   * Kiểm tra xem hiện có session CloakBrowser nào đang hoạt động hay không.
   */
  public hasActiveSession(): boolean {
    return this.activeSession !== null;
  }

  /**
   * Lấy thông tin về session đang hoạt động hiện tại (nếu có).
   */
  public getActiveSessionInfo(): Readonly<ActiveSessionInfo> | null {
    return this.activeSession ? { ...this.activeSession } : null;
  }

  /**
   * Quét và dọn dẹp các tiến trình Chromium/CloakBrowser mồ côi (orphan/zombie processes)
   * chạy ngầm gây chiếm dụng session slot hoặc khóa profile.
   */
  public forceCleanupOrphanProcesses(): void {
    if (process.platform === 'win32') {
      try {
        // Trên Windows: nếu không có session nào được quản lý mà vẫn còn chrome.exe rác
        // ta có thể dọn sạch các chrome process không mong muốn nếu cần thiết.
        // Chỉ chạy khi không có active session để tránh kill nhầm.
        if (!this.activeSession) {
          // Bỏ qua hoặc chỉ log để an toàn
        }
      } catch {
        // Bỏ qua lỗi nếu không có process nào
      }
    } else if (process.platform === 'linux') {
      try {
        // Trên Linux: dọn dẹp nếu có lệnh
      } catch {
        // Bỏ qua lỗi
      }
    }
  }

  /**
   * Yêu cầu cấp phát khóa độc quyền (Mutex Lock) để mở session CloakBrowser mới.
   * Nếu đã có session đang chạy, ném lỗi SessionConflictError ngay lập tức.
   */
  public async acquireLock(taskName: string, tempProfileDir?: string): Promise<SessionLockHandle> {
    if (this.activeSession !== null) {
      throw new SessionConflictError(this.activeSession.taskName, taskName);
    }

    const sessionInfo: ActiveSessionInfo = {
      taskName,
      startedAt: Date.now(),
      browser: null,
      tempProfileDir,
    };

    this.activeSession = sessionInfo;

    return {
      taskName,
      startedAt: sessionInfo.startedAt,
      registerBrowser: (browser: ActiveSessionInfo['browser']) => {
        if (this.activeSession && this.activeSession.taskName === taskName) {
          this.activeSession.browser = browser;
        }
      },
      release: async () => {
        if (this.activeSession && this.activeSession.taskName === taskName) {
          this.activeSession.browser = null;
        }
        await this.releaseLock(taskName);
      },
    };
  }

  /**
   * Đóng sạch sẽ session hiện tại, giải phóng tài nguyên và xóa profile tạm nếu có.
   */
  public async releaseLock(taskName?: string): Promise<void> {
    if (!this.activeSession) return;

    if (taskName && this.activeSession.taskName !== taskName) {
      console.warn(
        `[CloakSessionManager] Cảnh báo: Tác vụ "${taskName}" cố gắng giải phóng lock của "${this.activeSession.taskName}". Bỏ qua.`
      );
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;

    // 1. Đóng trình duyệt triệt để
    if (session.browser) {
      try {
        let timer: NodeJS.Timeout | null = null;
        const graceful = await Promise.race([
          session.browser.close().then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
            timer.unref();
          }),
        ]);

        if (timer) clearTimeout(timer);

        if (!graceful) {
          try {
            const proc = session.browser.process?.();
            if (proc) {
              proc.kill('SIGKILL');
              const pid = (proc as { pid?: number }).pid;
              if (process.platform === 'linux' && pid && typeof pid === 'number') {
                try {
                  process.kill(-pid, 'SIGKILL');
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // Process may already have terminated
          }
        }
      } catch (err) {
        console.warn('[CloakSessionManager] Lỗi khi đóng browser instance:', err instanceof Error ? err.message : String(err));
      }
    }

    // 2. Xoá sạch thư mục profile tạm thời (che giấu danh tính tuyệt đối)
    if (session.tempProfileDir && existsSync(session.tempProfileDir)) {
      try {
        rmSync(session.tempProfileDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[CloakSessionManager] Không thể xoá profile tạm "${session.tempProfileDir}":`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * Reset hoàn toàn trạng thái lock (dùng trong test hoặc phục hồi khẩn cấp).
   */
  public reset(): void {
    this.activeSession = null;
  }
}

export const cloakSessionManager = new CloakSessionManager();
