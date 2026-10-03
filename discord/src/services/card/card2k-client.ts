/**
 * card2k charging client.
 *
 * Two parts of card2k's contract are NOT publicly documented and cannot be
 * recovered by inspection: the `sign` concatenation order and the `command`
 * values. Their official docs are login-gated and their official client jar is
 * string-encrypted (qProtect), so every string constant is decrypted at runtime.
 *
 * Guessing either is worse than not shipping. A wrong field order fails
 * identically to every other error, giving no signal to iterate on — and each
 * failed attempt may consume a real card. So both are configuration: until the
 * owner supplies the values from their partner dashboard, isCard2kConfigured()
 * returns false and the whole feature stays switched off rather than half-working.
 *
 * What IS verified and hardcoded here: the endpoint, the response schema, and the
 * status semantics — all from card2k-controlled artefacts.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidDenomination, type Telco } from './card2k-telcos.js';

export type Card2kConfig = {
  baseUrl: string;
  partnerId: string;
  partnerKey: string;
  /**
   * Field order for the md5 signature, e.g. ['partner_key', 'code', 'serial'].
   * Empty means unknown, which disables the feature.
   */
  signFields: readonly string[];
  /** Dispatcher value for submitting a card. Empty disables the feature. */
  commandCharge: string;
  /** Dispatcher value for checking one. Empty disables the feature. */
  commandCheck: string;
  timeoutMs: number;
};

/**
 * Whether enough of the contract is known to make a call at all.
 *
 * Checked before every submission, not just at boot: a half-configured deployment
 * must refuse to touch a card rather than burn it on a request that cannot be
 * signed correctly.
 */
export function isCard2kConfigured(config: Card2kConfig): boolean {
  return (
    config.partnerId !== '' &&
    config.partnerKey !== '' &&
    config.signFields.length > 0 &&
    config.commandCharge !== '' &&
    config.commandCheck !== ''
  );
}

/**
 * Builds the md5 signature from the configured field order.
 *
 * Field names map to the request values; anything unknown is a configuration
 * error and throws, because silently signing over an empty string would produce a
 * plausible-looking signature that can never verify.
 */
export function signRequest(config: Card2kConfig, values: Record<string, string>): string {
  if (config.signFields.length === 0) {
    throw new Error('Chưa cấu hình CARD2K_SIGN_FIELDS — không thể ký yêu cầu');
  }

  const parts = config.signFields.map((field) => {
    if (field === 'partner_key') return config.partnerKey;
    if (field === 'partner_id') return config.partnerId;
    const value = values[field];
    if (value === undefined) {
      throw new Error(`CARD2K_SIGN_FIELDS chứa trường không biết: "${field}"`);
    }
    return value;
  });

  return md5(parts.join(''));
}

function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * Response envelope. Field names and types come from decompiling card2k's own
 * CardResponse class, so they are exact — including the mixed typing: `status` is
 * an int and `trans_id` a long, while `value` and `amount` are Strings. Everything
 * numeric is coerced because the provider is inconsistent about which it sends.
 */
const responseSchema = z.object({
  status: z.coerce.number().int(),
  message: z.string().default(''),
  // A long in Java. Kept as a string: a large long loses precision as a JS number,
  // and nothing here does arithmetic on it — it exists for lookups and disputes.
  trans_id: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? null : String(v))),
  request_id: z.string().optional().default(''),
  telco: z.string().optional().default(''),
  serial: z.string().optional().default(''),
  declared_value: z.coerce.number().int().nonnegative().optional(),
  /** The card's REAL face value, as determined by the telco. */
  value: z.coerce.number().int().nonnegative().optional(),
  /** What card2k actually pays out, after their fee. */
  amount: z.coerce.number().int().nonnegative().optional(),
});

export type Card2kRaw = z.infer<typeof responseSchema>;

/**
 * Outcome of a submit or check.
 *
 * 'unknown' is deliberately distinct from 'failed'. A failure is actionable — the
 * card was bad, nothing was taken. An unrecognised status means the card may have
 * been consumed while we cannot tell, so it must be held for a human instead of
 * being written off. The documented status table is incomplete (no code is known
 * for maintenance, bad signature, or a duplicate request_id), which makes this the
 * common case rather than a theoretical one.
 */
export type CardOutcome = 'success' | 'wrong_amount' | 'pending' | 'failed' | 'unknown';

export type CardResult = {
  outcome: CardOutcome;
  providerStatus: number;
  providerMessage: string;
  transId: string | null;
  /** The card's real value. Null when the provider did not say. */
  actualValue: number | null;
  /** Net paid to us after card2k's fee. Recorded for reconciliation, not credit. */
  netAmount: number | null;
};

/**
 * Maps card2k's numeric status onto our state machine.
 *
 * 1 success · 2 succeeded but the declared denomination was wrong · 3 card
 * invalid or already used · 99 still processing · 100 the command was rejected.
 * Anything else is 'unknown' by design — see CardOutcome.
 */
export function mapStatus(status: number): CardOutcome {
  if (status === 1) return 'success';
  if (status === 2) return 'wrong_amount';
  if (status === 3) return 'failed';
  if (status === 99) return 'pending';
  // 100 means our command value is wrong: a configuration fault, not a bad card.
  // Never 'failed', which would write off a card that was never submitted.
  if (status === 100) return 'unknown';
  return 'unknown';
}

export type SubmitInput = {
  telco: Telco;
  serial: string;
  code: string;
  /** Declared denomination in ĐỒNG. */
  amount: number;
  requestId: string;
};

export class Card2kError extends Error {
  constructor(
    message: string,
    /** True when the card was certainly not submitted, so a retry is safe. */
    readonly notSubmitted: boolean,
  ) {
    super(message);
    this.name = 'Card2kError';
  }
}

/**
 * Submits a card for charging.
 *
 * Throws rather than returning a result when the request could not be made at
 * all. The caller must treat a throw as "state unknown, keep polling" unless
 * `notSubmitted` is set — a timeout is the case where card2k most likely DID
 * receive the card, and writing that off would silently eat it.
 */
export async function submitCard(config: Card2kConfig, input: SubmitInput): Promise<CardResult> {
  if (!isCard2kConfigured(config)) {
    throw new Card2kError('Chưa cấu hình card2k (thiếu sign hoặc command)', true);
  }
  if (!isValidDenomination(input.telco, input.amount)) {
    throw new Card2kError(`${input.telco} không có mệnh giá ${input.amount}`, true);
  }

  const values: Record<string, string> = {
    telco: input.telco,
    code: input.code,
    serial: input.serial,
    amount: String(input.amount),
    request_id: input.requestId,
  };

  return post(config, {
    ...values,
    command: config.commandCharge,
    partner_id: config.partnerId,
    sign: signRequest(config, values),
  });
}

/**
 * Checks a previously submitted card.
 *
 * Same endpoint as submit, different `command`: card2k's own client funnels both
 * through one request sender, and every separate path probed returns 404.
 */
export async function checkCard(
  config: Card2kConfig,
  input: { requestId: string; serial: string; code: string; telco: Telco; amount: number },
): Promise<CardResult> {
  if (!isCard2kConfigured(config)) {
    throw new Card2kError('Chưa cấu hình card2k (thiếu sign hoặc command)', true);
  }

  const values: Record<string, string> = {
    telco: input.telco,
    code: input.code,
    serial: input.serial,
    amount: String(input.amount),
    request_id: input.requestId,
  };

  return post(config, {
    ...values,
    command: config.commandCheck,
    partner_id: config.partnerId,
    sign: signRequest(config, values),
  });
}

/**
 * One POST to the charging endpoint.
 *
 * Three non-obvious requirements, all verified against the live host:
 *
 * - `redirect: 'manual'`. card2k.com 302s to card2k.net for pages but serves the
 *   API directly. Following a redirect drops the POST body, and the request then
 *   fails in a way that looks like a rejected card.
 * - A browser-like User-Agent. Cloudflare answers default agents with 403.
 * - An explicit timeout. Without one a hung connection blocks the poll sweep,
 *   which is single-file.
 */
async function post(config: Card2kConfig, body: Record<string, string>): Promise<CardResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chargingws/v2`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    // Could be a timeout or a dropped connection. Either way card2k may already
    // hold the card, so this is NOT reported as safe to retry.
    throw new Card2kError(err instanceof Error ? err.message : String(err), false);
  } finally {
    clearTimeout(timer);
  }

  // A redirect here means the base URL is wrong (card2k.net instead of .com), and
  // the body was never delivered.
  if (response.status >= 300 && response.status < 400) {
    throw new Card2kError(`card2k chuyển hướng ${response.status} — sai CARD2K_BASE_URL`, true);
  }
  if (response.status === 403) {
    throw new Card2kError('card2k trả 403 (Cloudflare chặn)', true);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Card2kError(`card2k trả về nội dung không phải JSON (HTTP ${response.status})`, false);
  }

  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Card2kError(`card2k trả về JSON lạ: ${JSON.stringify(parsed).slice(0, 200)}`, false);
  }

  const raw = result.data;
  return {
    outcome: mapStatus(raw.status),
    providerStatus: raw.status,
    providerMessage: raw.message,
    transId: raw.trans_id,
    actualValue: raw.value ?? null,
    netAmount: raw.amount ?? null,
  };
}
