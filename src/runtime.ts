import { createYouTubeClient } from './auth/google.js';
import type { GoogleProxyOAuthProvider } from './auth/provider.js';
import type { BaseConfig } from './config.js';
import { userIdFromExtra } from './http/app.js';
import { logger } from './logger.js';
import type { ServiceResolver } from './mcp/server.js';
import { YouTubeService } from './youtube/service.js';

/**
 * HTTP mode: one YouTubeService per Google user, built from that user's sealed refresh token.
 * Cached so the googleapis client can reuse its access token between requests.
 */
export function httpServiceResolver(
  config: BaseConfig,
  provider: GoogleProxyOAuthProvider,
): ServiceResolver {
  const cache = new Map<string, { service: YouTubeService; refreshToken: string }>();
  return async (extra) => {
    const userId = userIdFromExtra(extra);
    const { refreshToken } = await provider.getGoogleRefreshToken(userId);
    const cached = cache.get(userId);
    if (cached?.refreshToken === refreshToken) return cached.service;

    const client = createYouTubeClient({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken,
      onRefreshTokenRotated: (rotated) => {
        provider.updateGoogleRefreshToken(userId, rotated).catch((error: unknown) => {
          logger.error('failed to persist rotated Google refresh token', { error: String(error) });
        });
      },
    });
    const service = new YouTubeService({
      youtube: client.youtube,
      getAccessToken: client.getAccessToken,
      sourceOptions: { allowLocalPaths: false },
    });
    cache.set(userId, { service, refreshToken });
    return service;
  };
}
