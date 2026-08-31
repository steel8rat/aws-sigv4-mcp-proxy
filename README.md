# aws-sigv4-mcp-proxy

Bridge a plain-HTTP or stdio [MCP](https://modelcontextprotocol.io) client to an
**AWS SigV4-gated MCP endpoint** — Amazon Bedrock AgentCore runtimes, or any MCP
server behind API Gateway / a Lambda Function URL / IAM auth.

Most MCP clients (Claude Desktop, Cursor, VS Code, Kiro, the GitHub Copilot SDK, …)
can only be pointed at a static URL with static headers, or launched as a
`command` subprocess. None of them can compute a SigV4 signature per request, so
they cannot talk to an IAM-secured endpoint directly. This package sits in
between:

```
MCP client  ──plain HTTP / stdio──▶  aws-sigv4-mcp-proxy  ──SigV4-signed HTTPS──▶  AWS
```

It signs every forwarded request with SigV4 using whatever credentials the
process already has (env vars, SSO cache, an EC2 / ECS / AgentCore execution
role — the standard AWS credential chain), so the client never has to know AWS
auth exists.

This is a small, dependency-light TypeScript counterpart to AWS's Python
[`mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws). It exists because
embedding the Python tool (boto3 + botocore + uv) into a Node container adds
~250&nbsp;MB; this package's runtime dependencies are the Smithy SigV4 signer and
a SHA-256 implementation (~6&nbsp;MB unpacked, no AWS SDK client).

## Install

```bash
npm install aws-sigv4-mcp-proxy
```

To use the default AWS credential chain (recommended on ECS / Lambda / AgentCore),
also install the optional peer dependency:

```bash
npm install @aws-sdk/credential-provider-node
```

Requires Node.js ≥ 20 (uses the global `fetch`).

## CLI — stdio mode

The default mode reads newline-delimited JSON-RPC on stdin, signs and forwards
each message over MCP Streamable HTTP, and writes responses (JSON or
`text/event-stream`) back to stdout. This is how most MCP clients expect to launch
a server.

```bash
# Bedrock AgentCore runtime (service + region are inferred from the ARN)
aws-sigv4-mcp-proxy arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_mcp-abcd1234

# Any other SigV4-gated endpoint
aws-sigv4-mcp-proxy --url https://abc123.execute-api.us-east-1.amazonaws.com/prod/mcp \
  --service execute-api --region us-east-1
```

Example client config (`.mcp.json`, Claude Desktop, Cursor, VS Code — same shape):

```jsonc
{
  "mcpServers": {
    "my_remote_mcp": {
      "command": "npx",
      "args": [
        "-y", "aws-sigv4-mcp-proxy",
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_mcp-abcd1234"
      ],
      "env": { "AWS_PROFILE": "my-sso-profile", "AWS_REGION": "us-east-1" }
    }
  }
}
```

## CLI — HTTP listener mode

`--http` starts a local unauthenticated listener instead. Point a client that
only accepts a static URL at it.

```bash
aws-sigv4-mcp-proxy --http --port 9100 \
  arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_mcp-abcd1234
# [aws-sigv4-mcp-proxy] listening on http://127.0.0.1:9100/mcp -> https://bedrock-agentcore...
```

```jsonc
{ "my_remote_mcp": { "type": "http", "url": "http://127.0.0.1:9100/mcp" } }
```

### All flags

| Flag | Description |
| --- | --- |
| `<url\|runtime-arn>` | Positional target: a URL, or an `arn:…` AgentCore runtime ARN |
| `--url` / `--runtime-arn` | Same as the positional, explicit form |
| `--http` | Run a local HTTP listener instead of the stdio bridge |
| `--service` | SigV4 service name (default `bedrock-agentcore` for an ARN; required with `--url`) |
| `--region` | AWS region (default: parsed from the ARN, else `$AWS_REGION` / `$AWS_DEFAULT_REGION`) |
| `--qualifier` | AgentCore runtime qualifier (default `DEFAULT`) |
| `--protocol-version` | Initial `MCP-Protocol-Version` header (stdio mode; updated from the `initialize` result) |
| `--no-server-stream` | Do not open a standalone GET SSE stream for server-initiated messages (stdio mode) |
| `--port` / `--host` / `--path` | HTTP listener bind settings (default `127.0.0.1`, ephemeral port, `/mcp`) |

## Programmatic API

### Generic core

```ts
import { startSigV4Proxy } from "aws-sigv4-mcp-proxy";

const proxy = await startSigV4Proxy({
  targetUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/prod/mcp",
  service: "execute-api",
  region: "us-east-1",
  // credentials?: static creds or a provider; omit for the default chain
  port: 9100,            // optional; default: ephemeral
});

console.log(proxy.url); // http://127.0.0.1:9100/mcp
// ... on shutdown:
await proxy.close();
```

```ts
import { startStdioProxy } from "aws-sigv4-mcp-proxy";

const proxy = await startStdioProxy({
  targetUrl,
  service: "execute-api",
  region: "us-east-1",
});
await proxy.done; // resolves when stdin ends and in-flight messages are flushed
```

### Bedrock AgentCore convenience layer

```ts
import { startAgentCoreProxy, startAgentCoreStdioProxy, agentCoreInvocationUrl } from "aws-sigv4-mcp-proxy";

const proxy = await startAgentCoreProxy({
  runtimeArn: process.env.MY_MCP_RUNTIME_ARN!, // region + service inferred
  qualifier: "DEFAULT",                        // optional
  port: 9100,                                  // optional
});

agentCoreInvocationUrl(runtimeArn);
// https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded-arn>/invocations?qualifier=DEFAULT
```

## How the AgentCore invoke URL is derived

There is no published AWS REST reference for invoking an AgentCore runtime over
signed HTTP. The path shape here is reverse-engineered from AWS's own tooling —
the `agentcore` CLI's Smithy operation table (`InvokeAgentRuntime` →
`POST /runtimes/{agentRuntimeArn}/invocations`) and its URL builder — and matches
what the Python `mcp-proxy-for-aws` uses. AWS's tooling treats this endpoint as a
genuine MCP Streamable HTTP passthrough (raw JSON-RPC body, `Mcp-Session-Id` /
`Mcp-Protocol-Version` headers), which is what this proxy relies on.

It has been verified end to end against a live runtime. Still: cross-check it if
AWS publishes an official reference, and watch for it changing across `agentcore`
CLI versions. Override the pieces you need with `region`, `qualifier`, and
`dnsSuffix` (for non-standard partitions), or bypass the convenience layer
entirely with `startSigV4Proxy` + your own `targetUrl`.

## Design notes

- **Single target per instance.** One proxy instance maps to exactly one upstream
  endpoint. It does not route by path or header to multiple targets — run one
  instance per target. This keeps signing, session handling and error mapping
  unambiguous, and is deliberate; please don't re-litigate it without a concrete
  need.
- **Responses are streamed, not buffered.** `text/event-stream` responses (MCP's
  mechanism for long-running calls and server notifications) are piped through
  chunk by chunk in both modes.
- **stdio session handling.** The bridge tracks `Mcp-Session-Id` from the first
  response and the negotiated protocol version from the `initialize` result, and
  attaches both to subsequent requests. After initialization it opens a standalone
  `GET` SSE stream for server-initiated messages, disabling it silently if the
  upstream answers `4xx`/`5xx` (e.g. `405` when the server has no such stream).
- **Transport failures are JSON-RPC shaped.** An unreachable upstream or a non-2xx
  response is returned to the client as
  `{ "jsonrpc": "2.0", "id": <request id>, "error": { "code": -32001, "message": … } }`
  rather than a bare HTTP failure.
- **Header allowlist.** Request: `content-type`, `accept` (forced to
  `application/json, text/event-stream` when missing or `*/*`), `mcp-session-id`,
  `mcp-protocol-version`, `last-event-id`. Response: `content-type`,
  `cache-control`, `mcp-session-id`, `mcp-protocol-version`, `www-authenticate`.
  Both lists are overridable via `forwardRequestHeaders` / `forwardResponseHeaders`.

### Limitations

- SSE resumption via `Last-Event-ID` is passed through but the standalone
  server-stream does not yet reconnect automatically on drop.
- The HTTP listener is unauthenticated; bind it to loopback (the default) and
  treat it as a local-only shim.

## Prior art

| Package | Why it doesn't fit |
| --- | --- |
| [`aws/mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws) | Python only; boto3/botocore too heavy to embed in a Node container |
| `mcp-proxy` (npm) | SSE ↔ stdio bridge, no AWS auth |
| `mcp-remote` (npm) | OAuth-based remote MCP proxy, not SigV4 |
| `@aws/bedrock-agentcore-sdk-typescript` | `RuntimeClient` only covers WebSocket/shell auth, no signed HTTP invoke |
| [`aws-sigv4-fetch`](https://github.com/zirkelc/aws-signature-v4) | The right signing primitive, but not a proxy |

## License

MIT
