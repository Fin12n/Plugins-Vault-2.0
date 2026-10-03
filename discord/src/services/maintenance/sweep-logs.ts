import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type SweepLogLevel = 'info' | 'success' | 'warn' | 'error';

export type SweepLogEntry = {
  id: number;
  timestamp: number;
  level: SweepLogLevel;
  message: string;
  workerId?: number;
};

export class SweepLogManager {
  private logs: SweepLogEntry[] = [];
  private workerLogs = new Map<number, SweepLogEntry[]>();
  private nextId = 1;
  private maxLogs = 500;
  private maxLogsPerWorker = 300;
  private logDir = './data/logs/workers';

  private currentProxyIp: string | null = null;

  constructor() {
    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  setCurrentProxyIp(ip: string | null): void {
    this.currentProxyIp = ip;
  }

  getCurrentProxyIp(): string | null {
    return this.currentProxyIp;
  }

  add(message: string, level: SweepLogLevel = 'info', workerId?: number): SweepLogEntry {
    const entry: SweepLogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      message,
      ...(workerId !== undefined ? { workerId } : {}),
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }

    if (workerId !== undefined) {
      let list = this.workerLogs.get(workerId);
      if (!list) {
        list = [];
        this.workerLogs.set(workerId, list);
      }
      list.push(entry);
      if (list.length > this.maxLogsPerWorker) {
        list.splice(0, list.length - this.maxLogsPerWorker);
      }

      // Ghi ra file log riêng của worker để xem lại debug
      try {
        const timeStr = new Date(entry.timestamp).toISOString();
        const line = `[${timeStr}] [${level.toUpperCase()}] ${message}\n`;
        appendFileSync(join(this.logDir, `worker-${workerId}.log`), line, 'utf8');
      } catch {
        // ignore
      }
    }

    return entry;
  }

  /** Ghi log khi thực hiện tải */
  addForWorker(workerId: number, message: string, level: SweepLogLevel = 'info'): SweepLogEntry {
    return this.add(message, level, workerId);
  }

  getAll(sinceId?: number, workerId?: number): SweepLogEntry[] {
    const source = workerId !== undefined ? (this.workerLogs.get(workerId) ?? []) : this.logs;
    if (sinceId !== undefined && Number.isFinite(sinceId)) {
      return source.filter((l) => l.id > sinceId);
    }
    return [...source];
  }

  getWorkerLogs(workerId: number, sinceId?: number): SweepLogEntry[] {
    return this.getAll(sinceId, workerId);
  }

  getActiveWorkerIds(): number[] {
    return Array.from(this.workerLogs.keys()).sort((a, b) => a - b);
  }

  clear(workerId?: number): void {
    if (workerId !== undefined) {
      this.workerLogs.delete(workerId);
      this.logs = this.logs.filter((l) => l.workerId !== workerId);
    } else {
      this.logs = [];
      this.workerLogs.clear();
    }
  }
}

export const sweepLogs = new SweepLogManager();
