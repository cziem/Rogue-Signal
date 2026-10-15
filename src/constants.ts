export const SERVER_NAME = 'rogue-signal-youtube-mcp-server';
export const SERVER_VERSION = '1.0.0';

/** Google OAuth scopes requested from the channel owner. */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
] as const;

/** Scope advertised by this server's own authorization server to MCP clients. */
export const MCP_SCOPE = 'youtube';

export const MCP_PATH = '/mcp';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

export const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
export const STUDIO_VIDEO_URL = (videoId: string): string =>
  `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;
export const WATCH_URL = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
export const PLAYLIST_URL = (playlistId: string): string =>
  `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

/** Resumable upload chunks must be multiples of 256 KiB (except the last one). */
export const UPLOAD_CHUNK_QUANTUM = 256 * 1024;

/** YouTube limits (https://developers.google.com/youtube/v3/docs/videos#resource). */
export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5000;
export const TAGS_MAX_CHARS = 500;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Default allowlisted channel handle when no channel allowlist is configured. */
export const DEFAULT_CHANNEL_HANDLE = '@officialroguesignal';
