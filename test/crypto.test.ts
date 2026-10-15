import { describe, expect, it } from 'vitest';
import {
  hashToken,
  open,
  parseEncryptionKey,
  pkceChallenge,
  randomToken,
  safeEqual,
  seal,
} from '../src/crypto.js';
import { TEST_KEY } from './helpers.js';

describe('crypto', () => {
  it('round-trips sealed data and binds it to the AAD', () => {
    const box = seal('refresh-token', TEST_KEY, 'aad-1');
    expect(box.ct).not.toContain('refresh-token');
    expect(open(box, TEST_KEY, 'aad-1')).toBe('refresh-token');
    expect(() => open(box, TEST_KEY, 'aad-2')).toThrow();
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const box = seal('secret', TEST_KEY, 'a');
    const tampered = { ...box, ct: Buffer.from('xxxxxx').toString('base64') };
    expect(() => open(tampered, TEST_KEY, 'a')).toThrow();
    expect(() => open(box, Buffer.alloc(32, 1), 'a')).toThrow();
  });

  it('uses a fresh IV per seal', () => {
    expect(seal('x', TEST_KEY, 'a').iv).not.toBe(seal('x', TEST_KEY, 'a').iv);
  });

  it('parses base64 and hex keys and rejects wrong lengths', () => {
    expect(parseEncryptionKey(TEST_KEY.toString('base64'))).toEqual(TEST_KEY);
    expect(parseEncryptionKey(TEST_KEY.toString('hex'))).toEqual(TEST_KEY);
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
  });

  it('computes RFC 7636 S256 challenges', () => {
    // Test vector from RFC 7636 Appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('hashes tokens deterministically and compares safely', () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
