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

  // Lưu trữ tham chiếu chính xác các event handlers để unbind sạch sẽ
  let browserHandler: (() => void) | null = null;
  let processHandler: ((code: unknown, signal: unknown) => void) | null = null;
  let pageHandler: (() => void) | null = null;

  type EventEmitters = {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  };

  let attachedBrowser: EventEmitters | null = null;
  let attachedProcess: EventEmitters | null = null;
  let attachedPage: EventEmitters | null = null;

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

  const removeHandler = (target: EventEmitters | null, event: string, handler: ((...args: unknown[]) => void) | null) => {
    if (!target || !handler) return;
    try {
      if (typeof target.off === 'function') {
        target.off(event, handler);
      } else if (typeof target.removeListener === 'function') {
        target.removeListener(event, handler);
      }
    } catch {
      // Bỏ qua lỗi nếu target đã bị đóng
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

      // Gỡ bỏ chính xác các handler đã đăng ký để chống memory leak & MaxListenersExceeded
      if (attachedBrowser && browserHandler) {
        removeHandler(attachedBrowser, 'disconnected', browserHandler);
        browserHandler = null;
        attachedBrowser = null;
      }

      if (attachedProcess && processHandler) {
        removeHandler(attachedProcess, 'exit', processHandler as (...args: unknown[]) => void);
        processHandler = null;
        attachedProcess = null;
      }

      if (attachedPage && pageHandler) {
        removeHandler(attachedPage, 'close', pageHandler);
        pageHandler = null;
        attachedPage = null;
      }
    },
    attachBrowser: (browser: unknown, page?: unknown) => {
      if (!browser || typeof browser !== 'object') return;

      const b = browser as EventEmitters & {
        process?: () => EventEmitters | null;
      };

      // Nếu trước đó đã attach, gỡ bỏ handler cũ trước khi gán mới
      if (attachedBrowser && browserHandler) {
        removeHandler(attachedBrowser, 'disconnected', browserHandler);
      }
      if (attachedProcess && processHandler) {
        removeHandler(attachedProcess, 'exit', processHandler as (...args: unknown[]) => void);
      }
      if (attachedPage && pageHandler) {
        removeHandler(attachedPage, 'close', pageHandler);
      }

      attachedBrowser = b;
      browserHandler = () => {
        triggerAbruptClose('Trình duyệt Chrome đã mất kết nối hoặc bị đóng');
      };
      if (typeof b.on === 'function') {
        b.on('disconnected', browserHandler);
      }

      try {
        const proc = b.process?.();
        if (proc && typeof proc.on === 'function') {
          attachedProcess = proc;
          processHandler = (code: unknown, signal: unknown) => {
            triggerAbruptClose(`Tiến trình Chrome đã tắt (mã: ${code ?? signal ?? 'unknown'})`);
          };
          proc.on('exit', processHandler as (...args: unknown[]) => void);
        }
      } catch {
        // Bỏ qua nếu môi trường không hỗ trợ process()
      }

      if (page && typeof page === 'object') {
        const p = page as EventEmitters;
        if (typeof p.on === 'function') {
          attachedPage = p;
          pageHandler = () => {
            triggerAbruptClose('Cửa sổ trang Chrome đã bị đóng');
          };
          p.on('close', pageHandler);
        }
      }
    },
  };
}
