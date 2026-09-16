import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing-headers' | 'bad-signature' | 'stale-timestamp' };

/** Rejects a replayed request outside this window, in seconds. */
const MAX_CLOCK_SKEW = 300;

/**
 * Verifies SePay's HMAC-SHA256 webhook signature.
 *
 * The signing string is `{timestamp}.{rawBody}` — the timestamp and the literal
 * dot are part of it, so signing the body alone produces a valid-looking but
 * always-wrong digest.
 *
 * rawBody must be the exact bytes received. Re-serializing with JSON.stringify
 * changes key order and Unicode escaping, which is the single most common reason
 * this integration fails.
 */
export function verifySepaySignature(input: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  nowSeconds?: number;
}): SignatureVerdict {
  if (!input.signatureHeader || !input.timestampHeader) return { ok: false, reason: 'missing-headers' };

  const timestamp = Number(input.timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing-headers' };

  const current = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(current - timestamp) > MAX_CLOCK_SKEW) return { ok: false, reason: 'stale-timestamp' };

  const body = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody;
  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestampHeader}.`)
    .update(body)
    .digest('hex');

  // The header is prefixed and hex-encoded; comparing against base64 or leaving
  // the prefix on would always fail.
  const provided = input.signatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the length is checked first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  return { ok: true };
}

/** Builds a signature header the way SePay does, for tests and local simulation. */
export function signSepayPayload(secret: string, timestamp: number, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}
