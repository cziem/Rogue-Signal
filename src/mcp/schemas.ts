import { z } from 'zod';
import { TITLE_MAX_CHARS } from '../constants.js';

export const videoId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{6,20}$/, 'Expected a YouTube video ID such as "dQw4w9WgXcQ".')
  .describe('YouTube video ID (e.g. "dQw4w9WgXcQ"). Get it from upload_video or list_videos.');

export const playlistId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{10,64}$/, 'Expected a YouTube playlist ID such as "PLxxxxxxxx".')
  .describe('YouTube playlist ID (e.g. "PL..."). Get it from list_playlists or create_playlist.');

export const mediaSource = z
  .union([
    z
      .object({
        url: z.url().describe('Public or signed http(s) URL. Streamed; never buffered whole.'),
      })
      .strict(),
    z
      .object({
        path: z.string().min(1).describe('Local file path. Only works in local stdio mode.'),
      })
      .strict(),
  ])
  .describe(
    'Either { "url": "https://..." } or { "path": "/local/file" } (path: stdio mode only).',
  );

export const title = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_MAX_CHARS)
  .refine((v) => !/[<>]/.test(v), 'Title must not contain "<" or ">".')
  .describe(`Video title, max ${TITLE_MAX_CHARS} characters, no "<" or ">".`);

export const description = z
  .string()
  .describe('Video description (max 5000 bytes, no "<" or ">"). Hashtags and links are fine.');

export const tags = z
  .array(z.string().min(1).max(100))
  .max(100)
  .describe('Tags without "#". Combined length must stay under 500 characters.');

export const categoryId = z
  .string()
  .regex(/^\d{1,3}$/, 'categoryId must be a numeric string such as "24".')
  .describe(
    'YouTube category ID as a string. Common: "1" Film & Animation, "24" Entertainment, "27" Education, "28" Science & Technology.',
  );

export const language = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a BCP-47 language code such as "en" or "en-GB".')
  .describe('BCP-47 language code of the title/description and audio, e.g. "en".');

export const confirm = z
  .literal(true)
  .describe(
    'Must be exactly true. Only set this after the human has explicitly reviewed the video and approved this action in the conversation.',
  );

export const pageToken = z
  .string()
  .min(1)
  .optional()
  .describe('nextPageToken from a previous call.');
export const maxResults = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(25)
  .describe('Items per page (1-50).');

export const chapter = z.object({
  start: z
    .union([z.string(), z.number().nonnegative()])
    .describe('Start time as "m:ss", "h:mm:ss" or seconds. The first chapter must start at 0.'),
  title: z.string().trim().min(1).max(100).describe('Chapter title.'),
});

// ----------------------------------------------------------------------------
// Output schemas (structuredContent)
// ----------------------------------------------------------------------------

const optionalString = z.string().optional();

export const videoStatusOutput = {
  videoId: z.string(),
  title: optionalString,
  privacyStatus: optionalString,
  publishAt: optionalString,
  uploadStatus: optionalString,
  failureReason: optionalString,
  rejectionReason: optionalString,
  processingStatus: optionalString,
  processingFailureReason: optionalString,
  processingProgress: z
    .object({
      partsTotal: z.number().optional(),
      partsProcessed: z.number().optional(),
      timeLeftMs: z.number().optional(),
    })
    .optional(),
  madeForKids: z.boolean().optional(),
  containsSyntheticMedia: z.boolean().optional(),
  license: optionalString,
  embeddable: z.boolean().optional(),
  duration: optionalString,
  studioUrl: z.string(),
  watchUrl: z.string(),
  notes: z.array(z.string()),
};

export const uploadOutput = {
  videoId: z.string(),
  privacyStatus: z.string(),
  studioUrl: z.string(),
  watchUrl: z.string(),
  uploadStatus: optionalString,
  processingStatus: optionalString,
  bytesUploaded: z.number(),
  playlistItemId: optionalString,
  thumbnailSet: z.boolean(),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export const playlistOutput = {
  playlistId: z.string(),
  title: optionalString,
  description: optionalString,
  privacyStatus: optionalString,
  itemCount: z.number().optional(),
  url: z.string(),
};

export const playlistPageOutput = {
  items: z.array(z.object(playlistOutput)),
  nextPageToken: optionalString,
  totalResults: z.number().optional(),
};

export const videoPageOutput = {
  items: z.array(
    z.object({
      videoId: z.string(),
      title: optionalString,
      publishedAt: optionalString,
      privacyStatus: optionalString,
      publishAt: optionalString,
      uploadStatus: optionalString,
      studioUrl: z.string(),
    }),
  ),
  nextPageToken: optionalString,
  totalResults: z.number().optional(),
};

export const addToPlaylistOutput = {
  playlistItemId: z.string(),
  playlistId: z.string(),
  videoId: z.string(),
  position: z.number().optional(),
};

export const updateMetadataOutput = {
  videoId: z.string(),
  title: optionalString,
  description: optionalString,
  tags: z.array(z.string()).optional(),
  categoryId: optionalString,
  defaultLanguage: optionalString,
  studioUrl: z.string(),
};

export const thumbnailOutput = {
  videoId: z.string(),
  thumbnailUrl: optionalString,
};
