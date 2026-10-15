import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleOAuth } from '../src/auth/google.js';
import { GoogleProxyOAuthProvider } from '../src/auth/provider.js';
import { open } from '../src/crypto.js';
import { createHttpApp } from '../src/http/app.js';
import type { YouTubeService } from '../src/youtube/service.js';
import { MemoryStore } from '../src/store/encryptedFileStore.js';
import { TEST_KEY } from './helpers.js';

const BASE = new URL('http://localhost:8080');
const RESOURCE = new URL('http://localhost:8080/mcp');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function fakeGoogle(
  overrides: Partial<{ email: string; channelId: string; refreshToken: string | undefined }> = {},
): GoogleOAuth {
  return {
    authorizationUrl: ({ state, redirectUri }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: vi.fn(() =>
      Promise.resolve({
        accessToken: 'google-access',
        refreshToken:
          'refreshToken' in overrides ? overrides.refreshToken : 'google-refresh-secret',
        idToken: 'id-token',
      }),
    ),
    verifyIdToken: () =>
      Promise.resolve({
        sub: 'google-sub-1',
        email: overrides.email ?? 'owner@example.com',
        emailVerified: true,
      }),
    fetchChannel: () =>
      Promise.resolve({ channelId: overrides.channelId ?? 'UCrogue', title: 'Rogue Signal' }),
  };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

interface Harness {
  app: Express;
  store: MemoryStore;
  provider: GoogleProxyOAuthProvider;
}

function setup(google: GoogleOAuth = fakeGoogle(), allowedChannelIds: string[] = []): Harness {
  const store = new MemoryStore();
  const provider = new GoogleProxyOAuthProvider({
    store,
    google,
    encryptionKey: TEST_KEY,
    publicBaseUrl: BASE,
    resourceUrl: RESOURCE,
    allowedEmails: ['owner@example.com'],
    allowedChannelIds,
    redirectPolicy: { allowedOrigins: ['https://claude.ai'], allowLoopback: true },
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
  });
  const service = { getVideoStatus: vi.fn() } as unknown as YouTubeService;
  const app = createHttpApp({
    provider,
    publicBaseUrl: BASE,
    resourceUrl: RESOURCE,
    resolveService: () => Promise.resolve(service),
    disableRateLimits: true,
  });
  return { app, store, provider };
}

async function register(app: Express, redirectUris = [REDIRECT]) {
  return request(app)
    .post('/register')
    .send({
      client_name: 'Claude',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
}

/** Runs the full browser leg and returns our authorization code (or the error redirect). */
async function authorize(h: Harness, clientId: string, challenge: string) {
  const auth = await request(h.app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'youtube',
    resource: RESOURCE.href,
  });
  expect(auth.status).toBe(200);
  expect(auth.text).toContain('Continue with Google');
  const pending = /name="pending" value="([^"]+)"/.exec(auth.text)?.[1];
  expect(pending).toBeDefined();

  const consent = await request(h.app)
    .post('/oauth/consent')
    .type('form')
    .send({ pending, decision: 'approve' });
  expect(consent.status).toBe(302);
  const googleUrl = new URL(consent.headers.location!);
  expect(googleUrl.host).toBe('accounts.google.com');
  expect(googleUrl.searchParams.get('redirect_uri')).toBe(
    'http://localhost:8080/oauth/google/callback',
  );

  const callback = await request(h.app)
    .get('/oauth/google/callback')
    .query({ state: googleUrl.searchParams.get('state'), code: 'google-code' });
  expect(callback.status).toBe(302);
  return new URL(callback.headers.location!);
}

describe('OAuth authorization server', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('publishes discovery metadata', async () => {
    const prm = await request(h.app).get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.body).toMatchObject({
      resource: RESOURCE.href,
      authorization_servers: ['http://localhost:8080/'],
    });
    const as = await request(h.app).get('/.well-known/oauth-authorization-server');
    expect(as.body).toMatchObject({
      authorization_endpoint: 'http://localhost:8080/authorize',
      token_endpoint: 'http://localhost:8080/token',
      registration_endpoint: 'http://localhost:8080/register',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('rejects unauthenticated MCP requests with a resource-metadata challenge', async () => {
    const res = await request(h.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await request(h.app).post('/mcp').set('Authorization', 'Bearer nope').send({});
    expect(bad.status).toBe(401);
  });

  it('refuses client registration with non-allowlisted redirect URIs', async () => {
    const res = await register(h.app, ['https://evil.example/callback']);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
    expect((await register(h.app, ['http://127.0.0.1:3333/cb'])).status).toBe(201);
  });

  it('runs the full flow: register, authorize via Google, token, MCP call, refresh rotation, revoke', async () => {
    const reg = await register(h.app);
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();

    const redirect = await authorize(h, clientId, challenge);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('client-state');
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();

    // Google refresh token is stored sealed, never in plaintext.
    const user = await h.store.read((s) => s.users['google-sub-1']);
    expect(JSON.stringify(user)).not.toContain('google-refresh-secret');
    expect(open(user!.googleRefreshToken, TEST_KEY, 'google-refresh:google-sub-1')).toBe(
      'google-refresh-secret',
    );

    // Wrong verifier fails.
    const badPkce = await request(h.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'x'.repeat(43),
        client_id: clientId,
        redirect_uri: REDIRECT,
      });
    expect(badPkce.status).toBe(400);

    const token = await request(h.app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: RESOURCE.href,
    });
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'youtube' });
    const accessToken = token.body.access_token as string;
    const refreshToken = token.body.refresh_token as string;

    // Code is single-use.
    const reuse = await request(h.app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);

    // Bearer tokens are stored hashed only.
    const raw = JSON.stringify(await h.store.read((s) => s));
    expect(raw).not.toContain(accessToken);
    expect(raw).not.toContain(refreshToken);

    // Authenticated MCP call works.
    const mcp = await request(h.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      });
    expect(mcp.status).toBe(200);
    expect(mcp.body.result.serverInfo.name).toBe('rogue-signal-youtube-mcp-server');
    expect(mcp.body.result.instructions).toMatch(/Review gate/);

    const list = await request(h.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list.body.result.tools as unknown[]).length).toBe(10);

    // Refresh rotates the refresh token.
    const refreshed = await request(h.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);
    const replay = await request(h.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    expect(replay.status).toBe(400);

    // Revocation.
    const newAccess = refreshed.body.access_token as string;
    await request(h.app)
      .post('/revoke')
      .type('form')
      .send({ token: newAccess, client_id: clientId })
      .expect(200);
    const after = await request(h.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${newAccess}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(after.status).toBe(401);
  });

  it('denies Google accounts that are not allowlisted', async () => {
    h = setup(fakeGoogle({ email: 'stranger@example.com' }));
    const reg = await register(h.app);
    const redirect = await authorize(h, reg.body.client_id as string, pkce().challenge);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('error_description')).toContain('stranger@example.com');
    expect(redirect.searchParams.get('code')).toBeNull();
    expect(await h.store.read((s) => Object.keys(s.users))).toEqual([]);
  });

  it('denies channels not on ALLOWED_CHANNEL_IDS', async () => {
    h = setup(fakeGoogle({ channelId: 'UCother' }), ['UCrogue']);
    const reg = await register(h.app);
    const redirect = await authorize(h, reg.body.client_id as string, pkce().challenge);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
  });

  it('fails clearly when Google returns no refresh token for a new user', async () => {
    h = setup(fakeGoogle({ refreshToken: undefined }));
    const reg = await register(h.app);
    const redirect = await authorize(h, reg.body.client_id as string, pkce().challenge);
    expect(redirect.searchParams.get('error_description')).toMatch(/refresh token/);
  });

  it('handles user cancellation and replayed callbacks', async () => {
    const reg = await register(h.app);
    const auth = await request(h.app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: reg.body.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's',
      });
    const pending = /name="pending" value="([^"]+)"/.exec(auth.text)?.[1];
    const deny = await request(h.app)
      .post('/oauth/consent')
      .type('form')
      .send({ pending, decision: 'deny' });
    expect(new URL(deny.headers.location!).searchParams.get('error')).toBe('access_denied');

    const replay = await request(h.app)
      .get('/oauth/google/callback')
      .query({ state: pending, code: 'c' });
    expect(replay.status).toBe(400);
  });

  it('rejects authorization for a foreign resource', async () => {
    const reg = await register(h.app);
    const res = await request(h.app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: reg.body.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        resource: 'https://other.example/mcp',
      });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location!).searchParams.get('error')).toBe('invalid_target');
  });
});
