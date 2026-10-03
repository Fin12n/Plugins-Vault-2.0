export type SpigotAccountCooldown = {
  reason: string;
  retryAt: number;
  remainingMs: number;
};

export type SpigotAccountCooldownStore = {
  read: (label: string) => SpigotAccountCooldown | null;
  write: (label: string, reason: string, durationMs: number) => void;
  clear: (label: string) => void;
};

/** Keeps an upstream-blocked account out of repeated browser launches. */
export class SpigotAccountCooldowns {
  private readonly blocked = new Map<string, { reason: string; retryAt: number }>();

  constructor(
    private readonly durationMs: number,
    private readonly now: () => number = Date.now,
    private readonly store?: SpigotAccountCooldownStore,
  ) {}

  block(label: string, reason: string): SpigotAccountCooldown {
    const retryAt = this.now() + this.durationMs;
    this.blocked.set(label, { reason, retryAt });
    this.store?.write(label, reason, this.durationMs);
    return { reason, retryAt, remainingMs: this.durationMs };
  }

  get(label: string): SpigotAccountCooldown | null {
    const entry = this.blocked.get(label);
    if (!entry) return this.store?.read(label) ?? null;

    const remainingMs = entry.retryAt - this.now();
    if (remainingMs <= 0) {
      this.blocked.delete(label);
      return this.store?.read(label) ?? null;
    }
    return { ...entry, remainingMs };
  }

  clear(label: string): void {
    this.blocked.delete(label);
    this.store?.clear(label);
  }
}
