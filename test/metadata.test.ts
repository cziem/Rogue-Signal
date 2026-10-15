import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  normalizeTags,
  parseTimestamp,
  renderChapters,
  tagsLength,
} from '../src/youtube/metadata.js';

const chapters = [
  { startSeconds: 0, title: 'Cold open' },
  { startSeconds: 95, title: 'The rogue agent wakes' },
  { startSeconds: 3725, title: 'Kill switch' },
];

describe('timestamps', () => {
  it('formats and parses', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(95)).toBe('1:35');
    expect(formatTimestamp(3725)).toBe('1:02:05');
    expect(parseTimestamp('1:02:05')).toBe(3725);
    expect(parseTimestamp('01:35')).toBe(95);
    expect(parseTimestamp(12)).toBe(12);
    expect(() => parseTimestamp('abc')).toThrow(/Invalid chapter timestamp/);
  });
});

describe('renderChapters', () => {
  it('appends a chapter block', () => {
    expect(renderChapters('Episode 1 of Agent Wars.', chapters)).toBe(
      'Episode 1 of Agent Wars.\n\nChapters:\n0:00 Cold open\n1:35 The rogue agent wakes\n1:02:05 Kill switch',
    );
  });

  it('replaces an existing chapter block in place (idempotent)', () => {
    const once = renderChapters('Intro text\n\n#AgentWars', chapters);
    const twice = renderChapters(once, chapters);
    expect(twice).toBe(once);

    const existing = 'Intro\n\n0:00 Old A\n0:30 Old B\n1:00 Old C\n\nSubscribe!';
    expect(renderChapters(existing, chapters)).toBe(
      'Intro\n\n0:00 Cold open\n1:35 The rogue agent wakes\n1:02:05 Kill switch\n\nSubscribe!',
    );
  });

  it('enforces YouTube chapter rules', () => {
    expect(() => renderChapters('', chapters.slice(0, 2))).toThrow(/at least 3/);
    expect(() =>
      renderChapters('', [
        { startSeconds: 5, title: 'a' },
        { startSeconds: 50, title: 'b' },
        { startSeconds: 100, title: 'c' },
      ]),
    ).toThrow(/0:00/);
    expect(() =>
      renderChapters('', [
        { startSeconds: 0, title: 'a' },
        { startSeconds: 5, title: 'b' },
        { startSeconds: 100, title: 'c' },
      ]),
    ).toThrow(/10 seconds/);
  });

  it('enforces the description byte limit', () => {
    expect(() => renderChapters('x'.repeat(4990), chapters)).toThrow(/5000/);
  });
});

describe('tags', () => {
  it('normalizes, dedupes and strips hashes', () => {
    expect(normalizeTags(['#AI', 'ai', ' Agent Wars ', '', '<bad>'])).toEqual(['AI', 'Agent Wars']);
  });

  it('counts quotes for multi-word tags and enforces 500 chars', () => {
    expect(tagsLength(['a b', 'c'])).toBe(5 + 1 + 1);
    expect(() => normalizeTags(Array.from({ length: 60 }, (_, i) => `tag number ${i}`))).toThrow(
      /500/,
    );
  });
});
