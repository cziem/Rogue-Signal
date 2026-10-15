import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION } from '../constants.js';
import { UserFacingError, errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { parseTimestamp } from '../youtube/metadata.js';
import type { ProgressReporter, YouTubeService } from '../youtube/service.js';
import * as s from './schemas.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Resolves the YouTube service for the caller (per-user in HTTP mode, singleton in stdio mode). */
export type ServiceResolver = (extra: ToolExtra) => Promise<YouTubeService>;

export const SERVER_INSTRUCTIONS = `YouTube publishing tools for the Rogue Signal channel (@officialroguesignal), home of the AI story series Agent Wars, Kill Switch and Ghost in the Stack.

Review gate (non-negotiable):
- upload_video ALWAYS uploads as private. There is no way to upload as public or unlisted.
- schedule_publish and make_public change what the public sees. Only call them after the human has explicitly approved that specific video in this conversation, and pass confirm: true. Never infer approval.

Typical flow: upload_video -> get_video_status until processingStatus is "succeeded" -> human reviews in YouTube Studio -> on approval, schedule_publish (or make_public).
Pinned comments are not supported by the YouTube API; tell the user to pin comments in YouTube Studio.`;

function ok(data: object, summary: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  const message =
    error instanceof UserFacingError ? error.message : `Unexpected error: ${errorMessage(error)}`;
  if (!(error instanceof UserFacingError))
    logger.error('tool failed', { error: errorMessage(error) });
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Strips undefined values so structuredContent is plain JSON. */
function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function progressReporter(extra: ToolExtra): ProgressReporter | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let lastSent = 0;
  return async (progress, total, message) => {
    const now = Date.now();
    if (now - lastSent < 1000 && progress !== total) return;
    lastSent = now;
    await extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, ...(total ? { total } : {}), message },
      })
      .catch(() => undefined);
  };
}

const confirmGuard = (confirm: unknown): void => {
  if (confirm !== true) {
    throw new UserFacingError(
      'Refused: confirm must be true, and only after the human explicitly approved this action.',
      'confirmation_required',
    );
  }
};

export function createMcpServer(resolveService: ServiceResolver): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );

  const run = async (
    extra: ToolExtra,
    fn: (service: YouTubeService) => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    try {
      return await fn(await resolveService(extra));
    } catch (error) {
      return fail(error);
    }
  };

  server.registerTool(
    'upload_video',
    {
      title: 'Upload video (private)',
      description:
        'Upload a video to the Rogue Signal channel. ALWAYS uploads as private (the channel has a human review gate; this cannot be overridden). ' +
        'Uses a resumable, streamed upload so large episode files are fine. Sets the AI/synthetic-content disclosure by default. ' +
        'Optionally adds the video to a playlist and sets a thumbnail. Returns the videoId and YouTube Studio URL. ' +
        'Processing continues on YouTube after upload; poll get_video_status.',
      inputSchema: {
        source: s.mediaSource,
        title: s.title,
        description: s.description.default(''),
        tags: s.tags.default([]),
        categoryId: s.categoryId.default('24'),
        madeForKids: z
          .boolean()
          .default(false)
          .describe('COPPA "made for kids" declaration. Default false.'),
        containsSyntheticMedia: z
          .boolean()
          .default(true)
          .describe(
            'Altered or synthetic content disclosure (status.containsSyntheticMedia). Default true for this AI-story channel.',
          ),
        defaultLanguage: s.language.optional(),
        playlistId: s.playlistId.optional(),
        thumbnail: s.mediaSource.optional().describe('Optional thumbnail (JPEG/PNG, max 2 MB).'),
      },
      outputSchema: s.uploadOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const result = await service.uploadVideo(args, progressReporter(extra), extra.signal);
        const data = clean({
          ...result,
          nextStep:
            'Video is PRIVATE. Ask the human to review it in YouTube Studio. Only after explicit approval, call schedule_publish or make_public with confirm: true.',
        });
        return ok(data, `Uploaded "${args.title}" as private: ${result.studioUrl}`);
      }),
  );

  server.registerTool(
    'schedule_publish',
    {
      title: 'Schedule publish (requires human approval)',
      description:
        'Schedule a private video to go public automatically at publishAt. The video stays private until then. ' +
        'ONLY call this after the human has explicitly reviewed and approved this specific video and time in the conversation; never infer approval. ' +
        'Requires confirm: true. publishAt must be an ISO 8601 timestamp in the future, with timezone (e.g. "2026-11-01T17:00:00Z").',
      inputSchema: {
        videoId: s.videoId,
        publishAt: z.iso
          .datetime({
            offset: true,
            message: 'publishAt must be ISO 8601 with a timezone, e.g. 2026-11-01T17:00:00Z.',
          })
          .describe('ISO 8601 timestamp with timezone, in the future.'),
        confirm: s.confirm,
      },
      outputSchema: s.videoStatusOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        confirmGuard(args.confirm);
        const status = await service.schedulePublish(args.videoId, args.publishAt);
        return ok(
          clean(status),
          `Scheduled ${args.videoId} to publish at ${status.publishAt ?? args.publishAt}.`,
        );
      }),
  );

  server.registerTool(
    'make_public',
    {
      title: 'Make public now (requires human approval)',
      description:
        'Immediately make a video public. ONLY call this after the human has explicitly reviewed and approved publishing this specific video right now; never infer approval. ' +
        'Requires confirm: true. Clears any scheduled publishAt. Note: unaudited Google API projects cannot make videos public (YouTube keeps them private).',
      inputSchema: { videoId: s.videoId, confirm: s.confirm },
      outputSchema: s.videoStatusOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        confirmGuard(args.confirm);
        const status = await service.makePublic(args.videoId);
        return ok(
          clean(status),
          `Video ${args.videoId} privacy is now "${status.privacyStatus ?? 'unknown'}".`,
        );
      }),
  );

  server.registerTool(
    'update_metadata',
    {
      title: 'Update video metadata',
      description:
        'Update title, description, tags, category and/or language of a video. Omitted fields are kept. ' +
        'chapters are rendered as timestamp lines in the description (replacing any existing chapter block); YouTube needs at least 3 chapters, the first at 0:00, each at least 10s. ' +
        'Does not change privacy.',
      inputSchema: {
        videoId: s.videoId,
        title: s.title.optional(),
        description: s.description.optional(),
        tags: s.tags.optional(),
        categoryId: s.categoryId.optional(),
        defaultLanguage: s.language.optional(),
        chapters: z.array(s.chapter).min(3).max(100).optional(),
      },
      outputSchema: s.updateMetadataOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const chapters = args.chapters?.map((c) => ({
          startSeconds: parseTimestamp(c.start),
          title: c.title,
        }));
        const result = await service.updateMetadata({ ...args, chapters });
        const data = clean({
          videoId: result.videoId,
          title: result.snippet.title ?? undefined,
          description: result.snippet.description ?? undefined,
          tags: result.snippet.tags ?? undefined,
          categoryId: result.snippet.categoryId ?? undefined,
          defaultLanguage: result.snippet.defaultLanguage ?? undefined,
          studioUrl: result.studioUrl,
        });
        return ok(data, `Updated metadata for ${args.videoId}.`);
      }),
  );

  server.registerTool(
    'set_thumbnail',
    {
      title: 'Set custom thumbnail',
      description:
        'Set a custom thumbnail (JPEG or PNG, max 2 MB; 1280x720 recommended) from a URL or local path (stdio only). ' +
        'The channel must be verified to use custom thumbnails.',
      inputSchema: { videoId: s.videoId, source: s.mediaSource },
      outputSchema: s.thumbnailOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const result = await service.setThumbnail(args.videoId, args.source);
        return ok(clean(result), `Thumbnail set for ${args.videoId}.`);
      }),
  );

  server.registerTool(
    'create_playlist',
    {
      title: 'Create playlist',
      description:
        'Create a playlist on the channel, e.g. one per series ("Agent Wars - Season 1"). Defaults to private; playlists are not part of the video review gate.',
      inputSchema: {
        title: z.string().trim().min(1).max(150).describe('Playlist title (max 150 chars).'),
        description: z.string().max(5000).optional(),
        privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
        defaultLanguage: s.language.optional(),
      },
      outputSchema: s.playlistOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const result = await service.createPlaylist(args);
        return ok(clean(result), `Created playlist "${args.title}" (${result.playlistId}).`);
      }),
  );

  server.registerTool(
    'list_playlists',
    {
      title: 'List playlists',
      description: "List the channel's playlists (paginated). Use nextPageToken to fetch more.",
      inputSchema: { pageToken: s.pageToken, maxResults: s.maxResults },
      outputSchema: s.playlistPageOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const page = await service.listPlaylists(args.pageToken, args.maxResults);
        return ok(
          clean(page),
          `${page.items.length} playlist(s)${page.nextPageToken ? '; more available' : ''}.`,
        );
      }),
  );

  server.registerTool(
    'add_to_playlist',
    {
      title: 'Add video to playlist',
      description:
        'Add a video to a playlist, optionally at a 0-based position. Adding the same video twice creates a duplicate entry.',
      inputSchema: {
        playlistId: s.playlistId,
        videoId: s.videoId,
        position: z.number().int().min(0).optional().describe('0-based position; omit to append.'),
      },
      outputSchema: s.addToPlaylistOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const result = await service.addToPlaylist(args.playlistId, args.videoId, args.position);
        return ok(clean(result), `Added ${args.videoId} to playlist ${args.playlistId}.`);
      }),
  );

  server.registerTool(
    'list_videos',
    {
      title: 'List channel uploads',
      description:
        "List the channel's uploads, newest first, including private and scheduled videos (paginated). Use nextPageToken to fetch more.",
      inputSchema: { pageToken: s.pageToken, maxResults: s.maxResults },
      outputSchema: s.videoPageOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const page = await service.listVideos(args.pageToken, args.maxResults);
        return ok(
          clean(page),
          `${page.items.length} video(s)${page.nextPageToken ? '; more available' : ''}.`,
        );
      }),
  );

  server.registerTool(
    'get_video_status',
    {
      title: 'Get video status',
      description:
        'Get upload and processing status, privacy, scheduled publishAt, and failure/rejection reasons for a video. ' +
        'Poll after upload_video until processingStatus is "succeeded" before asking the human to review.',
      inputSchema: { videoId: s.videoId },
      outputSchema: s.videoStatusOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(extra, async (service) => {
        const status = await service.getVideoStatus(args.videoId);
        return ok(
          clean(status),
          `${args.videoId}: privacy=${status.privacyStatus ?? '?'}, upload=${status.uploadStatus ?? '?'}, processing=${status.processingStatus ?? '?'}.`,
        );
      }),
  );

  return server;
}
