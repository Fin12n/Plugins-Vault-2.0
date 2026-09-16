/** Spiget API client. Read-only metadata; no auth needed and none exists. */

export type SpigetVersion = {
  /** Stable identity. Version names are neither unique nor semver-ordered. */
  uuid: string;
  /** Human version string, author-entered free text. */
  name: string;
  /** Milliseconds — Spiget returns seconds, converted here at the boundary. */
  releaseDateMs: number;
  downloads: number;
};

/** One version row as Spiget sends it. `uuid` is documented but often absent. */
type RawVersion = {
  uuid?: string;
  id?: number;
  name: string;
  releaseDate: number;
  downloads: number;
};

export type SpigetClientOptions = {
  userAgent?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
};

const BASE = 'https://api.spiget.org/v2';

/**
 * Serialized, throttled Spiget client.
 *
 * Rate limits are undocumented and no rate-limit headers are returned, and the
 * service runs on donated infrastructure, so requests are queued one at a time
 * with a minimum gap and backed off exponentially with jitter on 429/5xx —
 * assuming no Retry-After header, because there is none.
 *
 * The download-proxy endpoint is never touched: its own spec marks it strictly
 * rate-limited.
 */
export class SpigetClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SpigetClientOptions = {}) {
    this.userAgent = options.userAgent ?? 'plugin-vault-bot (private archive)';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Latest version of a resource.
   *
   * Read from /versions/latest, NEVER from the resource object's version pointer:
   * for premium resources that pointer is stale by years (one popular resource
   * points at a 2022 build while the true latest is from 2026), because premium
   * rows carry synthetic non-chronological ids and the pointer appears to be
   * chosen by id. Free resources happen to be consistent, which is exactly why
   * the bug hides during testing.
   */
  async getLatestVersion(resourceId: number): Promise<SpigetVersion | null> {
    const raw = await this.request<RawVersion>(`/resources/${resourceId}/versions/latest`);
    if (!raw) return null;
    return toVersion(raw);
  }

  /**
   * Version history, newest first.
   *
   * sort=-releaseDate is mandatory: the default order is ascending internal id,
   * and for premium resources those ids are not chronological, so the last page —
   * the intuitive "newest" — can return a years-old build.
   */
  async listVersions(resourceId: number, size = 100): Promise<SpigetVersion[]> {
    const raw = await this.request<RawVersion[]>(
      `/resources/${resourceId}/versions?size=${size}&sort=-releaseDate`,
    );
    return (raw ?? [])
      .map(toVersion)
      .filter((version): version is SpigetVersion => version !== null);
  }

  /** Queues a request behind the others, honouring the minimum gap. */
  private request<T>(path: string): Promise<T | null> {
    const run = this.queue.then(() => this.execute<T>(path));
    // Keep the chain alive even when one request rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(path: string): Promise<T | null> {
    const gap = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (gap > 0) await delay(gap);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.lastRequestAt = Date.now();
      // Cache-buster: responses are edge-cached for an hour, and a cached response
      // has been observed far staler than its max-age suggests.
      const separator = path.includes('?') ? '&' : '?';
      const url = `${BASE}${path}${separator}_ts=${this.lastRequestAt}`;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { 'user-agent': this.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        });
      } catch (err) {
        if (attempt === this.maxRetries) throw err;
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.status === 404) return null;

      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.maxRetries) return null;
        await delay(backoffMs(attempt));
        continue;
      }

      if (!response.ok) return null;
      return (await response.json()) as T;
    }
    return null;
  }
}

/**
 * Normalises one version row, or null when it carries no stable identity.
 *
 * `uuid` is absent from whole resources, not just stray rows: resource 32430
 * returns every version with only `downloads, rating, name, releaseDate,
 * resource, id`. The identity lands in `pending_download.version_uuid` and
 * `upstream_state.version_uuid`, both NOT NULL, so reading the field without a
 * fallback throws out of the enqueue loop and aborts the entire update sweep —
 * one such resource stops every download for every plugin.
 *
 * `id` is the stable per-version key in those responses. Safe to substitute
 * because this value is only ever compared, never used to build a URL: download
 * links are resolved by version name.
 */
function toVersion(raw: RawVersion): SpigetVersion | null {
  const uuid =
    typeof raw.uuid === 'string' && raw.uuid !== ''
      ? raw.uuid
      : typeof raw.id === 'number'
        ? String(raw.id)
        : '';
  if (uuid === '') return null;

  return {
    uuid,
    name: raw.name,
    // releaseDate is UNIX SECONDS; passing it straight to a Date yields 1970.
    releaseDateMs: raw.releaseDate * 1000,
    downloads: raw.downloads,
  };
}

/** Exponential backoff with jitter, since no Retry-After header is provided. */
export function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  return base + Math.floor(Math.random() * 500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
