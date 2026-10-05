/**
 * Module phát hiện và xử lý sự kiện trình duyệt Chrome bị tắt đột ngột
 * (người dùng đóng cửa sổ, tiến trình bị kill, crash, hoặc đứt kết nối CDP).
 */

export function isChromeClosedError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).toLowerCase();

  return (
    msg.includes('target closed') ||
    msg.includes('targetcloseerror') ||
    msg.includes('browser has been disconnected') ||
    msg.includes('browser disconnected') ||
    msg.includes('connection closed') ||
    msg.includes('session closed') ||
    msg.includes('navigation failed because browser has disconnected') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('protocol error: connection closed') ||
    msg.includes('protocol error (target.') ||
    msg.includes('protocol error (page.') ||
    msg.includes('chrome_abruptly_closed') ||
    msg.includes('chrome process exited') ||
    msg.includes('page crashed') ||
    msg.includes('target crashed') ||
    msg.includes('chrome bị tắt') ||
    msg.includes('trình duyệt chrome đã bị đóng')
  );
}

export type AbruptCloseListener = (reason: string) => void;

export type Unsubscribe = () => void;

export type AbruptCloseTracker = {
  markGraceful: () => void;
  isGraceful: () => boolean;
  isAbruptlyClosed: () => boolean;
  getAbruptReason: () => string;
  onAbruptClose: (listener: AbruptCloseListener) => Unsubscribe;
  markAbruptlyClosed: (reason?: string) => void;
  attachBrowser: (browser: unknown, page?: unknown) => void;
  clearListeners?: () => void;
  dispose: () => void;
};

export function createAbruptCloseTracker(): AbruptCloseTracker {
  let closedGracefully = false;
  let abruptlyClosed = false;
  let abruptReason = '';
  const listeners = new Set<AbruptCloseListener>();

  const triggerAbruptClose = (reason: string) => {
    if (closedGracefully || abruptlyClosed) return;
    abruptlyClosed = true;
    abruptReason = reason;
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch {
        // Bỏ qua lỗi trong listener
      }
    }
  };

  return {
    markGraceful: () => {
      closedGracefully = true;
    },
    isGraceful: () => closedGracefully,
    isAbruptlyClosed: () => abruptlyClosed,
    getAbruptReason: () => abruptReason,
    onAbruptClose: (listener: AbruptCloseListener): Unsubscribe => {
      if (closedGracefully) {
        return () => {};
      }
      listeners.add(listener);
      if (abruptlyClosed) {
        try {
          listener(abruptReason);
        } catch {
          // Bỏ qua
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
    markAbruptlyClosed: (reason?: string) => {
      triggerAbruptClose(reason ?? 'Phát hiện trình duyệt Chrome bị đóng đột ngột');
    },
    clearListeners: () => {
      listeners.clear();
    },
    dispose: () => {
      closedGracefully = true;
      abruptlyClosed = false;
      abruptReason = '';
      listeners.clear();
    },
    attachBrowser: (browser: unknown, page?: unknown) => {
      if (!browser || typeof browser !== 'object') return;

      const b = browser as {
        on?: (event: string, handler: (...args: unknown[]) => void) => void;
        process?: () => { on?: (event: string, handler: (...args: unknown[]) => void) => void } | null;
      };

      if (typeof b.on === 'function') {
        b.on('disconnected', () => {
          triggerAbruptClose('Trình duyệt Chrome đã mất kết nối hoặc bị đóng');
        });
      }

      try {
        const proc = b.process?.();
        if (proc && typeof proc.on === 'function') {
          proc.on('exit', (code: unknown, signal: unknown) => {
            triggerAbruptClose(`Tiến trình Chrome đã tắt (mã: ${code ?? signal ?? 'unknown'})`);
          });
        }
      } catch {
        // Bỏ qua nếu môi trường không hỗ trợ process()
      }

      if (page && typeof page === 'object') {
        const p = page as {
          on?: (event: string, handler: (...args: unknown[]) => void) => void;
        };
        if (typeof p.on === 'function') {
          p.on('close', () => {
            triggerAbruptClose('Cửa sổ trang Chrome đã bị đóng');
          });
        }
      }
    },
  };
}
