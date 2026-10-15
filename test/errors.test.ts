import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { normalizeGoogleError, toYouTubeError } from '../src/youtube/errors.js';
import { googleError } from './helpers.js';

describe('toYouTubeError', () => {
  it.each([
    ['quotaExceeded', 403, 'quota_exceeded', /quota/i],
    ['invalidPublishAt', 400, 'invalid_publish_at', /publishAt/],
    ['forbidden', 403, 'forbidden', /locked to private/],
    ['insufficientPermissions', 403, 'insufficient_scope', /scopes/],
    ['videoNotFound', 404, 'not_found', /list_videos/],
    ['uploadLimitExceeded', 400, 'upload_limit_exceeded', /upload limit/],
  ])('maps %s', (reason, status, code, pattern) => {
    const mapped = toYouTubeError(googleError(status, reason), 'doing a thing');
    expect(mapped).toBeInstanceOf(UserFacingError);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toMatch(pattern);
    expect(mapped.message).toContain('doing a thing');
  });

  it('maps OAuth invalid_grant (auth expiry)', () => {
    const error = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    });
    const mapped = toYouTubeError(error, 'refreshing');
    expect(mapped.code).toBe('auth_expired');
    expect(mapped.message).toMatch(/reconnect/i);
  });

  it('maps bare 401 and 5xx', () => {
    expect(toYouTubeError(Object.assign(new Error('x'), { status: 401 }), 'a').code).toBe(
      'auth_expired',
    );
    expect(toYouTubeError(Object.assign(new Error('x'), { status: 503 }), 'a').code).toBe(
      'unavailable',
    );
  });

  it('reads errors from fetch-style bodies', () => {
    const error = Object.assign(new Error('HTTP 403'), {
      status: 403,
      body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
    });
    expect(normalizeGoogleError(error).reason).toBe('quotaExceeded');
  });

  it('passes UserFacingErrors through', () => {
    const original = new UserFacingError('keep me');
    expect(toYouTubeError(original, 'x')).toBe(original);
  });
});
