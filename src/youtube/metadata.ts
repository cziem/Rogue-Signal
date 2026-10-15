import { DESCRIPTION_MAX_BYTES, TAGS_MAX_CHARS } from '../constants.js';
import { UserFacingError } from '../errors.js';

export interface Chapter {
  /** Seconds from the start of the video. */
  startSeconds: number;
  title: string;
}

/** Formats seconds as m:ss or h:mm:ss, the format YouTube recognizes for chapters. */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** Parses "1:02:03", "02:03" or a number of seconds. */
export function parseTimestamp(value: string | number): number {
  if (typeof value === 'number') return value;
  const parts = value.trim().split(':').map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) {
    throw new UserFacingError(
      `Invalid chapter timestamp "${value}". Use h:mm:ss, m:ss or seconds.`,
    );
  }
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

const CHAPTER_LINE = /^\s*\(?\d{1,2}(?::\d{2}){1,2}\)?\s+[-–—:]?\s*\S.*$/;

/**
 * Validates chapters against YouTube's rules (first at 0:00, at least 3, each >= 10s, ascending).
 * https://support.google.com/youtube/answer/9884579
 */
export function validateChapters(chapters: readonly Chapter[]): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.startSeconds - b.startSeconds);
  if (sorted.length < 3) {
    throw new UserFacingError('YouTube requires at least 3 chapters.', 'invalid_input');
  }
  if (sorted[0]?.startSeconds !== 0) {
    throw new UserFacingError('The first chapter must start at 0:00.', 'invalid_input');
  }
  for (const [i, current] of sorted.entries()) {
    const prev = sorted[i - 1];
    if (!prev) continue;
    if (current.startSeconds - prev.startSeconds < 10) {
      throw new UserFacingError(
        `Chapters must be at least 10 seconds long ("${prev.title}" -> "${current.title}").`,
        'invalid_input',
      );
    }
  }
  return sorted;
}

/**
 * Renders chapters into a description. Any existing chapter block (consecutive timestamp
 * lines) is replaced, so calling this repeatedly is idempotent.
 */
export function renderChapters(description: string, chapters: readonly Chapter[]): string {
  const valid = validateChapters(chapters);
  const block = valid.map((c) => `${formatTimestamp(c.startSeconds)} ${c.title.trim()}`).join('\n');

  const kept: string[] = [];
  let insertAt = -1;
  for (const line of description.split('\n')) {
    if (CHAPTER_LINE.test(line)) {
      if (insertAt === -1) insertAt = kept.length;
      continue;
    }
    kept.push(line);
  }
  let result: string;
  if (insertAt === -1) {
    const body = description.trimEnd();
    result = body.length > 0 ? `${body}\n\nChapters:\n${block}` : `Chapters:\n${block}`;
  } else {
    kept.splice(insertAt, 0, block);
    result = kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }
  assertDescription(result);
  return result;
}

export function assertDescription(description: string): void {
  const bytes = Buffer.byteLength(description, 'utf8');
  if (bytes > DESCRIPTION_MAX_BYTES) {
    throw new UserFacingError(
      `Description is ${bytes} bytes; YouTube's limit is ${DESCRIPTION_MAX_BYTES}.`,
      'invalid_input',
    );
  }
  if (/[<>]/.test(description)) {
    throw new UserFacingError('Description must not contain "<" or ">".', 'invalid_input');
  }
}

/**
 * YouTube counts tag length with quotes around tags that contain spaces, plus a comma
 * separator between tags.
 */
export function tagsLength(tags: readonly string[]): number {
  return tags.reduce(
    (sum, tag, i) => sum + tag.length + (tag.includes(' ') ? 2 : 0) + (i > 0 ? 1 : 0),
    0,
  );
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, '');
    if (tag.length === 0 || /[<>]/.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  const length = tagsLength(result);
  if (length > TAGS_MAX_CHARS) {
    throw new UserFacingError(
      `Tags total ${length} characters; YouTube's limit is ${TAGS_MAX_CHARS}. Remove some tags.`,
      'invalid_input',
    );
  }
  return result;
}

export { CHAPTER_LINE };
