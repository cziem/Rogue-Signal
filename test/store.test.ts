import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedFileStore } from '../src/store/encryptedFileStore.js';
import { TEST_KEY } from './helpers.js';

describe('EncryptedFileStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rs-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const grant = (expiresAt: number) => ({
    clientId: 'c',
    userId: 'u',
    scopes: ['youtube'],
    resource: 'https://x/mcp',
    expiresAt,
  });

  it('persists state encrypted and reloads it', async () => {
    const store = new EncryptedFileStore(dir, TEST_KEY, () => 1000);
    await store.update((s) => {
      s.accessTokens.hash1 = grant(2000);
    });
    const raw = await readFile(join(dir, 'state.enc'), 'utf8');
    expect(raw).not.toContain('hash1');

    const reloaded = new EncryptedFileStore(dir, TEST_KEY, () => 1000);
    expect(await reloaded.read((s) => s.accessTokens.hash1?.userId)).toBe('u');
  });

  it('fails loudly with a different key', async () => {
    await new EncryptedFileStore(dir, TEST_KEY).update((s) => {
      s.accessTokens.a = grant(9e12);
    });
    const other = new EncryptedFileStore(dir, Buffer.alloc(32, 9));
    await expect(other.read((s) => s)).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('purges expired entries on update', async () => {
    let now = 1000;
    const store = new EncryptedFileStore(dir, TEST_KEY, () => now);
    await store.update((s) => {
      s.accessTokens.old = grant(1500);
      s.accessTokens.fresh = grant(5000);
    });
    now = 2000;
    await store.update(() => undefined);
    expect(await store.read((s) => Object.keys(s.accessTokens))).toEqual(['fresh']);
  });

  it('does not commit a mutation that throws', async () => {
    const store = new EncryptedFileStore(dir, TEST_KEY);
    await expect(
      store.update((s) => {
        s.accessTokens.x = grant(9e12);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.read((s) => s.accessTokens.x)).toBeUndefined();
  });

  it('serializes concurrent updates', async () => {
    const store = new EncryptedFileStore(dir, TEST_KEY);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update((s) => {
          s.accessTokens[`t${i}`] = grant(9e12);
        }),
      ),
    );
    expect(await store.read((s) => Object.keys(s.accessTokens).length)).toBe(20);
  });
});
