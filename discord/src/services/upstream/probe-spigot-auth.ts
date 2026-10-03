import { cookieHeaderFor, type SpigotAccount } from './spigot-account-store.js';

/**
 * Answers "is this session still logged in?" so a 403 on a download can be told
 * apart from a dead cookie.
 *
 * This distinction is the whole reason the probe exists. Both cases return 403,
 * and treating a logged-out session as "did not buy it" makes the caller walk
 * every account against the same shared cause — which is the credential-stuffing
 * signature this feature must not produce.
 */

const SPIGOT_HOST = 'www.spigotmc.org';
/**
 * The account page. Requires a session, and it is a cheap render — a resource
 * page would work but is heavily cached at the edge, which is exactly what makes
 * status codes untrustworthy here.
 */
const PROBE_URL = `https://${SPIGOT_HOST}/account/`;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type AuthVerdict =
  | { state: 'authenticated' }
  | { state: 'logged_out' }
  /** Challenge, rate limit, or unparseable. Never a classification. */
  | { state: 'indeterminate'; detail: string };

export type ProbeDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Positive markers for a logged-in XenForo page.
 *
 * Asserting presence, never absence-of-error: XenForo serves 200 to guests
 * constantly, and a cached guest copy of a 200 would otherwise read as a live
 * session. A guest page has none of these.
 */
function hasAuthenticatedMarker(body: string): boolean {
  return (
    /data-logged-in="true"/i.test(body) ||
    /\/logout\/\?/.test(body) ||
    /class="[^"]*p-navgroup--member/i.test(body)
  );
}

/**
 * Number of leading bytes examined for a challenge interstitial.
 *
 * Bounded deliberately. Every ordinary SpigotMC page embeds
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` near its END — measured at
 * byte 47471 of a 48158-byte resource page that returned a plain 200. Scanning
 * the whole body therefore matched every page ever fetched, so the probe
 * returned `indeterminate` unconditionally and an expired cookie was never
 * detectable. A real interstitial is a tiny document whose markers are all up
 * front, so a small window separates the two cases cleanly.
 */
const CHALLENGE_PEEK_BYTES = 2048;

/**
 * True when Cloudflare, not the origin, answered.
 *
 * The response HEADER is the reliable signal: Cloudflare stamps `Cf-Mitigated:
 * challenge` on an interstitial and the origin never does. The body peek is only
 * a fallback for a proxy that strips headers.
 */
function looksChallenged(status: number, body: string, headers?: Headers): boolean {
  if (status === 429 || status === 503) return true;

  const mitigated = headers?.get('cf-mitigated') ?? '';
  if (/challenge/i.test(mitigated)) return true;

  return /just a moment|cdn-cgi\/challenge|cf-browser-verification|attention required/i.test(
    body.slice(0, CHALLENGE_PEEK_BYTES),
  );
}

/**
 * Probes one account.
 *
 * Call once per account per sweep and cache the verdict. Probing per finding
 * would multiply traffic by the number of plugins for no extra information.
 */
export async function probeSpigotAuth(deps: ProbeDeps, account: SpigotAccount): Promise<AuthVerdict> {
  const doFetch = deps.fetchImpl ?? fetch;

  let response: Response;
  let body: string;
  try {
    response = await doFetch(PROBE_URL, {
      method: 'GET',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html',
        cookie: cookieHeaderFor(account),
      },
      // Manual: a redirect to /login/ is itself the logged-out signal, and
      // following it would land on a challenge-gated page and muddy the verdict.
      redirect: 'manual',
      signal: deps.signal ?? AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
    body = response.status >= 300 && response.status < 400 ? '' : await response.text();
  } catch (err) {
    // A transport failure says nothing about the session.
    return { state: 'indeterminate', detail: err instanceof Error ? err.message : String(err) };
  }

  if (looksChallenged(response.status, body, response.headers)) {
    return { state: 'indeterminate', detail: `Cloudflare chặn (HTTP ${response.status})` };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    if (/\/login\b/.test(location)) return { state: 'logged_out' };
    return { state: 'indeterminate', detail: `chuyển hướng tới ${location || '(không rõ)'}` };
  }

  if (response.status === 401 || response.status === 403) return { state: 'logged_out' };

  if (response.ok) {
    if (hasAuthenticatedMarker(body)) return { state: 'authenticated' };
    // 200 without a marker is a guest page, so the session is gone. Reporting
    // this as authenticated is the dangerous direction: it would let the caller
    // conclude "not purchased" and walk every remaining account.
    return { state: 'logged_out' };
  }

  return { state: 'indeterminate', detail: `HTTP ${response.status}` };
}
