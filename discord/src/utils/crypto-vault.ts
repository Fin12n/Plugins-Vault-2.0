import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM encrypted secret store for passwords, session cookies, and sensitive tokens.
 *
 * Derives a 32-byte encryption key from SESSION_SECRET using scrypt with a fixed salt.
 * Output payload format: `ivHex:authTagHex:ciphertextHex`.
 */

const SALT = 'spigot-vault-salt-v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM

let cachedKey: Buffer | null = null;

function getDerivedKey(): Buffer {
  if (cachedKey) return cachedKey;
  const masterSecret = process.env.SESSION_SECRET || 'fallback-dev-secret-at-least-32-chars-long';
  cachedKey = scryptSync(masterSecret, SALT, 32);
  return cachedKey;
}

/** Resets the cached key (used in tests when SESSION_SECRET changes). */
export function resetCachedKey(): void {
  cachedKey = null;
}

/**
 * Encrypts a plaintext string into `iv:tag:ciphertext` hex format using AES-256-GCM.
 * Empty strings are returned as empty.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = getDerivedKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${ciphertext}`;
}

function tryDecryptWithKey(key: Buffer, ivHex: string, tagHex: string, cipherHex: string): string | null {
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Decrypts an `iv:tag:ciphertext` payload back to plaintext.
 * Returns empty string if payload is empty or invalid.
 */
export function decryptSecret(payload: string): string {
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 3) {
    // If not encrypted format, return as is (useful during migration / fallback)
    return payload;
  }

  const [ivHex, tagHex, cipherHex] = parts;
  if (!ivHex || !tagHex || !cipherHex) return '';

  // 1. Thử giải mã với khóa chính (bắt nguồn từ SESSION_SECRET hiện tại)
  const primaryKey = getDerivedKey();
  const primaryResult = tryDecryptWithKey(primaryKey, ivHex, tagHex, cipherHex);
  if (primaryResult !== null) return primaryResult;

  // 2. Fallback sang khóa dev mặc định nếu secret được mã hóa lúc chưa nạp .env
  const fallbackKey = scryptSync('fallback-dev-secret-at-least-32-chars-long', SALT, 32);
  const fallbackResult = tryDecryptWithKey(fallbackKey, ivHex, tagHex, cipherHex);
  if (fallbackResult !== null) return fallbackResult;

  console.error('Lỗi giải mã secret: Không thể xác thực dữ liệu (sai khóa SESSION_SECRET)');
  return '';
}
