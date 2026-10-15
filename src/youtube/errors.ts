import { UserFacingError } from '../errors.js';

/** Shape of a Google API JSON error body (`{ error: { code, message, errors: [{ reason }] } }`). */
interface GoogleErrorBody {
  error?:
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: { reason?: string; message?: string; domain?: string }[];
      }
    | string;
  error_description?: string;
}

export interface NormalizedGoogleError {
  status: number | undefined;
  reason: string | undefined;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extracts status / reason / message from a GaxiosError, a fetch error body, or anything else. */
export function normalizeGoogleError(error: unknown): NormalizedGoogleError {
  if (!isRecord(error)) return { status: undefined, reason: undefined, message: String(error) };

  const response = isRecord(error.response) ? error.response : undefined;
  const status =
    typeof error.status === 'number'
      ? error.status
      : typeof response?.status === 'number'
        ? response.status
        : typeof error.code === 'number'
          ? error.code
          : undefined;

  const rawBody = response?.data ?? error.body;
  const body = isRecord(rawBody) ? (rawBody as GoogleErrorBody) : undefined;
  let reason: string | undefined;
  let message = typeof error.message === 'string' ? error.message : 'Unknown Google API error';

  if (typeof body?.error === 'string') {
    // OAuth token endpoint errors, e.g. { error: 'invalid_grant', error_description: '...' }
    reason = body.error;
    message = body.error_description ?? body.error;
  } else if (body?.error) {
    reason = body.error.errors?.[0]?.reason ?? body.error.status;
    message = body.error.message ?? message;
  }
  if (!reason && message.includes('invalid_grant')) reason = 'invalid_grant';
  return { status, reason, message };
}

const AUDIT_NOTE =
  'If this Google Cloud project has not passed the YouTube API Services audit, every video ' +
  'uploaded through it is locked to private by YouTube. Make the video public manually in ' +
  'YouTube Studio, or request an audit: https://support.google.com/youtube/contact/yt_api_form';

/**
 * Maps a Google/YouTube error to a UserFacingError with an actionable message.
 * `context` describes what was being attempted ("uploading video", ...).
 */
export function toYouTubeError(error: unknown, context: string): UserFacingError {
  if (error instanceof UserFacingError) return error;
  const { status, reason, message } = normalizeGoogleError(error);
  const prefix = `YouTube API error while ${context}`;

  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return new UserFacingError(
        `${prefix}: the daily YouTube Data API quota for this Google Cloud project is exhausted. ` +
          'Quota resets at midnight Pacific Time. Uploads are by far the most expensive call; ' +
          'check current costs at https://developers.google.com/youtube/v3/determine_quota_cost ' +
          'and request more quota in the Google Cloud console if needed. Do not retry until then.',
        'quota_exceeded',
      );
    case 'uploadLimitExceeded':
      return new UserFacingError(
        `${prefix}: the channel has hit YouTube's upload limit. Wait (typically 24h) before uploading again.`,
        'upload_limit_exceeded',
      );
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return new UserFacingError(
        `${prefix}: rate limited by YouTube. Wait a minute and retry.`,
        'rate_limited',
      );
    case 'invalidPublishAt':
      return new UserFacingError(
        `${prefix}: YouTube rejected publishAt. It must be an ISO 8601 timestamp in the future, ` +
          'and the video must be private (and not previously published) for scheduling to work.',
        'invalid_publish_at',
      );
    case 'invalid_grant':
    case 'authError':
      return new UserFacingError(
        `${prefix}: the stored Google authorization has expired or was revoked. ` +
          'Reconnect: in claude.ai, disconnect and reconnect the connector; in stdio mode, run ' +
          '`rogue-signal-mcp auth` again. (Apps in "Testing" publishing status get refresh tokens ' +
          'that expire after 7 days; publish the OAuth consent screen to avoid this.)',
        'auth_expired',
      );
    case 'insufficientPermissions':
    case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
      return new UserFacingError(
        `${prefix}: the Google authorization is missing the YouTube scopes. Reconnect and grant ` +
          'every requested permission on the Google consent screen.',
        'insufficient_scope',
      );
    case 'youtubeSignupRequired':
    case 'channelNotFound':
      return new UserFacingError(
        `${prefix}: the signed-in Google account has no YouTube channel. Sign in with the account ` +
          'that owns @officialroguesignal (or select the brand account during Google sign-in).',
        'no_channel',
      );
    case 'videoNotFound':
      return new UserFacingError(
        `${prefix}: video not found. Check the videoId (use list_videos) and that it belongs to this channel.`,
        'not_found',
      );
    case 'playlistNotFound':
      return new UserFacingError(
        `${prefix}: playlist not found. Use list_playlists to get a valid playlistId.`,
        'not_found',
      );
    case 'invalidCategoryId':
      return new UserFacingError(
        `${prefix}: invalid categoryId. Common IDs: 1 Film & Animation, 22 People & Blogs, ` +
          '24 Entertainment, 27 Education, 28 Science & Technology.',
        'invalid_input',
      );
    case 'invalidTitle':
    case 'invalidDescription':
    case 'invalidTags':
    case 'invalidVideoMetadata':
      return new UserFacingError(
        `${prefix}: ${message} (titles: max 100 chars; descriptions: max 5000 bytes; tags: max 500 chars total; no "<" or ">").`,
        'invalid_input',
      );
    case 'forbidden':
    case 'forbiddenPrivacySetting':
    case 'invalidPrivacyStatus':
      return new UserFacingError(`${prefix}: ${message}. ${AUDIT_NOTE}`, 'forbidden');
    default:
      break;
  }

  if (status === 401) {
    return new UserFacingError(
      `${prefix}: Google rejected the credentials (401). Reconnect the Google account.`,
      'auth_expired',
    );
  }
  if (status !== undefined && status >= 500) {
    return new UserFacingError(
      `${prefix}: YouTube is temporarily unavailable (${status}). Retry shortly.`,
      'unavailable',
    );
  }
  return new UserFacingError(
    `${prefix}: ${message}${reason ? ` (reason: ${reason})` : ''}`,
    'youtube_error',
  );
}

export { AUDIT_NOTE };
