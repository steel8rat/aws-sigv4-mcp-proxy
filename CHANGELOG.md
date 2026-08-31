# Changelog

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
