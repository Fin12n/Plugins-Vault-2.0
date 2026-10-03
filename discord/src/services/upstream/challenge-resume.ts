export function createChallengeResumeHandler(
  maintenance: () => { triggerUpdateCheck: (forcePurchasedScan?: boolean) => boolean } | null,
  options: { retryDelayMs?: number; maxAttempts?: number } = {},
): () => void {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? 300;
  let pending: NodeJS.Timeout | null = null;

  const attempt = (remaining: number): void => {
    pending = null;
    if (maintenance()?.triggerUpdateCheck(false)) return;
    if (remaining <= 1) return;
    pending = setTimeout(() => attempt(remaining - 1), retryDelayMs);
    pending.unref();
  };

  return () => {
    if (pending) return;
    attempt(maxAttempts);
  };
}
