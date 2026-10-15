#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleOAuthClient, createYouTubeClient } from './auth/google.js';
import { GoogleProxyOAuthProvider } from './auth/provider.js';
import { loadHttpConfig, loadStdioConfig } from './config.js';
import { errorMessage } from './errors.js';
import { createHttpApp } from './http/app.js';
import { logger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { httpServiceResolver } from './runtime.js';
import { loadLocalRefreshToken, runLocalAuth, saveLocalRefreshToken } from './stdio/localAuth.js';
import { EncryptedFileStore } from './store/encryptedFileStore.js';
import { YouTubeService } from './youtube/service.js';

const USAGE = `Usage:
  rogue-signal-mcp            Run over stdio (local, e.g. Claude Code)
  rogue-signal-mcp --http     Run the remote Streamable HTTP server with OAuth
  rogue-signal-mcp auth       Sign in with Google once for stdio mode
`;

function runHttp(): void {
  const config = loadHttpConfig();
  const store = new EncryptedFileStore(config.dataDir, config.encryptionKey);
  const provider = new GoogleProxyOAuthProvider({
    store,
    google: new GoogleOAuthClient(config.google.clientId, config.google.clientSecret),
    encryptionKey: config.encryptionKey,
    publicBaseUrl: config.publicBaseUrl,
    resourceUrl: config.resourceUrl,
    allowedEmails: config.allowedEmails,
    allowedChannelIds: config.allowedChannelIds,
    redirectPolicy: {
      allowedOrigins: config.allowedRedirectOrigins,
      allowLoopback: config.allowLoopbackRedirects,
    },
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
  });
  const app = createHttpApp({
    provider,
    publicBaseUrl: config.publicBaseUrl,
    resourceUrl: config.resourceUrl,
    resolveService: httpServiceResolver(config, provider),
    trustProxy: config.trustProxy,
  });
  const server = app.listen(config.port, config.host, () => {
    logger.info('HTTP MCP server listening', {
      host: config.host,
      port: config.port,
      mcpUrl: config.resourceUrl.href,
    });
  });
  // Long uploads: do not let Node cut off slow requests.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  const shutdown = (): void => {
    logger.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function runStdio(): Promise<void> {
  const config = loadStdioConfig();
  const refreshToken = await loadLocalRefreshToken(config);
  const client = createYouTubeClient({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    refreshToken,
    onRefreshTokenRotated: (rotated) => {
      saveLocalRefreshToken(config, rotated).catch((error: unknown) => {
        logger.error('failed to persist rotated refresh token', { error: errorMessage(error) });
      });
    },
  });
  const service = new YouTubeService({
    youtube: client.youtube,
    getAccessToken: client.getAccessToken,
    sourceOptions: { allowLocalPaths: true },
  });
  const server = createMcpServer(() => Promise.resolve(service));
  await server.connect(new StdioServerTransport());
  logger.info('stdio MCP server running');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }
  if (args[0] === 'auth') {
    const result = await runLocalAuth(loadStdioConfig());
    process.stderr.write(
      `Signed in as ${result.email}; channel ${result.channel}. Token stored encrypted.\n`,
    );
    return;
  }
  if (args.includes('--http') || process.env.MCP_TRANSPORT === 'http') {
    runHttp();
    return;
  }
  await runStdio();
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
