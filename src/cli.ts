#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AGENT_CORE_SERVICE, agentCoreInvocationUrl, regionFromArn } from "./agentcore.js";
import { startSigV4Proxy } from "./proxy.js";
import { startStdioProxy } from "./stdio.js";

const USAGE = `aws-sigv4-mcp-proxy — bridge a plain MCP client to a SigV4-gated MCP endpoint

Usage:
  aws-sigv4-mcp-proxy [options] <url|runtime-arn>

Target (exactly one):
  <url|runtime-arn>          positional: a URL, or an "arn:..." AgentCore runtime ARN
  --url <url>                signed target URL (generic: API Gateway, Lambda URL, ...)
  --runtime-arn <arn>        Bedrock AgentCore runtime ARN (builds the invoke URL)

Mode:
  (default)                  stdio bridge: newline-delimited JSON-RPC on stdin/stdout
  --http                     run a local HTTP listener instead

Options:
  --service <name>           SigV4 service name (default: bedrock-agentcore for an ARN; required for --url)
  --region <region>          AWS region (default: parsed from the ARN, else $AWS_REGION)
  --qualifier <name>         AgentCore runtime qualifier (default: DEFAULT)
  --protocol-version <ver>   initial MCP-Protocol-Version header (stdio mode)
  --no-server-stream         do not open a standalone GET SSE stream (stdio mode)
  --retry-empty-response     replay a request answered with an empty HTTP 200 (up to 3
                             attempts); at-least-once: a lost tool call may run twice
  --port <n>                 local port (http mode; default: ephemeral)
  --host <addr>              local bind address (http mode; default: 127.0.0.1)
  --path <path>              local path to advertise (http mode; default: /mcp)
  -h, --help                 show this help
  --version                  print version

Credentials come from the standard AWS chain (env vars, SSO cache, shared config,
container/instance role). Requires @aws-sdk/credential-provider-node to be installed.
`;

function fail(message: string): never {
  process.stderr.write(`aws-sigv4-mcp-proxy: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    http: { type: "boolean", default: false },
    url: { type: "string" },
    "runtime-arn": { type: "string" },
    service: { type: "string" },
    region: { type: "string" },
    qualifier: { type: "string" },
    "protocol-version": { type: "string" },
    "no-server-stream": { type: "boolean", default: false },
    "retry-empty-response": { type: "boolean", default: false },
    port: { type: "string" },
    host: { type: "string" },
    path: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

let runtimeArn = values["runtime-arn"];
let url = values.url;
const positional = positionals[0];
if (positional && !runtimeArn && !url) {
  if (positional.startsWith("arn:")) runtimeArn = positional;
  else url = positional;
}

if (runtimeArn && url) fail("provide only one of --url / --runtime-arn");
if (!runtimeArn && !url) fail("a target URL or runtime ARN is required");

let targetUrl: string;
let service: string;
let region: string;

if (runtimeArn) {
  try {
    region = values.region ?? regionFromArn(runtimeArn);
    targetUrl = agentCoreInvocationUrl(runtimeArn, { region, qualifier: values.qualifier });
  } catch (err) {
    fail((err as Error).message);
  }
  service = values.service ?? AGENT_CORE_SERVICE;
} else {
  try {
    new URL(url as string);
  } catch {
    fail(`--url is not a valid URL: ${JSON.stringify(url)}`);
  }
  targetUrl = url as string;
  service = values.service ?? fail("--service is required with --url");
  region =
    values.region ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    fail("--region is required with --url (or set AWS_REGION)");
}

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

if (values.http) {
  const proxy = await startSigV4Proxy({
    targetUrl,
    service,
    region,
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    path: values.path,
    retryEmptyResponse: values["retry-empty-response"],
  });
  process.stderr.write(`[aws-sigv4-mcp-proxy] listening on ${proxy.url} -> ${targetUrl}\n`);
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      void proxy.close().finally(() => process.exit(0));
    });
  }
} else {
  const proxy = await startStdioProxy({
    targetUrl,
    service,
    region,
    protocolVersion: values["protocol-version"],
    serverStream: !values["no-server-stream"],
    retryEmptyResponse: values["retry-empty-response"],
  });
  process.stderr.write(`[aws-sigv4-mcp-proxy] stdio bridge -> ${targetUrl}\n`);
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      void proxy.close();
    });
  }
  await proxy.done;
  process.exit(0);
}
