import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, openMedia, readMediaToBuffer } from '../src/sources/mediaSource.js';

const publicResolver = () => Promise.resolve(['93.184.216.34']);

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '0.0.0.0',
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('openMedia (url)', () => {
  it('streams the body with size and content type', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response('video-bytes', {
          headers: { 'content-type': 'video/mp4', 'content-length': '11' },
        }),
      ),
    ) as unknown as typeof fetch;
    const media = await openMedia({ url: 'https://cdn.example.com/ep1.mp4?sig=abc' }, 'video', {
      allowLocalPaths: false,
      fetch: fetchFn,
      resolveHost: publicResolver,
    });
    expect(media.size).toBe(11);
    expect(media.contentType).toBe('video/mp4');
    expect(media.label).toBe('https://cdn.example.com/ep1.mp4');
    expect((await readMediaToBuffer(media, 100)).toString()).toBe('video-bytes');
  });

  it('guesses the type from the extension when the header is generic', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response('x', { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    ) as unknown as typeof fetch;
    const media = await openMedia({ url: 'https://cdn.example.com/a.mov' }, 'video', {
      allowLocalPaths: false,
      fetch: fetchFn,
      resolveHost: publicResolver,
    });
    expect(media.contentType).toBe('video/quicktime');
    expect(media.size).toBeUndefined();
  });

  it('blocks private addresses, including via redirects', async () => {
    await expect(
      openMedia({ url: 'http://169.254.169.254/latest' }, 'video', { allowLocalPaths: false }),
    ).rejects.toThrow(/private or internal/);

    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      openMedia({ url: 'https://cdn.example.com/a.mp4' }, 'video', {
        allowLocalPaths: false,
        fetch: fetchFn,
        resolveHost: publicResolver,
      }),
    ).rejects.toThrow(/private or internal/);
  });

  it('reports HTTP failures', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response('no', { status: 403 })),
    ) as unknown as typeof fetch;
    await expect(
      openMedia({ url: 'https://cdn.example.com/a.mp4' }, 'video', {
        allowLocalPaths: false,
        fetch: fetchFn,
        resolveHost: publicResolver,
      }),
    ).rejects.toThrow(/HTTP 403.*signed URL/);
  });

  it('rejects embedded credentials and non-http schemes', async () => {
    await expect(
      openMedia({ url: 'https://u:p@cdn.example.com/a' }, 'video', { allowLocalPaths: false }),
    ).rejects.toThrow(/credentials/);
    await expect(
      openMedia({ url: 'file:///etc/passwd' }, 'video', { allowLocalPaths: false }),
    ).rejects.toThrow(/http/);
  });
});

describe('openMedia (path)', () => {
  it('is refused unless local paths are allowed (stdio only)', async () => {
    await expect(
      openMedia({ path: '/etc/hosts' }, 'video', { allowLocalPaths: false }),
    ).rejects.toThrow(/stdio/);
  });

  it('opens local files with size and type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rs-media-'));
    try {
      const file = join(dir, 'thumb.png');
      await writeFile(file, Buffer.alloc(50));
      const media = await openMedia({ path: file }, 'image', { allowLocalPaths: true });
      expect(media.size).toBe(50);
      expect(media.contentType).toBe('image/png');
      await expect(readMediaToBuffer(media, 10)).rejects.toThrow(/too large/);
      await expect(
        openMedia({ path: join(dir, 'missing.mp4') }, 'video', { allowLocalPaths: true }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
