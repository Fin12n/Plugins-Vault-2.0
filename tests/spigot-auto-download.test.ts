import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import {
  deferDownload,
  enqueueDownload,
  listAllPendingDownloads,
  listDueDownloads,
  resolveDownload,
} from '../src/repositories/pending-download.js';
import {
  Secret,
  checkAccountsFilePermissions,
  cookieHeaderFor,
  loadSpigotAccounts,
  mergeSetCookies,
  saveSpigotAccounts,
} from '../src/services/upstream/spigot-account-store.js';
import { downloadSpigotResource } from '../src/services/upstream/download-spigot-resource.js';
import { loadSpigotCredentials } from '../src/services/upstream/spigot-credential-store.js';
import { parseSpigotCredentialText } from '../src/services/upstream/spigot-credential-import.js';
import { seedImportedPurchasedResources } from '../src/services/upstream/seed-imported-purchased-resources.js';
import { resourceIdFromHref } from '../src/services/upstream/scan-purchased-resources.js';
import {
  findScanState,
  forgetScanState,
  listScanStates,
  recordScan,
  selectAccountsDueForScan,
} from '../src/repositories/account-scan-state.js';
import { downloadViaBrowser, loginToSpigot, type BrowserPage } from '../src/services/upstream/download-via-browser.js';
import {
  formatSyncOutcome,
  normalizeName,
  displayFrom,
  syncPurchasedResources,
} from '../src/services/upstream/sync-purchased-resources.js';
import { createPlugin, listPlugins, updatePlugin } from '../src/repositories/plugins.js';
import {
  findNonOwners,
  findOwner,
  forgetAccount,
  listOwnership,
  orderAccountsFor,
  recordOwnership,
} from '../src/repositories/resource-ownership.js';
import { probeSpigotAuth } from '../src/services/upstream/probe-spigot-auth.js';
import { fetchSpigotProxy } from '../src/services/upstream/proxy-provider.js';
import {
  accountProfileDir,
  closeBrowser,
  clearStaleProfileLocks,
  probeBrowserLauncher,
  pruneOrphanProfiles,
  puppeteerCacheChrome,
  resolveChromePath,
} from '../src/services/upstream/browser-launcher.js';
import { autoDownloadVersions, type AutoDownloadOutcome } from '../src/services/upstream/auto-download-versions.js';
import { formatAbortReason, formatDownloadOutcome } from '../src/services/upstream/format-download-outcome.js';
import type { UpdateFinding } from '../src/services/upstream/check-plugin-updates.js';
import { buildZip } from './helpers/jar-fixture-builder.js';
import {
  downloadUrlFor,
  findVersionId,
  isSpigetSyntheticId,
  parseHistoryLinks,
  parseVersionParam,
} from '../src/services/upstream/spigot-version-links.js';
import {
  markAccountStatus,
  needsRefresh,
} from '../src/services/upstream/spigot-account-store.js';

/**
 * Realistically-sized jar for a "download".
 *
 * Padded with random bytes: the download verifier rejects anything under 1 KB as
 * an error page, and a bare two-entry zip is ~150 bytes. Random rather than
 * repeated so deflate cannot compress the padding away.
 */
function pluginJar(name: string, version: string): Buffer {
  return buildZip([
    { name: 'plugin.yml', data: Buffer.from(`name: ${name}\nversion: ${version}\nmain: a.B\n`, 'utf8') },
    { name: 'a/Filler.class', data: randomBytes(4096) },
  ]);
}

type StubReply = {
  status?: number;
  body?: Buffer | string;
  headers?: Record<string, string>;
  setCookie?: string[];
};

/**
 * Stub fetch. Every test in this file uses one — no live spigotmc.org traffic,
 * deliberately: the feature's whole risk profile is outbound requests.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => StubReply): {
  impl: typeof fetch;
  urls: string[];
  cookies: (string | undefined)[];
} {
  const urls: string[] = [];
  const cookies: (string | undefined)[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    cookies.push(headers.cookie);

    const reply = handler(url, init);
    const status = reply.status ?? 200;
    const body = reply.body ?? '';
    const h = new Headers(reply.headers ?? {});
    for (const line of reply.setCookie ?? []) h.append('set-cookie', line);

    // 3xx must not carry a body, or Response throws.
    if (status >= 300 && status < 400) return new Response(null, { status, headers: h });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: h });
  }) as unknown as typeof fetch;
  return { impl, urls, cookies };
}

const acct = (label: string, user = 'u-1%2Cabc', session = 's-1') => ({
  label,
  xfUser: new Secret(user),
  xfSession: new Secret(session),
});

const LOGGED_IN_HTML = '<html data-logged-in="true"><a href="/logout/?t=1">Log out</a></html>';
const GUEST_HTML = '<html data-logged-in="false"><a href="/login/">Log in</a></html>';
const CHALLENGE_HTML = '<html><title>Just a moment...</title>cdn-cgi/challenge-platform</html>';

describe('Secret', () => {
  it('never exposes its value through any serialization path', () => {
    const s = new Secret('super-secret-cookie-value');

    // Each of these is a real leak path: an error serializer, a log call, and
    // string interpolation into a Discord message.
    expect(JSON.stringify({ cookie: s })).not.toContain('super-secret');
    expect(inspect({ cookie: s })).not.toContain('super-secret');
    expect(`${s}`).not.toContain('super-secret');
    expect(JSON.stringify(s)).toBe('"[redacted]"');
    expect(s.reveal()).toBe('super-secret-cookie-value');
  });

  it('reports length without revealing content', () => {
    expect(new Secret('abcd').length).toBe(4);
  });
});

describe('spigot account store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spigot-acct-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    const path = join(dir, 'accounts.json');
    await writeFile(path, content, 'utf8');
    return path;
  };

  it('treats a missing file as the feature being off, not an error', () => {
    const load = loadSpigotAccounts(join(dir, 'nope.json'));
    expect(load).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('fails loudly on malformed JSON rather than reporting zero accounts', async () => {
    // Silently reading a typo as "no accounts" would be indistinguishable from
    // the feature working and finding nothing to do.
    const load = loadSpigotAccounts(await write('{ not json'));
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('tolerates a UTF-8 BOM, which hand-editing on Windows produces', async () => {
    const load = loadSpigotAccounts(await write('﻿[{"label":"a","xfUser":"u","xfSession":"s"}]'));
    expect(load.ok).toBe(true);
  });

  it('rejects an account missing xfUser, which would work briefly then fail', async () => {
    // xf_session alone expires in an hour; xf_user is what makes it long-lived.
    const load = await write('[{"label":"a","xfSession":"s"}]').then(loadSpigotAccounts);
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
    expect(load.ok === false && load.detail).toContain('xfUser');
  });

  it('rejects duplicate labels, since the label keys the auth cache', async () => {
    const load = await write('[{"label":"a","xfUser":"u"},{"label":"a","xfUser":"v"}]').then(loadSpigotAccounts);
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('sends xf_user exactly as stored, without decoding', () => {
    // xf_user is URL-encoded in the browser (`1,abc` → `1%2Cabc`); decoding the
    // comma breaks authentication.
    expect(cookieHeaderFor(acct('a', '1%2Cabc'))).toBe('xf_user=1%2Cabc; xf_session=s-1');
  });

  it('omits xf_session when empty rather than sending a blank cookie', () => {
    expect(cookieHeaderFor(acct('a', 'u', ''))).toBe('xf_user=u');
  });

  it('round-trips through save and load', async () => {
    const path = join(dir, 'accounts.json');
    saveSpigotAccounts(path, [acct('one', 'u1', 's1'), acct('two', 'u2', 's2')]);
    const load = loadSpigotAccounts(path);
    expect(load.ok && load.accounts.map((a) => a.label)).toEqual(['one', 'two']);
    expect(load.ok && load.accounts[0]!.xfUser.reveal()).toBe('u1');
  });

  it('leaves no temp file behind after a save', async () => {
    const path = join(dir, 'accounts.json');
    saveSpigotAccounts(path, [acct('one')]);
    const leftovers = (await readFile(path, 'utf8')) && existsSync(path);
    expect(leftovers).toBe(true);
    // The write is temp-then-rename; a stray .tmp would mean the rename failed.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the file 0600 so secrets are never world-readable', async () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'accounts.json');
    saveSpigotAccounts(path, [acct('one')]);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(checkAccountsFilePermissions(path)).toBeNull();
  });
});

describe('cookie rotation', () => {
  it('adopts a refreshed xf_user so the session self-renews', () => {
    const merged = mergeSetCookies(acct('a', 'old'), ['xf_user=new; Path=/; HttpOnly']);
    expect(merged?.account.xfUser.reveal()).toBe('new');
    expect(merged?.loggedOut).toBe(false);
  });

  it('reports nothing changed when the cookie is unchanged', () => {
    expect(mergeSetCookies(acct('a', 'same'), ['xf_user=same; Path=/'])).toBeNull();
  });

  it('never overwrites a live cookie with an empty one', () => {
    // XenForo deletes a cookie by setting it empty with a past expiry. Adopting
    // that would destroy the session the bot just used successfully.
    const merged = mergeSetCookies(acct('a', 'live'), ['xf_user=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(merged?.account.xfUser.reveal()).toBe('live');
    expect(merged?.loggedOut).toBe(true);
  });

  it('ignores cookies that are not ours', () => {
    expect(mergeSetCookies(acct('a', 'u'), ['cf_clearance=xyz; Path=/', '_ga=GA1.2'])).toBeNull();
  });
});

describe('auth probe', () => {
  it('accepts a page carrying a logged-in marker', async () => {
    const { impl } = stubFetch(() => ({ body: LOGGED_IN_HTML, headers: { 'content-type': 'text/html' } }));
    expect(await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).toEqual({ state: 'authenticated' });
  });

  it('treats a 200 guest page as logged out, not as authenticated', async () => {
    // The dangerous direction: reading this as authenticated makes the caller
    // conclude "not purchased" and walk every remaining account.
    const { impl } = stubFetch(() => ({ body: GUEST_HTML, headers: { 'content-type': 'text/html' } }));
    expect(await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).toEqual({ state: 'logged_out' });
  });

  it('reads a redirect to /login as logged out', async () => {
    const { impl } = stubFetch(() => ({ status: 303, headers: { location: '/login/' } }));
    expect(await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).toEqual({ state: 'logged_out' });
  });

  it('reports a challenge as indeterminate rather than guessing', async () => {
    const { impl } = stubFetch(() => ({
      status: 403,
      body: CHALLENGE_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    expect((await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).state).toBe('indeterminate');
  });

  it('detects an expired session on a page that merely mentions the challenge script', async () => {
    // Every ordinary SpigotMC page embeds /cdn-cgi/challenge-platform/ near its
    // END — measured at byte 47471 of a 48158-byte page that returned a plain
    // 200. Scanning the whole body therefore matched every page ever fetched, so
    // the probe answered 'indeterminate' unconditionally and an expired cookie
    // was never detectable at all.
    const realisticGuestPage =
      GUEST_HTML +
      'x'.repeat(45_000) +
      '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    const { impl } = stubFetch(() => ({
      body: realisticGuestPage,
      headers: { 'content-type': 'text/html' },
    }));

    expect(await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).toEqual({ state: 'logged_out' });
  });

  it('trusts the Cf-Mitigated header over the body', async () => {
    // Cloudflare stamps this and the origin never does, so it settles the case
    // even when the interstitial markup is not what the body matcher expects.
    const { impl } = stubFetch(() => ({
      status: 403,
      body: '<html>nothing familiar here</html>',
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    }));
    expect((await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).state).toBe('indeterminate');
  });

  it('reports a transport failure as indeterminate', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect((await probeSpigotAuth({ fetchImpl: impl }, acct('a'))).state).toBe('indeterminate');
  });
});

describe('downloadSpigotResource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spigot-dl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deps = (impl: typeof fetch) => ({ tmpDir: dir, fetchImpl: impl, maxBytes: 10 * 1024 * 1024 });

  it('requests the bare download endpoint without a version parameter', async () => {
    // Spiget exposes no usable Spigot version id, and its premium ids are
    // synthetic — so a ?version= would break on exactly the premium resources
    // this feature exists for while looking correct against free ones.
    const jar = pluginJar('Mythic', '5.6.2');
    const { impl, urls } = stubFetch(() => ({
      body: jar,
      headers: { 'content-type': 'application/java-archive', 'content-length': String(jar.length) },
    }));

    const outcome = await downloadSpigotResource(deps(impl), acct('a'), 12345);
    expect(outcome.status).toBe('ok');
    expect(urls[0]).toBe('https://www.spigotmc.org/resources/12345/download');
    expect(urls[0]).not.toContain('version=');
  });

  it('never sends the cookie to a third-party host on redirect', async () => {
    // Resources can be `external` and redirect off-site. undici does not strip
    // an author-set Cookie across origins the way a browser refuses to.
    const jar = pluginJar('Ext', '1.0');
    const { impl, cookies, urls } = stubFetch((url) => {
      if (url.includes('spigotmc.org')) {
        return { status: 302, headers: { location: 'https://github.com/evil/release.jar' } };
      }
      return { body: jar, headers: { 'content-type': 'application/java-archive' } };
    });

    const outcome = await downloadSpigotResource(deps(impl), acct('a'), 9089);
    expect(outcome.status).toBe('ok');
    expect(urls[1]).toContain('github.com');
    expect(cookies[0]).toContain('xf_user');
    expect(cookies[1]).toBeUndefined();
  });

  it('reports a plain 403 as not_owned', async () => {
    const { impl } = stubFetch(() => ({ status: 403, body: '<html>no access</html>' }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('not_owned');
  });

  it('distinguishes a Cloudflare 403 from not_owned', async () => {
    // Conflating them would make the caller walk every account against a wall.
    const { impl } = stubFetch(() => ({
      status: 403,
      body: CHALLENGE_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('challenged');
  });

  it('treats 429 as a challenge so the sweep backs off', async () => {
    const { impl } = stubFetch(() => ({ status: 429 }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('challenged');
  });

  it('reports 404 as gone', async () => {
    const { impl } = stubFetch(() => ({ status: 404 }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('gone');
  });

  it('rejects an HTML 200 instead of storing it as a jar', async () => {
    const { impl } = stubFetch(() => ({ body: GUEST_HTML, headers: { 'content-type': 'text/html' } }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('incomplete');
  });

  it('rejects a body that is not a zip even with a jar content-type', async () => {
    const { impl } = stubFetch(() => ({
      body: Buffer.from('x'.repeat(2048)),
      headers: { 'content-type': 'application/java-archive' },
    }));
    const outcome = await downloadSpigotResource(deps(impl), acct('a'), 1);
    expect(outcome.status).toBe('incomplete');
    expect(outcome.status === 'incomplete' && outcome.detail).toContain('zip');
  });

  it('rejects a truncated jar by reconciling against content-length', async () => {
    // A truncated jar still passes the PK check, since those are the first two
    // bytes. Without this it reaches ingest and parks a bogus "unreadable" entry.
    const jar = pluginJar('Mythic', '5.6.2');
    const { impl } = stubFetch(() => ({
      body: jar,
      headers: {
        'content-type': 'application/java-archive',
        'content-length': String(jar.length + 500),
      },
    }));
    const outcome = await downloadSpigotResource(deps(impl), acct('a'), 1);
    expect(outcome.status).toBe('incomplete');
    expect(outcome.status === 'incomplete' && outcome.detail).toContain('/');
  });

  it('rejects an implausibly small body', async () => {
    const { impl } = stubFetch(() => ({
      body: Buffer.from('PK'),
      headers: { 'content-type': 'application/java-archive' },
    }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('incomplete');
  });

  it('refuses a file larger than the cap before streaming it', async () => {
    const { impl } = stubFetch(() => ({
      body: pluginJar('Big', '1.0'),
      headers: { 'content-type': 'application/java-archive', 'content-length': String(50 * 1024 * 1024) },
    }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('error');
  });

  it('surfaces a revoked cookie as cookie_dead', async () => {
    const { impl } = stubFetch(() => ({
      status: 403,
      body: '<html>no</html>',
      setCookie: ['xf_user=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
    }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('cookie_dead');
  });

  it('reports rotated cookies alongside a successful download', async () => {
    const jar = pluginJar('Mythic', '5.6.2');
    const { impl } = stubFetch(() => ({
      body: jar,
      headers: { 'content-type': 'application/java-archive', 'content-length': String(jar.length) },
      setCookie: ['xf_user=rotated-value; Path=/'],
    }));
    const outcome = await downloadSpigotResource(deps(impl), acct('a', 'original'), 1);
    expect(outcome.status === 'ok' && outcome.rotated?.xfUser.reveal()).toBe('rotated-value');
  });

  it('leaves no temp file behind when verification fails', async () => {
    const { readdir } = await import('node:fs/promises');
    const { impl } = stubFetch(() => ({
      body: Buffer.from('x'.repeat(2048)),
      headers: { 'content-type': 'application/java-archive' },
    }));
    await downloadSpigotResource(deps(impl), acct('a'), 1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('stops after too many redirects', async () => {
    const { impl } = stubFetch(() => ({
      status: 302,
      headers: { location: 'https://www.spigotmc.org/resources/1/download' },
    }));
    expect((await downloadSpigotResource(deps(impl), acct('a'), 1)).status).toBe('error');
  });
});

describe('pending download queue', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    createPlugin(db, {
      slug: 'mythic',
      displayName: 'Mythic',
      descriptorName: 'Mythic',
      platform: 'spigot',
      depositPrice: 0,
      isPremium: true,
    });
  });
  afterEach(() => db.close());

  it('queues a version and returns it as due', () => {
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });
    expect(listDueDownloads(db, 10).map((r) => r.versionUuid)).toEqual(['u1']);
  });

  it('gives every plugin a turn before any plugin gets a second row', () => {
    // A historical backfill enqueues hundreds of rows for one plugin in the same
    // second. Ordering only by created_at would hand the whole sweep budget to
    // that plugin and never reach the others.
    createPlugin(db, {
      slug: 'skript',
      displayName: 'Skript',
      descriptorName: 'Skript',
      platform: 'spigot',
      depositPrice: 0,
      isPremium: true,
    });
    for (let i = 0; i < 50; i += 1) {
      enqueueDownload(db, { pluginId: 1, versionUuid: `backfill-${i}`, versionName: `1.${i}` });
    }
    enqueueDownload(db, { pluginId: 2, versionUuid: 'late', versionName: '2.0' });

    expect(listDueDownloads(db, 2).map((r) => r.pluginId)).toEqual([1, 2]);
  });

  it('does not reset backoff when the same version is seen again', () => {
    // Re-detecting a version every sweep must not undo the backoff, or a
    // permanently failing download retries at full rate forever.
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });
    deferDownload(db, 1, 'u1', 'boom');
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });

    const all = listAllPendingDownloads(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.attempts).toBe(1);
    expect(listDueDownloads(db, 10)).toEqual([]);
  });

  it('backs off further on each failure', () => {
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });
    deferDownload(db, 1, 'u1', 'first');
    const after1 = listAllPendingDownloads(db)[0]!.nextAttemptAt;
    deferDownload(db, 1, 'u1', 'second');
    const after2 = listAllPendingDownloads(db)[0]!;
    expect(after2.attempts).toBe(2);
    expect(after2.nextAttemptAt).toBeGreaterThan(after1);
  });

  it('clears the row on a terminal outcome', () => {
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });
    resolveDownload(db, 1, 'u1');
    expect(listAllPendingDownloads(db)).toEqual([]);
  });

  it('drops the queue when the plugin is deleted', () => {
    enqueueDownload(db, { pluginId: 1, versionUuid: 'u1', versionName: '1.0' });
    db.prepare('DELETE FROM plugins WHERE id = 1').run();
    expect(listAllPendingDownloads(db)).toEqual([]);
  });
});

describe('autoDownloadVersions', () => {
  let db: Database.Database;
  let root: string;
  let accountsFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spigot-auto-'));
    await mkdir(join(root, 'vault'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    accountsFile = join(root, 'accounts.json');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    createPlugin(db, {
      slug: 'mythic',
      displayName: 'Mythic',
      descriptorName: 'Mythic',
      platform: 'spigot',
      depositPrice: 0,
      isPremium: true,
    });
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const finding = (uuid = 'u-new', name = '5.6.2'): UpdateFinding => ({
    pluginId: 1,
    pluginName: 'Mythic',
    resourceId: 12345,
    isPremium: true,
    upstream: { uuid, name, releaseDateMs: 1_780_000_000_000, downloads: 10 },
    archivedVersion: null,
  });

  const deps = (impl: typeof fetch, accounts = [acct('a')], enabled = true) => ({
    db,
    ingest: { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') },
    accounts,
    accountsFile,
    download: { tmpDir: join(root, 'tmp'), fetchImpl: impl, maxBytes: 10 * 1024 * 1024 },
    minIntervalMs: 0,
    maxPerSweep: 5,
    isEnabled: () => enabled,
    sleep: async () => {},
    logger: { warn: () => {} },
  });

  const jarReply = (name = 'Mythic', version = '5.6.2'): StubReply => {
    const jar = pluginJar(name, version);
    return {
      body: jar,
      headers: { 'content-type': 'application/java-archive', 'content-length': String(jar.length) },
    };
  };

  /** Jar on disk, standing in for what a real fetchJar hands back. */
  const writeJar = async (version = '5.6.2'): Promise<string> => {
    const path = join(root, 'tmp', `fetched-${version}.jar`);
    await writeFile(path, pluginJar('Mythic', version));
    return path;
  };

  it('archives a downloaded jar through the existing ingest path', async () => {
    const { impl } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(deps(impl), [finding()]);

    expect(result.outcomes[0]).toMatchObject({ status: 'archived', pluginName: 'Mythic' });
    // Filed under the existing plugin, with the version read from the jar's own
    // descriptor rather than from the URL.
    const rows = db.prepare('SELECT plugin_id, version FROM versions').all();
    expect(rows).toEqual([{ plugin_id: 1, version: '5.6.2' }]);
    expect(listAllPendingDownloads(db)).toEqual([]);
  });

  it('reports a byte-identical re-download as a duplicate, not a failure', async () => {
    // One fixed body across both sweeps, so the second download is genuinely the
    // same bytes and SHA-256 dedupe is what catches it.
    const fixed = jarReply();
    const { impl } = stubFetch(() => fixed);
    await autoDownloadVersions(deps(impl), [finding('u-1')]);
    const second = await autoDownloadVersions(deps(impl), [finding('u-2')]);

    expect(second.outcomes[0]?.status).toBe('duplicate');
    expect(db.prepare('SELECT COUNT(*) c FROM versions').get()).toMatchObject({ c: 1 });
  });

  it('tries the next account when the first does not own the resource', async () => {
    const { impl } = stubFetch((url, init) => {
      const cookie = ((init?.headers ?? {}) as Record<string, string>).cookie ?? '';
      if (url.includes('/account/')) {
        return { body: LOGGED_IN_HTML, headers: { 'content-type': 'text/html' } };
      }
      if (cookie.includes('owner')) return jarReply();
      return { status: 403, body: '<html>no</html>' };
    });

    const result = await autoDownloadVersions(
      deps(impl, [acct('no-purchase', 'nobody'), acct('buyer', 'owner')]),
      [finding()],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'archived', accountLabel: 'buyer' });
  });

  it('walks to the next account when the version table is invisible to the first', async () => {
    // The failure the owner spotted in production: a premium resource's version
    // table only renders for an account that OWNS it, so the wrong account sees a
    // page with no version rows — reported as 'incomplete', "version not found".
    // Returning on that meant a plugin bought on account 2 was never opened with
    // account 2, and the queue retried the same wrong account forever.
    const tried: string[] = [];
    const { impl } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(
      {
        ...deps(impl, [acct('a'), acct('b')]),
        fetchJar: async (account) => {
          tried.push(account.label);
          return account.label === 'b'
            ? { status: 'ok', tmpPath: await writeJar(), bytes: 5000, rotated: null }
            : { status: 'incomplete', detail: 'không thấy bản ở trang lịch sử' };
        },
      },
      [finding()],
    );

    expect(tried).toEqual(['a', 'b']);
    expect(result.outcomes[0]).toMatchObject({ status: 'archived', accountLabel: 'b' });
  });

  it('keeps a version queued when every account hit a retryable snag', async () => {
    // Distinct from not_owned: nothing was settled, so resolving the row would
    // discard the version permanently.
    const { impl } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(
      {
        ...deps(impl, [acct('a'), acct('b')]),
        fetchJar: async () => ({ status: 'incomplete', detail: 'trang lịch sử trống' }),
      },
      [finding()],
    );

    expect(result.outcomes[0]).toMatchObject({ status: 'retrying' });
    expect(listAllPendingDownloads(db)).toHaveLength(1);
  });

  it('walks to the next account when the first does not own the resource', async () => {
    // The browser sweep previously offered the orchestrator only the first account
    // that logged in, so this fallback was dead code and a plugin bought on the
    // second account was reported as owned by nobody.
    const tried: string[] = [];
    // The probe must read as authenticated, or a 403 is classified as a dead
    // session and the sweep stops instead of trying the next account.
    const { impl } = stubFetch(() => ({
      body: LOGGED_IN_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    const result = await autoDownloadVersions(
      {
        ...deps(impl, [acct('a'), acct('b')]),
        fetchJar: async (account) => {
          tried.push(account.label);
          return account.label === 'b'
            ? { status: 'ok', tmpPath: await writeJar(), bytes: 5000, rotated: null }
            : { status: 'not_owned' };
        },
      },
      [finding()],
    );

    expect(tried).toEqual(['a', 'b']);
    expect(result.outcomes[0]).toMatchObject({ status: 'archived', accountLabel: 'b' });
  });

  it('reports not_owned once and clears the queue when nobody owns it', async () => {
    // Leaving it queued would DM the owner about the same plugin every sweep.
    const { impl } = stubFetch((url) =>
      url.includes('/account/')
        ? { body: LOGGED_IN_HTML, headers: { 'content-type': 'text/html' } }
        : { status: 403, body: '<html>no</html>' },
    );

    const result = await autoDownloadVersions(deps(impl, [acct('a'), acct('b')]), [finding()]);
    expect(result.outcomes[0]?.status).toBe('not_owned');
    expect(listAllPendingDownloads(db)).toEqual([]);
  });

  it('stops the sweep on a dead cookie instead of walking every account', async () => {
    // A dead cookie is a shared cause; continuing would produce the
    // credential-stuffing signature this feature must avoid.
    const { impl } = stubFetch((url) =>
      url.includes('/account/')
        ? { body: GUEST_HTML, headers: { 'content-type': 'text/html' } }
        : { status: 403, body: '<html>no</html>' },
    );

    const result = await autoDownloadVersions(deps(impl, [acct('a'), acct('b')]), [finding()]);
    expect(result.aborted).toBe(true);
    expect(result.outcomes[0]?.status).toBe('cookie_dead');
    // Still owed, so it is retried once the owner refreshes the cookie.
    expect(listAllPendingDownloads(db)).toHaveLength(1);
  });

  it('aborts on a challenge and keeps the version queued', async () => {
    const { impl } = stubFetch(() => ({
      status: 429,
      body: CHALLENGE_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    const result = await autoDownloadVersions(deps(impl), [finding()]);
    expect(result.outcomes[0]?.status).toBe('challenged');
    expect(result.aborted).toBe(true);
    expect(listAllPendingDownloads(db)).toEqual([
      expect.objectContaining({ attempts: 0, lastError: 'HTTP 429' }),
    ]);
    expect(listDueDownloads(db, 10)).toHaveLength(1);
  });

  it('does not try another account after a browser challenge', async () => {
    const tried: string[] = [];
    const { impl } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(
      {
        ...deps(impl, [acct('a'), acct('b')]),
        fetchJar: async (account) => {
          tried.push(account.label);
          return { status: 'challenged', detail: 'Cloudflare challenge' };
        },
      },
      [finding()],
    );

    expect(tried).toEqual(['a']);
    expect(result).toMatchObject({ aborted: true, abortReason: 'challenged' });
    expect(listAllPendingDownloads(db)).toHaveLength(1);
  });

  it('keeps a transiently failed version queued for a later sweep', async () => {
    // The defect this queue exists for: upstream_state is already committed, so
    // without a pending row the version would never be fetched again.
    const { impl } = stubFetch(() => ({
      body: Buffer.from('x'.repeat(2048)),
      headers: { 'content-type': 'application/java-archive' },
    }));
    const result = await autoDownloadVersions(deps(impl), [finding()]);
    expect(result.outcomes[0]?.status).toBe('retrying');
    expect(listAllPendingDownloads(db)[0]!.attempts).toBe(1);
  });

  it('queues every finding before downloading any of them', async () => {
    // A crash mid-sweep must not lose the versions that had not been reached.
    const { impl } = stubFetch(() => ({ status: 429, body: CHALLENGE_HTML, headers: { 'content-type': 'text/html' } }));
    await autoDownloadVersions(deps(impl), [finding('u-1', '1.0'), finding('u-2', '2.0')]);
    expect(listAllPendingDownloads(db).map((r) => r.versionUuid).sort()).toEqual(['u-1', 'u-2']);
  });

  it('does not start a download when the toggle is off', async () => {
    const { impl, urls } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(deps(impl, [acct('a')], false), [finding()]);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('disabled');
    expect(urls).toEqual([]);
  });

  it('honours the per-sweep cap', async () => {
    const { impl } = stubFetch(() => jarReply());
    const d = { ...deps(impl), maxPerSweep: 1 };
    const result = await autoDownloadVersions(d, [finding('u-1', '1.0'), finding('u-2', '2.0')]);
    expect(result.outcomes).toHaveLength(1);
    // The un-downloaded one is still owed rather than silently dropped.
    expect(listAllPendingDownloads(db).map((r) => r.versionUuid)).toContain('u-2');
  });

  it('persists rotated cookies to the accounts file', async () => {
    const { impl } = stubFetch(() => ({ ...jarReply(), setCookie: ['xf_user=fresh-token; Path=/'] }));
    await autoDownloadVersions(deps(impl), [finding()]);

    const load = loadSpigotAccounts(accountsFile);
    expect(load.ok && load.accounts[0]!.xfUser.reveal()).toBe('fresh-token');
  });

  it('does nothing when no accounts are configured', async () => {
    const { impl, urls } = stubFetch(() => jarReply());
    const result = await autoDownloadVersions(deps(impl, []), [finding()]);
    expect(result.abortReason).toBe('no-accounts');
    expect(urls).toEqual([]);
  });

  it('tells the fetcher which version to get, not just which resource', async () => {
    // Without the version name the browser downloader reads the resource page's
    // own link, which always points at current latest. A queue of ten historical
    // versions then downloaded the same jar ten times.
    const asked: { resourceId: number; versionName: string }[] = [];
    const { impl } = stubFetch(() => jarReply());
    await autoDownloadVersions(
      {
        ...deps(impl),
        fetchJar: async (_a, resourceId, versionName) => {
          asked.push({ resourceId, versionName });
          return { status: 'error', detail: 'stub' };
        },
      },
      [finding('u-1', '2.9.7.18'), finding('u-2', '2.9.7.23')],
    );

    expect(asked.map((a) => a.versionName)).toEqual(['2.9.7.18', '2.9.7.23']);
  });

  it('files the jar under the plugin it was fetched for, not the descriptor name', async () => {
    // The jar declares its code name ("Mythic") while the tracked entry carries
    // the marketplace title. Matching by name created a SECOND plugin, leaving the
    // tracked one empty so the same version re-downloaded every sweep forever.
    db.prepare('UPDATE plugins SET display_name = ?, descriptor_name = ? WHERE id = 1').run(
      'Mythic Mobs Premium',
      'Mythic Mobs Premium',
    );
    const { impl } = stubFetch(() => jarReply('Mythic', '5.6.2'));

    const result = await autoDownloadVersions(deps(impl), [
      { ...finding(), pluginName: 'Mythic Mobs Premium' },
    ]);

    expect(result.outcomes[0]).toMatchObject({ status: 'archived' });
    expect(db.prepare('SELECT count(*) AS c FROM plugins').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT plugin_id FROM versions').all()).toEqual([{ plugin_id: 1 }]);
  });

  it('probes each account at most once per sweep', async () => {
    const { impl, urls } = stubFetch((url) =>
      url.includes('/account/')
        ? { body: LOGGED_IN_HTML, headers: { 'content-type': 'text/html' } }
        : { status: 403, body: '<html>no</html>' },
    );

    await autoDownloadVersions(deps(impl, [acct('a')]), [finding('u-1', '1.0'), finding('u-2', '2.0')]);
    expect(urls.filter((u) => u.includes('/account/'))).toHaveLength(1);
  });

  it('keeps the account already signed in when it also owns the plugin', async () => {
    // The failure the owner reported: both accounts own Vulcan, and the sweep kept
    // switching between them. Every switch is a logout plus a login — around 40
    // seconds and a fresh Cloudflare challenge — and a hiccup in any of them made
    // the download fail outright. Any owning account serves the jar equally well,
    // so the live session must win.
    recordOwnership(db, 12345, 'acc-1', 'owned');
    recordOwnership(db, 12345, 'acc-2', 'owned');

    const tried: string[] = [];
    const { impl } = stubFetch(() => jarReply());

    await autoDownloadVersions(
      {
        ...deps(impl, [acct('acc-1'), acct('acc-2')]),
        // acc-2 holds the live session.
        activeAccount: () => 'acc-2',
        fetchJar: async (account) => {
          tried.push(account.label);
          return { status: 'ok', tmpPath: await writeJar(), bytes: 5000, rotated: null };
        },
      },
      [finding()],
    );

    expect(tried).toEqual(['acc-2']);
  });

  it('does not prefer the live session for a plugin it does not own', async () => {
    // Preferring it unconditionally would send every download to one account and
    // never reach the one that actually bought the plugin.
    recordOwnership(db, 12345, 'acc-1', 'owned');
    recordOwnership(db, 12345, 'acc-2', 'not_owned');

    const tried: string[] = [];
    const { impl } = stubFetch(() => jarReply());

    await autoDownloadVersions(
      {
        ...deps(impl, [acct('acc-1'), acct('acc-2')]),
        activeAccount: () => 'acc-2',
        fetchJar: async (account) => {
          tried.push(account.label);
          return { status: 'ok', tmpPath: await writeJar(), bytes: 5000, rotated: null };
        },
      },
      [finding()],
    );

    expect(tried).toEqual(['acc-1']);
  });

  it('learns which account owns a resource and skips the others next sweep', async () => {
    // The point of the cache: the first sweep discovers, later sweeps go direct.
    const seenCookies: string[] = [];
    const { impl } = stubFetch((url, init) => {
      const cookie = ((init?.headers ?? {}) as Record<string, string>).cookie ?? '';
      if (url.includes('/account/')) return { body: LOGGED_IN_HTML, headers: { 'content-type': 'text/html' } };
      seenCookies.push(cookie);
      if (cookie.includes('owner')) return jarReply();
      return { status: 403, body: '<html>no</html>' };
    });

    const accounts = [acct('no-1', 'nobody1'), acct('no-2', 'nobody2'), acct('buyer', 'owner')];

    await autoDownloadVersions(deps(impl, accounts), [finding('u-1', '1.0')]);
    const firstSweep = seenCookies.length;
    expect(firstSweep).toBe(3); // walked all three to find the owner

    seenCookies.length = 0;
    await autoDownloadVersions(deps(impl, accounts), [finding('u-2', '2.0')]);
    // Straight to the owner: one request instead of three.
    expect(seenCookies).toHaveLength(1);
    expect(seenCookies[0]).toContain('owner');
  });

  it('records a refusal only when the account was authenticated', async () => {
    // A challenge says nothing about ownership; caching it would permanently
    // deprioritise an account that may well own the plugin.
    const { impl } = stubFetch(() => ({
      status: 429,
      body: CHALLENGE_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    await autoDownloadVersions(deps(impl, [acct('a')]), [finding()]);
    expect(listOwnership(db)).toEqual([]);
  });

  it('forgets ownership for an account no longer in the file', async () => {
    recordOwnership(db, 12345, 'da-xoa', 'owned');
    const { impl } = stubFetch(() => jarReply());
    await autoDownloadVersions(deps(impl, [acct('con-lai')]), [finding()]);
    expect(listOwnership(db).map((r) => r.accountLabel)).not.toContain('da-xoa');
  });

  it('leaves no temp file behind after archiving', async () => {
    const { readdir } = await import('node:fs/promises');
    const { impl } = stubFetch(() => jarReply());
    await autoDownloadVersions(deps(impl), [finding()]);
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
  });
});

describe('outcome formatting', () => {
  const out = (status: AutoDownloadOutcome['status'], detail = ''): AutoDownloadOutcome => ({
    pluginName: 'Mythic',
    versionName: '5.6.2',
    status,
    detail,
  });

  it('maps every status to owner-visible text', () => {
    // A fallthrough would make the interesting cases arrive as silence, which
    // reads as "everything is fine".
    const statuses: AutoDownloadOutcome['status'][] = [
      'archived',
      'duplicate',
      'parked',
      'not_owned',
      'cookie_dead',
      'challenged',
      'retrying',
      'failed',
    ];
    for (const status of statuses) {
      const line = formatDownloadOutcome(out(status, 'chi tiết'));
      expect(line, status).toContain('Mythic');
      expect(line, status).not.toContain('undefined');
      expect(line.length, status).toBeGreaterThan(10);
    }
  });

  it('names the account that succeeded', () => {
    expect(formatDownloadOutcome({ ...out('archived'), accountLabel: 'acc-chinh' })).toContain('acc-chinh');
  });

  it('tells the owner what to do about a dead cookie', () => {
    const line = formatDownloadOutcome(out('cookie_dead', 'tài khoản a'));
    expect(line).toContain('Stay logged in');
  });

  it('explains an off toggle rather than staying silent', () => {
    expect(formatAbortReason({ outcomes: [], aborted: true, abortReason: 'disabled' })).toContain('tắt');
  });

  it('says nothing extra when the sweep completed', () => {
    expect(formatAbortReason({ outcomes: [], aborted: false })).toBeNull();
  });

  it('does not repeat a reason already covered by its own outcome line', () => {
    expect(formatAbortReason({ outcomes: [], aborted: true, abortReason: 'cookie_dead' })).toBeNull();
  });
});

describe('spigot credential store', () => {
  let credDir: string;

  beforeEach(async () => {
    credDir = await mkdtemp(join(tmpdir(), 'spigot-cred-'));
  });
  afterEach(async () => {
    await rm(credDir, { recursive: true, force: true });
  });

  const writeCreds = async (content: string) => {
    const path = join(credDir, 'creds.json');
    await writeFile(path, content, 'utf8');
    return path;
  };

  it('treats a missing file as the feature being off', () => {
    expect(loadSpigotCredentials(join(credDir, 'nope.json'))).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('reads the plain three-column form the owner types by hand', async () => {
    const load = loadSpigotCredentials(await writeCreds('acc-chinh  user1  pass1\nacc-2  user2  pass2\n'));
    expect(load.ok && load.credentials).toEqual([
      { label: 'acc-chinh', username: 'user1', password: 'pass1' },
      { label: 'acc-2', username: 'user2', password: 'pass2' },
    ]);
  });

  it('defaults the label to the username in the two-column form', async () => {
    const load = loadSpigotCredentials(await writeCreds('user1  pass1\n'));
    expect(load.ok && load.credentials[0]).toEqual({ label: 'user1', username: 'user1', password: 'pass1' });
  });

  it('reads the JSON form', async () => {
    const load = loadSpigotCredentials(await writeCreds('[{"label":"a","username":"u","password":"p"}]'));
    expect(load.ok && load.credentials[0]).toEqual({ label: 'a', username: 'u', password: 'p' });
  });

  it('skips comments and blank lines', async () => {
    const load = loadSpigotCredentials(await writeCreds('# ghi chu\n\nacc  user  pass\n'));
    expect(load.ok && load.credentials).toHaveLength(1);
  });

  it('tolerates a UTF-8 BOM, which hand-editing on Windows produces', async () => {
    expect(loadSpigotCredentials(await writeCreds('\ufeffacc  user  pass\n')).ok).toBe(true);
  });

  it('says so plainly when a password contains spaces instead of truncating it', async () => {
    // Silently keeping only the first word would produce a wrong password and an
    // unexplainable login failure.
    const load = loadSpigotCredentials(await writeCreds('acc  user  mat khau co dau cach\n'));
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
    expect(load.ok === false && load.detail).toContain('JSON');
  });

  it('rejects a line with only one column', async () => {
    expect(loadSpigotCredentials(await writeCreds('chi-mot-cot\n'))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects duplicate labels, since the label identifies the account', async () => {
    const load = loadSpigotCredentials(await writeCreds('acc  u1  p1\nacc  u2  p2\n'));
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects a JSON entry missing its password', async () => {
    const load = loadSpigotCredentials(await writeCreds('[{"label":"a","username":"u"}]'));
    expect(load).toMatchObject({ ok: false, reason: 'malformed' });
    expect(load.ok === false && load.detail).toContain('password');
  });

  it('fails loudly on malformed JSON rather than reporting zero accounts', async () => {
    expect(loadSpigotCredentials(await writeCreds('[{ not json'))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports an empty file as malformed, not as zero accounts', async () => {
    expect(loadSpigotCredentials(await writeCreds('   \n'))).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('spigot dashboard credential import', () => {
  it('seeds decorated purchase titles idempotently', () => {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    migrate(seedDb);
    const credentials = [{
      label: 'account-a',
      username: 'account-a',
      password: 'password',
      enabled: true,
      importedStatus: 'success',
      purchasedResources: [
        '[Official] mcMMO - Original Author Returns!',
        '⭐ [50% OFF SALE] ⭐ ImmortalTags ⭐ The Ultimate Chat Tags Plugin',
      ],
    }];

    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(2);
    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(0);
    expect(listPlugins(seedDb, 10, 0).map((plugin) => plugin.displayName).sort()).toEqual([
      'ImmortalTags',
      'mcMMO - Original Author Returns',
    ]);
    seedDb.close();
  });

  it('keeps pre-existing duplicate rows because import is append-only', () => {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    migrate(seedDb);
    createPlugin(seedDb, {
      slug: 'mcmmo-original-author-returns',
      displayName: 'mcMMO - Original Author Returns',
      descriptorName: 'mcMMO - Original Author Returns',
      platform: 'spigot',
    });
    createPlugin(seedDb, {
      slug: 'mcmmo-original-author-returns-2',
      displayName: 'mcMMO - Original Author Returns',
      descriptorName: 'mcMMO - Original Author Returns',
      platform: 'spigot',
    });

    const credentials = [{
      label: 'account-a',
      username: 'account-a',
      password: 'password',
      enabled: true,
      importedStatus: 'success',
      purchasedResources: ['[Official] mcMMO - Original Author Returns!'],
    }];

    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(0);
    expect(listPlugins(seedDb, 10, 0).map((plugin) => plugin.slug).sort()).toEqual([
      'mcmmo-original-author-returns',
      'mcmmo-original-author-returns-2',
    ]);
    seedDb.close();
  });

  it('never deletes a legitimate language-named plugin while seeding', () => {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    migrate(seedDb);
    createPlugin(seedDb, { slug: 'de', displayName: 'DE', descriptorName: 'DE', platform: 'spigot' });

    const credentials = [{
      label: 'account-a',
      username: 'account-a',
      password: 'password',
      enabled: true,
      importedStatus: 'success',
      purchasedResources: ['MyLobbySystem'],
    }];

    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(1);
    expect(listPlugins(seedDb, 10, 0).map((plugin) => plugin.displayName).sort()).toEqual(['DE', 'MyLobbySystem']);
    seedDb.close();
  });

  it('records imported ownership once a matched plugin has a resource id', () => {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    migrate(seedDb);
    const plugin = createPlugin(seedDb, {
      slug: 'player-vaults-x',
      displayName: 'PlayerVaultsX',
      descriptorName: 'PlayerVaultsX',
      platform: 'spigot',
    });
    updatePlugin(seedDb, plugin.id, { resourceId: 28201 });

    const credentials = [{
      label: 'account-a',
      username: 'account-a',
      password: 'password',
      enabled: true,
      importedStatus: 'success',
      purchasedResources: ['PlayerVaultsX'],
    }];

    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(0);
    expect(findOwner(seedDb, 28201)).toBe('account-a');
    seedDb.close();
  });

  it('keeps duplicate imported titles from creating two plugins in one pass', () => {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    migrate(seedDb);
    const credentials = [
      {
        label: 'account-a', username: 'account-a', password: 'password', enabled: true,
        importedStatus: 'success', purchasedResources: ['PlayerVaultsX'],
      },
      {
        label: 'account-b', username: 'account-b', password: 'password', enabled: true,
        importedStatus: 'success', purchasedResources: ['PlayerVaultsX'],
      },
    ];

    expect(seedImportedPurchasedResources(seedDb, credentials)).toBe(1);
    expect(listPlugins(seedDb, 10, 0).map((plugin) => plugin.displayName)).toEqual(['PlayerVaultsX']);
    seedDb.close();
  });

  it('parses the report format, including passwords with spaces', () => {
    const parsed = parseSpigotCredentialText(`
👤 User: account-a
🔑 Password: password with spaces
📦 Plugins found: 1
✅ Status: success
🛒 Purchased resources:
Vault+
--------------------------------------------------`);

    expect(parsed.ok && parsed.credentials[0]).toMatchObject({
      username: 'account-a',
      password: 'password with spaces',
      purchasedResources: ['Vault+'],
      enabled: true,
    });
  });

  it('splits a language-prefixed pipe list when it matches Plugins found', () => {
    const parsed = parseSpigotCredentialText(`
User: account-a
Password: password
Plugins found: 3
Status: success
Purchased resources:
DE | MyLobbySystem | Extras | inkl. Nick, Chat, Tokens
-----`);

    expect(parsed.ok && parsed.credentials[0]?.purchasedResources).toEqual([
      'MyLobbySystem',
      'Extras',
      'inkl. Nick, Chat, Tokens',
    ]);
  });

  it('keeps pipes inside a single plugin title', () => {
    const parsed = parseSpigotCredentialText(`
User: account-a
Password: password
Plugins found: 1
Status: success
Purchased resources:
Advanced Market | Player Market Place - GUI - Local Database
-----`);

    expect(parsed.ok && parsed.credentials[0]?.purchasedResources).toEqual([
      'Advanced Market | Player Market Place - GUI - Local Database',
    ]);
  });

  it('skips an earlier strict subset while preserving the later superset', () => {
    const parsed = parseSpigotCredentialText(`
User: A
Password: a
Plugins found: 1
Status: success
Purchased resources:
Vault+
-----
User: B
Password: b
Plugins found: 2
Status: success
Purchased resources:
Vault+
Enchant
-----`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.credentials.map((account) => account.enabled)).toEqual([false, true]);
  });

  it('keeps overlapping accounts when each contributes a unique resource', () => {
    const parsed = parseSpigotCredentialText(`
User: A
Password: a
Plugins found: 2
Status: success
Purchased resources:
Vault+
Economy
-----
User: B
Password: b
Plugins found: 2
Status: success
Purchased resources:
Vault+
Enchant
-----`);

    expect(parsed.ok && parsed.credentials.map((account) => account.enabled)).toEqual([true, true]);
  });

  it('never filters an account whose inventory is not confirmed successful', () => {
    const parsed = parseSpigotCredentialText(`
User: A
Password: a
Plugins found: 1
Status: failed
Purchased resources:
Vault+
-----
User: B
Password: b
Plugins found: 1
Status: success
Purchased resources:
Vault+
-----`);

    expect(parsed.ok && parsed.credentials.map((account) => account.enabled)).toEqual([true, true]);
  });

  it('rejects a resource count mismatch instead of trusting an incomplete list', () => {
    const parsed = parseSpigotCredentialText(`
User: A
Password: a
Plugins found: 2
Status: success
Purchased resources:
Vault+
-----`);
    expect(parsed).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('does not expose source text from a malformed JSON error', () => {
    const secret = 'private-password-token';
    const parsed = parseSpigotCredentialText(`[{"username":"a","password":"${secret}"},]`);

    expect(parsed).toEqual({ ok: false, reason: 'malformed', detail: 'JSON không hợp lệ' });
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  it('treats JSON as JSON even when a password contains User:', () => {
    const parsed = parseSpigotCredentialText('[{"username":"a","password":"contains User: text"}]');

    expect(parsed.ok && parsed.credentials[0]?.password).toBe('contains User: text');
  });

  it('recomputes JSON account filtering instead of trusting enabled flags', () => {
    const parsed = parseSpigotCredentialText(JSON.stringify([
      { username: 'A', password: 'a', importedStatus: 'success', purchasedResources: ['Vault+'], enabled: true },
      { username: 'B', password: 'b', importedStatus: 'success', purchasedResources: ['Vault+', 'Enchant'], enabled: false },
    ]));

    expect(parsed.ok && parsed.credentials.map((account) => account.enabled)).toEqual([false, true]);
  });

  it('upgrades a language-prefixed resource stored by an older JSON import', () => {
    const parsed = parseSpigotCredentialText(JSON.stringify([{
      username: 'a', password: 'b', importedStatus: 'success',
      purchasedResources: ['DE | MyLobbySystem | Extras | inkl. Nick, Chat, Tokens'],
    }]));

    expect(parsed.ok && parsed.credentials[0]?.purchasedResources).toEqual([
      'MyLobbySystem', 'Extras', 'inkl. Nick, Chat, Tokens',
    ]);
  });
});

describe('resource ownership cache', () => {
  let odb: Database.Database;

  beforeEach(() => {
    odb = new Database(':memory:');
    odb.pragma('foreign_keys = ON');
    migrate(odb);
  });
  afterEach(() => odb.close());

  const accounts = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];

  it('remembers the account that owns a resource', () => {
    recordOwnership(odb, 12345, 'b', 'owned');
    expect(findOwner(odb, 12345)).toBe('b');
  });

  it('reports no owner before anything has been learned', () => {
    expect(findOwner(odb, 12345)).toBeNull();
  });

  it('puts the known owner first so the common case costs one request', () => {
    recordOwnership(odb, 12345, 'c', 'owned');
    expect(orderAccountsFor(odb, 12345, accounts).map((a) => a.label)).toEqual(['c', 'a', 'b']);
  });

  it('orders known non-owners last but does not drop them', () => {
    // Dropping them would make a later purchase invisible forever.
    recordOwnership(odb, 12345, 'a', 'not_owned');
    expect(orderAccountsFor(odb, 12345, accounts).map((a) => a.label)).toEqual(['b', 'c', 'a']);
  });

  it('combines both: owner first, unknown next, non-owner last', () => {
    recordOwnership(odb, 12345, 'c', 'owned');
    recordOwnership(odb, 12345, 'a', 'not_owned');
    expect(orderAccountsFor(odb, 12345, accounts).map((a) => a.label)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the owner-listed order among accounts of equal rank', () => {
    expect(orderAccountsFor(odb, 999, accounts).map((a) => a.label)).toEqual(['a', 'b', 'c']);
  });

  it('does not prefer a live session unless it is a confirmed owner', () => {
    recordOwnership(odb, 12345, 'c', 'owned');
    expect(orderAccountsFor(odb, 12345, accounts, 'a').map((a) => a.label)).toEqual(['c', 'a', 'b']);
  });

  it('keeps each resource separate', () => {
    recordOwnership(odb, 111, 'a', 'owned');
    recordOwnership(odb, 222, 'b', 'owned');
    expect(findOwner(odb, 111)).toBe('a');
    expect(findOwner(odb, 222)).toBe('b');
  });

  it('lets a later purchase overturn a recorded refusal', () => {
    expect(recordOwnership(odb, 12345, 'a', 'not_owned')).toBe(true);
    expect(recordOwnership(odb, 12345, 'a', 'owned')).toBe(true);
    expect(findOwner(odb, 12345)).toBe('a');
    expect(findNonOwners(odb, 12345).has('a')).toBe(false);
  });

  it('writes one row per resource and account, not one per attempt', () => {
    expect(recordOwnership(odb, 12345, 'a', 'owned')).toBe(true);
    for (let i = 0; i < 4; i++) expect(recordOwnership(odb, 12345, 'a', 'owned')).toBe(false);
    expect(listOwnership(odb)).toHaveLength(1);
  });

  it('forgets an account whose label left the credentials file', () => {
    recordOwnership(odb, 111, 'gone', 'owned');
    recordOwnership(odb, 222, 'gone', 'not_owned');
    recordOwnership(odb, 111, 'kept', 'not_owned');
    expect(forgetAccount(odb, 'gone')).toBe(2);
    expect(listOwnership(odb).map((r) => r.accountLabel)).toEqual(['kept']);
  });

  it('rejects a state outside the two permitted values', () => {
    expect(() =>
      odb
        .prepare("INSERT INTO resource_ownership (resource_id, account_label, state, checked_at) VALUES (1,'a','maybe',1)")
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('purchased resource discovery', () => {
  describe('resourceIdFromHref', () => {
    it('reads the id from the relative href Spigot actually uses', () => {
      // Spigot's purchased page links WITHOUT a leading slash. An earlier pattern
      // required "/resources/" and so reported zero plugins on a page that had one.
      expect(resourceIdFromHref('resources/vulcan-anti-cheat-1-8-26-2-folia.83626/')).toEqual({
        resourceId: 83626,
        slug: 'vulcan-anti-cheat-1-8-26-2-folia',
      });
    });

    it('reads the id from absolute, slugless, and suffixed forms', () => {
      expect(resourceIdFromHref('https://www.spigotmc.org/resources/vulcan.83626/')?.resourceId).toBe(83626);
      expect(resourceIdFromHref('/resources/83626/')?.resourceId).toBe(83626);
      expect(resourceIdFromHref('resources/vulcan.83626/updates')?.resourceId).toBe(83626);
      expect(resourceIdFromHref('resources/vulcan.83626/download?version=645021')?.resourceId).toBe(83626);
      expect(resourceIdFromHref('resources/vulcan.83626')?.resourceId).toBe(83626);
    });

    it('rejects hrefs that would yield a plausible-looking fake id', () => {
      // Each of these carries a number in the same shape; treating any of them as
      // a resource id would make the bot track something that is not a plugin.
      expect(resourceIdFromHref('/resources/categories/premium.4/')).toBeNull();
      expect(resourceIdFromHref('/resources/authors/someone.12345/')).toBeNull();
      expect(resourceIdFromHref('members/frap.163521/')).toBeNull();
      expect(resourceIdFromHref('resources/purchased')).toBeNull();
      expect(resourceIdFromHref('https://www.spigotmc.org/resources/')).toBeNull();
    });
  });

  describe('normalizeName', () => {
    it('strips the marketing tail Spigot titles carry', () => {
      // Vault name comes from the jar descriptor ("Vulcan"); Spigot's title is
      // decorated. Comparing verbatim would never match.
      expect(normalizeName('Vulcan Anti-Cheat | Advanced Cheat Detection | 1.8-26.2 | Folia Supported!')).toBe(
        'vulcananticheat',
      );
    });

    it('ignores case, spaces, and punctuation differences', () => {
      expect(normalizeName('Anti-Cheat')).toBe(normalizeName('anti cheat'));
      expect(normalizeName('AntiCheat')).toBe(normalizeName('Anti Cheat'));
    });
  });

  describe('displayFrom', () => {
    it('drops a leading version-range prefix, which otherwise sorts before letters', () => {
      // Real title from the owner's vault. Left alone it sorts under "[" so it
      // lands after Z in the menu, and Discord truncates the row before the name.
      expect(
        displayFrom('[1.8 - 26.2] ⭐ Advanced Crates ⭕ 17 Premium Animations ✅ Custom Item Support ✅ I'),
      ).toBe('Advanced Crates');
    });

    it('cuts AT the first emoji, since authors use it to separate name from pitch', () => {
      // Merely deleting emoji leaves "KnockbackMaster PROFESSIONAL CUSTOM
      // KNOCKBACK and HITS for PvP" — correct words, still not a name.
      expect(displayFrom('KnockbackMaster ⭐ PROFESSIONAL CUSTOM KNOCKBACK and HITS for PvP')).toBe(
        'KnockbackMaster',
      );
    });

    it('cuts at a text separator when the title uses no emoji', () => {
      expect(displayFrom('Vulcan Anti-Cheat | Advanced Cheat Detection | 1.8-26.2 | Folia Supported!')).toBe(
        'Vulcan Anti-Cheat',
      );
    });

    it('handles an emoji in first position without returning empty', () => {
      // Cutting at the first emoji when it sits at index 0 yields "" — a plugin
      // with no name cannot be found again.
      expect(displayFrom('⭐ OnlyEmojiFirst ⭐ thing')).toBe('OnlyEmojiFirst');
      expect(displayFrom('⭐⭐⭐')).not.toBe('');
    });

    it('leaves an already-clean name alone', () => {
      expect(displayFrom('FactionsUUID')).toBe('FactionsUUID');
      expect(displayFrom('Ultra Permissions')).toBe('Ultra Permissions');
    });

    it('strips alternating bracket and emoji prefixes', () => {
      expect(displayFrom('【SALE】 EpicPlugin — best ever')).toBe('EpicPlugin');
    });

    it('drops an unbracketed leading version-range prefix followed by emoji/separator', () => {
      expect(
        displayFrom('1.17 - 26.2 ⭕ AdvancedJobs ⭐ 20+ Default Jobs & Create Your Own Jobs Plugin⚡GUI Editor ✅'),
      ).toBe('AdvancedJobs');
    });

    it('cleans leading emojis with variation selectors', () => {
      expect(displayFrom('⚔️ HackedServer')).toBe('HackedServer');
      expect(displayFrom('🛡️ Plugin Hide Pro')).toBe('Plugin Hide Pro');
    });
  });

  describe('syncPurchasedResources', () => {
    let sdb: Database.Database;

    beforeEach(() => {
      sdb = new Database(':memory:');
      sdb.pragma('foreign_keys = ON');
      migrate(sdb);
    });
    afterEach(() => sdb.close());

    let slugCounter = 0;
    const addPlugin = (displayName: string, descriptorName = displayName) =>
      createPlugin(sdb, {
        // Counter-suffixed: two display names can legitimately slugify the same
        // ("Anti-Cheat" and "Anti Cheat"), and the fixture must not fail on a
        // UNIQUE violation before the code under test runs.
        slug: `p${++slugCounter}-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        displayName,
        descriptorName,
        platform: 'spigot',
      });

    it('links a purchased resource to the plugin already in the vault', () => {
      const plugin = addPlugin('Vulcan');
      const out = syncPurchasedResources(sdb, [
        { resourceId: 83626, title: 'Vulcan | Advanced Cheat Detection | 1.8-26.2', slug: 'vulcan' },
      ]);

      expect(out.linked).toEqual([{ pluginName: 'Vulcan', resourceId: 83626 }]);
      expect(listPlugins(sdb, 10, 0).find((p) => p.id === plugin.id)?.resourceId).toBe(83626);
    });

    it('matches on descriptor name when the display name differs', () => {
      addPlugin('Vulcan AC', 'Vulcan');
      const out = syncPurchasedResources(sdb, [{ resourceId: 83626, title: 'Vulcan', slug: 'vulcan' }]);
      expect(out.linked).toHaveLength(1);
    });

    it('never overwrites an id the owner already set', () => {
      // A wrong overwrite would silently track the wrong upstream plugin.
      const plugin = addPlugin('Vulcan');
      updatePlugin(sdb, plugin.id, { resourceId: 99999 });
      const out = syncPurchasedResources(sdb, [{ resourceId: 83626, title: 'Vulcan', slug: 'vulcan' }]);

      expect(out.linked).toEqual([]);
      expect(listPlugins(sdb, 10, 0)[0]!.resourceId).toBe(99999);
    });

    it('counts an id already present as alreadyLinked rather than relinking it', () => {
      const plugin = addPlugin('Vulcan');
      updatePlugin(sdb, plugin.id, { resourceId: 83626 });
      const out = syncPurchasedResources(sdb, [{ resourceId: 83626, title: 'Vulcan', slug: 'vulcan' }]);
      expect(out.alreadyLinked).toBe(1);
      expect(out.linked).toEqual([]);
    });

    it('refuses to guess when two plugins share a normalized name', () => {
      // Guessing here would attach the id to whichever row came back first.
      addPlugin('Anti-Cheat', 'AntiCheatOne');
      addPlugin('Anti Cheat', 'AntiCheatTwo');
      const out = syncPurchasedResources(sdb, [{ resourceId: 555, title: 'Anti-Cheat', slug: 'ac' }]);

      expect(out.linked).toEqual([]);
      expect(out.unmatched).toEqual([{ title: 'Anti-Cheat', resourceId: 555 }]);
    });

    it('reports an unmatched purchase instead of dropping it silently', () => {
      addPlugin('SomethingElse');
      const out = syncPurchasedResources(sdb, [{ resourceId: 777, title: 'Vulcan', slug: 'vulcan' }]);
      expect(out.unmatched).toEqual([{ title: 'Vulcan', resourceId: 777 }]);
    });

    it('creates a tracked plugin for a purchase with no jar yet when asked', () => {
      const out = syncPurchasedResources(
        sdb,
        [{ resourceId: 83626, title: 'Vulcan | Advanced Cheat Detection', slug: 'vulcan' }],
        { createMissing: true },
      );

      expect(out.created).toEqual([{ pluginName: 'Vulcan', resourceId: 83626 }]);
      const created = listPlugins(sdb, 10, 0)[0]!;
      expect(created.resourceId).toBe(83626);
      expect(created.displayName).toBe('Vulcan');
    });

    it('does not create anything unless createMissing is set', () => {
      const out = syncPurchasedResources(sdb, [{ resourceId: 83626, title: 'Vulcan', slug: 'vulcan' }]);
      expect(out.created).toEqual([]);
      expect(listPlugins(sdb, 10, 0)).toHaveLength(0);
    });

    it('keeps slugs unique when a created name collides', () => {
      addPlugin('Vulcan');
      const out = syncPurchasedResources(
        sdb,
        [{ resourceId: 83626, title: 'Vulcan Reborn', slug: 'x' }],
        { createMissing: true },
      );
      // Linked or created, but never a UNIQUE violation.
      expect(out.created.length + out.linked.length).toBe(1);
    });

    it('does not give two plugins the same resource id', () => {
      addPlugin('Vulcan');
      addPlugin('Vulcan Two', 'VulcanTwo');
      const out = syncPurchasedResources(sdb, [
        { resourceId: 83626, title: 'Vulcan', slug: 'v' },
        { resourceId: 83626, title: 'Vulcan Two', slug: 'v2' },
      ]);
      const used = listPlugins(sdb, 10, 0).filter((p) => p.resourceId === 83626);
      expect(used).toHaveLength(1);
      expect(out.alreadyLinked).toBe(1);
    });

    it('handles an empty purchased list without touching the vault', () => {
      addPlugin('Vulcan');
      const out = syncPurchasedResources(sdb, []);
      expect(out).toEqual({ linked: [], created: [], alreadyLinked: 0, unmatched: [] });
    });

    it('says nothing when there is nothing to report', () => {
      expect(formatSyncOutcome({ linked: [], created: [], alreadyLinked: 3, unmatched: [] })).toEqual([]);
    });
  });
});

describe('downloadViaBrowser', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'dl-browser-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * Trang giả tối thiểu. Ghi lại mọi URL được điều hướng tới, để khẳng định link
   * tải có mang theo tham số version.
   */
  const fakePage = (options: {
    downloadHref: string;
    /** Ghi tệp vào thư mục tải khi điều hướng tới link tải. */
    onDownload?: (dir: string) => void;
    pageMessage?: string;
  }): { page: BrowserPage; visited: string[]; downloadDir: () => string } => {
    const visited: string[] = [];
    let downloadDir = '';

    const page: BrowserPage = {
      goto: async (url: string) => {
        visited.push(url);
        if (url.includes('download') && options.onDownload && downloadDir) options.onDownload(downloadDir);
        return undefined;
      },
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('a[href*="download"]')) return options.downloadHref;
        if (src.includes('errorPanel')) return options.pageMessage ?? '';
        return '';
      },
      title: async () => 'Vulcan | SpigotMC',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    return { page, visited, downloadDir: () => downloadDir };
  };

  it('follows the version-bearing download link from the page', async () => {
    // Spigot serves HTML instead of a jar when ?version= is missing, which
    // surfaced as "tải về không phải jar" and an endless retry loop. The version
    // number is Spigot's internal id and cannot be derived from Spiget data, so
    // the link must come from the page.
    const { page, visited } = fakePage({
      downloadHref: 'resources/vulcan.83626/download?version=645021',
      onDownload: (dir) => writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '2.9.7.23')),
    });

    const outcome = await downloadViaBrowser({ tmpDir: tmp, maxBytes: 50_000_000 }, page, 83626);

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.includes('version=645021'))).toBe(true);
  });

  it('falls back to the plain download path when the page has no link', async () => {
    // Better to try than to skip: a layout change must not stop downloads dead.
    const { page, visited } = fakePage({
      downloadHref: '',
      onDownload: (dir) => writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '1.0')),
    });

    const outcome = await downloadViaBrowser({ tmpDir: tmp, maxBytes: 50_000_000 }, page, 83626);

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.endsWith('/resources/83626/download'))).toBe(true);
  });

  it('rejects an HTML error page saved under a jar name', async () => {
    // Without the magic-byte check this reaches the vault and only surfaces later
    // as a broken plugin on a live server.
    const { page } = fakePage({
      downloadHref: 'resources/vulcan.83626/download?version=1',
      onDownload: (dir) => writeFileSync(join(dir, 'Vulcan.jar'), Buffer.alloc(4096, 0x3c)),
    });

    const outcome = await downloadViaBrowser({ tmpDir: tmp, maxBytes: 50_000_000 }, page, 83626);

    expect(outcome.status).toBe('incomplete');
  });

  it('reports progress through the injected logger', async () => {
    // Downloads take minutes across several stages; silence makes a stalled sweep
    // look identical to a slow one.
    const lines: string[] = [];
    const { page } = fakePage({
      downloadHref: 'resources/vulcan.83626/download?version=645021',
      onDownload: (dir) => writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '2.9.7.23')),
    });

    await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000, log: (m) => void lines.push(m) },
      page,
      83626,
    );

    expect(lines.some((l) => l.includes('mở trang'))).toBe(true);
    expect(lines.some((l) => l.includes('link tải') && l.includes('version=645021'))).toBe(true);
    expect(lines.some((l) => l.includes('tải xong'))).toBe(true);
  });

  it('stays silent when no logger is given', async () => {
    const { page } = fakePage({
      downloadHref: 'resources/vulcan.83626/download?version=1',
      onDownload: (dir) => writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '1.0')),
    });
    await expect(
      downloadViaBrowser({ tmpDir: tmp, maxBytes: 50_000_000 }, page, 83626),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  /**
   * Page whose history table maps version names to their own download links, the
   * way Spigot's /history really does.
   */
  const historyPage = (
    rows: { name: string; versionId: string }[],
    onDownload?: (dir: string) => void,
  ): { page: BrowserPage; visited: string[] } => {
    const visited: string[] = [];
    let downloadDir = '';

    const page = {
      goto: async (url: string) => {
        visited.push(url);
        if (url.includes('download?version=') && onDownload && downloadDir) onDownload(downloadDir);
        return undefined;
      },
      evaluate: async (source: unknown) => {
        const src = String(source);
        // The real code now asks for the page HTML and parses it in Node, so the
        // stub serves markup shaped like Spigot's real version table rather than
        // emulating a DOM walk. That keeps the stub honest: the production parser
        // runs against it unchanged.
        if (src.includes('outerHTML')) {
          const body = rows
            .map(
              (r) =>
                `<tr class="dataRow"><td class="version">${r.name}</td>` +
                `<td class="releaseDate">x</td>` +
                `<td class="dataOptions download">` +
                `<a href="resources/vulcan.83626/download?version=${r.versionId}">Download</a></td></tr>`,
            )
            .join('\n');
          return `<html><body><table class="dataTable">${body}</table></body></html>`;
        }
        if (src.includes('a[href*="download"]')) return '';
        if (src.includes('errorPanel')) return '';
        return '';
      },
      title: async () => 'Vulcan | SpigotMC',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    return { page, visited };
  };

  it('fetches the requested version from the history page, not current latest', async () => {
    // The resource page only ever links current latest. Asking for an older
    // version and getting the newest jar meant every backfill download produced
    // the same file, archived once and then reported as a duplicate forever.
    const { page, visited } = historyPage(
      [
        { name: '2.9.7.23', versionId: '645021' },
        { name: '2.9.7.18', versionId: '600001' },
      ],
      (dir) => writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '2.9.7.18')),
    );

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000 },
      page,
      83626,
      '2.9.7.18',
    );

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.includes('version=600001'))).toBe(true);
    expect(visited.some((u) => u.includes('version=645021'))).toBe(false);
    // Two Cloudflare settle waits (resource page, then history) plus the download
    // poll exceed the 5s default.
  }, 15_000);

  it('reports a login wall as a dead cookie, not as a missing version', async () => {
    // Measured on the real site: an unauthenticated request for a PREMIUM
    // resource's history renders "You must be logged in to do that." as an
    // ordinary page — HTTP 200, no error status. Reading that as "version not
    // found" would defer the version and hide the fact that the session died.
    const page = {
      goto: async () => undefined,
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('outerHTML')) {
          return '<html><body><div class="errorPanel">You must be logged in to do that.</div></body></html>';
        }
        return '';
      },
      title: async () => 'Error | SpigotMC',
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000 },
      page,
      1035,
      '4.7.0',
    );

    expect(outcome.status).toBe('cookie_dead');
  }, 20_000);

  it('resolves an ungated history page without any browser navigation', async () => {
    // Cloudflare gates this site by PATH: /resources/<id>/history answers 200 to
    // plain curl while /login and /download do not. So a resource whose history is
    // public costs no browser navigation and no challenge wait — which is most of
    // the per-tick cost removed.
    const visited: string[] = [];
    let downloadDir = '';

    const html =
      '<html><table><tr><td class="version">1.0</td>' +
      '<td><a href="resources/p.7/download?version=900">D</a></td></tr></table></html>';
    const { impl, urls } = stubFetch(() => ({ body: html, headers: { 'content-type': 'text/html' } }));

    const page = {
      goto: async (url: string) => {
        visited.push(url);
        if (url.includes('download?version=') && downloadDir) {
          writeFileSync(join(downloadDir, 'P.jar'), pluginJar('P', '1.0'));
        }
        return undefined;
      },
      // Returning '' for every evaluate proves the version id did NOT come from
      // the page: if the browser were consulted, no id would be found.
      evaluate: async () => '',
      title: async () => 'P | SpigotMC',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000, fetchImpl: impl },
      page,
      7,
      '1.0',
    );

    expect(outcome.status).toBe('ok');
    expect(urls.some((u) => u.endsWith('/resources/7/history'))).toBe(true);
    // The history page was never opened in the browser; only the download was.
    expect(visited.some((u) => u.endsWith('/history'))).toBe(false);
    expect(visited.some((u) => u.includes('version=900'))).toBe(true);
  }, 20_000);

  it('falls back to the browser when the history page needs a session', async () => {
    // A premium resource answers an unauthenticated history request with an
    // ordinary page saying "you must be logged in". The plain-fetch attempt must
    // give way to the authenticated browser rather than reporting a missing version.
    const visited: string[] = [];
    let downloadDir = '';

    const { impl } = stubFetch(() => ({
      body: '<html><body>You must be logged in to do that.</body></html>',
      headers: { 'content-type': 'text/html' },
    }));

    const page = {
      goto: async (url: string) => {
        visited.push(url);
        if (url.includes('download?version=') && downloadDir) {
          writeFileSync(join(downloadDir, 'P.jar'), pluginJar('P', '2.0'));
        }
        return undefined;
      },
      evaluate: async (source: unknown) => {
        if (!String(source).includes('outerHTML')) return '';
        return (
          '<html><table><tr><td class="version">2.0</td>' +
          '<td><a href="resources/p.8/download?version=910">D</a></td></tr></table></html>'
        );
      },
      title: async () => 'P | SpigotMC',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000, fetchImpl: impl },
      page,
      8,
      '2.0',
    );

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.endsWith('/history'))).toBe(true);
    expect(visited.some((u) => u.includes('version=910'))).toBe(true);
  }, 20_000);

  it('falls back to /updates when /history carries no version table', async () => {
    // XenForo Resource Manager serves the version list at /history on some themes
    // and /updates on others. Trying only one silently fails on the other.
    const visited: string[] = [];
    let downloadDir = '';

    const page = {
      goto: async (url: string) => {
        visited.push(url);
        if (url.includes('download?version=') && downloadDir) {
          writeFileSync(join(downloadDir, 'P.jar'), pluginJar('P', '1.0'));
        }
        return undefined;
      },
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (!src.includes('outerHTML')) return '';
        const onUpdates = visited[visited.length - 1]?.includes('/updates') ?? false;
        return onUpdates
          ? '<html><table><tr><td class="version">1.0</td>' +
              '<td><a href="resources/p.1/download?version=555">D</a></td></tr></table></html>'
          : '<html><body>no table here</body></html>';
      },
      title: async () => 'P | SpigotMC',
      createCDPSession: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Browser.setDownloadBehavior' && params) downloadDir = String(params.downloadPath);
          return undefined;
        },
      }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000 },
      page,
      1,
      '1.0',
    );

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.endsWith('/history'))).toBe(true);
    expect(visited.some((u) => u.endsWith('/updates'))).toBe(true);
    expect(visited.some((u) => u.includes('version=555'))).toBe(true);
  }, 20_000);

  it('refuses to substitute another jar when the asked-for version is absent', async () => {
    // Downloading latest and storing it under an older version's name corrupts
    // the vault silently, which is far worse than reporting a miss.
    const { page } = historyPage([{ name: '2.9.7.23', versionId: '645021' }], (dir) =>
      writeFileSync(join(dir, 'Vulcan.jar'), pluginJar('Vulcan', '2.9.7.23')),
    );

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000 },
      page,
      83626,
      '2.9.7.99',
    );

    // Retryable, NOT terminal. /history is paginated and only the first page is in
    // the DOM, so a missing older release is a page-one miss rather than proof the
    // version was deleted. 'gone' would delete the queue row and lose it forever.
    expect(outcome.status).toBe('incomplete');
  }, 15_000);

  it('matches the version name exactly, so a prefix cannot win', async () => {
    // Substring matching made "1.0" select the row for "1.0.5". Because history is
    // newest-first, that quietly archived a NEWER jar under an older version's name.
    const { page, visited } = historyPage(
      [
        { name: '1.0.5', versionId: '700005' },
        { name: '1.0', versionId: '700000' },
      ],
      (dir) => writeFileSync(join(dir, 'P.jar'), pluginJar('P', '1.0')),
    );

    const outcome = await downloadViaBrowser(
      { tmpDir: tmp, maxBytes: 50_000_000 },
      page,
      83626,
      '1.0',
    );

    expect(outcome.status).toBe('ok');
    expect(visited.some((u) => u.includes('version=700000'))).toBe(true);
    expect(visited.some((u) => u.includes('version=700005'))).toBe(false);
  }, 15_000);
});

describe('account scan throttling', () => {
  let adb: Database.Database;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    adb = new Database(':memory:');
    adb.pragma('foreign_keys = ON');
    migrate(adb);
  });
  afterEach(() => adb.close());

  const accounts = Array.from({ length: 8 }, (_, i) => ({ label: `acc-${i + 1}` }));

  it('treats a never-scanned account as due, so the first run learns everything', () => {
    const due = selectAccountsDueForScan(adb, accounts, DAY_MS, 5);
    expect(due.map((a) => a.label)).toEqual(['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5']);
  });

  it('caps how many accounts one sweep scans', () => {
    // The whole point: scanning all of them costs ~45s each, which at 100 accounts
    // exceeds the sweep interval and starves the download step entirely.
    expect(selectAccountsDueForScan(adb, accounts, DAY_MS, 3)).toHaveLength(3);
  });

  it('skips an account scanned within the interval', () => {
    for (const account of accounts) recordScan(adb, account.label, 1);
    expect(selectAccountsDueForScan(adb, accounts, DAY_MS, 5)).toEqual([]);
  });

  it('retries a failed account within the hour instead of locking it out for a day', () => {
    // A failure has to be recorded, or the broken account is retried every sweep
    // and starves accounts never scanned at all. But recording it like a success
    // means one mistyped password parks the account for 24 hours — including
    // after the owner has already fixed it.
    const HOUR_MS = 60 * 60 * 1000;
    recordScan(adb, 'acc-2', 0, 'sai mật khẩu', { retryAfterMs: HOUR_MS, intervalMs: DAY_MS });

    // Not due immediately: an instant retry is the behaviour being avoided.
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-2' }], DAY_MS, 5)).toEqual([]);

    adb.prepare('UPDATE account_scan_state SET last_scan_at = last_scan_at - ? WHERE account_label = ?')
      .run(Math.floor((HOUR_MS + 60_000) / 1000), 'acc-2');
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-2' }], DAY_MS, 5).map((a) => a.label)).toEqual(['acc-2']);
  });

  it('does not shorten the interval for a successful scan', () => {
    // The short retry is for failures only; a good scan must still wait a full day.
    recordScan(adb, 'acc-1', 12, '', { retryAfterMs: 60 * 60 * 1000, intervalMs: DAY_MS });
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-1' }], DAY_MS, 5)).toEqual([]);
  });

  it('forgets a scan mark so the owner can force a re-read after fixing a password', () => {
    recordScan(adb, 'acc-2', 0, 'sai mật khẩu');
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-2' }], DAY_MS, 5)).toEqual([]);

    forgetScanState(adb, 'acc-2');
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-2' }], DAY_MS, 5).map((a) => a.label)).toEqual(['acc-2']);
  });

  it('scans again once the interval has passed', () => {
    recordScan(adb, 'acc-1', 1);
    // Backdate beyond the interval, as the clock would.
    adb.prepare('UPDATE account_scan_state SET last_scan_at = last_scan_at - ? WHERE account_label = ?')
      .run(Math.floor((DAY_MS + 60_000) / 1000), 'acc-1');

    expect(selectAccountsDueForScan(adb, [{ label: 'acc-1' }], DAY_MS, 5).map((a) => a.label)).toEqual(['acc-1']);
  });

  it('rotates through accounts oldest-first rather than always the same few', () => {
    // Without ordering, the first N in the file would monopolise every sweep and
    // later accounts would never be scanned at all.
    recordScan(adb, 'acc-1', 1);
    recordScan(adb, 'acc-2', 1);
    const ages: Record<string, number> = { 'acc-1': 3 * 24 * 3600, 'acc-2': 5 * 24 * 3600 };
    for (const [label, age] of Object.entries(ages)) {
      adb.prepare('UPDATE account_scan_state SET last_scan_at = last_scan_at - ? WHERE account_label = ?')
        .run(age, label);
    }

    const due = selectAccountsDueForScan(adb, [{ label: 'acc-1' }, { label: 'acc-2' }], DAY_MS, 2);
    // acc-2 is staler, so it goes first.
    expect(due.map((a) => a.label)).toEqual(['acc-2', 'acc-1']);
  });

  it('puts never-scanned accounts ahead of stale ones', () => {
    recordScan(adb, 'acc-1', 1);
    adb.prepare('UPDATE account_scan_state SET last_scan_at = last_scan_at - ? WHERE account_label = ?')
      .run(10 * 24 * 3600, 'acc-1');

    const due = selectAccountsDueForScan(adb, [{ label: 'acc-1' }, { label: 'acc-new' }], DAY_MS, 2);
    expect(due[0]!.label).toBe('acc-new');
  });

  it('records a failed scan so a broken account does not retry every hour', () => {
    // Otherwise a permanently failing account consumes a slot each sweep and
    // starves accounts that have never been scanned.
    recordScan(adb, 'acc-1', 0, 'Cloudflare không cho qua');
    expect(findScanState(adb, 'acc-1')).toMatchObject({ resourceCount: 0, lastError: 'Cloudflare không cho qua' });
    expect(selectAccountsDueForScan(adb, [{ label: 'acc-1' }], DAY_MS, 5)).toEqual([]);
  });

  it('clears the error when a later scan succeeds', () => {
    recordScan(adb, 'acc-1', 0, 'lỗi tạm');
    recordScan(adb, 'acc-1', 4);
    expect(findScanState(adb, 'acc-1')).toMatchObject({ resourceCount: 4, lastError: '' });
  });

  it('keeps one row per account rather than one per scan', () => {
    for (let i = 0; i < 5; i++) recordScan(adb, 'acc-1', i);
    expect(listScanStates(adb)).toHaveLength(1);
  });

  it('forgets an account removed from the credentials file', () => {
    recordScan(adb, 'gone', 1);
    recordScan(adb, 'kept', 1);
    expect(forgetScanState(adb, 'gone')).toBe(1);
    expect(listScanStates(adb).map((s) => s.accountLabel)).toEqual(['kept']);
  });

  it('handles an empty account list', () => {
    expect(selectAccountsDueForScan(adb, [], DAY_MS, 5)).toEqual([]);
  });
});

describe('loginToSpigot failure reporting', () => {
  /**
   * Trang đăng nhập giả. `after` mô tả trạng thái trang SAU khi bấm gửi, vì đó
   * mới là lúc phân biệt được các nguyên nhân thất bại.
   */
  const loginPage = (after: {
    title?: string;
    message?: string;
    stillOnLoginPage?: boolean;
    needsTwoFactor?: boolean;
    filledUsername?: string;
    loggedIn?: boolean;
  }): BrowserPage => {
    let submitted = false;
    return {
      goto: async () => undefined,
      title: async () => after.title ?? 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        // Đánh dấu form: luôn tìm thấy, để test tập trung vào phần sau khi gửi.
        if (src.includes('data-vault-form') && src.includes('setAttribute')) {
          submitted = true;
          return true;
        }
        if (src.includes('accountUsername')) return submitted && (after.loggedIn ?? false);
        if (src.includes('needsTwoFactor')) {
          return JSON.stringify({
            title: after.title ?? 'Log in | SpigotMC',
            message: after.message ?? '',
            stillOnLoginPage: after.stillOnLoginPage ?? true,
            needsTwoFactor: after.needsTwoFactor ?? false,
            // Defaults to the credential's own username: the fields having
            // accepted the keystrokes is the normal case, and an empty box now
            // means something specific (they never landed).
            filledUsername: after.filledUsername ?? 'nguoi-dung',
          });
        }
        // Ô nhập đã nhận đúng chữ, nên không kích hoạt nhánh gõ lại.
        if (src.includes('passwordLength')) {
          return JSON.stringify({
            login: after.filledUsername ?? 'nguoi-dung',
            passwordLength: 8,
          });
        }
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;
  };

  const credential = { label: 'acc-2', username: 'nguoi-dung', password: 'mat-khau' };
  /** Bỏ mọi khoảng chờ: chúng cần cho site thật, nhưng làm test chạy 2 phút. */
  const FAST = { settleMs: 0, pollMs: 0, typeDelayMs: 0 };

  it('requests /login without a trailing slash, which is not challenged', async () => {
    // Measured repeatedly against the live site: /login/ returns 403 with
    // Cf-Mitigated: challenge, while /login returns 200 and the real form. The
    // slash was costing a Cloudflare wait on every login attempt and is the
    // likeliest reason a second login in the same browser failed.
    const visited: string[] = [];
    const page = {
      goto: async (url: string) => void visited.push(url),
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    await loginToSpigot(page, credential, FAST);

    expect(visited[0]).toBe('https://www.spigotmc.org/login');
    expect(visited[0]).not.toMatch(/\/login\/$/);
  });

  /** Trang chặn: tiêu đề đứng ở "Just a moment...", DOM có widget hay không tuỳ ca. */
  const challengedPage = (interactive: boolean): BrowserPage =>
    ({
      goto: async () => undefined,
      title: async () => 'Just a moment...',
      evaluate: async (source: unknown) =>
        String(source).includes('challenge-running') ? interactive : '',
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
    }) as unknown as BrowserPage;

  /** Đồng hồ giả tiến theo đúng số ms mà vòng chờ xin ngủ. */
  const fakeClock = (): { now: () => number; delay: (ms: number) => Promise<void>; elapsed: () => number } => {
    let value = 0;
    return {
      now: () => value,
      delay: async (ms: number) => void (value += ms),
      elapsed: () => value,
    };
  };

  it('bỏ sớm khi Turnstile đang đợi người click, và nói rõ là cần đổi IP', async () => {
    // Widget đã dựng mà chưa qua thì không bao giờ tự qua: đợi hết 90 giây chỉ làm
    // cả lượt quét đứng im, còn việc đáng làm là đổi IP rồi thử lại.
    const clock = fakeClock();
    const result = await loginToSpigot(challengedPage(true), credential, {
      settleMs: 0,
      pollMs: 2_500,
      typeDelayMs: 0,
      delay: clock.delay,
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: false, reason: 'challenged' });
    expect(result.ok === false && result.detail).toContain('đổi IP');
    // Bỏ ở mốc 60 giây, tức trước trần 90 giây — đó là điểm khác biệt cần chốt.
    expect(clock.elapsed()).toBeLessThan(90_000);
  });

  it('vẫn bỏ sớm khi widget nhấp nháy, vì Cloudflare dựng lại nó giữa các vòng kiểm', async () => {
    // Đo trên trang chặn thật: input[name=cf-turnstile-response] hiện rồi mất rồi
    // hiện lại. Đòi thấy widget đúng vòng kiểm cuối thì lần nào cũng có thể trượt.
    const clock = fakeClock();
    let polls = 0;
    const page = {
      goto: async () => undefined,
      title: async () => 'Just a moment...',
      evaluate: async (source: unknown) => {
        if (!String(source).includes('challenge-running')) return '';
        polls++;
        // Chỉ thấy widget ở vòng đầu, sau đó luôn "none".
        return polls === 1;
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined, press: async () => undefined },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, {
      settleMs: 0,
      pollMs: 2_500,
      typeDelayMs: 0,
      delay: clock.delay,
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: false, reason: 'challenged' });
    expect(result.ok === false && result.detail).toContain('đổi IP');
    // Bỏ ở mốc 60 giây, tức trước trần 90 giây — đó là điểm khác biệt cần chốt.
    expect(clock.elapsed()).toBeLessThan(90_000);
  });

  it('thử thách chạy ngầm thì vẫn chờ hết hạn, vì loại đó tự xong', async () => {
    const clock = fakeClock();
    const result = await loginToSpigot(challengedPage(false), credential, {
      settleMs: 0,
      pollMs: 2_500,
      typeDelayMs: 0,
      delay: clock.delay,
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: false, reason: 'challenged' });
    expect(result.ok === false && result.detail).not.toContain('đổi IP');
    expect(clock.elapsed()).toBeGreaterThanOrEqual(90_000);
  });

  it('prefers the form the page identifies, not the one that sits lowest', async () => {
    // The live page carries FIVE forms and THREE with input[name=login]: a
    // header copy, #pageLogin, and a hidden #login with style="display:none".
    // Geometry alone picked whichever sat lowest, which shifted with layout —
    // and a hidden form's inputs cannot be typed into at all, producing the
    // empty username box that was reported as a wrong password.
    const script: string[] = [];
    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) {
          script.push(src);
          return 1;
        }
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    await loginToSpigot(page, credential, FAST);

    const selector = script[0] ?? '';
    expect(selector).toContain('pageLogin');
    expect(selector).toContain('autofocus');
    // Candidacy is decided by the inputs being rendered, not the form's own
    // computed style: a display:none ANCESTOR leaves the form's style clean while
    // making its inputs untypeable. offsetWidth/getClientRects is the rendered
    // check that catches it.
    expect(selector).toContain('getClientRects');
  });

  it('reports two-factor separately instead of blaming the password', async () => {
    // 2FA cannot be solved by retrying or by fixing the password, so calling it a
    // credential failure sends the owner to re-check something that is correct.
    const result = await loginToSpigot(loginPage({ needsTwoFactor: true }), credential, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'two_factor' });
    expect(result.ok === false && result.detail).toContain('2FA');
  });

  it('reports the page error message when Spigot gives one', async () => {
    const result = await loginToSpigot(
      loginPage({ message: 'Tên tài khoản hoặc mật khẩu không đúng.' }),
      credential,
      FAST,
    );
    expect(result).toMatchObject({ ok: false, reason: 'bad_credentials' });
    expect(result.ok === false && result.detail).toContain('không đúng');
  });

  it('names the typed-into-wrong-field case rather than calling it bad credentials', async () => {
    // The username box holding something else means the keystrokes went to the
    // wrong form, which is a positioning bug, not a wrong password.
    const result = await loginToSpigot(loginPage({ filledUsername: 'nguoi-khac' }), credential, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'form_mismatch' });
  });

  it('never clicks a coordinate, since a form below the fold makes one miss', async () => {
    // Coordinates caused both real failures: a viewport-relative rect from a form
    // below the fold produced clicks that focused nothing, so keystrokes went to
    // the page body and an empty form was submitted — reported as a wrong
    // password. focus() through the element cannot miss, so the mouse is unused.
    const clicks: string[] = [];
    const typed: string[] = [];

    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) {
          return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        }
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: {
        click: async () => void clicks.push('click'),
        move: async () => void clicks.push('move'),
      },
      keyboard: { type: async (text: string) => void typed.push(text) },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toEqual({ ok: true });
    expect(clicks).toEqual([]);
    // Typed once each, through the real keyboard so the events stay genuine.
    expect(typed).toEqual(['nguoi-dung', 'mat-khau']);
  });

  it('recovers when the keyboard leaves the field empty on a reused page', async () => {
    // The real sweep failure: account 1 signs in, then every later account fails
    // with an empty username box. After a logout navigates the tab away and back,
    // document.hasFocus() is false, so element.focus() moves activeElement in the
    // DOM but page.keyboard.type routes to the browser widget and the keys land
    // nowhere. The direct fill through the native value setter does not depend on
    // OS focus, so it puts the text in and the account signs in as it should.
    let directlyFilled = false;
    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return 1;
        // The fallback path: assigning .value through the prototype setter and
        // dispatching a real input event. This is what the keyboard could not do.
        if (src.includes('HTMLInputElement') && src.includes('dispatchEvent')) {
          directlyFilled = true;
          return '';
        }
        // Empty until the direct fill runs — the keyboard alone never fills it.
        if (src.includes('passwordLength')) {
          return directlyFilled
            ? JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 })
            : JSON.stringify({ login: '', passwordLength: 0 });
        }
        if (src.includes('accountUsername')) return directlyFilled;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toEqual({ ok: true });
    expect(directlyFilled).toBe(true);
  });

  it('reports a fill failure as such rather than as a wrong password', async () => {
    // If the field still does not hold the value after a direct focus, the page is
    // not what the bot expects. Saying "wrong password" here sent the owner to
    // reset a password that was correct all along.
    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) return JSON.stringify({ login: '', passwordLength: 0 });
        if (src.includes('accountUsername')) return false;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toMatchObject({ ok: false, reason: 'form_mismatch' });
    expect(result.ok === false && result.detail).toContain('không phải sai mật khẩu');
  });

  it('reads the field of the form it filled, not the first one on the page', async () => {
    // The page carries two login forms. Looking up input[name=login] against the
    // whole document read the OTHER form's empty box, concluded the typing had
    // failed, and retyped the username over an already-correct password — turning
    // both working accounts into "Incorrect password".
    const typed: string[] = [];

    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) {
          // Scoped correctly → the filled value. An unscoped lookup would have
          // returned '' here, which is what triggered the destructive retype.
          return src.includes('data-vault-form')
            ? JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 })
            : JSON.stringify({ login: '', passwordLength: 0 });
        }
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async (text: string) => void typed.push(text) },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toEqual({ ok: true });
    // Typed exactly once each: no spurious retype on top of good input.
    expect(typed).toEqual(['nguoi-dung', 'mat-khau']);
  });

  it('waits for a slow submit instead of calling it a wrong password', async () => {
    // The real cause of the repeated false "Incorrect password": after clicking
    // submit the code slept a FIXED span and judged once. If the POST had not
    // landed yet, the logged-in marker was simply absent and every later branch
    // read that as bad credentials.
    let looks = 0;
    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        // Signed in only from the third look — the POST was still in flight before.
        if (src.includes('accountUsername')) return ++looks >= 3;
        if (src.includes('needsTwoFactor')) {
          return JSON.stringify({
            title: 'Log in | SpigotMC',
            message: '',
            stillOnLoginPage: true,
            needsTwoFactor: false,
            filledUsername: 'nguoi-dung',
          });
        }
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, { settleMs: 5_000, pollMs: 1, typeDelayMs: 0 });

    expect(result).toEqual({ ok: true });
  });

  it('allows a post-submit challenge to clear after the old 12-second limit', async () => {
    let clock = 0;
    let submitted = false;
    const page = {
      goto: async () => undefined,
      title: async () => submitted && clock < 15_000 ? 'Just a moment...' : 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return 1;
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        if (src.includes('b.click()')) { submitted = true; return ''; }
        if (src.includes('accountUsername')) return submitted && clock >= 15_000;
        if (src.includes('needsTwoFactor')) return JSON.stringify({ title: 'Log in | SpigotMC', message: '', stillOnLoginPage: true, needsTwoFactor: false, filledUsername: 'nguoi-dung' });
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async () => undefined },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, {
      pollMs: 2_500,
      typeDelayMs: 0,
      delay: async (ms) => { clock += ms; },
      now: () => clock,
    });

    expect(clock).toBeGreaterThan(12_000);
    expect(result).toEqual({ ok: true });
  });

  it('does not retype when the fields already hold the right values', async () => {
    // Typing twice into a working form would double every character.
    const typed: string[] = [];
    const page = {
      goto: async () => undefined,
      title: async () => 'Log in | SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return true;
        if (src.includes('passwordLength')) return JSON.stringify({ login: 'nguoi-dung', passwordLength: 8 });
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async (text: string) => void typed.push(text) },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toEqual({ ok: true });
    expect(typed).toEqual(['nguoi-dung', 'mat-khau']);
  });

  it('blames the empty field, not the password, when no keystroke landed', async () => {
    // Exactly what the second account hit: the box came back EMPTY and the page
    // offered no error, which the old code reported as bad credentials — sending
    // the owner to change a password that was correct all along. An empty box means
    // the click missed and the typing went to the page body.
    const result = await loginToSpigot(loginPage({ filledUsername: '' }), credential, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'form_mismatch' });
    expect(result.ok === false && result.detail).toContain('không phải sai mật khẩu');
  });

  it('still reports something useful when the page offers no message', async () => {
    // The old code returned a bare "đăng nhập không thành công", which collapsed
    // every cause into one unactionable line.
    const result = await loginToSpigot(loginPage({ title: 'SpigotMC' }), credential, FAST);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('SpigotMC');
    expect(result.ok === false && result.detail).not.toBe('đăng nhập không thành công');
  });

  it('succeeds when the page shows a signed-in marker', async () => {
    const result = await loginToSpigot(loginPage({ loggedIn: true }), credential, FAST);
    expect(result).toEqual({ ok: true });
  });

  it('reuses a kept profile without re-typing when the session is still live', async () => {
    // The point of one profile per account: a session kept from a previous sweep
    // means Spigot hides the login form, so there are zero usable forms. That is
    // success — the account is already in — and nothing should be typed. Retyping
    // the password here would be wasted work and is what Spigot rate-limits.
    const typed: string[] = [];
    const page = {
      goto: async () => undefined,
      title: async () => 'SpigotMC',
      evaluate: async (source: unknown) => {
        const src = String(source);
        // No usable login form: the session is live and the form is hidden.
        if (src.includes('data-vault-form') && src.includes('setAttribute')) return 0;
        if (src.includes('accountUsername')) return true;
        return '';
      },
      createCDPSession: async () => ({ send: async () => undefined }),
      mouse: { click: async () => undefined, move: async () => undefined },
      keyboard: { type: async (text: string) => void typed.push(text) },
    } as unknown as BrowserPage;

    const result = await loginToSpigot(page, credential, FAST);

    expect(result).toEqual({ ok: true });
    expect(typed).toEqual([]);
  });
});

describe('chrome resolution', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chrome-probe-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a configured path that exists', async () => {
    const fake = join(dir, 'chrome');
    await writeFile(fake, '');    expect(resolveChromePath(fake)).toBe(fake);
  });

  it('rejects a configured path that does not exist, rather than searching past it', async () => {
    // Silently falling back would launch a different browser than the operator
    // named, making a typo in CHROME_PATH impossible to notice.
    expect(resolveChromePath(join(dir, 'missing'))).toBeNull();
  });

  it('reports an actionable reason rather than a bare failure', async () => {
    // Whichever piece is missing — the package or the browser — the operator must
    // get a command they can run. chrome-launcher's own wording ("CHROME_PATH must
    // be set") reads as a config mistake when nothing is configured wrong.
    const probe = await probeBrowserLauncher(join(dir, 'missing'));
    expect(probe.available).toBe(false);
    expect(probe.available === false && probe.reason).toMatch(
      process.platform === 'linux' || process.platform === 'win32'
        ? /CHROME_PATH|apt-get|npm i|puppeteer/
        : /Linux host\/container hoặc Windows/,
    );
  });

  it('refuses to launch Spigot automation outside supported hosts (Linux / Windows)', async () => {
    const probe = await probeBrowserLauncher(undefined, undefined, 'darwin');
    expect(probe).toEqual({
      available: false,
      reason: 'tự động Spigot chỉ được phép chạy trong Linux host/container hoặc Windows; không hỗ trợ nền tảng này',
    });
  });

  it('force-kills Chrome when a broken CDP connection makes close hang', async () => {
    const kill = vi.fn(() => true);
    const browser = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
      process: vi.fn(() => ({ kill })),
    };

    await closeBrowser(browser, 5);

    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('finds a Chrome that puppeteer downloaded, which needs no root to install', async () => {
    // The sudo-free install route is the only one available on a VPS where the bot
    // user cannot escalate, so failing to look here would force a dead end.
    const build = join(dir, '.cache', 'puppeteer', 'chrome', 'linux-140.0.7300.0', 'chrome-linux64');
    await mkdir(build, { recursive: true });
    await writeFile(join(build, 'chrome'), '');

    expect(puppeteerCacheChrome(dir)).toBe(join(build, 'chrome'));
  });

  it('prefers the newest downloaded build', async () => {
    // Puppeteer keeps every version it has fetched; launching an old one against a
    // current challenge is exactly the failure this whole path exists to avoid.
    for (const version of ['linux-131.0.6778.0', 'linux-140.0.7300.0']) {
      const build = join(dir, '.cache', 'puppeteer', 'chrome', version, 'chrome-linux64');
      await mkdir(build, { recursive: true });
      await writeFile(join(build, 'chrome'), '');
    }

    expect(puppeteerCacheChrome(dir)).toContain('linux-140.0.7300.0');
  });

  it('returns null when nothing was ever downloaded', async () => {
    expect(puppeteerCacheChrome(dir)).toBeNull();
  });
});

describe('accountProfileDir', () => {
  const base = join('data', 'chrome-profile');

  it('gives each account its own directory under the shared base', () => {
    // Distinct directories are the whole point: they let the sweep sign a second
    // account in without logging the first out, which is what broke login.
    const a = accountProfileDir(base, 'acc-1');
    const b = accountProfileDir(base, 'acc-2');
    expect(a).not.toBe(b);
    expect(a.startsWith(base)).toBe(true);
  });

  it('sanitises a label with slashes or an email into a safe token', () => {
    // Labels come from an owner-edited file and can be an email or hold a slash;
    // an unsanitised value would create nested or invalid directories.
    const dir = accountProfileDir(base, 'a b/c@d.com');
    const leaf = dir.slice(base.length + 1);
    expect(leaf).not.toMatch(/[^a-zA-Z0-9._-]/);
  });

  it('keeps two labels that sanitise alike from sharing a profile', () => {
    // "a/b" and "a b" both sanitise to "a_b"; the hash suffix keeps their
    // sessions — and cf_clearance — from colliding.
    expect(accountProfileDir(base, 'a/b')).not.toBe(accountProfileDir(base, 'a b'));
  });

  it('is stable for the same label, so a profile is reused across sweeps', () => {
    // Reuse is what lets an account keep its cf_clearance and skip the challenge
    // on every sweep after the first.
    expect(accountProfileDir(base, 'acc-1')).toBe(accountProfileDir(base, 'acc-1'));
  });
});

describe('pruneOrphanProfiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'profile-prune-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the profile of an account no longer in the file', async () => {
    const gone = accountProfileDir(dir, 'acc-old');
    const kept = accountProfileDir(dir, 'acc-1');
    await mkdir(gone, { recursive: true });
    await mkdir(kept, { recursive: true });

    const removed = pruneOrphanProfiles(dir, ['acc-1']);

    expect(removed).toBe(1);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('leaves directories it did not create alone', async () => {
    // No trailing -<hash>, so not one of ours: a stray directory (or the shared
    // default profile's own files) must never be deleted.
    const foreign = join(dir, 'SomeOtherProfile');
    await mkdir(foreign, { recursive: true });

    const removed = pruneOrphanProfiles(dir, []);

    expect(removed).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  it('does nothing when the base has never been created', () => {
    expect(pruneOrphanProfiles(join(dir, 'nope'), ['acc-1'])).toBe(0);
  });
});

describe('fetchSpigotProxy', () => {
  /** A fetch stub returning the given body/status, recording nothing sensitive. */
  const stub = (status: number, body: unknown): typeof fetch =>
    (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;

  it('returns unset — not an error — when no API url is configured', async () => {
    const r = await fetchSpigotProxy(undefined, stub(200, {}));
    expect(r).toEqual({ ok: false, reason: 'unset' });
  });

  it('normalises data.proxyHttp into an http:// server for Chrome', async () => {
    const r = await fetchSpigotProxy('https://x', stub(200, { success: true, data: { proxyHttp: '1.2.3.4:8080' } }));
    expect(r).toEqual({ ok: true, proxy: { server: 'http://1.2.3.4:8080' } });
  });

  it('keeps an existing scheme instead of doubling it', async () => {
    const r = await fetchSpigotProxy('https://x', stub(200, { success: true, data: { proxyHttp: 'socks5://9.9.9.9:1080' } }));
    expect(r).toEqual({ ok: true, proxy: { server: 'socks5://9.9.9.9:1080' } });
  });

  it('rejects a response missing data.proxyHttp rather than using a broken proxy', async () => {
    const r = await fetchSpigotProxy('https://x', stub(200, { success: true, data: {} }));
    expect(r).toMatchObject({ ok: false, reason: 'bad_shape' });
  });

  it('reports a non-200 as a fetch failure', async () => {
    const r = await fetchSpigotProxy('https://x', stub(503, {}));
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
  });

  it('surfaces the provider message on success:false so an expired key is legible', async () => {
    // The provider answers 200 with { success:false, message } for an expired key
    // or exhausted quota. Passing that message straight through tells the owner to
    // renew rather than hiding it behind a generic "missing proxyHttp".
    const r = await fetchSpigotProxy('https://x', stub(200, { success: false, message: 'API key đã hết hạn sử dụng' }));
    expect(r).toMatchObject({ ok: false, reason: 'refused', detail: 'API key đã hết hạn sử dụng' });
  });

  it('reads the body of a 4xx refusal instead of reporting only the status code', async () => {
    // The real rotating endpoint answers 400 — not 200 — with the reason it will not
    // hand out a new IP yet. Judging by status alone turned "wait 49 seconds" into
    // "the API is unreachable", which sent every browser launch out on the host IP.
    const r = await fetchSpigotProxy(
      'https://x',
      stub(400, { success: false, message: 'Proxy của bạn chưa đến hạn có thể đổi. Vui lòng thử lại sau 49 giây' }),
    );
    expect(r).toMatchObject({ ok: false, reason: 'refused' });
    expect(r.ok === false ? r.detail : '').toContain('chưa đến hạn');
  });

  it('still reports a status code when a failing response carries no JSON', async () => {
    const notJson = (async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const r = await fetchSpigotProxy('https://x', notJson);
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed', detail: 'API proxy trả mã 502' });
  });

  it('reports a network throw as a fetch failure without leaking the URL', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED https://api.example/?api_key=SECRET');
    }) as unknown as typeof fetch;
    const r = await fetchSpigotProxy('https://x', failing);
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
    expect(r.ok === false ? r.detail : '').not.toContain('api_key');
  });
});

describe('spigot version links', () => {
  /**
   * The real version table from spigotmc.org/resources/essentialsx.9089/history,
   * trimmed to the table element. A hand-written fixture would only prove the
   * parser matches my guess at the markup.
   */
  const historyHtml = readFileSync(join(import.meta.dirname, 'fixtures/spigot-history-rows.html'), 'utf8');

  it('pairs every version name with the id from its own row', () => {
    const links = parseHistoryLinks(historyHtml);

    expect(links.length).toBeGreaterThan(30);
    // Cross-checked against the raw HTML: 2.21.1 really is 590890.
    expect(links).toEqual(
      expect.arrayContaining([
        { versionName: '2.22.0', versionId: '639442' },
        { versionName: '2.21.1', versionId: '590890' },
      ]),
    );
  });

  it('matches a version name exactly, so a prefix cannot win', () => {
    // Substring matching made a request for "1.0" select the row for "1.0.5", and
    // since history lists newest first the wrong, newer jar was archived under the
    // older name. A name that exists only as a prefix must find nothing.
    expect(findVersionId(historyHtml, '2.21.1')).toBe('590890');
    expect(findVersionId(historyHtml, 'v2.21.1')).toBe('590890');
    expect(findVersionId(historyHtml, '2.21')).toBeNull();
    expect(findVersionId(historyHtml, '2.2')).toBeNull();
  });

  it('returns null for a version the page does not carry', () => {
    // Null means "not on this page" — history paginates, so it is NOT evidence the
    // version was deleted. The caller must defer, never resolve terminal.
    expect(findVersionId(historyHtml, '99.99.99')).toBeNull();
  });

  it('parses the version param out of a relative Spiget file url', () => {
    expect(
      parseVersionParam('resources/vulcan-anti-cheat-advanced-cheat-detection.83626/download?version=645021'),
    ).toBe('645021');
    expect(parseVersionParam('resources/83626/')).toBeNull();
  });

  it('rejects Spiget synthetic version ids', () => {
    // Measured: for premium resources Spiget reports 999252070 where the real
    // Spigot id is 645021, and some premium versions report 0. Passing one through
    // asks Spigot for a version that does not exist, and Spigot may answer with
    // current latest — archiving the wrong jar under the asked-for name. 40/40
    // FREE resources match exactly, which is why a free-resource test cannot
    // catch this.
    expect(isSpigetSyntheticId(999_252_070)).toBe(true);
    expect(isSpigetSyntheticId(0)).toBe(true);
    expect(isSpigetSyntheticId(645_021)).toBe(false);
  });

  it('builds the bare-id download url, which survives an author rename', () => {
    expect(downloadUrlFor(83626, '645021')).toBe(
      'https://www.spigotmc.org/resources/83626/download?version=645021',
    );
  });
});

describe('account session health', () => {
  let healthDir: string;
  let healthFile: string;

  beforeEach(async () => {
    healthDir = await mkdtemp(join(tmpdir(), 'acct-health-'));
    healthFile = join(healthDir, 'accounts.json');
  });
  afterEach(async () => {
    await rm(healthDir, { recursive: true, force: true });
  });

  const healthy = (label: string, user = 'u-1%2Cabc') => ({
    ...acct(label, user),
    issuedAt: null,
    lastVerifiedAt: null,
    status: 'ok' as const,
  });

  it('loads a file written before the health fields existed', async () => {
    // An existing deployment's file must keep working, or upgrading the bot
    // silently disables auto-download.
    await writeFile(healthFile, JSON.stringify([{ label: 'acc-1', xfUser: 'u', xfSession: 's' }]), 'utf8');

    const load = loadSpigotAccounts(healthFile);
    expect(load.ok).toBe(true);
    expect(load.ok && load.accounts[0]).toMatchObject({
      label: 'acc-1',
      issuedAt: null,
      lastVerifiedAt: null,
      status: 'ok',
    });
  });

  it('round-trips the health fields', () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    saveSpigotAccounts(healthFile, [{ ...healthy('acc-1'), issuedAt: stamp, lastVerifiedAt: stamp, status: 'stale' }]);

    const load = loadSpigotAccounts(healthFile);
    expect(load.ok && load.accounts[0]).toMatchObject({
      issuedAt: stamp,
      lastVerifiedAt: stamp,
      status: 'stale',
    });
  });

  it('still redacts the cookie after the fields were added', () => {
    saveSpigotAccounts(healthFile, [healthy('acc-1', 'super-secret')]);
    const load = loadSpigotAccounts(healthFile);
    const account = load.ok ? load.accounts[0] : undefined;

    expect(JSON.stringify(account)).not.toContain('super-secret');
    expect(inspect(account)).not.toContain('super-secret');
    expect(`${account?.xfUser}`).not.toContain('super-secret');
  });

  it('marks one account without disturbing the others', () => {
    saveSpigotAccounts(healthFile, [healthy('acc-1'), healthy('acc-2')]);

    markAccountStatus(healthFile, 'acc-2', 'needs_login');

    const load = loadSpigotAccounts(healthFile);
    expect(load.ok && load.accounts.map((a) => [a.label, a.status])).toEqual([
      ['acc-1', 'ok'],
      ['acc-2', 'needs_login'],
    ]);
  });

  it('does nothing for an unknown label rather than throwing', () => {
    // Status writing is bookkeeping. Failing the caller over it would cost a
    // download that already succeeded.
    saveSpigotAccounts(healthFile, [healthy('acc-1')]);
    expect(() => markAccountStatus(healthFile, 'nope', 'locked')).not.toThrow();
    expect(loadSpigotAccounts(healthFile).ok).toBe(true);
  });

  it('treats an unknown cookie age as due for refresh', () => {
    // A cookie written by an older build carries no timestamp. Assuming it is
    // fresh would let it expire unnoticed 30 days after it was minted.
    expect(needsRefresh(healthy('a'))).toBe(true);
  });

  it('refreshes at 20 days, before XenForo revokes at 30', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z');
    const at = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    expect(needsRefresh({ ...healthy('a'), issuedAt: at(5) }, 20, now)).toBe(false);
    expect(needsRefresh({ ...healthy('a'), issuedAt: at(21) }, 20, now)).toBe(true);
  });

  it('refreshes any account not marked ok, however fresh its cookie', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z');
    const account = { ...healthy('a'), issuedAt: new Date(now).toISOString(), status: 'needs_login' as const };
    expect(needsRefresh(account, 20, now)).toBe(true);
  });
});

describe('persistent chrome profile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chrome-profile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes a lock left by a Chrome that did not exit cleanly', async () => {
    // Chrome hard-locks a profile to one process and the failure is SILENT: the
    // second launch simply never becomes reachable, with nothing on stdout or
    // stderr. A sweep killed mid-download would otherwise brick the profile for
    // every later run with no visible cause.
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await writeFile(join(dir, name), '');
    }
    await writeFile(join(dir, 'Cookies'), 'keep me');

    clearStaleProfileLocks(dir);

    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(dir, 'SingletonSocket'))).toBe(false);
    // The cookie database is the whole point of keeping the profile.
    expect(existsSync(join(dir, 'Cookies'))).toBe(true);
  });

  it('does nothing when the profile has never been created', () => {
    expect(() => clearStaleProfileLocks(join(dir, 'nope'))).not.toThrow();
  });
});
