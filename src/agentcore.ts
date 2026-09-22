import { startSigV4Proxy, type SigV4Proxy } from "./proxy.js";
import { startStdioProxy, type StdioProxy } from "./stdio.js";
import type { SignerConfig } from "./signer.js";
import type { EmptyResponseRetryOptions } from "./empty.js";

/** SigV4 service name for the Bedrock AgentCore data plane. */
export const AGENT_CORE_SERVICE = "bedrock-agentcore";

export interface AgentCoreUrlOptions {
  /** Overrides the region parsed from the ARN. */
  region?: string;
  /** Runtime endpoint qualifier (version alias). Defaults to `DEFAULT`. */
  qualifier?: string;
  /** Partition DNS suffix. Defaults to `amazonaws.com` (standard `aws` partition). */
  dnsSuffix?: string;
}

/** Extract the region segment (index 3) from an ARN. */
export function regionFromArn(arn: string): string {
  const segments = arn.split(":");
  if (segments[0] !== "arn" || segments.length < 6) {
    throw new Error(`Not a valid ARN: ${JSON.stringify(arn)}`);
  }
  const region = segments[3];
  if (!region) throw new Error(`ARN has no region segment: ${JSON.stringify(arn)}`);
  return region;
}

/**
 * Build the Bedrock AgentCore `InvokeAgentRuntime` data-plane URL for a runtime ARN:
 * `https://bedrock-agentcore.<region>.<dnsSuffix>/runtimes/<url-encoded-arn>/invocations?qualifier=<qualifier>`
 *
 * The path shape is reverse-engineered from the `agentcore` CLI and AWS's Python
 * `mcp-proxy-for-aws`; cross-check it if AWS publishes an official reference.
 */
export function agentCoreInvocationUrl(runtimeArn: string, options: AgentCoreUrlOptions = {}): string {
  if (!runtimeArn.startsWith("arn:")) {
    throw new Error(`Expected a Bedrock AgentCore runtime ARN, got: ${JSON.stringify(runtimeArn)}`);
  }
  const region = options.region ?? regionFromArn(runtimeArn);
  const qualifier = options.qualifier ?? "DEFAULT";
  const dnsSuffix = options.dnsSuffix ?? "amazonaws.com";
  const host = `bedrock-agentcore.${region}.${dnsSuffix}`;
  return `https://${host}/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=${encodeURIComponent(qualifier)}`;
}

export interface AgentCoreProxyOptions extends Partial<SignerConfig>, AgentCoreUrlOptions {
  /** ARN of the deployed Bedrock AgentCore runtime to invoke. */
  runtimeArn: string;
  /**
   * Replay a JSON-RPC request that gets HTTP 200 with an empty body before reporting
   * it as an error. Default off, as for the generic proxies: a replay is at-least-once.
   */
  retryEmptyResponse?: boolean | EmptyResponseRetryOptions;
  /** Called with non-fatal warnings such as retries. */
  onWarn?: (message: string) => void;
}

export interface AgentCoreHttpProxyOptions extends AgentCoreProxyOptions {
  port?: number;
  host?: string;
  path?: string;
  fetch?: typeof fetch;
}

function resolveTarget(options: AgentCoreProxyOptions): { targetUrl: string; region: string; service: string } {
  const region = options.region ?? regionFromArn(options.runtimeArn);
  return {
    region,
    service: options.service ?? AGENT_CORE_SERVICE,
    targetUrl: agentCoreInvocationUrl(options.runtimeArn, {
      region,
      qualifier: options.qualifier,
      dnsSuffix: options.dnsSuffix,
    }),
  };
}

/** Convenience wrapper around {@link startSigV4Proxy} for a Bedrock AgentCore runtime ARN. */
export function startAgentCoreProxy(options: AgentCoreHttpProxyOptions): Promise<SigV4Proxy> {
  const { targetUrl, region, service } = resolveTarget(options);
  return startSigV4Proxy({
    targetUrl,
    service,
    region,
    credentials: options.credentials,
    port: options.port,
    host: options.host,
    path: options.path,
    fetch: options.fetch,
    retryEmptyResponse: options.retryEmptyResponse,
    onWarn: options.onWarn,
  });
}

/** Convenience wrapper around {@link startStdioProxy} for a Bedrock AgentCore runtime ARN. */
export function startAgentCoreStdioProxy(
  options: AgentCoreProxyOptions & {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    fetch?: typeof fetch;
    protocolVersion?: string;
    serverStream?: boolean;
  },
): Promise<StdioProxy> {
  const { targetUrl, region, service } = resolveTarget(options);
  return startStdioProxy({
    targetUrl,
    service,
    region,
    credentials: options.credentials,
    input: options.input,
    output: options.output,
    fetch: options.fetch,
    protocolVersion: options.protocolVersion,
    serverStream: options.serverStream,
    retryEmptyResponse: options.retryEmptyResponse,
    onWarn: options.onWarn,
  });
}

/**
 * @deprecated Renamed to {@link startAgentCoreProxy}. Kept for the initial
 * migration from the in-tree `aws-sigv4-mcp-proxy.ts` draft.
 */
export const startAwsSigV4McpProxy = startAgentCoreProxy;
