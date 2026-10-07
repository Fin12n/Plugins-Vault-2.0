import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  name: string;
  creationDate?: string;
  executablePath?: string;
  parentPid?: number;
}

export interface TreeSnapshot {
  parent: ProcessIdentity;
  descendants: ProcessIdentity[];
}

export interface TerminateTreeResult {
  success: boolean;
  reason?: 'verified_clean' | 'identity_mismatch' | 'descendants_survived' | 'kill_failed' | 'already_dead';
  ownedPid: number;
  expectedIdentity?: ProcessIdentity;
  currentIdentity?: ProcessIdentity | null;
  killedPids: number[];
  survivingPids: number[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kiểm tra xem một process ID có còn tồn tại trên hệ điều hành hay không.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code === 'EPERM'; // EPERM = process còn sống nhưng không có quyền gửi signal
  }
}

/**
 * Trích xuất định danh tiến trình (ProcessIdentity) trên Windows sử dụng WMIC hoặc PowerShell.
 */
async function captureWindowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  // Cách 1: Sử dụng wmic (rất nhanh, thường < 50ms)
  try {
    const { stdout } = await execFileAsync('wmic', [
      'process',
      'where',
      `ProcessId=${pid}`,
      'get',
      'ProcessId,Name,CreationDate,ExecutablePath,ParentProcessId',
      '/format:csv',
    ], { timeout: 4000 });

    const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Dòng 0: Header (Node,CreationDate,ExecutablePath,Name,ParentProcessId,ProcessId)
    // Dòng 1+: Data
    if (lines.length >= 2 && lines[1]) {
      const parts = lines[1].split(',');
      if (parts.length >= 6) {
        const creationDate = parts[1]?.trim() || undefined;
        const executablePath = parts[2]?.trim() || undefined;
        const name = parts[3]?.trim() || '';
        const parentPid = parts[4] ? Number.parseInt(parts[4].trim(), 10) : undefined;
        const foundPid = parts[5] ? Number.parseInt(parts[5].trim(), 10) : pid;

        if (name && !Number.isNaN(foundPid)) {
          return {
            pid: foundPid,
            name,
            creationDate,
            executablePath,
            parentPid: Number.isNaN(parentPid) ? undefined : parentPid,
          };
        }
      }
    }
  } catch {
    // Fallback sang PowerShell
  }

  // Cách 2: Fallback sang PowerShell Get-CimInstance
  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId, Name, ExecutablePath, ParentProcessId | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed.ProcessId === 'number' && parsed.Name) {
      return {
        pid: parsed.ProcessId,
        name: parsed.Name,
        executablePath: parsed.ExecutablePath || undefined,
        parentPid: typeof parsed.ParentProcessId === 'number' ? parsed.ParentProcessId : undefined,
      };
    }
  } catch {
    // Process không tồn tại hoặc lỗi query
  }

  return null;
}

/**
 * Trích xuất định danh tiến trình trên Linux / POSIX bằng cách đọc /proc.
 */
async function capturePosixProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const { readFileSync } = await import('node:fs');
    const statPath = `/proc/${pid}/stat`;
    const statContent = readFileSync(statPath, 'utf8');
    // Format: pid (comm) state ppid ... starttime
    const match = statContent.match(/^(\d+)\s+\((.+)\)\s+[A-Za-z]\s+(\d+)/);
    if (match && match[2] && match[3]) {
      const name = match[2];
      const parentPid = Number.parseInt(match[3], 10);
      const fields = statContent.split(' ');
      const startTime = fields[21] || undefined; // Field 22 in 1-based index
      return {
        pid,
        name,
        creationDate: startTime,
        parentPid: Number.isNaN(parentPid) ? undefined : parentPid,
      };
    }
  } catch {
    // Process không tồn tại
  }
  return null;
}

/**
 * Trích xuất metadata định danh của một tiến trình (PID, name, creationDate, parentPid).
 */
export async function captureProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!isProcessAlive(pid)) return null;
  if (process.platform === 'win32') {
    return captureWindowsProcessIdentity(pid);
  }
  return capturePosixProcessIdentity(pid);
}

/**
 * Tìm tất cả các Process ID con (descendants) trực tiếp hoặc gián tiếp của parentPid.
 */
export async function snapshotDescendants(parentPid: number): Promise<ProcessIdentity[]> {
  const descendants: ProcessIdentity[] = [];
  const queue: number[] = [parentPid];
  const visited = new Set<number>([parentPid]);

  if (process.platform === 'win32') {
    while (queue.length > 0) {
      const currentPid = queue.shift()!;
      try {
        const { stdout } = await execFileAsync('wmic', [
          'process',
          'where',
          `ParentProcessId=${currentPid}`,
          'get',
          'ProcessId,Name,CreationDate,ExecutablePath,ParentProcessId',
          '/format:csv',
        ], { timeout: 4000 });

        const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const parts = line.split(',');
          if (parts.length >= 6) {
            const creationDate = parts[1]?.trim() || undefined;
            const executablePath = parts[2]?.trim() || undefined;
            const name = parts[3]?.trim() || '';
            const pPid = parts[4] ? Number.parseInt(parts[4].trim(), 10) : undefined;
            const childPid = parts[5] ? Number.parseInt(parts[5].trim(), 10) : NaN;

            if (!Number.isNaN(childPid) && childPid > 0 && !visited.has(childPid)) {
              visited.add(childPid);
              queue.push(childPid);
              descendants.push({
                pid: childPid,
                name,
                creationDate,
                executablePath,
                parentPid: pPid,
              });
            }
          }
        }
      } catch {
        // Fallback sang PowerShell nếu WMIC thất bại
        try {
          const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${currentPid}" | Select-Object ProcessId, Name, ExecutablePath, ParentProcessId | ConvertTo-Json -Compress`;
          const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 5000,
          });
          const parsed = JSON.parse(stdout.trim());
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            if (item && typeof item.ProcessId === 'number' && !visited.has(item.ProcessId)) {
              visited.add(item.ProcessId);
              queue.push(item.ProcessId);
              descendants.push({
                pid: item.ProcessId,
                name: item.Name,
                executablePath: item.ExecutablePath || undefined,
                parentPid: item.ParentProcessId,
              });
            }
          }
        } catch { }
      }
    }
  } else {
    // POSIX: quét pgrep -P hoặc /proc
    while (queue.length > 0) {
      const currentPid = queue.shift()!;
      try {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(currentPid)], { timeout: 3000 });
        const childPids = stdout
          .trim()
          .split(/\s+/)
          .map((p) => Number.parseInt(p, 10))
          .filter((p) => !Number.isNaN(p) && p > 0 && !visited.has(p));

        for (const cPid of childPids) {
          visited.add(cPid);
          queue.push(cPid);
          const id = await capturePosixProcessIdentity(cPid);
          descendants.push(id ?? { pid: cPid, name: 'unknown' });
        }
      } catch { }
    }
  }

  return descendants;
}

/**
 * Xác minh tính đồng nhất của tiến trình (PID Reuse Protection).
 * Trả về true nếu tiến trình hiện tại vẫn khớp danh tính đã lưu.
 */
export function verifyProcessIdentity(
  expected: ProcessIdentity,
  current: ProcessIdentity | null,
): boolean {
  if (!current) return false;
  if (expected.pid !== current.pid) return false;

  // Kiểm tra tên executable (so sánh không phân biệt hoa thường)
  if (expected.name && current.name) {
    const expBase = basename(expected.name).toLowerCase();
    const curBase = basename(current.name).toLowerCase();
    if (expBase !== curBase) {
      return false;
    }
  }

  // Kiểm tra thời gian khởi tạo (CreationDate) nếu có
  if (expected.creationDate && current.creationDate) {
    if (expected.creationDate !== current.creationDate) {
      return false;
    }
  }

  // Kiểm tra đường dẫn executable nếu cả hai đều có
  if (expected.executablePath && current.executablePath) {
    if (expected.executablePath.toLowerCase() !== current.executablePath.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Tiêu diệt toàn bộ cây tiến trình (Process Tree) thuộc ownedPid một cách an toàn và có kiểm chứng.
 *
 * An toàn tuyệt đối:
 * 1. Chụp ảnh descendants trước khi kill.
 * 2. Xác minh PID identity trước khi kill (chống kill nhầm PID bị OS tái sử dụng).
 * 3. Chỉ gửi taskkill /PID <ownedPid> /T /F (không bao giờ dùng /IM chrome.exe).
 * 4. Xác minh toàn bộ parent và descendants trong snapshot đã chết hoàn toàn.
 */
export async function terminateProcessTree(
  ownedPid: number,
  expectedIdentity?: ProcessIdentity,
  options: { verifyTimeoutMs?: number } = {},
): Promise<TerminateTreeResult> {
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 1500;

  if (!isProcessAlive(ownedPid)) {
    return {
      success: true,
      reason: 'already_dead',
      ownedPid,
      expectedIdentity,
      killedPids: [],
      survivingPids: [],
    };
  }

  // 1. Chụp ảnh định danh hiện tại của ownedPid
  const currentIdentity = await captureProcessIdentity(ownedPid);

  // 2. Bảo vệ tái sử dụng PID (PID Reuse Protection)
  if (expectedIdentity) {
    const isMatched = verifyProcessIdentity(expectedIdentity, currentIdentity);
    if (!isMatched) {
      console.warn(
        `[ProcessTreeKiller] ⚠️ Từ chối kill PID ${ownedPid}: Phát hiện process identity mismatch ` +
        `(kỳ vọng: "${expectedIdentity.name}" [${expectedIdentity.creationDate ?? 'no-date'}], ` +
        `hiện tại: "${currentIdentity?.name ?? 'null'}" [${currentIdentity?.creationDate ?? 'no-date'}]). ` +
        `Tránh kill nhầm tiến trình khác!`
      );
      return {
        success: false,
        reason: 'identity_mismatch',
        ownedPid,
        expectedIdentity,
        currentIdentity,
        killedPids: [],
        survivingPids: [ownedPid],
      };
    }
  }

  // 3. Chụp ảnh toàn bộ descendants trước khi kill
  const descendants = await snapshotDescendants(ownedPid);
  const targetPids = [ownedPid, ...descendants.map((d) => d.pid)];

  // 4. Thực thi tiêu diệt cây tiến trình
  if (process.platform === 'win32') {
    try {
      // taskkill /PID <ownedPid> /T /F tiêu diệt đúng ownedPid và toàn bộ cây con của nó
      await execFileAsync('taskkill', ['/PID', String(ownedPid), '/T', '/F'], { timeout: 5000 });
    } catch (killErr: unknown) {
      // Nếu taskkill thất bại, fallback sang kill từng PID trực tiếp
      for (const p of targetPids) {
        try { process.kill(p, 'SIGKILL'); } catch { }
      }
    }
  } else {
    // POSIX: Thử kill Process Group trước (nếu process được spawn detached)
    try {
      process.kill(-ownedPid, 'SIGKILL');
    } catch {
      // Fallback: kill từng PID trong danh sách target
      for (const p of targetPids) {
        try { process.kill(p, 'SIGKILL'); } catch { }
      }
    }
  }

  // 5. Xác minh toàn diện (Full Descendant Verification)
  const deadline = Date.now() + verifyTimeoutMs;
  let survivingPids: number[] = [];

  while (Date.now() < deadline) {
    survivingPids = targetPids.filter((p) => isProcessAlive(p));
    if (survivingPids.length === 0) {
      break;
    }
    await sleep(100);
  }

  // Nếu còn process con sót lại, thực hiện vòng dọn dẹp thứ hai
  if (survivingPids.length > 0) {
    for (const sPid of survivingPids) {
      try {
        if (process.platform === 'win32') {
          await execFileAsync('taskkill', ['/PID', String(sPid), '/F'], { timeout: 3000 });
        } else {
          process.kill(sPid, 'SIGKILL');
        }
      } catch { }
    }

    await sleep(100);
    survivingPids = targetPids.filter((p) => isProcessAlive(p));
  }

  if (survivingPids.length === 0) {
    return {
      success: true,
      reason: 'verified_clean',
      ownedPid,
      expectedIdentity: expectedIdentity ?? currentIdentity ?? undefined,
      currentIdentity,
      killedPids: targetPids,
      survivingPids: [],
    };
  }

  return {
    success: false,
    reason: 'descendants_survived',
    ownedPid,
    expectedIdentity: expectedIdentity ?? currentIdentity ?? undefined,
    currentIdentity,
    killedPids: targetPids.filter((p) => !survivingPids.includes(p)),
    survivingPids,
  };
}
