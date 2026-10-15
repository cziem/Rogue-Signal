import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_QUANTUM } from '../src/constants.js';
import {
  ChunkReader,
  nextOffsetFromRange,
  resumableUpload,
} from '../src/youtube/resumableUpload.js';
import { bytes } from './helpers.js';

const SESSION = 'https://upload.example/session/1';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyLength: number;
}

/** Fake YouTube upload endpoint: records calls and answers per a script. */
function fakeUploadServer(script: (call: Call, received: number) => Response) {
  const calls: Call[] = [];
  let received = 0;
  const fetchFn = vi.fn((input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body;
    const bodyLength =
      body instanceof Uint8Array ? body.byteLength : typeof body === 'string' ? body.length : 0;
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers, bodyLength };
    calls.push(call);
    if (call.method === 'POST') {
      return Promise.resolve(new Response(null, { status: 200, headers: { location: SESSION } }));
    }
    const response = script(call, received);
    if (response.status === 308 || response.status === 200) {
      if (call.bodyLength > 0) received += call.bodyLength;
    }
    return Promise.resolve(response);
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch, received: () => received };
}

const ack = (upTo: number) =>
  new Response(null, { status: 308, headers: upTo > 0 ? { range: `bytes=0-${upTo - 1}` } : {} });
const done = () =>
  new Response(
    JSON.stringify({
      id: 'vid123',
      status: { privacyStatus: 'private', uploadStatus: 'uploaded' },
    }),
    { status: 200 },
  );

describe('ChunkReader', () => {
  it('yields exact-size chunks and flags the last one', async () => {
    const reader = new ChunkReader(bytes('abc', 'defgh', 'ij'));
    expect(await reader.next(4)).toEqual({ chunk: Buffer.from('abcd'), last: false });
    expect(await reader.next(4)).toEqual({ chunk: Buffer.from('efgh'), last: false });
    expect(await reader.next(4)).toEqual({ chunk: Buffer.from('ij'), last: true });
  });

  it('flags last when the stream ends exactly on a boundary', async () => {
    const reader = new ChunkReader(bytes('abcd'));
    expect(await reader.next(4)).toEqual({ chunk: Buffer.from('abcd'), last: true });
  });
});

describe('nextOffsetFromRange', () => {
  it('parses Range headers', () => {
    expect(nextOffsetFromRange('bytes=0-1023')).toBe(1024);
    expect(nextOffsetFromRange(null)).toBe(0);
  });
});

describe('resumableUpload', () => {
  const resource = { snippet: { title: 't' }, status: { privacyStatus: 'private' } };
  const chunk = UPLOAD_CHUNK_QUANTUM;

  it('starts a session with metadata then uploads in chunks', async () => {
    const size = chunk * 2 + 100;
    const server = fakeUploadServer((call, received) => {
      const end = received + call.bodyLength;
      return end >= size ? done() : ack(end);
    });
    const progress: number[] = [];
    const video = await resumableUpload({
      resource,
      parts: ['snippet', 'status'],
      body: bytes(Buffer.alloc(size, 1)),
      contentType: 'video/mp4',
      size,
      chunkSize: chunk,
      getAccessToken: () => Promise.resolve('tok'),
      fetch: server.fetchFn,
      onProgress: (n) => {
        progress.push(n);
      },
    });

    expect(video.id).toBe('vid123');
    const [init, ...puts] = server.calls;
    expect(init?.method).toBe('POST');
    expect(init?.url).toContain('uploadType=resumable');
    expect(init?.url).toContain('part=snippet%2Cstatus');
    expect(init?.headers['X-Upload-Content-Length']).toBe(String(size));
    expect(puts.map((c) => c.headers['Content-Range'])).toEqual([
      `bytes 0-${chunk - 1}/${size}`,
      `bytes ${chunk}-${chunk * 2 - 1}/${size}`,
      `bytes ${chunk * 2}-${size - 1}/${size}`,
    ]);
    expect(progress.at(-1)).toBe(size);
  });

  it('uses "*" total for unknown sizes until the last chunk', async () => {
    const size = chunk + 10;
    const server = fakeUploadServer((call, received) => {
      const end = received + call.bodyLength;
      return end >= size ? done() : ack(end);
    });
    await resumableUpload({
      resource,
      parts: ['snippet'],
      body: bytes(Buffer.alloc(chunk), Buffer.alloc(10)),
      contentType: 'video/mp4',
      size: undefined,
      chunkSize: chunk,
      getAccessToken: () => Promise.resolve('tok'),
      fetch: server.fetchFn,
    });
    const ranges = server.calls.slice(1).map((c) => c.headers['Content-Range']);
    expect(ranges).toEqual([`bytes 0-${chunk - 1}/*`, `bytes ${chunk}-${size - 1}/${size}`]);
  });

  it('retries a 503 and resumes from the server-reported offset', async () => {
    const size = chunk * 2;
    let failed = false;
    const server = fakeUploadServer((call, received) => {
      if (call.bodyLength === 0) return ack(received); // status query
      if (!failed && received === chunk) {
        failed = true;
        return new Response('{}', { status: 503 });
      }
      const end = received + call.bodyLength;
      return end >= size ? done() : ack(end);
    });
    const sleep = vi.fn(() => Promise.resolve());
    const video = await resumableUpload({
      resource,
      parts: ['snippet'],
      body: bytes(Buffer.alloc(size)),
      contentType: 'video/mp4',
      size,
      chunkSize: chunk,
      getAccessToken: () => Promise.resolve('tok'),
      fetch: server.fetchFn,
      sleep,
    });
    expect(video.id).toBe('vid123');
    expect(sleep).toHaveBeenCalledTimes(1);
    const statusQuery = server.calls.find((c) => c.headers['Content-Range'] === `bytes */${size}`);
    expect(statusQuery).toBeDefined();
  });

  it('handles partial acknowledgement within a chunk', async () => {
    const size = chunk;
    let first = true;
    const server = fakeUploadServer((call, received) => {
      if (first) {
        first = false;
        // Server only kept the first 1000 bytes.
        return new Response(null, { status: 308, headers: { range: 'bytes=0-999' } });
      }
      return received + call.bodyLength >= size ? done() : ack(received + call.bodyLength);
    });
    await resumableUpload({
      resource,
      parts: ['snippet'],
      body: bytes(Buffer.alloc(size)),
      contentType: 'video/mp4',
      size,
      chunkSize: chunk,
      getAccessToken: () => Promise.resolve('tok'),
      fetch: server.fetchFn,
    });
    expect(server.calls[2]?.headers['Content-Range']).toBe(`bytes 1000-${size - 1}/${size}`);
  });

  it('maps a quota error when starting the session', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] },
          }),
          {
            status: 403,
          },
        ),
      ),
    ) as unknown as typeof fetch;
    await expect(
      resumableUpload({
        resource,
        parts: ['snippet'],
        body: bytes('x'),
        contentType: 'video/mp4',
        size: 1,
        getAccessToken: () => Promise.resolve('tok'),
        fetch: fetchFn,
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('rejects empty sources', async () => {
    const server = fakeUploadServer(() => done());
    await expect(
      resumableUpload({
        resource,
        parts: ['snippet'],
        body: bytes(),
        contentType: 'video/mp4',
        size: undefined,
        getAccessToken: () => Promise.resolve('tok'),
        fetch: server.fetchFn,
      }),
    ).rejects.toThrow(/empty/);
  });
});
