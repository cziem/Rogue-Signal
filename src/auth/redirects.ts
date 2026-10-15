const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RedirectPolicy {
  /** Origins (scheme + host) allowed for https redirect URIs, e.g. https://claude.ai. */
  allowedOrigins: readonly string[];
  /** Allow http://localhost / 127.0.0.1 redirect URIs (native clients such as Claude Code). */
  allowLoopback: boolean;
}

/**
 * Restricts which redirect URIs a dynamically registered client may use, so an attacker
 * cannot register a client that sends authorization codes to their own site.
 */
export function isAllowedRedirectUri(raw: string, policy: RedirectPolicy): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return policy.allowLoopback;
  if (url.protocol !== 'https:') return false;
  return policy.allowedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}
