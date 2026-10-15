import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GOOGLE_CALLBACK_PATH, MCP_PATH, MCP_SCOPE, SERVER_VERSION } from '../constants.js';
import { UserFacingError, errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { CONSENT_ACTION_PATH, type GoogleProxyOAuthProvider } from '../auth/provider.js';
import { createMcpServer, type ServiceResolver } from '../mcp/server.js';

export interface HttpAppOptions {
  provider: GoogleProxyOAuthProvider;
  publicBaseUrl: URL;
  resourceUrl: URL;
  resolveService: ServiceResolver;
  trustProxy?: boolean;
  /** Disable the SDK's built-in rate limits (tests only). */
  disableRateLimits?: boolean;
}

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export function createHttpApp(options: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: SERVER_VERSION });
  });

  const rateLimit = options.disableRateLimits ? { rateLimit: false as const } : {};
  app.use(
    mcpAuthRouter({
      provider: options.provider,
      issuerUrl: options.publicBaseUrl,
      resourceServerUrl: options.resourceUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: 'Rogue Signal YouTube',
      authorizationOptions: rateLimit,
      tokenOptions: rateLimit,
      clientRegistrationOptions: { ...rateLimit, clientSecretExpirySeconds: 0 },
      revocationOptions: rateLimit,
    }),
  );

  app.post(
    CONSENT_ACTION_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    asyncHandler((req, res) => options.provider.handleConsent(req, res)),
  );
  app.get(
    GOOGLE_CALLBACK_PATH,
    asyncHandler((req, res) => options.provider.handleGoogleCallback(req, res)),
  );

  const bearer = requireBearerAuth({
    verifier: options.provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.resourceUrl),
    expectedResource: options.resourceUrl,
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, JSON responses.
  app.post(
    MCP_PATH,
    bearer,
    express.json({ limit: '1mb' }),
    asyncHandler(async (req, res) => {
      const server = createMcpServer(options.resolveService);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server).' },
        id: null,
      });
  };
  app.get(MCP_PATH, bearer, methodNotAllowed);
  app.delete(MCP_PATH, bearer, methodNotAllowed);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled HTTP error', { error: errorMessage(error) });
    if (res.headersSent) return;
    const message = error instanceof UserFacingError ? error.message : 'Internal server error';
    res.status(500).json({ error: 'server_error', error_description: message });
  });

  return app;
}

/** Builds the per-request YouTube service resolver from the bearer token's user. */
export function userIdFromExtra(extra: { authInfo?: { extra?: Record<string, unknown> } }): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== 'string') {
    throw new UserFacingError('Not authenticated. Reconnect the connector.', 'auth_expired');
  }
  return userId;
}
