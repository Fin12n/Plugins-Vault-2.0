/**
 * Centralized Write Freeze / Maintenance Guard for Phase 1 Cutover.
 *
 * Blocks the 7 business writers when active:
 * 1) Opening new order / Buy
 * 2) Opening wallet topup
 * 3) Card topup submission
 * 4) SePay webhook transaction processing
 * 5) Discount redemption
 * 6) Manual release from dashboard
 * 7) Auto-sync (already deprecated)
 */

let inMemoryFreeze = false;

export function setWriteFreeze(frozen: boolean): void {
  inMemoryFreeze = frozen;
}

export function isWriteFrozen(): boolean {
  if (process.env.GLOBAL_MAINTENANCE_MODE === "true" || process.env.GLOBAL_MAINTENANCE_MODE === "1") {
    return true;
  }
  return inMemoryFreeze;
}

export class WriteFreezeError extends Error {
  constructor(actionName = "Thao tác") {
    super(`${actionName} tạm thời bị khóa do hệ thống đang trong chế độ bảo trì dữ liệu.`);
    this.name = "WriteFreezeError";
  }
}

export function assertNotFrozen(actionName?: string): void {
  if (isWriteFrozen()) {
    throw new WriteFreezeError(actionName);
  }
}
