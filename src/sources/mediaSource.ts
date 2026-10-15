import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { UserFacingError } from '../errors.js';
import type { FetchLike } from '../youtube/resumableUpload.js';

export type MediaSourceInput = { url: string } | { path: string };

export interface OpenedMedia {
  body: AsyncIterable<Uint8Array>;
  size: number | undefined;
  contentType: string;
  /** Human-readable label for logs and output. */
  label: string;
}

export interface SourceOptions {
  /** Local paths are only allowed in stdio mode (the HTTP server must not read its own disk). */
  allowLocalPaths: boolean;
  fetch?: FetchLike;
  /** Skip the private-address check (tests only). */
  allowPrivateNetworks?: boolean;
  /** Resolves a hostname to IPs (injected for tests). */
  resolveHost?: (host: string) => Promise<string[]>;
}

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
};
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export type MediaKind = 'video' | 'image';

function guessType(name: string, kind: MediaKind): string | undefined {
  const ext = extname(name.split('?')[0] ?? name).toLowerCase();
  return (kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES)[ext];
}

/** True for loopback, link-local (incl. cloud metadata 169.254.169.254), private and unique-local ranges. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

async function assertPublicUrl(url: URL, options: SourceOptions): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UserFacingError('Source URL must use http(s).', 'invalid_source');
  }
  if (url.username || url.password) {
    throw new UserFacingError(
      'Source URL must not embed credentials; use a signed URL instead.',
      'invalid_source',
    );
  }
  if (options.allowPrivateNetworks) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (options.resolveHost ?? defaultResolve)(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UserFacingError(
      'Source URL resolves to a private or internal address, which is not allowed.',
      'invalid_source',
    );
  }
}

const MAX_REDIRECTS = 5;

async function openUrl(raw: string, kind: MediaKind, options: SourceOptions): Promise<OpenedMedia> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserFacingError(`Invalid source URL: ${raw}`, 'invalid_source');
  }
  const doFetch = options.fetch ?? fetch;

  // Follow redirects manually so every hop passes the private-address check.
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url, options);
    response = await doFetch(url, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) {
    throw new UserFacingError(
      `Could not download source (${response ? `HTTP ${response.status}` : 'too many redirects'}). ` +
        'If it is a signed URL, check that it has not expired.',
      'invalid_source',
    );
  }

  const length = response.headers.get('content-length');
  const size = length && /^\d+$/.test(length) ? Number(length) : undefined;
  const headerType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const headerMatches = headerType?.startsWith(`${kind}/`) ?? false;
  const contentType =
    (headerMatches ? headerType : undefined) ??
    guessType(url.pathname, kind) ??
    (kind === 'video' ? 'video/*' : 'image/jpeg');

  return {
    body: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    size,
    contentType,
    label: `${url.origin}${url.pathname}`,
  };
}

async function openPath(
  raw: string,
  kind: MediaKind,
  options: SourceOptions,
): Promise<OpenedMedia> {
  if (!options.allowLocalPaths) {
    throw new UserFacingError(
      'Local file paths are only supported when the server runs locally over stdio. ' +
        'On the remote connector, pass a public or signed URL instead.',
      'invalid_source',
    );
  }
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new UserFacingError(`File not found: ${path}`, 'invalid_source');
  }
  if (!info.isFile()) throw new UserFacingError(`Not a file: ${path}`, 'invalid_source');
  return {
    body: createReadStream(path, { highWaterMark: 1024 * 1024 }),
    size: info.size,
    contentType: guessType(path, kind) ?? (kind === 'video' ? 'video/*' : 'image/jpeg'),
    label: path,
  };
}

export function openMedia(
  input: MediaSourceInput,
  kind: MediaKind,
  options: SourceOptions,
): Promise<OpenedMedia> {
  return 'url' in input ? openUrl(input.url, kind, options) : openPath(input.path, kind, options);
}

/** Reads a small media file fully into memory, enforcing a byte cap (used for thumbnails). */
export async function readMediaToBuffer(media: OpenedMedia, maxBytes: number): Promise<Buffer> {
  if (media.size !== undefined && media.size > maxBytes) {
    throw new UserFacingError(
      `File is too large (${media.size} bytes; max ${maxBytes}).`,
      'invalid_source',
    );
  }
  const parts: Buffer[] = [];
  let total = 0;
  for await (const piece of media.body) {
    total += piece.byteLength;
    if (total > maxBytes) {
      throw new UserFacingError(`File is too large (max ${maxBytes} bytes).`, 'invalid_source');
    }
    parts.push(Buffer.from(piece));
  }
  return Buffer.concat(parts);
}
