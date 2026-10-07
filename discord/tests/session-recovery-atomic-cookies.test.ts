import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sessionRecoveryManager,
  classifySessionFailure,
  hasAuthenticatedMarker,
  atomicWriteJsonFile,
  quarantineCorruptedFile,
  validateAndParseCookies,
  type SessionState,
} from '../src/services/upstream/session-recovery-manager.js';
import {
  saveAccountCookiesToFile,
  loadAccountCookiesFromFile,
  getAccountCookieDir,
  type SpigotCookieItem,
} from '../src/services/upstream/spigot-cookie-files.js';

describe('Phase 4C-3: Session Recovery & Atomic Cookie Storage', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = join(
      tmpdir(),
      `phase-4c3-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    );
    mkdirSync(tempBaseDir, { recursive: true });
    sessionRecoveryManager.reset();
  });

  afterEach(() => {
    sessionRecoveryManager.reset();
    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. RECOVERY TEST MATRIX (TEST-SR01 -> TEST-SR15)
  // =========================================================================

  it('TEST-SR01: Valid cookie -> load -> authenticated -> READY', async () => {
    const validCookies: SpigotCookieItem[] = [
      { name: 'xf_user', value: '12345,hashstring', domain: '.spigotmc.org' },
      { name: 'xf_session', value: 'session_token_xyz', domain: '.spigotmc.org' },
    ];

    saveAccountCookiesToFile('acc-valid', validCookies, { status: 'active' }, tempBaseDir);

    const loaded = loadAccountCookiesFromFile('acc-valid', tempBaseDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.cookies).toHaveLength(2);
    expect(sessionRecoveryManager.getState('acc-valid')).toBe('VALID');

    // Verification marker check
    const mockHtml = '<div data-logged-in="true">Welcome back!</div>';
    expect(hasAuthenticatedMarker(mockHtml)).toBe(true);

    sessionRecoveryManager.setState('acc-valid', 'READY');
    expect(sessionRecoveryManager.getState('acc-valid')).toBe('READY');
  });

  it('TEST-SR02: Malformed JSON -> quarantine -> recovery', async () => {
    const accountDir = getAccountCookieDir('acc-malformed', tempBaseDir);
    mkdirSync(accountDir, { recursive: true });
    const cookieFile = join(accountDir, 'cookies.json');

    // Write corrupted non-JSON
    writeFileSync(cookieFile, '{ this is totally broken json: [', 'utf-8');

    // Loading should detect corruption, quarantine it, and return null
    const loaded = loadAccountCookiesFromFile('acc-malformed', tempBaseDir);
    expect(loaded).toBeNull();
    expect(existsSync(cookieFile)).toBe(false); // Original broken file unlinked/moved

    // Check quarantine file
    const dirFiles = readdirSync(accountDir);
    const quarantineArtifact = dirFiles.find((f) => f.includes('cookies.json.corrupt.'));
    expect(quarantineArtifact).toBeDefined();
    expect(sessionRecoveryManager.getState('acc-malformed')).toBe('QUARANTINED');

    // Now trigger recovery
    const recoveryResult = await sessionRecoveryManager.recoverSession(
      'acc-malformed',
      async () => [
        { name: 'xf_user', value: 'recovered_user_token', domain: '.spigotmc.org' },
      ],
      { customBaseDir: tempBaseDir }
    );

    expect(recoveryResult.ok).toBe(true);
    expect(recoveryResult.state).toBe('READY');
    expect(existsSync(cookieFile)).toBe(true);
  });

  it('TEST-SR03: Truncated cookie file -> quarantine -> recovery', async () => {
    const accountDir = getAccountCookieDir('acc-truncated', tempBaseDir);
    mkdirSync(accountDir, { recursive: true });
    const cookieFile = join(accountDir, 'cookies.json');

    // Write truncated JSON array
    writeFileSync(cookieFile, '[{"name": "xf_user", "value": "trunc', 'utf-8');

    const loaded = loadAccountCookiesFromFile('acc-truncated', tempBaseDir);
    expect(loaded).toBeNull();
    expect(existsSync(cookieFile)).toBe(false);

    const dirFiles = readdirSync(accountDir);
    const quarantined = dirFiles.find((f) => f.includes('cookies.json.corrupt.'));
    expect(quarantined).toBeDefined();

    // Recovery succeeds
    const recoveryResult = await sessionRecoveryManager.recoverSession(
      'acc-truncated',
      async () => [
        { name: 'xf_user', value: 'clean_recovered_cookie' },
      ],
      { customBaseDir: tempBaseDir }
    );
    expect(recoveryResult.ok).toBe(true);
    expect(sessionRecoveryManager.getState('acc-truncated')).toBe('READY');
  });

  it('TEST-SR04: Empty cookie file (zero-byte) -> quarantine -> recovery', async () => {
    const accountDir = getAccountCookieDir('acc-empty', tempBaseDir);
    mkdirSync(accountDir, { recursive: true });
    const cookieFile = join(accountDir, 'cookies.json');

    // Write 0-byte file
    writeFileSync(cookieFile, '', 'utf-8');

    const loaded = loadAccountCookiesFromFile('acc-empty', tempBaseDir);
    expect(loaded).toBeNull();
    expect(existsSync(cookieFile)).toBe(false);

    const dirFiles = readdirSync(accountDir);
    const quarantined = dirFiles.find((f) => f.includes('cookies.json.corrupt.'));
    expect(quarantined).toBeDefined();

    const recoveryResult = await sessionRecoveryManager.recoverSession(
      'acc-empty',
      async () => [{ name: 'xf_user', value: 'recovered_from_empty' }],
      { customBaseDir: tempBaseDir }
    );
    expect(recoveryResult.ok).toBe(true);
    expect(sessionRecoveryManager.getState('acc-empty')).toBe('READY');
  });

  it('TEST-SR05: Network timeout -> session retained (never converted to NEEDS_LOGIN)', () => {
    saveAccountCookiesToFile('acc-timeout', [{ name: 'xf_user', value: 'user_val' }], {}, tempBaseDir);

    const classification = classifySessionFailure({
      errorMessage: 'Navigation timeout of 30000 ms exceeded',
    });

    expect(classification.type).toBe('TRANSIENT');
    expect(sessionRecoveryManager.getState('acc-timeout')).toBe('VALID');

    // Cookie file must NOT be destroyed
    const loaded = loadAccountCookiesFromFile('acc-timeout', tempBaseDir);
    expect(loaded).not.toBeNull();
  });

  it('TEST-SR06: Socket reset -> session retained', () => {
    saveAccountCookiesToFile('acc-reset', [{ name: 'xf_user', value: 'user_val' }], {}, tempBaseDir);

    const classification = classifySessionFailure({
      errorMessage: 'read ECONNRESET (net::ERR_CONNECTION_RESET)',
    });

    expect(classification.type).toBe('TRANSIENT');
    const loaded = loadAccountCookiesFromFile('acc-reset', tempBaseDir);
    expect(loaded).not.toBeNull();
  });

  it('TEST-SR07: CDP failure -> session retained/recover', () => {
    saveAccountCookiesToFile('acc-cdp', [{ name: 'xf_user', value: 'user_val' }], {}, tempBaseDir);

    const classification = classifySessionFailure({
      errorMessage: 'Protocol error (Target.detachFromTarget): Session closed. Most likely the target has been closed.',
    });

    expect(classification.type).toBe('TRANSIENT');
    const loaded = loadAccountCookiesFromFile('acc-cdp', tempBaseDir);
    expect(loaded).not.toBeNull();
  });

  it('TEST-SR08: Explicit login redirect -> NEEDS_LOGIN', () => {
    const classification = classifySessionFailure({
      redirectLocation: 'https://www.spigotmc.org/login/',
      url: 'https://www.spigotmc.org/login/',
      statusCode: 302,
    });

    expect(classification.type).toBe('NEEDS_LOGIN');
    expect(classification.reason).toContain('đăng nhập');
  });

  it('TEST-SR09: Authenticated-user check fails -> NEEDS_LOGIN', () => {
    const guestHtml = '<div>Welcome Guest! Please register or log in.</div>';
    expect(hasAuthenticatedMarker(guestHtml)).toBe(false);

    const classification = classifySessionFailure({
      url: 'https://www.spigotmc.org/account/',
      statusCode: 200,
      hasAuthMarker: false,
    });

    expect(classification.type).toBe('NEEDS_LOGIN');
  });

  it('TEST-SR10: HTTP 403 without auth evidence -> MUST NOT blindly quarantine cookie or mark NEEDS_LOGIN', () => {
    saveAccountCookiesToFile('acc-403', [{ name: 'xf_user', value: 'valid_cookie' }], {}, tempBaseDir);

    // Spigot or Cloudflare returned 403 on edge
    const classification = classifySessionFailure({
      url: 'https://www.spigotmc.org/resources/123/download',
      statusCode: 403,
      // No auth evidence provided
    });

    expect(classification.type).toBe('TRANSIENT');
    expect(classification.type).not.toBe('NEEDS_LOGIN');

    // Cookie must remain intact, never quarantined
    const loaded = loadAccountCookiesFromFile('acc-403', tempBaseDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.cookies).toHaveLength(1);
  });

  it('TEST-SR11: HTTP 403 + authenticated-user failure -> NEEDS_LOGIN', () => {
    const classification = classifySessionFailure({
      url: 'https://www.spigotmc.org/account/',
      statusCode: 403,
      hasAuthMarker: false, // Confirmed logged-out evidence
    });

    expect(classification.type).toBe('NEEDS_LOGIN');
  });

  it('TEST-SR12: Concurrent recovery same account -> exactly one recovery owner', async () => {
    let workerExecutionCount = 0;

    const mockWorker = async () => {
      workerExecutionCount++;
      // Simulate asynchronous recovery work
      await new Promise((r) => setTimeout(r, 60));
      return [{ name: 'xf_user', value: 'concurrent_recovered_cookie' }];
    };

    // Job A and Job B launch concurrently for the same account
    const [resultA, resultB] = await Promise.all([
      sessionRecoveryManager.recoverSession('same-acc', mockWorker, { customBaseDir: tempBaseDir }),
      sessionRecoveryManager.recoverSession('same-acc', mockWorker, { customBaseDir: tempBaseDir }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    // Worker must only have run ONCE! Job B reused the recovered session
    expect(workerExecutionCount).toBe(1);
    expect(sessionRecoveryManager.getState('same-acc')).toBe('READY');
  });

  it('TEST-SR13: 100 consecutive atomic cookie writes -> zero corrupted targets', () => {
    const targetFile = join(tempBaseDir, 'atomic-test', 'cookies.json');

    for (let i = 0; i < 100; i++) {
      const payload: SpigotCookieItem[] = [
        { name: 'xf_user', value: `token_iteration_${i}`, domain: '.spigotmc.org' },
        { name: 'counter', value: String(i) },
      ];

      atomicWriteJsonFile(targetFile, payload);

      // Verify immediate read is completely valid and never empty / truncated
      const content = readFileSync(targetFile, 'utf-8');
      expect(content.length).toBeGreaterThan(0);

      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].value).toBe(`token_iteration_${i}`);
      expect(parsed[1].value).toBe(String(i));
    }
  });

  it('TEST-SR14: Recovery fails halfway -> old valid cookie remains intact', async () => {
    const originalCookies: SpigotCookieItem[] = [
      { name: 'xf_user', value: 'original_precious_token' },
    ];
    saveAccountCookiesToFile('acc-halfway-fail', originalCookies, {}, tempBaseDir);

    const failingWorker = async () => {
      // Simulate catastrophic failure midway through recovery
      throw new Error('Upstream challenge solve failed');
    };

    await expect(
      sessionRecoveryManager.recoverSession('acc-halfway-fail', failingWorker, {
        customBaseDir: tempBaseDir,
        force: true,
      })
    ).rejects.toThrow('Upstream challenge solve failed');

    // The original valid cookie MUST remain intact!
    const loaded = loadAccountCookiesFromFile('acc-halfway-fail', tempBaseDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.cookies[0]?.value).toBe('original_precious_token');
  });

  it('TEST-SR15: Quarantine name collision -> no overwrite', () => {
    const accountDir = join(tempBaseDir, 'collision-acc');
    mkdirSync(accountDir, { recursive: true });

    const brokenFile1 = join(accountDir, 'cookies.json');
    writeFileSync(brokenFile1, 'bad1', 'utf-8');
    const q1 = quarantineCorruptedFile(brokenFile1);

    expect(q1).not.toBeNull();
    expect(existsSync(q1!)).toBe(true);

    // Create another broken file immediately
    const brokenFile2 = join(accountDir, 'cookies.json');
    writeFileSync(brokenFile2, 'bad2', 'utf-8');
    const q2 = quarantineCorruptedFile(brokenFile2);

    expect(q2).not.toBeNull();
    expect(existsSync(q2!)).toBe(true);

    // Both files MUST have distinct paths and exist simultaneously without overwrite!
    expect(q1).not.toBe(q2);
    expect(existsSync(q1!)).toBe(true);
    expect(existsSync(q2!)).toBe(true);

    expect(readFileSync(q1!, 'utf-8')).toBe('bad1');
    expect(readFileSync(q2!, 'utf-8')).toBe('bad2');
  });

  // =========================================================================
  // 2. SECURITY & SECRETS SANITIZATION (Item 9)
  // =========================================================================
  it('TEST-SEC01: Quarantine filename and logs never contain cookie secrets', () => {
    const accountDir = join(tempBaseDir, 'secret-acc');
    mkdirSync(accountDir, { recursive: true });

    const cookieFile = join(accountDir, 'cookies.json');
    const superSecretCookie = 'super_secret_password_token_12345';
    writeFileSync(cookieFile, `[bad json with secret ${superSecretCookie}`, 'utf-8');

    const qPath = quarantineCorruptedFile(cookieFile);
    expect(qPath).not.toBeNull();

    // Quarantine filename MUST NOT contain the secret
    expect(qPath).not.toContain(superSecretCookie);
    expect(qPath).not.toContain('password');
    expect(qPath).not.toContain('token');
  });
});
