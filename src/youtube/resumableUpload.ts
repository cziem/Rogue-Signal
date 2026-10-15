import type { youtube_v3 } from 'googleapis';
import { UPLOAD_CHUNK_QUANTUM, YOUTUBE_UPLOAD_URL } from '../constants.js';
import { UserFacingError } from '../errors.js';
import { logger } from '../logger.js';
import { toYouTubeError } from './errors.js';

export type FetchLike = typeof fetch;

export interface ResumableUploadOptions {
  /** Video resource to create (snippet + status). */
  resource: youtube_v3.Schema$Video;
  parts: readonly string[];
  body: AsyncIterable<Uint8Array>;
  contentType: string;
  /** Total size in bytes when known (enables exact Content-Range and progress percentages). */
  size: number | undefined;
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
  /** Bytes per chunk; rounded up to a multiple of 256 KiB. Default 16 MiB. */
  chunkSize?: number;
  /** Max consecutive retries for one chunk on transient failure. */
  maxRetries?: number;
  onProgress?: (uploadedBytes: number, totalBytes: number | undefined) => void | Promise<void>;
  signal?: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CHUNK = 16 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Pulls exact-size chunks from an async byte stream while holding at most one chunk
 * (plus one incoming piece) in memory. Also reports whether the stream is exhausted
 * after the returned chunk, which the resumable protocol needs for the final range.
 */
export class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async next(size: number): Promise<{ chunk: Buffer; last: boolean }> {
    // Read until we have MORE than `size` bytes (so we know another chunk follows) or EOF.
    while (!this.ended && this.pendingBytes <= size) {
      const result = await this.iterator.next();
      if (result.done) {
        this.ended = true;
        break;
      }
      const piece = Buffer.from(
        result.value.buffer,
        result.value.byteOffset,
        result.value.byteLength,
      );
      if (piece.length > 0) {
        this.pending.push(piece);
        this.pendingBytes += piece.length;
      }
    }
    const all = Buffer.concat(this.pending);
    const chunk = all.subarray(0, Math.min(size, all.length));
    const rest = all.subarray(chunk.length);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
    return { chunk: Buffer.from(chunk), last: this.ended && rest.length === 0 };
  }
}

/** Parses the `Range: bytes=0-12345` header of a 308 response into the next byte offset. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const match = /bytes=0-(\d+)/.exec(range);
  return match?.[1] ? Number(match[1]) + 1 : 0;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function httpError(status: number, body: unknown): Error & { status: number; body: unknown } {
  return Object.assign(new Error(`HTTP ${status}`), { status, body });
}

/**
 * YouTube resumable upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).
 *
 * Streams the source in fixed-size chunks; only the current chunk is buffered, so memory
 * use is bounded regardless of episode size. Transient failures are retried with
 * exponential backoff, resuming from the offset the server reports.
 */
export async function resumableUpload(
  options: ResumableUploadOptions,
): Promise<youtube_v3.Schema$Video> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 5;
  const chunkSize =
    Math.ceil((options.chunkSize ?? DEFAULT_CHUNK) / UPLOAD_CHUNK_QUANTUM) * UPLOAD_CHUNK_QUANTUM;

  // 1. Start the session.
  const initUrl = new URL(YOUTUBE_UPLOAD_URL);
  initUrl.searchParams.set('uploadType', 'resumable');
  initUrl.searchParams.set('part', options.parts.join(','));
  const initHeaders: Record<string, string> = {
    Authorization: `Bearer ${await options.getAccessToken()}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': options.contentType,
  };
  if (options.size !== undefined) initHeaders['X-Upload-Content-Length'] = String(options.size);

  const init = await doFetch(initUrl, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify(options.resource),
    signal: options.signal ?? null,
  });
  if (!init.ok) {
    throw toYouTubeError(httpError(init.status, await readJson(init)), 'starting the upload');
  }
  const sessionUrl = init.headers.get('location');
  if (!sessionUrl) {
    throw new UserFacingError('YouTube did not return a resumable upload session URL.');
  }

  // 2. Upload chunks.
  const reader = new ChunkReader(options.body);
  let offset = 0;
  const totalLabel = (last: boolean, end: number): string =>
    options.size !== undefined ? String(options.size) : last ? String(end) : '*';

  for (;;) {
    const { chunk, last } = await reader.next(chunkSize);
    if (chunk.length === 0) {
      throw new UserFacingError('The video source is empty (0 bytes).', 'invalid_source');
    }
    // `sent` tracks how much of this chunk the server has acknowledged.
    let sent = 0;
    let attempt = 0;

    while (sent < chunk.length) {
      const piece = chunk.subarray(sent);
      const start = offset + sent;
      const end = offset + chunk.length; // exclusive
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await options.getAccessToken()}`,
        'Content-Type': options.contentType,
        'Content-Range': `bytes ${start}-${end - 1}/${totalLabel(last, end)}`,
      };

      let response: Response;
      try {
        response = await doFetch(sessionUrl, {
          method: 'PUT',
          headers,
          body: new Uint8Array(piece),
          signal: options.signal ?? null,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attempt += 1;
        if (attempt > maxRetries) throw toYouTubeError(error, 'uploading video data');
        logger.warn('upload chunk network error; retrying', { attempt, start });
        await sleep(2 ** attempt * 500);
        const status = await queryOffset(doFetch, sessionUrl, options, totalLabel(last, end));
        if (status.done) return status.video;
        sent = Math.max(0, Math.min(status.offset - offset, chunk.length));
        continue;
      }

      if (response.status === 200 || response.status === 201) {
        await options.onProgress?.(end, options.size ?? end);
        return (await readJson(response)) as youtube_v3.Schema$Video;
      }
      if (response.status === 308) {
        await response.body?.cancel().catch(() => undefined);
        const acknowledged = nextOffsetFromRange(response.headers.get('range'));
        sent = Math.max(0, Math.min(acknowledged - offset, chunk.length));
        attempt = 0;
        if (sent >= chunk.length) break;
        continue;
      }
      const body = await readJson(response);
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        attempt += 1;
        logger.warn('upload chunk failed; retrying', { attempt, status: response.status, start });
        await sleep(2 ** attempt * 500);
        const status = await queryOffset(doFetch, sessionUrl, options, totalLabel(last, end));
        if (status.done) return status.video;
        sent = Math.max(0, Math.min(status.offset - offset, chunk.length));
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        throw new UserFacingError(
          'The YouTube upload session expired or was cancelled. Start the upload again.',
          'upload_session_expired',
        );
      }
      throw toYouTubeError(httpError(response.status, body), 'uploading video data');
    }

    offset += chunk.length;
    await options.onProgress?.(offset, options.size);
    if (last) {
      throw new UserFacingError(
        'YouTube acknowledged all bytes but did not finalize the upload. Check YouTube Studio.',
      );
    }
  }
}

type SessionStatus =
  { done: false; offset: number } | { done: true; video: youtube_v3.Schema$Video };

/** Asks the server how many bytes it has (empty PUT with `Content-Range: bytes * /total`). */
async function queryOffset(
  doFetch: FetchLike,
  sessionUrl: string,
  options: ResumableUploadOptions,
  total: string,
): Promise<SessionStatus> {
  const response = await doFetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${await options.getAccessToken()}`,
      'Content-Range': `bytes */${total}`,
    },
    signal: options.signal ?? null,
  });
  if (response.status === 200 || response.status === 201) {
    return { done: true, video: (await readJson(response)) as youtube_v3.Schema$Video };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 308) {
    return { done: false, offset: nextOffsetFromRange(response.headers.get('range')) };
  }
  if (response.status === 404 || response.status === 410) {
    throw new UserFacingError(
      'The YouTube upload session expired. Start the upload again.',
      'upload_session_expired',
    );
  }
  return { done: false, offset: 0 };
}
