/**
 * Plain-fetch client for the spigotmc.org paths Cloudflare does NOT gate.
 *
 * Cloudflare gates this site by URL PATH, not by request shape. Measured with
 * curl carrying a full Chrome User-Agent:
 *
 *   200: /, /resources/<id>/, /resources/<id>/history, api.spiget.org
 *   403: /login, /account/, /resources/purchased, /resources/<id>/download
 *
 * So version discovery and resource metadata never needed a browser — only login
 * and download do. Keeping them on plain fetch removes most browser navigations
 * and most challenge waits from an ordinary tick.
 *
 * The 403s carry `Cf-Mitigated: challenge`, which is how a challenge is told
 * apart from the origin's own refusal. Conflating them is what previously made a
 * dead session look like "you do not own this".
 */

/**
 * A real browser UA. Not deception for its own sake: a default Node UA is an
 * instant block at the Cloudflare edge, which would surface as an unexplainable
 * 403 on paths that are otherwise open.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type PublicFetchResult =
  | { ok: true; html: string }
  /** Cloudflare answered, not the origin. Says nothing about the resource. */
  | { ok: false; reason: 'challenged'; detail: string }
  /** The origin refused: not purchased, deleted, or login required. */
  | { ok: false; reason: 'refused'; detail: string }
  | { ok: false; reason: 'error'; detail: string };

export type PublicFetchDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** True when Cloudflare, rather than the origin, produced this response. */
export function isChallenge(status: number, headers: Headers, bodyStart: string): boolean {
  if (status === 429 || status === 503) return true;
  if (/challenge/i.test(headers.get('cf-mitigated') ?? '')) return true;
  // Bounded peek: every ordinary page embeds the challenge platform script near
  // its END, so scanning a whole body matches every page ever fetched.
  return /just a moment|checking your browser|cf-browser-verification/i.test(bodyStart.slice(0, 2048));
}

/** Fetches one ungated page as HTML. */
export async function fetchPublicPage(
  deps: PublicFetchDeps,
  url: string,
): Promise<PublicFetchResult> {
  const doFetch = deps.fetchImpl ?? fetch;

  let response: Response;
  let body: string;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: deps.signal ?? AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
    body = await response.text();
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }

  if (isChallenge(response.status, response.headers, body)) {
    return { ok: false, reason: 'challenged', detail: `Cloudflare chặn (HTTP ${response.status})` };
  }

  // A premium resource answers an unauthenticated request with an ordinary page
  // saying so — HTTP 200, no error status. Detected by content or it reads as a
  // page with no versions on it.
  if (/must be logged in|log in or sign up/i.test(body.slice(0, 4096))) {
    return { ok: false, reason: 'refused', detail: 'trang yêu cầu đăng nhập' };
  }

  if (!response.ok) {
    return { ok: false, reason: 'refused', detail: `HTTP ${response.status}` };
  }

  return { ok: true, html: body };
}

/** Version-history page for a resource, by bare numeric id. */
export function historyUrl(resourceId: number): string {
  return `https://www.spigotmc.org/resources/${resourceId}/history`;
}
