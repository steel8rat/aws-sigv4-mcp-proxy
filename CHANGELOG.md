# Changelog

## 0.2.0

- An HTTP 200 with an empty body to a JSON-RPC request is now reported to the
  client as a `-32603` JSON-RPC error instead of being passed through. In stdio
  mode this previously left the client waiting forever; an SSE response that
  ends without answering the request is reported the same way. Notifications,
  client responses, batches, `GET` and `DELETE` are unaffected.
- New `retryEmptyResponse` option (`boolean | EmptyResponseRetryOptions`) on
  `startSigV4Proxy`, `startStdioProxy` and both AgentCore wrappers, and a
  `--retry-empty-response` CLI flag. Off by default: replays are at-least-once.
- New `onWarn` option on the same entry points for non-fatal warnings (retries).

## 0.1.0

Initial release. Extracted and reworked from an in-tree draft.

- `startSigV4Proxy` — generic local HTTP listener that forwards every request to a
  SigV4-gated `targetUrl` (`service` + `region` + optional `credentials`).
- `startStdioProxy` — newline-delimited JSON-RPC stdio bridge over MCP Streamable
  HTTP, with `Mcp-Session-Id` / `MCP-Protocol-Version` tracking and a standalone
  server-stream (`GET` SSE) for server-initiated messages.
- `startAgentCoreProxy` / `startAgentCoreStdioProxy` / `agentCoreInvocationUrl` —
  Bedrock AgentCore convenience layer that builds the `/runtimes/.../invocations`
  URL from a runtime ARN and defaults `service` to `bedrock-agentcore`.
- `aws-sigv4-mcp-proxy` CLI (`bin`) covering both modes, usable from any MCP client's
  `command`/`args` config.
- `text/event-stream` responses are streamed through, not buffered.
- Transport failures are returned as JSON-RPC 2.0 error envelopes.
- Runtime dependencies limited to `@smithy/signature-v4` + `@aws-crypto/sha256-js`
  (+ `@smithy/types`); the default AWS credential chain is an optional peer
  dependency (`@aws-sdk/credential-provider-node`).
- `startAwsSigV4McpProxy` is kept as a deprecated alias for `startAgentCoreProxy`.
