# Connector authorization design

The remote server is both an **OAuth 2.1 authorization server** (for MCP clients such as claude.ai) and a **resource server** (the `/mcp` endpoint). User authentication is delegated to Google: the person connecting signs in with the Google account that owns the channel, and the server keeps that account's Google refresh token. MCP clients never see Google tokens.

## Endpoints

| Path                                        | Purpose                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata. Points at this server as the authorization server. |
| `/.well-known/oauth-authorization-server`   | RFC 8414 authorization-server metadata.                                                  |
| `/register`                                 | RFC 7591 dynamic client registration (claude.ai registers itself here).                  |
| `/authorize`                                | Starts authorization. Shows a consent page.                                              |
| `/oauth/consent`                            | The consent form posts here, which redirects to Google.                                  |
| `/oauth/google/callback`                    | Google redirects back here.                                                              |
| `/token`                                    | Authorization-code (PKCE S256 required) and refresh-token grants.                        |
| `/revoke`                                   | RFC 7009 token revocation.                                                               |
| `/mcp`                                      | Streamable HTTP MCP endpoint. Requires `Authorization: Bearer`.                          |

The metadata, registration, authorize, token and revoke handlers come from `@modelcontextprotocol/sdk`'s `mcpAuthRouter`. This repo adds the provider (`src/auth/provider.ts`), the consent page and the Google leg.

## Flow

```
claude.ai                     this server                         Google
   | POST /mcp (no token)         |                                  |
   |<-- 401 WWW-Authenticate: resource_metadata=... ----------------|
   | GET well-known metadata      |                                  |
   | POST /register               |  redirect_uris checked against   |
   |                              |  OAUTH_ALLOWED_REDIRECT_ORIGINS  |
   | GET /authorize (PKCE, state, resource)                          |
   |                              |  store pending authz (10 min)    |
   |<-- consent page -------------|                                  |
   | POST /oauth/consent approve  |                                  |
   |                              |-- 302 accounts.google.com ------>|  (own PKCE, state = pending id,
   |                              |                                  |   access_type=offline, prompt=consent)
   |                              |<-- /oauth/google/callback?code --|
   |                              |  exchange code, verify ID token  |
   |                              |  email in ALLOWED_GOOGLE_EMAILS? |
   |                              |  channel in ALLOWED_CHANNEL_IDS? |
   |                              |  seal + store Google refresh tok |
   |<-- 302 redirect_uri?code=<our code>&state ----------------------|
   | POST /token (code_verifier)  |  verify PKCE, single-use code    |
   |<-- our access_token + refresh_token                              |
   | POST /mcp Bearer <ours>      |  look up grant -> userId         |
   |                              |  decrypt Google refresh token -->| YouTube Data API
```

## Security properties

- **Never unauthenticated.** `/mcp` is behind `requireBearerAuth` with a required scope and an expected resource (RFC 8707 audience). HTTP mode will not start without `ALLOWED_GOOGLE_EMAILS`.
- **Allowlist enforced at sign-in.** Only verified Google emails on the allowlist get a code. `ALLOWED_CHANNEL_IDS` can additionally pin the channel.
- **PKCE on both legs.** Clients must use S256 (enforced by the SDK). The server uses its own PKCE verifier toward Google.
- **Redirect URI allowlist.** Dynamic registration only accepts https redirect URIs on approved origins (default `https://claude.ai`, `https://claude.com`) plus loopback http URIs for native clients. An attacker cannot register a client that sends codes to their own site.
- **Explicit consent page** before the Google redirect. It shows the client name and redirect host, so a silent cross-site authorization is not possible. It is served with `frame-ancestors 'none'`.
- **Single-use, short-lived codes** (5 min), deleted on first use. Pending authorizations expire after 10 min and are consumed once.
- **Refresh-token rotation.** Every refresh issues a new refresh token and invalidates the old one.
- **Hashed bearer tokens.** Access tokens, refresh tokens and codes are stored only as SHA-256 hashes.
- **Encryption at rest.** The whole state file is AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. Each Google refresh token is also sealed on its own, with the user ID as associated data. Writes are atomic (temp file + rename) and serialized.
- **SSRF guard for URL sources.** Every hop of a source URL, redirects included, must resolve to a public address, which blocks cloud metadata and private ranges. Local paths are refused in HTTP mode.

## Storage and scaling

State is a single encrypted file in `DATA_DIR`, which suits the intended deployment: **one instance** with a persistent volume. To run more than one instance, implement the `StateStore` interface (`src/store/encryptedFileStore.ts`) against a shared database such as Firestore or Postgres, keeping the per-token sealing.

## Key rotation

Changing `TOKEN_ENCRYPTION_KEY` makes the existing state file unreadable, and the server says so at startup. To rotate the key, delete `state.enc` and reconnect. Clients re-register automatically.
