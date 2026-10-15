import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SealedBox {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * Parses a 256-bit key given as base64/base64url (44 chars) or hex (64 chars).
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

export function seal(plaintext: string, key: Buffer, aad: string): SealedBox {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function open(box: SealedBox, key: Buffer, aad: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** URL-safe random token with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes so a store leak does not leak bearer tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** RFC 7636 S256 code challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
