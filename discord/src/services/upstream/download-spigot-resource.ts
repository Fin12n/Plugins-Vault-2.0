import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { cookieHeaderFor, mergeSetCookies, type SpigotAccount } from './spigot-account-store.js';

/**
 * Authenticated jar download from spigotmc.org.
 *
 * Deliberately not a browser: a plain fetch is cheaper, and this path was the hot
 * path for as long as the download endpoint answered an authenticated GET.
 *
 * It no longer does. Measured on 23/08/2026 with a freshly minted cookie, from a VPS
 * whose browser path downloads the same jar fine:
 *
 *   GET /resources/51204/download → 403, `cf-mitigated: challenge`, "Just a moment..."
 *
 * Cloudflare terminates ahead of XenForo, so no combination of xf_user/xf_session can
 * open a challenge-gated path — the cookie never reaches the origin. So this module is
 * kept for the case where Spigot stops gating the endpoint again, and for the tests that
 * pin its classification logic, but every real download now goes through
 * `download-via-browser.ts`. A `challenged` outcome here is expected, not a bug.
 */

const SPIGOT_HOST = 'www.spigotmc.org';
const MAX_REDIRECTS = 5;
/** A jar smaller than this is an error page, not a plugin. */
const MIN_PLAUSIBLE_BYTES = 1024;

/**
 * A real browser UA. Not deception for its own sake: a default Node UA is an
 * instant block at the Cloudflare edge, which would surface as an unexplainable
 * 403 indistinguishable from "not purchased".
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type DownloadOutcome =
  /** Jar on disk at tmpPath, verified as far as bytes allow. */
  | { status: 'ok'; tmpPath: string; bytes: number; rotated: SpigotAccount | null }
  /** Authenticated but this account does not own the resource. */
  | { status: 'not_owned' }
  /** Session is gone. Terminal for every account if the cause is shared. */
  | { status: 'cookie_dead' }
  /** Cloudflare interstitial or rate limit — back off, classify nothing. */
  | { status: 'challenged'; detail: string }
  /** Resource or version no longer exists. */
  | { status: 'gone'; detail?: string }
  /** Body did not survive verification; retryable once. */
  | { status: 'incomplete'; detail: string }
  /** Anything else, including transport failure. */
  | { status: 'error'; detail: string };

export type DownloadDeps = {
  tmpDir: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Ceiling on a single jar; reuses the upload cap rather than adding a knob. */
  maxBytes: number;
  /** Aborts a stalled transfer without capping a legitimately slow large jar. */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * True when a Cloudflare interstitial or rate limit is in play.
 *
 * `Cf-Mitigated: challenge` is the authoritative signal — Cloudflare stamps it
 * and the origin never does. The body check remains as a fallback, and stays
 * bounded by its caller to a leading slice: every ordinary SpigotMC page embeds
 * `/cdn-cgi/challenge-platform/...` near the END of the document, so scanning a
 * whole body would match every page.
 */
function looksChallenged(status: number, contentType: string, bodyStart: string, headers?: Headers): boolean {
  if (status === 429 || status === 503) return true;
  if (/challenge/i.test(headers?.get('cf-mitigated') ?? '')) return true;
  if (!contentType.includes('html')) return false;
  return /just a moment|cdn-cgi\/challenge|cf-browser-verification|attention required/i.test(bodyStart);
}

/**
 * Downloads the current latest jar for a resource.
 *
 * No `?version=` parameter, on purpose. Spiget exposes no usable Spigot version
 * id — SpigetVersion carries none, and for premium resources the ids Spiget does
 * return are synthetic (they ascend as release dates descend), so they would
 * work in testing against free resources and fail on exactly the premium ones
 * this exists for. The bare endpoint serves current latest, which is the trigger
 * condition anyway, and the archived version is read from the jar's own
 * descriptor rather than from this URL.
 */
export async function downloadSpigotResource(
  deps: DownloadDeps,
  account: SpigotAccount,
  resourceId: number,
): Promise<DownloadOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let url = `https://${SPIGOT_HOST}/resources/${resourceId}/download`;
  let rotated: SpigotAccount | null = null;
  let current = account;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(url);
    // The cookie goes only to Spigot. Resources can be `external` and redirect
    // to an author-controlled host; undici does not strip an author-set Cookie
    // across origins the way a browser refuses to, so following blindly would
    // hand the owner's session to a third party.
    const sameHost = target.host === SPIGOT_HOST;
    const headers: Record<string, string> = {
      'user-agent': BROWSER_UA,
      accept: 'application/java-archive, application/octet-stream, */*',
    };
    if (sameHost) headers.cookie = cookieHeaderFor(current);

    let response: Response;
    try {
      response = await doFetch(target, {
        method: 'GET',
        headers,
        // Followed by hand so each hop's host can be checked before the cookie
        // is attached.
        redirect: 'manual',
        signal: deps.signal ?? null,
      });
    } catch (err) {
      return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }

    if (sameHost) {
      const merged = mergeSetCookies(current, response.headers.getSetCookie());
      if (merged) {
        if (merged.loggedOut) return { status: 'cookie_dead' };
        current = merged.account;
        rotated = merged.account;
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error', detail: `chuyển hướng ${response.status} không có location` };
      url = new URL(location, target).toString();
      continue;
    }

    if (response.status === 404) return { status: 'gone' };

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (response.status === 403 || looksChallenged(response.status, contentType, '', response.headers)) {
      // Read a slice to tell a Cloudflare interstitial from Spigot's own "you do
      // not own this" page. Conflating them would make the caller walk every
      // account against a challenge, which is the credential-stuffing signature.
      const peek = (await response.text().catch(() => '')).slice(0, 2048);
      if (looksChallenged(response.status, contentType, peek, response.headers)) {
        return { status: 'challenged', detail: `HTTP ${response.status}` };
      }
      if (response.status === 403) return { status: 'not_owned' };
      return { status: 'error', detail: `HTTP ${response.status}` };
    }

    if (!response.ok) return { status: 'error', detail: `HTTP ${response.status}` };
    if (!response.body) return { status: 'error', detail: 'phản hồi không có nội dung' };

    // An HTML 200 is Spigot serving a login or error page. Storing it as a jar
    // would surface much later as a corrupt plugin on a live server.
    if (contentType.includes('text/html')) {
      return { status: 'incomplete', detail: 'nhận được HTML thay vì jar' };
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > deps.maxBytes) {
      return { status: 'error', detail: `tệp ${declared} byte vượt giới hạn ${deps.maxBytes}` };
    }

    return await streamToTemp(deps, response, declared, rotated);
  }

  return { status: 'error', detail: 'quá nhiều lần chuyển hướng' };
}

/** Streams the body to a temp file, verifying as bytes arrive. */
async function streamToTemp(
  deps: DownloadDeps,
  response: Response,
  declared: number,
  rotated: SpigotAccount | null,
): Promise<DownloadOutcome> {
  const tmpPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar`);
  let bytes = 0;
  let head = Buffer.alloc(0);
  let overflow = false;

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  const sink = createWriteStream(tmpPath, { flags: 'wx' });

  const stall = deps.stallTimeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const resetStall = () => {
    if (timer) clearTimeout(timer);
    // Idle-based, not total: a wall-clock timeout sized for metadata would abort
    // every large jar mid-stream, while a slow-but-progressing transfer is fine.
    timer = setTimeout(() => source.destroy(new Error('quá lâu không nhận được dữ liệu')), stall);
  };

  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4)]);
    if (bytes > deps.maxBytes) {
      overflow = true;
      source.destroy(new Error(`vượt giới hạn ${deps.maxBytes} byte`));
      return;
    }
    resetStall();
  });

  try {
    resetStall();
    await pipeline(source, sink);
  } catch (err) {
    if (timer) clearTimeout(timer);
    await discard(tmpPath);
    const detail = err instanceof Error ? err.message : String(err);
    // A dropped connection is retryable; exceeding the cap is not.
    return overflow ? { status: 'error', detail } : { status: 'incomplete', detail };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (bytes < MIN_PLAUSIBLE_BYTES) {
    await discard(tmpPath);
    return { status: 'incomplete', detail: `chỉ nhận được ${bytes} byte` };
  }

  // Zip local file header. Cheap, and rules out every HTML variant that slipped
  // past the content-type check.
  if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
    await discard(tmpPath);
    return { status: 'incomplete', detail: 'không phải tệp zip/jar' };
  }

  // A truncated jar still passes the PK check, since those are the first two
  // bytes. Without this, ingest would fail to read the descriptor and park a
  // bogus "descriptor unreadable" entry for a jar that was fine upstream.
  if (Number.isFinite(declared) && declared > 0 && bytes !== declared) {
    await discard(tmpPath);
    return { status: 'incomplete', detail: `nhận ${bytes}/${declared} byte` };
  }

  return { status: 'ok', tmpPath, bytes, rotated };
}

async function discard(path: string): Promise<void> {
  await unlink(path).catch(() => {
    // Never created, or already removed.
  });
}
