/**
 * Header allowlists for the HTTP-listener proxy, derived from the MCP
 * "Streamable HTTP" transport spec. Both lists are lower-case and can be
 * overridden per instance via {@link SigV4ProxyOptions}.
 */

/** Client -> server headers copied from the incoming request onto the signed request. */
export const DEFAULT_FORWARDED_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/** Server -> client headers copied from the upstream response back to the caller. */
export const DEFAULT_FORWARDED_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
];
