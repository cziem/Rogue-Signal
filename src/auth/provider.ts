import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { GOOGLE_CALLBACK_PATH, MCP_SCOPE } from '../constants.js';
import { hashToken, open, randomToken, seal } from '../crypto.js';
import { UserFacingError, errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import type { StateStore } from '../store/encryptedFileStore.js';
import type { Grant, UserRecord } from '../store/state.js';
import { renderConsentPage, renderMessagePage } from './consentPage.js';
import type { GoogleOAuth } from './google.js';
import { isAllowedRedirectUri, type RedirectPolicy } from './redirects.js';

export const CONSENT_ACTION_PATH = '/oauth/consent';
const PENDING_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 5 * 60;

export interface ProviderOptions {
  store: StateStore;
  google: GoogleOAuth;
  encryptionKey: Buffer;
  publicBaseUrl: URL;
  resourceUrl: URL;
  allowedEmails: readonly string[];
  allowedChannelIds: readonly string[];
  redirectPolicy: RedirectPolicy;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  now?: () => number;
}

export const refreshTokenAad = (userId: string): string => `google-refresh:${userId}`;

function sameResource(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * OAuth 2.1 authorization server for MCP clients that delegates user authentication to Google.
 *
 * Flow: client -> /authorize -> consent page -> Google sign-in -> /oauth/google/callback
 * -> (allowlist + channel check, store sealed Google refresh token) -> redirect to client with
 * our own authorization code -> /token issues our own opaque access + refresh tokens.
 *
 * Google tokens never leave the server; MCP clients only ever see tokens issued here.
 */
export class GoogleProxyOAuthProvider implements OAuthServerProvider {
  private readonly now: () => number;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly options: ProviderOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const { store, redirectPolicy } = options;
    this.clientsStore = {
      getClient: (clientId) => store.read((state) => state.clients[clientId]),
      registerClient: async (client) => {
        const bad = client.redirect_uris.filter(
          (uri) => !isAllowedRedirectUri(uri, redirectPolicy),
        );
        if (bad.length > 0) {
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed by this server: ${bad.join(', ')}. ` +
              'Allowed: https URIs on OAUTH_ALLOWED_REDIRECT_ORIGINS, or loopback http URIs.',
          );
        }
        const full = client as OAuthClientInformationFull;
        await store.update((state) => {
          state.clients[full.client_id] = full;
        });
        logger.info('registered OAuth client', {
          clientId: full.client_id,
          name: full.client_name,
        });
        return full;
      },
    };
  }

  private get resource(): string {
    return this.options.resourceUrl.href;
  }

  private googleRedirectUri(): string {
    return new URL(GOOGLE_CALLBACK_PATH, this.options.publicBaseUrl).href;
  }

  // ---------------------------------------------------------------------------
  // /authorize
  // ---------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && !sameResource(params.resource.href, this.resource)) {
      throw new InvalidTargetError(
        `Unknown resource ${params.resource.href}; expected ${this.resource}.`,
      );
    }
    const scopes = params.scopes?.length ? params.scopes : [MCP_SCOPE];
    if (scopes.some((scope) => scope !== MCP_SCOPE)) {
      throw new InvalidScopeError(`Only the "${MCP_SCOPE}" scope is supported.`);
    }
    const pendingId = randomToken();
    await this.options.store.update((state) => {
      state.pending[pendingId] = {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        clientState: params.state,
        scopes,
        resource: this.resource,
        googleCodeVerifier: randomToken(48),
        expiresAt: this.now() + PENDING_TTL_SECONDS,
      };
    });
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
      })
      .send(
        renderConsentPage({
          pendingId,
          clientName: client.client_name ?? client.client_id,
          redirectHost: new URL(params.redirectUri).host,
          actionPath: CONSENT_ACTION_PATH,
        }),
      );
  }

  /** POST /oauth/consent: the user approved or denied on our consent page. */
  async handleConsent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pendingId = typeof body.pending === 'string' ? body.pending : '';
    const decision = body.decision;
    const pending = await this.options.store.read((state) => state.pending[pendingId]);
    if (!pending) {
      res
        .status(400)
        .type('html')
        .send(
          renderMessagePage(
            'Link expired',
            'This sign-in request expired. Start again from your MCP client.',
          ),
        );
      return;
    }
    if (decision !== 'approve') {
      await this.options.store.update((state) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete state.pending[pendingId];
      });
      res.redirect(
        302,
        errorRedirect(
          pending.redirectUri,
          new AccessDeniedError('The user cancelled.'),
          pending.clientState,
        ),
      );
      return;
    }
    const url = this.options.google.authorizationUrl({
      state: pendingId,
      codeVerifier: pending.googleCodeVerifier,
      redirectUri: this.googleRedirectUri(),
    });
    res.redirect(302, url);
  }

  /** GET /oauth/google/callback: Google redirected back after sign-in. */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const googleError = typeof req.query.error === 'string' ? req.query.error : undefined;

    // Consume the pending authorization atomically (single use).
    const pending = await this.options.store.update((s) => {
      const value = s.pending[state];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (value) delete s.pending[state];
      return value;
    });
    if (!pending) {
      res
        .status(400)
        .type('html')
        .send(
          renderMessagePage(
            'Link expired',
            'This sign-in request expired or was already used. Start again from your MCP client.',
          ),
        );
      return;
    }
    if (googleError || !code) {
      res.redirect(
        302,
        errorRedirect(
          pending.redirectUri,
          new AccessDeniedError(`Google sign-in failed: ${googleError ?? 'no code'}`),
          pending.clientState,
        ),
      );
      return;
    }

    try {
      const tokens = await this.options.google.exchangeCode(
        code,
        pending.googleCodeVerifier,
        this.googleRedirectUri(),
      );
      if (!tokens.idToken) throw new UserFacingError('Google did not return an ID token.');
      const identity = await this.options.google.verifyIdToken(tokens.idToken);
      if (!identity.emailVerified || !this.options.allowedEmails.includes(identity.email)) {
        logger.warn('rejected sign-in from non-allowlisted account', { email: identity.email });
        throw new AccessDeniedError(
          `The Google account ${identity.email} is not allowed to use this server.`,
        );
      }
      const channel = await this.options.google.fetchChannel(tokens.accessToken);
      if (
        this.options.allowedChannelIds.length > 0 &&
        !this.options.allowedChannelIds.includes(channel.channelId)
      ) {
        throw new AccessDeniedError(
          `The YouTube channel "${channel.title}" (${channel.channelId}) is not on ALLOWED_CHANNEL_IDS. ` +
            'Sign in again and choose the correct channel / brand account.',
        );
      }

      const authCode = randomToken();
      await this.options.store.update((s) => {
        const existing = s.users[identity.sub];
        let sealed = existing?.googleRefreshToken;
        if (tokens.refreshToken)
          sealed = seal(
            tokens.refreshToken,
            this.options.encryptionKey,
            refreshTokenAad(identity.sub),
          );
        if (!sealed) {
          throw new UserFacingError(
            'Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and connect again.',
          );
        }
        const user: UserRecord = {
          userId: identity.sub,
          email: identity.email,
          channelId: channel.channelId,
          channelTitle: channel.title,
          googleRefreshToken: sealed,
          updatedAt: this.now(),
        };
        s.users[identity.sub] = user;
        s.codes[hashToken(authCode)] = {
          clientId: pending.clientId,
          userId: identity.sub,
          scopes: pending.scopes,
          resource: pending.resource,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          expiresAt: this.now() + CODE_TTL_SECONDS,
        };
      });
      logger.info('user authorized', {
        email: identity.email,
        channelId: channel.channelId,
        clientId: pending.clientId,
      });

      const target = new URL(pending.redirectUri);
      target.searchParams.set('code', authCode);
      if (pending.clientState !== undefined) target.searchParams.set('state', pending.clientState);
      res.redirect(302, target.href);
    } catch (error) {
      logger.warn('authorization failed', { error: errorMessage(error) });
      const oauthError =
        error instanceof AccessDeniedError ? error : new AccessDeniedError(errorMessage(error));
      res.redirect(302, errorRedirect(pending.redirectUri, oauthError, pending.clientState));
    }
  }

  // ---------------------------------------------------------------------------
  // /token
  // ---------------------------------------------------------------------------

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.options.store.read((s) => s.codes[hashToken(authorizationCode)]);
    if (record?.clientId !== client.client_id)
      throw new InvalidGrantError('Invalid or expired authorization code.');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.options.store.update((s) => {
      const key = hashToken(authorizationCode);
      const record = s.codes[key];
      // Single use: delete before any further validation.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete s.codes[key];
      if (record?.clientId !== client.client_id)
        throw new InvalidGrantError('Invalid or expired authorization code.');
      if (redirectUri !== undefined && redirectUri !== record.redirectUri)
        throw new InvalidGrantError('redirect_uri does not match the authorization request.');
      if (resource && !sameResource(resource.href, record.resource))
        throw new InvalidTargetError('resource does not match the authorization request.');
      if (!s.users[record.userId]) throw new InvalidGrantError('User is no longer authorized.');
      return this.issueTokens(s, record);
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.options.store.update((s) => {
      const key = hashToken(refreshToken);
      const record = s.refreshTokens[key];
      if (record?.clientId !== client.client_id)
        throw new InvalidGrantError('Invalid or expired refresh token.');
      if (scopes?.some((scope) => !record.scopes.includes(scope)))
        throw new InvalidScopeError('Requested scope exceeds the original grant.');
      if (resource && !sameResource(resource.href, record.resource))
        throw new InvalidTargetError('resource does not match the original grant.');
      if (!s.users[record.userId]) throw new InvalidGrantError('User is no longer authorized.');
      // Rotation (OAuth 2.1 for public clients): the old refresh token is invalidated.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete s.refreshTokens[key];
      return this.issueTokens(s, { ...record, scopes: scopes?.length ? scopes : record.scopes });
    });
  }

  private issueTokens(
    state: Parameters<Parameters<StateStore['update']>[0]>[0],
    grant: Omit<Grant, 'expiresAt'>,
  ): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = this.now();
    const base = {
      clientId: grant.clientId,
      userId: grant.userId,
      scopes: grant.scopes,
      resource: grant.resource,
    };
    state.accessTokens[hashToken(accessToken)] = {
      ...base,
      expiresAt: now + this.options.accessTokenTtlSeconds,
    };
    state.refreshTokens[hashToken(refreshToken)] = {
      ...base,
      expiresAt: now + this.options.refreshTokenTtlSeconds,
    };
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.options.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  }

  // ---------------------------------------------------------------------------
  // Resource server side
  // ---------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const found = await this.options.store.read((s) => {
      const grant = s.accessTokens[hashToken(token)];
      return grant && s.users[grant.userId] ? grant : undefined;
    });
    if (!found || found.expiresAt <= this.now())
      throw new InvalidTokenError('Invalid or expired access token.');
    return {
      token,
      clientId: found.clientId,
      scopes: found.scopes,
      expiresAt: found.expiresAt,
      resource: new URL(found.resource),
      extra: { userId: found.userId },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const key = hashToken(request.token);
    await this.options.store.update((s) => {
      for (const bucket of [s.accessTokens, s.refreshTokens]) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        if (bucket[key]?.clientId === client.client_id) delete bucket[key];
      }
    });
  }

  /** Decrypts the stored Google refresh token for a user. */
  async getGoogleRefreshToken(userId: string): Promise<{ refreshToken: string; user: UserRecord }> {
    const user = await this.options.store.read((s) => s.users[userId]);
    if (!user)
      throw new UserFacingError(
        'No Google account is linked. Reconnect the connector.',
        'auth_expired',
      );
    return {
      refreshToken: open(
        user.googleRefreshToken,
        this.options.encryptionKey,
        refreshTokenAad(userId),
      ),
      user,
    };
  }

  /** Persists a rotated Google refresh token. */
  async updateGoogleRefreshToken(userId: string, refreshToken: string): Promise<void> {
    await this.options.store.update((s) => {
      const user = s.users[userId];
      if (!user) return;
      user.googleRefreshToken = seal(
        refreshToken,
        this.options.encryptionKey,
        refreshTokenAad(userId),
      );
      user.updatedAt = this.now();
    });
  }
}

function errorRedirect(
  redirectUri: string,
  error: { errorCode: string; message: string },
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error.errorCode);
  url.searchParams.set('error_description', error.message);
  if (state !== undefined) url.searchParams.set('state', state);
  return url.href;
}
