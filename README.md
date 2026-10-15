# Rogue Signal YouTube MCP server

An [MCP](https://modelcontextprotocol.io) server for publishing to the **Rogue Signal** YouTube channel ([@officialroguesignal](https://www.youtube.com/@officialroguesignal)), home of the AI story series **Agent Wars**, **Kill Switch** and **Ghost in the Stack**.

It lets Claude upload episodes, write metadata and chapters, set thumbnails, manage series playlists and schedule releases. It never publishes anything on its own: every upload is private, and going public requires an explicit human approval (see [Review gate](#review-gate)).

- TypeScript on Node 20+, official `@modelcontextprotocol/sdk`, YouTube Data API v3 via `googleapis`.
- **Remote:** Streamable HTTP with OAuth 2.1, so you can add it to claude.ai as a custom connector.
- **Local:** stdio, for Claude Code.
- Resumable, streamed uploads from a URL (never buffered whole in memory) or a local path (stdio only).

## Tools

| Tool                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload_video`                                           | Resumable upload. **Always `private`.** Takes `source` (`{url}` or `{path}`), `title`, `description`, `tags`, `categoryId` (default `24`), `madeForKids` (default `false`), `containsSyntheticMedia` (default `true`, the AI-content disclosure), `defaultLanguage`, optional `playlistId` and `thumbnail`. Returns `videoId`, the YouTube Studio URL and the processing status, and sends progress notifications. |
| `schedule_publish`                                       | Keeps the video private and sets `publishAt` (ISO 8601 with timezone, in the future). Requires `confirm: true`.                                                                                                                                                                                                                                                                                                    |
| `make_public`                                            | Makes the video public immediately. Requires `confirm: true`.                                                                                                                                                                                                                                                                                                                                                      |
| `update_metadata`                                        | Updates title, description, tags, category and language. `chapters` are rendered as timestamp lines in the description.                                                                                                                                                                                                                                                                                            |
| `set_thumbnail`                                          | JPEG/PNG, max 2 MB, from a URL or path.                                                                                                                                                                                                                                                                                                                                                                            |
| `create_playlist` / `list_playlists` / `add_to_playlist` | Series and season playlists.                                                                                                                                                                                                                                                                                                                                                                                       |
| `list_videos`                                            | Channel uploads including private and scheduled ones, paginated.                                                                                                                                                                                                                                                                                                                                                   |
| `get_video_status`                                       | Upload and processing status, privacy, `publishAt`, failure and rejection reasons.                                                                                                                                                                                                                                                                                                                                 |

Every tool validates its input with zod, declares an `outputSchema`, returns `structuredContent`, and carries MCP annotations (`readOnlyHint`, `destructiveHint` and so on).

**Not supported: pinned comments.** The YouTube Data API cannot pin comments, so pin them by hand in YouTube Studio.

## Review gate

The channel has a human review step before anything goes live. The server enforces it:

1. `upload_video` hard-codes `privacyStatus: "private"`. No input can change it, and the tool schema has no privacy field.
2. `schedule_publish` and `make_public` are the only ways to make a video visible. Both need the literal `confirm: true`, and their descriptions (plus the server `instructions`) tell the model to call them only after the human has explicitly approved that specific video in the conversation. They are annotated `destructiveHint: true`, which clients can use to require a per-call approval.
3. The usual flow: `upload_video` → poll `get_video_status` until processing is `succeeded` → human review in Studio → on approval, `schedule_publish`.

`confirm: true` is a guardrail on the model's behaviour, not cryptographic proof that a human approved. The real protection is that uploads land as private, and that claude.ai shows tool-call approval prompts.

## Unaudited Google API projects lock uploads to private

YouTube restricts **every** video uploaded through an unverified API project (one created after 28 July 2020 that has not passed a [YouTube API Services compliance audit](https://support.google.com/youtube/contact/yt_api_form)) to private. Those videos cannot be made public through the API; `make_public` will report that YouTube kept them private. Until the audit passes, publish them by hand in YouTube Studio after review. The server's private-first design fits this restriction.

## Google Cloud setup

1. **Create a project** at <https://console.cloud.google.com/projectcreate> (for example `rogue-signal-publishing`).
2. **Enable the API:** go to APIs & Services → Library → **YouTube Data API v3** → Enable.
3. **Configure the OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type: **External** (unless the channel lives in a Workspace org).
   - App name: "Rogue Signal Publisher"; add a support email and a developer contact.
   - Scopes: add `.../auth/youtube.upload` and `.../auth/youtube` (plus `openid` and `email`).
   - Test users: add the Google account that owns the channel.
   - Publishing status: while it is **Testing**, Google refresh tokens **expire after 7 days**, so you would have to reconnect weekly. Click **Publish app** to avoid that. The YouTube scopes are sensitive, so Google may ask for app verification; for personal use you can proceed past the "unverified app" warning.
4. **Create OAuth credentials** (APIs & Services → Credentials → Create credentials → OAuth client ID):
   - **Remote server:** application type **Web application**. Authorized redirect URI: `https://<your-public-host>/oauth/google/callback` (for local HTTP testing, also `http://localhost:8080/oauth/google/callback`).
   - **Local stdio:** a **Desktop app** client is simplest, because it accepts the loopback redirect used by `rogue-signal-mcp auth` with no extra configuration. If you reuse the Web client instead, add `http://127.0.0.1:53682/callback` as a redirect URI.
5. Copy the client ID and secret into your env (below).
6. If the channel is a **Brand Account**, choose the brand account on Google's account chooser when you sign in. Set `ALLOWED_CHANNEL_IDS` to the channel's `UC...` ID to make sure the right channel is connected.

## Environment variables

See [`.env.example`](./.env.example) for the full list.

| Variable                                                                                                               | Mode  | Notes                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                             | both  | OAuth client from the steps above.                                                        |
| `TOKEN_ENCRYPTION_KEY`                                                                                                 | both  | 32 bytes in base64 or hex: `openssl rand -base64 32`. Encrypts stored tokens.             |
| `DATA_DIR`                                                                                                             | both  | Where the encrypted state lives (default `./data`). Must be persistent in production.     |
| `PUBLIC_BASE_URL`                                                                                                      | http  | Public https origin. The MCP endpoint is `$PUBLIC_BASE_URL/mcp`.                          |
| `ALLOWED_GOOGLE_EMAILS`                                                                                                | http  | **Required.** Comma-separated accounts allowed to connect.                                |
| `ALLOWED_CHANNEL_IDS`                                                                                                  | http  | Optional channel pin (`UC...`).                                                           |
| `OAUTH_ALLOWED_REDIRECT_ORIGINS`                                                                                       | http  | Origins allowed for client redirect URIs. Default `https://claude.ai,https://claude.com`. |
| `OAUTH_ALLOW_LOOPBACK_REDIRECTS`                                                                                       | http  | Allow `http://localhost` redirect URIs (Claude Code). Default `true`.                     |
| `GOOGLE_REFRESH_TOKEN`                                                                                                 | stdio | Optional alternative to `rogue-signal-mcp auth`.                                          |
| `PORT`, `HOST`, `LOG_LEVEL`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `TRUST_PROXY`, `LOCAL_AUTH_PORT` |       | Optional tuning.                                                                          |

## Local use with Claude Code (stdio)

```bash
git clone https://github.com/cziem/rogue-signal && cd rogue-signal
npm ci && npm run build
cp .env.example .env   # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY
set -a && . ./.env && set +a
node dist/index.js auth   # opens a Google sign-in URL; stores an encrypted refresh token in DATA_DIR
```

Then register the server with Claude Code. Use absolute paths, because Claude Code starts the process from another directory:

```bash
claude mcp add rogue-signal-youtube \
  -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  -e GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  -e TOKEN_ENCRYPTION_KEY="$TOKEN_ENCRYPTION_KEY" \
  -e DATA_DIR="$PWD/data" \
  -- node "$PWD/dist/index.js"
```

In stdio mode, `source` and `thumbnail` also accept `{ "path": "/abs/path/episode.mp4" }`.

You can also point Claude Code at a deployed remote server: `claude mcp add --transport http rogue-signal-youtube https://<host>/mcp`. It runs the same OAuth flow through a localhost redirect.

## Remote deploy

[docs/deploy.md](./docs/deploy.md) covers **Google Cloud Run** (primary, with Secret Manager and a GCS volume) and **Fly.io**. The image is a multi-stage build that runs as the non-root `node` user:

```bash
docker build -t rogue-signal-mcp .
docker run --rm -p 8080:8080 --env-file .env -v "$PWD/data:/data" rogue-signal-mcp
```

Run a single instance: the state store is one encrypted file.

## Add to claude.ai as a custom connector

1. Deploy, and make sure `https://<host>/oauth/google/callback` is an authorized redirect URI on the Google OAuth client.
2. In claude.ai, go to **Settings → Connectors → Add custom connector**.
3. Name it "Rogue Signal YouTube" and set the URL to `https://<host>/mcp`. Leave the advanced OAuth client fields empty, because the server supports dynamic client registration.
4. Click **Connect**. You will see this server's consent page, then Google sign-in. Sign in with the account that owns the channel (it must be on `ALLOWED_GOOGLE_EMAILS`) and grant all permissions.
5. Enable the connector in a chat, and keep tool-approval prompts on for `schedule_publish` and `make_public`.

To disconnect, remove the connector in claude.ai. To cut access entirely, also revoke the app at <https://myaccount.google.com/permissions>.

## Auth design

The server is its own OAuth 2.1 authorization server, and it proxies sign-in to Google. Clients get opaque tokens issued by this server, and Google refresh tokens stay on the server, encrypted with AES-256-GCM. PKCE is required, redirect URIs are allowlisted, codes are single-use, refresh tokens rotate, and bearer tokens are stored only as hashes. See [docs/auth-design.md](./docs/auth-design.md) for the flow diagram and the reasoning.

## Quota

The YouTube Data API has a daily quota per Google Cloud project (the default allocation is shown in the console under APIs & Services → YouTube Data API v3 → Quotas). Uploads cost far more than reads or metadata updates, and setting a thumbnail or adding to a playlist costs quota too. Costs change over time, so check the current figures in Google's [quota cost table](https://developers.google.com/youtube/v3/determine_quota_cost) before you plan a batch of uploads. Request more quota through the [audit and quota extension form](https://support.google.com/youtube/contact/yt_api_form). When the quota runs out, tools return a clear `quota exceeded` error (it resets at midnight Pacific Time).

## Error handling

Google errors are translated into messages that say what to do next: quota exhausted, upload limit, rate limiting, invalid `publishAt`, expired or revoked authorization (including the 7-day expiry for apps still in Testing), missing scopes, an account with no channel, the private lock on unaudited projects, and unknown video or playlist IDs.

## Development

```bash
npm ci
npm run lint        # eslint (strict type-checked) + prettier --check
npm run typecheck
npm test            # vitest, YouTube API and Google OAuth mocked
npm run build
npm run dev         # tsx watch, HTTP mode
```

Layout: `src/youtube` (service, resumable uploader, error mapping, metadata), `src/auth` (OAuth provider, Google client), `src/mcp` (tools and schemas), `src/http` (Express app), `src/store` (encrypted state), `src/sources` (URL/path streaming with an SSRF guard), `src/stdio` (local sign-in).

## License

[MIT](./LICENSE)
