import { Readable } from 'node:stream';
import type { youtube_v3 } from 'googleapis';
import { PLAYLIST_URL, STUDIO_VIDEO_URL, THUMBNAIL_MAX_BYTES, WATCH_URL } from '../constants.js';
import { UserFacingError } from '../errors.js';
import {
  openMedia,
  readMediaToBuffer,
  type MediaSourceInput,
  type SourceOptions,
} from '../sources/mediaSource.js';
import { toYouTubeError } from './errors.js';
import { assertDescription, normalizeTags, renderChapters, type Chapter } from './metadata.js';
import { resumableUpload, type FetchLike } from './resumableUpload.js';

/** The only privacy status this server ever uploads with. Do not make this configurable. */
export const UPLOAD_PRIVACY_STATUS = 'private' as const;

export interface UploadVideoInput {
  source: MediaSourceInput;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  defaultLanguage?: string | undefined;
  playlistId?: string | undefined;
  thumbnail?: MediaSourceInput | undefined;
}

export interface UploadVideoResult {
  videoId: string;
  privacyStatus: string;
  studioUrl: string;
  watchUrl: string;
  uploadStatus: string | undefined;
  processingStatus: string | undefined;
  bytesUploaded: number;
  playlistItemId: string | undefined;
  thumbnailSet: boolean;
  warnings: string[];
}

export interface VideoStatus {
  videoId: string;
  title: string | undefined;
  privacyStatus: string | undefined;
  publishAt: string | undefined;
  uploadStatus: string | undefined;
  failureReason: string | undefined;
  rejectionReason: string | undefined;
  processingStatus: string | undefined;
  processingFailureReason: string | undefined;
  processingProgress:
    | {
        partsTotal: number | undefined;
        partsProcessed: number | undefined;
        timeLeftMs: number | undefined;
      }
    | undefined;
  madeForKids: boolean | undefined;
  containsSyntheticMedia: boolean | undefined;
  license: string | undefined;
  embeddable: boolean | undefined;
  duration: string | undefined;
  studioUrl: string;
  watchUrl: string;
  /** Hint when the API reports the video as private despite a public request (unaudited app lock). */
  notes: string[];
}

export interface VideoSummary {
  videoId: string;
  title: string | undefined;
  publishedAt: string | undefined;
  privacyStatus: string | undefined;
  publishAt: string | undefined;
  uploadStatus: string | undefined;
  studioUrl: string;
}

export interface PlaylistSummary {
  playlistId: string;
  title: string | undefined;
  description: string | undefined;
  privacyStatus: string | undefined;
  itemCount: number | undefined;
  url: string;
}

export interface Page<T> {
  items: T[];
  nextPageToken: string | undefined;
  totalResults: number | undefined;
}

export interface UpdateMetadataInput {
  videoId: string;
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  categoryId?: string | undefined;
  defaultLanguage?: string | undefined;
  chapters?: Chapter[] | undefined;
}

export interface YouTubeServiceDeps {
  youtube: youtube_v3.Youtube;
  getAccessToken: () => Promise<string>;
  sourceOptions: SourceOptions;
  fetch?: FetchLike;
  now?: () => Date;
  uploadChunkSize?: number;
}

export type ProgressReporter = (
  progress: number,
  total: number | undefined,
  message: string,
) => Promise<void>;

const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

/**
 * All YouTube operations. Every method maps Google errors to actionable UserFacingErrors.
 */
export class YouTubeService {
  private readonly youtube: youtube_v3.Youtube;
  private readonly now: () => Date;
  private uploadsPlaylistId: string | undefined;

  constructor(private readonly deps: YouTubeServiceDeps) {
    this.youtube = deps.youtube;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Channel
  // ---------------------------------------------------------------------------

  async getMyChannel(): Promise<{
    channelId: string;
    title: string;
    uploadsPlaylistId: string | undefined;
  }> {
    const response = await this.call('fetching your channel', () =>
      this.youtube.channels.list({ part: ['snippet', 'contentDetails'], mine: true }),
    );
    const channel = response.data.items?.[0];
    if (!channel?.id) {
      throw new UserFacingError(
        'The signed-in Google account has no YouTube channel. Sign in with the account (or brand account) that owns the channel.',
        'no_channel',
      );
    }
    this.uploadsPlaylistId = opt(channel.contentDetails?.relatedPlaylists?.uploads);
    return {
      channelId: channel.id,
      title: channel.snippet?.title ?? '',
      uploadsPlaylistId: this.uploadsPlaylistId,
    };
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  async uploadVideo(
    input: UploadVideoInput,
    onProgress?: ProgressReporter,
    signal?: AbortSignal,
  ): Promise<UploadVideoResult> {
    assertDescription(input.description);
    const tags = normalizeTags(input.tags);
    const media = await openMedia(input.source, 'video', this.deps.sourceOptions);

    const resource: youtube_v3.Schema$Video = {
      snippet: {
        title: input.title,
        description: input.description,
        tags,
        categoryId: input.categoryId,
        ...(input.defaultLanguage
          ? { defaultLanguage: input.defaultLanguage, defaultAudioLanguage: input.defaultLanguage }
          : {}),
      },
      status: {
        // Review gate: uploads are ALWAYS private. Publishing is a separate, confirmed step.
        privacyStatus: UPLOAD_PRIVACY_STATUS,
        selfDeclaredMadeForKids: input.madeForKids,
        containsSyntheticMedia: input.containsSyntheticMedia,
        embeddable: true,
        license: 'youtube',
      },
    };

    let bytesUploaded = 0;
    const uploaded = await resumableUpload({
      resource,
      parts: ['snippet', 'status'],
      body: media.body,
      contentType: media.contentType,
      size: media.size,
      getAccessToken: this.deps.getAccessToken,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.uploadChunkSize ? { chunkSize: this.deps.uploadChunkSize } : {}),
      ...(signal ? { signal } : {}),
      onProgress: async (done, total) => {
        bytesUploaded = done;
        await onProgress?.(
          done,
          total,
          `Uploaded ${formatBytes(done)}${total ? ` of ${formatBytes(total)}` : ''}`,
        );
      },
    });
    const videoId = uploaded.id;
    if (!videoId)
      throw new UserFacingError('YouTube accepted the upload but returned no video ID.');

    const warnings: string[] = [];
    const privacy = uploaded.status?.privacyStatus ?? UPLOAD_PRIVACY_STATUS;

    let thumbnailSet = false;
    if (input.thumbnail) {
      try {
        await this.setThumbnail(videoId, input.thumbnail);
        thumbnailSet = true;
      } catch (error) {
        warnings.push(`Video uploaded, but the thumbnail failed: ${(error as Error).message}`);
      }
    }

    let playlistItemId: string | undefined;
    if (input.playlistId) {
      try {
        playlistItemId = (await this.addToPlaylist(input.playlistId, videoId)).playlistItemId;
      } catch (error) {
        warnings.push(
          `Video uploaded, but adding it to the playlist failed: ${(error as Error).message}`,
        );
      }
    }

    return {
      videoId,
      privacyStatus: privacy,
      studioUrl: STUDIO_VIDEO_URL(videoId),
      watchUrl: WATCH_URL(videoId),
      uploadStatus: opt(uploaded.status?.uploadStatus),
      processingStatus: opt(uploaded.processingDetails?.processingStatus) ?? 'processing',
      bytesUploaded,
      playlistItemId,
      thumbnailSet,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Publishing (review gate: both require explicit human confirmation at the tool layer)
  // ---------------------------------------------------------------------------

  async schedulePublish(videoId: string, publishAt: string): Promise<VideoStatus> {
    const when = new Date(publishAt);
    if (Number.isNaN(when.getTime())) {
      throw new UserFacingError(
        `publishAt "${publishAt}" is not a valid ISO 8601 timestamp.`,
        'invalid_publish_at',
      );
    }
    if (when.getTime() <= this.now().getTime() + 60_000) {
      throw new UserFacingError(
        `publishAt (${when.toISOString()}) must be in the future (at least a minute from now; it is ${this.now().toISOString()}).`,
        'invalid_publish_at',
      );
    }
    const current = await this.getVideoResource(videoId, ['status']);
    const status = current.status ?? {};
    if (status.privacyStatus === 'public') {
      throw new UserFacingError(
        'This video is already public; YouTube only schedules private videos.',
        'invalid_publish_at',
      );
    }
    await this.call('scheduling the video', () =>
      this.youtube.videos.update({
        part: ['status'],
        requestBody: {
          id: videoId,
          status: {
            ...pickWritableStatus(status),
            privacyStatus: 'private',
            publishAt: when.toISOString(),
          },
        },
      }),
    );
    return this.getVideoStatus(videoId);
  }

  async makePublic(videoId: string): Promise<VideoStatus> {
    const current = await this.getVideoResource(videoId, ['status']);
    const status = pickWritableStatus(current.status ?? {});
    delete status.publishAt;
    await this.call('making the video public', () =>
      this.youtube.videos.update({
        part: ['status'],
        requestBody: { id: videoId, status: { ...status, privacyStatus: 'public' } },
      }),
    );
    const result = await this.getVideoStatus(videoId);
    if (result.privacyStatus !== 'public') {
      result.notes.push(
        'YouTube kept the video private. Unaudited Google API projects can only create private videos; ' +
          'publish it manually in YouTube Studio or complete the YouTube API audit.',
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  async updateMetadata(
    input: UpdateMetadataInput,
  ): Promise<{ videoId: string; snippet: youtube_v3.Schema$VideoSnippet; studioUrl: string }> {
    const current = await this.getVideoResource(input.videoId, ['snippet']);
    const snippet = current.snippet ?? {};
    let description = input.description ?? snippet.description ?? '';
    if (input.chapters) description = renderChapters(description, input.chapters);
    assertDescription(description);

    const next: youtube_v3.Schema$VideoSnippet = {
      title: input.title ?? snippet.title ?? '',
      description,
      // categoryId is required by videos.update with part=snippet.
      categoryId: input.categoryId ?? snippet.categoryId ?? '24',
      tags: input.tags ? normalizeTags(input.tags) : (snippet.tags ?? []),
    };
    const language = input.defaultLanguage ?? snippet.defaultLanguage;
    if (language) next.defaultLanguage = language;
    if (snippet.defaultAudioLanguage) next.defaultAudioLanguage = snippet.defaultAudioLanguage;

    const response = await this.call('updating video metadata', () =>
      this.youtube.videos.update({
        part: ['snippet'],
        requestBody: { id: input.videoId, snippet: next },
      }),
    );
    return {
      videoId: input.videoId,
      snippet: response.data.snippet ?? next,
      studioUrl: STUDIO_VIDEO_URL(input.videoId),
    };
  }

  async setThumbnail(
    videoId: string,
    source: MediaSourceInput,
  ): Promise<{ videoId: string; thumbnailUrl: string | undefined }> {
    const media = await openMedia(source, 'image', this.deps.sourceOptions);
    if (!['image/jpeg', 'image/png'].includes(media.contentType)) {
      throw new UserFacingError(
        `Thumbnails must be JPEG or PNG (got ${media.contentType}).`,
        'invalid_source',
      );
    }
    const data = await readMediaToBuffer(media, THUMBNAIL_MAX_BYTES);
    const response = await this.call('setting the thumbnail', () =>
      this.youtube.thumbnails.set({
        videoId,
        media: { mimeType: media.contentType, body: Readable.from(data) },
      }),
    );
    const thumbs = response.data.items?.[0];
    return {
      videoId,
      thumbnailUrl: opt(thumbs?.maxres?.url ?? thumbs?.high?.url ?? thumbs?.default?.url),
    };
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  async createPlaylist(input: {
    title: string;
    description?: string | undefined;
    privacyStatus: 'private' | 'unlisted' | 'public';
    defaultLanguage?: string | undefined;
  }): Promise<PlaylistSummary> {
    const response = await this.call('creating the playlist', () =>
      this.youtube.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: input.title,
            description: input.description ?? '',
            ...(input.defaultLanguage ? { defaultLanguage: input.defaultLanguage } : {}),
          },
          status: { privacyStatus: input.privacyStatus },
        },
      }),
    );
    return toPlaylistSummary(response.data);
  }

  async listPlaylists(pageToken?: string, maxResults = 25): Promise<Page<PlaylistSummary>> {
    const response = await this.call('listing playlists', () =>
      this.youtube.playlists.list({
        part: ['snippet', 'status', 'contentDetails'],
        mine: true,
        maxResults,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
    return {
      items: (response.data.items ?? []).map(toPlaylistSummary),
      nextPageToken: opt(response.data.nextPageToken),
      totalResults: opt(response.data.pageInfo?.totalResults),
    };
  }

  async addToPlaylist(
    playlistId: string,
    videoId: string,
    position?: number,
  ): Promise<{
    playlistItemId: string;
    playlistId: string;
    videoId: string;
    position: number | undefined;
  }> {
    const response = await this.call('adding the video to the playlist', () =>
      this.youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId },
            ...(position !== undefined ? { position } : {}),
          },
        },
      }),
    );
    return {
      playlistItemId: response.data.id ?? '',
      playlistId,
      videoId,
      position: opt(response.data.snippet?.position),
    };
  }

  // ---------------------------------------------------------------------------
  // Listing & status
  // ---------------------------------------------------------------------------

  async listVideos(pageToken?: string, maxResults = 25): Promise<Page<VideoSummary>> {
    const uploads = this.uploadsPlaylistId ?? (await this.getMyChannel()).uploadsPlaylistId;
    if (!uploads) return { items: [], nextPageToken: undefined, totalResults: 0 };

    const page = await this.call('listing uploads', () =>
      this.youtube.playlistItems.list({
        part: ['contentDetails'],
        playlistId: uploads,
        maxResults,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
    const ids = (page.data.items ?? [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => typeof id === 'string');

    let videos: youtube_v3.Schema$Video[] = [];
    if (ids.length > 0) {
      const details = await this.call('fetching video details', () =>
        this.youtube.videos.list({ part: ['snippet', 'status'], id: ids, maxResults: ids.length }),
      );
      const byId = new Map((details.data.items ?? []).map((v) => [v.id, v]));
      videos = ids.map((id) => byId.get(id) ?? { id });
    }
    return {
      items: videos.map((v) => ({
        videoId: v.id ?? '',
        title: opt(v.snippet?.title),
        publishedAt: opt(v.snippet?.publishedAt),
        privacyStatus: opt(v.status?.privacyStatus),
        publishAt: opt(v.status?.publishAt),
        uploadStatus: opt(v.status?.uploadStatus),
        studioUrl: STUDIO_VIDEO_URL(v.id ?? ''),
      })),
      nextPageToken: opt(page.data.nextPageToken),
      totalResults: opt(page.data.pageInfo?.totalResults),
    };
  }

  async getVideoStatus(videoId: string): Promise<VideoStatus> {
    // processingDetails is only returned to the video owner.
    const video = await this.getVideoResource(videoId, [
      'snippet',
      'status',
      'processingDetails',
      'contentDetails',
    ]);
    const status = video.status ?? {};
    const processing = video.processingDetails;
    const notes: string[] = [];
    if (status.uploadStatus === 'rejected')
      notes.push(`Rejected by YouTube: ${status.rejectionReason ?? 'unknown reason'}.`);
    if (status.uploadStatus === 'failed')
      notes.push(`Upload failed: ${status.failureReason ?? 'unknown reason'}.`);
    if (status.privacyStatus === 'private' && status.publishAt) {
      notes.push(`Scheduled to go public at ${status.publishAt}.`);
    }
    return {
      videoId,
      title: opt(video.snippet?.title),
      privacyStatus: opt(status.privacyStatus),
      publishAt: opt(status.publishAt),
      uploadStatus: opt(status.uploadStatus),
      failureReason: opt(status.failureReason),
      rejectionReason: opt(status.rejectionReason),
      processingStatus: opt(processing?.processingStatus),
      processingFailureReason: opt(processing?.processingFailureReason),
      processingProgress: processing?.processingProgress
        ? {
            partsTotal: toNumber(processing.processingProgress.partsTotal),
            partsProcessed: toNumber(processing.processingProgress.partsProcessed),
            timeLeftMs: toNumber(processing.processingProgress.timeLeftMs),
          }
        : undefined,
      madeForKids: opt(status.madeForKids ?? status.selfDeclaredMadeForKids),
      containsSyntheticMedia: opt(status.containsSyntheticMedia),
      license: opt(status.license),
      embeddable: opt(status.embeddable),
      duration: opt(video.contentDetails?.duration),
      studioUrl: STUDIO_VIDEO_URL(videoId),
      watchUrl: WATCH_URL(videoId),
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async getVideoResource(
    videoId: string,
    parts: string[],
  ): Promise<youtube_v3.Schema$Video> {
    const response = await this.call('fetching the video', () =>
      this.youtube.videos.list({ part: parts, id: [videoId] }),
    );
    const video = response.data.items?.[0];
    if (!video) {
      throw new UserFacingError(
        `Video ${videoId} was not found on this channel. Use list_videos to find valid IDs.`,
        'not_found',
      );
    }
    return video;
  }

  private async call<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toYouTubeError(error, context);
    }
  }
}

/** Fields of status that videos.update accepts; omitting them on update would reset them. */
function pickWritableStatus(status: youtube_v3.Schema$VideoStatus): youtube_v3.Schema$VideoStatus {
  const result: youtube_v3.Schema$VideoStatus = {};
  if (status.privacyStatus != null) result.privacyStatus = status.privacyStatus;
  if (status.publishAt != null) result.publishAt = status.publishAt;
  if (status.embeddable != null) result.embeddable = status.embeddable;
  if (status.license != null) result.license = status.license;
  if (status.publicStatsViewable != null) result.publicStatsViewable = status.publicStatsViewable;
  if (status.selfDeclaredMadeForKids != null)
    result.selfDeclaredMadeForKids = status.selfDeclaredMadeForKids;
  else if (status.madeForKids != null) result.selfDeclaredMadeForKids = status.madeForKids;
  if (status.containsSyntheticMedia != null)
    result.containsSyntheticMedia = status.containsSyntheticMedia;
  return result;
}

function toPlaylistSummary(p: youtube_v3.Schema$Playlist): PlaylistSummary {
  return {
    playlistId: p.id ?? '',
    title: opt(p.snippet?.title),
    description: opt(p.snippet?.description),
    privacyStatus: opt(p.status?.privacyStatus),
    itemCount: opt(p.contentDetails?.itemCount),
    url: PLAYLIST_URL(p.id ?? ''),
  };
}

function toNumber(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}
