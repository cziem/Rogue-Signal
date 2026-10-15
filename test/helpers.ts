import type { youtube_v3 } from 'googleapis';
import { vi, type Mock } from 'vitest';

type AnyFn = (...args: never[]) => unknown;

export interface FakeYouTube {
  channels: { list: Mock<AnyFn> };
  videos: { list: Mock<AnyFn>; update: Mock<AnyFn> };
  thumbnails: { set: Mock<AnyFn> };
  playlists: { insert: Mock<AnyFn>; list: Mock<AnyFn> };
  playlistItems: { insert: Mock<AnyFn>; list: Mock<AnyFn> };
}

export function fakeYouTube(): { fake: FakeYouTube; youtube: youtube_v3.Youtube } {
  const fake: FakeYouTube = {
    channels: { list: vi.fn() },
    videos: { list: vi.fn(), update: vi.fn() },
    thumbnails: { set: vi.fn() },
    playlists: { insert: vi.fn(), list: vi.fn() },
    playlistItems: { insert: vi.fn(), list: vi.fn() },
  };
  return { fake, youtube: fake as unknown as youtube_v3.Youtube };
}

export const data = <T>(value: T): { data: T } => ({ data: value });

/** A Google API style error as thrown by gaxios. */
export function googleError(status: number, reason: string, message = reason): Error {
  return Object.assign(new Error(message), {
    status,
    response: { status, data: { error: { code: status, message, errors: [{ reason }] } } },
  });
}

export async function* bytes(...pieces: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const piece of pieces) {
    yield typeof piece === 'string' ? Buffer.from(piece) : piece;
  }
  await Promise.resolve();
}

export const TEST_KEY = Buffer.alloc(32, 7);
