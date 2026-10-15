import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleOAuthClient } from '../auth/google.js';
import { renderMessagePage } from '../auth/consentPage.js';
import type { StdioConfig } from '../config.js';
import { open, randomToken, seal, type SealedBox } from '../crypto.js';
import { UserFacingError } from '../errors.js';

const LOCAL_TOKEN_FILE = 'local-google-token.enc';
const LOCAL_AAD = 'google-refresh:local';

export function localTokenPath(dataDir: string): string {
  return join(dataDir, LOCAL_TOKEN_FILE);
}

export async function saveLocalRefreshToken(
  config: StdioConfig,
  refreshToken: string,
): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const box = seal(refreshToken, config.encryptionKey, LOCAL_AAD);
  await writeFile(localTokenPath(config.dataDir), JSON.stringify(box), { mode: 0o600 });
}

/** Resolves the refresh token for stdio mode: env var first, then the encrypted local file. */
export async function loadLocalRefreshToken(config: StdioConfig): Promise<string> {
  if (config.refreshToken) return config.refreshToken;
  let raw: string;
  try {
    raw = await readFile(localTokenPath(config.dataDir), 'utf8');
  } catch {
    throw new UserFacingError(
      'No Google credentials found. Run `rogue-signal-mcp auth` once to sign in (or set GOOGLE_REFRESH_TOKEN).',
      'auth_expired',
    );
  }
  return open(JSON.parse(raw) as SealedBox, config.encryptionKey, LOCAL_AAD);
}

/**
 * Interactive loopback OAuth for stdio mode: opens a one-shot localhost callback server,
 * prints the Google sign-in URL, and stores the resulting refresh token encrypted on disk.
 * Requires a "Desktop app" OAuth client (or a Web client with the loopback redirect registered).
 */
export async function runLocalAuth(
  config: StdioConfig,
): Promise<{ email: string; channel: string }> {
  const google = new GoogleOAuthClient(config.google.clientId, config.google.clientSecret);
  const redirectUri = `http://127.0.0.1:${config.localAuthPort}/callback`;
  const state = randomToken();
  const verifier = randomToken(48);
  const url = google.authorizationUrl({ state, codeVerifier: verifier, redirectUri });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', redirectUri);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const ok = reqUrl.searchParams.get('state') === state && reqUrl.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? renderMessagePage('Signed in', 'You can close this tab and return to the terminal.')
          : renderMessagePage(
              'Sign-in failed',
              reqUrl.searchParams.get('error') ?? 'State mismatch.',
            ),
      );
      server.close();
      if (ok) resolve(reqUrl.searchParams.get('code') ?? '');
      else
        reject(
          new Error(
            `Google sign-in failed: ${reqUrl.searchParams.get('error') ?? 'state mismatch'}`,
          ),
        );
    });
    server.on('error', reject);
    server.listen(config.localAuthPort, '127.0.0.1', () => {
      process.stderr.write(
        `\nOpen this URL in your browser and sign in with the channel owner account:\n\n${url}\n\n`,
      );
    });
  });

  const tokens = await google.exchangeCode(code, verifier, redirectUri);
  if (!tokens.refreshToken) {
    throw new Error(
      'Google returned no refresh token. Revoke the app at https://myaccount.google.com/permissions and retry.',
    );
  }
  const identity = tokens.idToken
    ? await google.verifyIdToken(tokens.idToken)
    : { email: 'unknown' };
  const channel = await google.fetchChannel(tokens.accessToken);
  await saveLocalRefreshToken(config, tokens.refreshToken);
  return { email: identity.email, channel: `${channel.title} (${channel.channelId})` };
}
