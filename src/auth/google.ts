import { google, type youtube_v3 } from 'googleapis';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { GOOGLE_SCOPES } from '../constants.js';
import { UserFacingError } from '../errors.js';
import { pkceChallenge } from '../crypto.js';
import { toYouTubeError } from '../youtube/errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | undefined;
  idToken: string | undefined;
}

export interface GoogleChannel {
  channelId: string;
  title: string;
}

/** The upstream Google OAuth operations the authorization server needs (an interface so tests can fake it). */
export interface GoogleOAuth {
  authorizationUrl(params: { state: string; codeVerifier: string; redirectUri: string }): string;
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<GoogleTokenSet>;
  verifyIdToken(idToken: string): Promise<GoogleIdentity>;
  fetchChannel(accessToken: string): Promise<GoogleChannel>;
}

export class GoogleOAuthClient implements GoogleOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private client(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    });
  }

  authorizationUrl(params: { state: string; codeVerifier: string; redirectUri: string }): string {
    return this.client(params.redirectUri).generateAuthUrl({
      access_type: 'offline',
      // Always show consent so Google returns a refresh token and the user sees what is granted.
      prompt: 'consent select_account',
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state: params.state,
      code_challenge: pkceChallenge(params.codeVerifier),
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<GoogleTokenSet> {
    try {
      const { tokens } = await this.client(redirectUri).getToken({
        code,
        codeVerifier,
        redirect_uri: redirectUri,
      });
      if (!tokens.access_token) throw new UserFacingError('Google returned no access token.');
      const scopes = new Set((tokens.scope ?? '').split(' '));
      const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !scopes.has(s));
      if (tokens.scope && missing.length > 0) {
        throw new UserFacingError(
          `Google sign-in did not grant the required YouTube permissions (${missing.join(', ')}). ` +
            'Try again and leave every permission checkbox ticked.',
          'insufficient_scope',
        );
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        idToken: tokens.id_token ?? undefined,
      };
    } catch (error) {
      throw toYouTubeError(error, 'exchanging the Google authorization code');
    }
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const ticket = await this.client().verifyIdToken({ idToken, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new UserFacingError('Google ID token is missing the subject or email claim.');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
    };
  }

  async fetchChannel(accessToken: string): Promise<GoogleChannel> {
    const auth = this.client();
    auth.setCredentials({ access_token: accessToken });
    const youtube = google.youtube({ version: 'v3', auth });
    try {
      const response = await youtube.channels.list({ part: ['snippet'], mine: true });
      const channel = response.data.items?.[0];
      if (!channel?.id) {
        throw new UserFacingError(
          'This Google account has no YouTube channel. Sign in again and pick the account or brand account that owns the channel.',
          'no_channel',
        );
      }
      return { channelId: channel.id, title: channel.snippet?.title ?? '' };
    } catch (error) {
      throw toYouTubeError(error, 'looking up your YouTube channel');
    }
  }
}

/** Builds an authenticated YouTube client from a stored refresh token. */
export function createYouTubeClient(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefreshTokenRotated?: (refreshToken: string) => void;
}): { youtube: youtube_v3.Youtube; getAccessToken: () => Promise<string> } {
  const auth = new OAuth2Client({ clientId: params.clientId, clientSecret: params.clientSecret });
  auth.setCredentials({ refresh_token: params.refreshToken });
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token && tokens.refresh_token !== params.refreshToken) {
      params.onRefreshTokenRotated?.(tokens.refresh_token);
    }
  });
  const getAccessToken = async (): Promise<string> => {
    try {
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error('invalid_grant: no access token returned');
      return token;
    } catch (error) {
      throw toYouTubeError(error, 'refreshing the Google access token');
    }
  };
  return { youtube: google.youtube({ version: 'v3', auth }), getAccessToken };
}
