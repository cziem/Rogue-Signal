import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SealedBox } from '../crypto.js';

/** A grant (code, access token or refresh token) bound to one MCP client and one Google user. */
export interface Grant {
  clientId: string;
  userId: string;
  scopes: string[];
  /** RFC 8707 resource the grant is restricted to. */
  resource: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface AuthorizationCodeRecord extends Grant {
  redirectUri: string;
  codeChallenge: string;
}

/** An in-flight authorization: the MCP client's request, parked while the user signs in to Google. */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string | undefined;
  scopes: string[];
  resource: string;
  /** PKCE verifier for the upstream Google leg. */
  googleCodeVerifier: string;
  expiresAt: number;
}

export interface UserRecord {
  /** Google account `sub`. */
  userId: string;
  email: string;
  channelId: string;
  channelTitle: string;
  /** Google refresh token, individually sealed (AAD = `google-refresh:<userId>`). */
  googleRefreshToken: SealedBox;
  updatedAt: number;
}

export interface PersistedState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  pending: Record<string, PendingAuthorization>;
  /** Keyed by SHA-256 hash of the code. */
  codes: Record<string, AuthorizationCodeRecord>;
  /** Keyed by SHA-256 hash of the token. */
  accessTokens: Record<string, Grant>;
  /** Keyed by SHA-256 hash of the token. */
  refreshTokens: Record<string, Grant>;
  users: Record<string, UserRecord>;
}

export function emptyState(): PersistedState {
  return {
    version: 1,
    clients: {},
    pending: {},
    codes: {},
    accessTokens: {},
    refreshTokens: {},
    users: {},
  };
}

/** Removes every expired pending authorization, code and token. Returns true if anything changed. */
export function purgeExpired(state: PersistedState, nowSeconds: number): boolean {
  let changed = false;
  const buckets: Record<string, { expiresAt: number }>[] = [
    state.pending,
    state.codes,
    state.accessTokens,
    state.refreshTokens,
  ];
  for (const bucket of buckets) {
    for (const [key, value] of Object.entries(bucket)) {
      if (value.expiresAt <= nowSeconds) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete bucket[key];
        changed = true;
      }
    }
  }
  return changed;
}
