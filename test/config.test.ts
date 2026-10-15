import { describe, expect, it } from 'vitest';
import { isAllowedRedirectUri } from '../src/auth/redirects.js';
import { loadHttpConfig, loadStdioConfig } from '../src/config.js';

const base = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('config', () => {
  it('loads HTTP config and derives the resource URL', () => {
    const config = loadHttpConfig({
      ...base,
      PUBLIC_BASE_URL: 'https://mcp.example.com/',
      ALLOWED_GOOGLE_EMAILS: 'Owner@Example.com, b@x.io',
    });
    expect(config.resourceUrl.href).toBe('https://mcp.example.com/mcp');
    expect(config.allowedEmails).toEqual(['owner@example.com', 'b@x.io']);
    expect(config.allowedRedirectOrigins).toEqual(['https://claude.ai', 'https://claude.com']);
    expect(config.port).toBe(8080);
  });

  it('refuses to start an HTTP server without an allowlist or https', () => {
    expect(() => loadHttpConfig({ ...base, PUBLIC_BASE_URL: 'https://mcp.example.com' })).toThrow(
      /ALLOWED_GOOGLE_EMAILS/,
    );
    expect(() =>
      loadHttpConfig({
        ...base,
        PUBLIC_BASE_URL: 'http://mcp.example.com',
        ALLOWED_GOOGLE_EMAILS: 'a@b.c',
      }),
    ).toThrow(/https/);
    expect(() => loadHttpConfig({ ...base, ALLOWED_GOOGLE_EMAILS: 'a@b.c' })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it('reports missing required variables', () => {
    expect(() => loadStdioConfig({})).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadStdioConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
  });
});

describe('redirect policy', () => {
  const policy = { allowedOrigins: ['https://claude.ai'], allowLoopback: true };
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['http://localhost:4567/callback', true],
    ['http://127.0.0.1:4567/callback', true],
    ['https://claude.ai.evil.com/cb', false],
    ['http://claude.ai/cb', false],
    ['https://evil.example/cb', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s -> %s', (uri, expected) => {
    expect(isAllowedRedirectUri(uri, policy)).toBe(expected);
  });
  it('can disable loopback', () => {
    expect(isAllowedRedirectUri('http://localhost:1/cb', { ...policy, allowLoopback: false })).toBe(
      false,
    );
  });
});
