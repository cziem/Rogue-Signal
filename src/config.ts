import { z } from 'zod';
import { parseEncryptionKey } from './crypto.js';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().optional().default(fallback);

const EnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, 'TOKEN_ENCRYPTION_KEY is required'),
  DATA_DIR: z.string().min(1).default('./data'),

  // HTTP (remote connector) mode
  PUBLIC_BASE_URL: z.url().optional(),
  PORT: intFromEnv(8080),
  HOST: z.string().default('0.0.0.0'),
  ALLOWED_GOOGLE_EMAILS: csv,
  ALLOWED_CHANNEL_IDS: csv,
  OAUTH_ALLOWED_REDIRECT_ORIGINS: z
    .string()
    .optional()
    .default('https://claude.ai,https://claude.com')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  OAUTH_ALLOW_LOOPBACK_REDIRECTS: boolFromEnv(true),
  ACCESS_TOKEN_TTL_SECONDS: intFromEnv(60 * 60),
  REFRESH_TOKEN_TTL_SECONDS: intFromEnv(30 * 24 * 60 * 60),
  TRUST_PROXY: boolFromEnv(true),

  // stdio (local) mode
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  LOCAL_AUTH_PORT: intFromEnv(53682),
});

export interface BaseConfig {
  google: { clientId: string; clientSecret: string };
  encryptionKey: Buffer;
  dataDir: string;
}

export interface HttpConfig extends BaseConfig {
  publicBaseUrl: URL;
  /** The protected resource identifier (RFC 8707), i.e. the MCP endpoint URL. */
  resourceUrl: URL;
  port: number;
  host: string;
  allowedEmails: readonly string[];
  allowedChannelIds: readonly string[];
  allowedRedirectOrigins: readonly string[];
  allowLoopbackRedirects: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  trustProxy: boolean;
}

export interface StdioConfig extends BaseConfig {
  refreshToken: string | undefined;
  localAuthPort: number;
}

function parseEnv(env: NodeJS.ProcessEnv): z.infer<typeof EnvSchema> {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}\nSee .env.example for reference.`);
  }
  return result.data;
}

function base(parsed: z.infer<typeof EnvSchema>): BaseConfig {
  return {
    google: { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET },
    encryptionKey: parseEncryptionKey(parsed.TOKEN_ENCRYPTION_KEY),
    dataDir: parsed.DATA_DIR,
  };
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = parseEnv(env);
  if (!parsed.PUBLIC_BASE_URL) {
    throw new Error(
      'PUBLIC_BASE_URL is required in HTTP mode (e.g. https://rogue-signal-mcp-xyz.a.run.app).',
    );
  }
  if (parsed.ALLOWED_GOOGLE_EMAILS.length === 0) {
    throw new Error(
      'ALLOWED_GOOGLE_EMAILS is required in HTTP mode: list the Google account(s) allowed to ' +
        'connect (the account that owns the channel). The server refuses to start without it.',
    );
  }
  const publicBaseUrl = new URL(parsed.PUBLIC_BASE_URL);
  publicBaseUrl.pathname = publicBaseUrl.pathname.replace(/\/+$/, '');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(publicBaseUrl.hostname);
  if (publicBaseUrl.protocol !== 'https:' && !isLocal) {
    throw new Error('PUBLIC_BASE_URL must use https:// (http is only allowed for localhost).');
  }
  const resourceUrl = new URL(`${publicBaseUrl.href.replace(/\/+$/, '')}/mcp`);
  return {
    ...base(parsed),
    publicBaseUrl,
    resourceUrl,
    port: parsed.PORT,
    host: parsed.HOST,
    allowedEmails: parsed.ALLOWED_GOOGLE_EMAILS.map((email) => email.toLowerCase()),
    allowedChannelIds: parsed.ALLOWED_CHANNEL_IDS,
    allowedRedirectOrigins: parsed.OAUTH_ALLOWED_REDIRECT_ORIGINS,
    allowLoopbackRedirects: parsed.OAUTH_ALLOW_LOOPBACK_REDIRECTS,
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.REFRESH_TOKEN_TTL_SECONDS,
    trustProxy: parsed.TRUST_PROXY,
  };
}

export function loadStdioConfig(env: NodeJS.ProcessEnv = process.env): StdioConfig {
  const parsed = parseEnv(env);
  return {
    ...base(parsed),
    refreshToken: parsed.GOOGLE_REFRESH_TOKEN,
    localAuthPort: parsed.LOCAL_AUTH_PORT,
  };
}
