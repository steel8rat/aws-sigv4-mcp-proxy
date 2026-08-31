import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

/** SigV4 signing configuration shared by every proxy entry point. */
export interface SignerConfig {
  /** SigV4 service name, e.g. `bedrock-agentcore`, `execute-api`, `lambda`. */
  service: string;
  /** AWS region the target is signed for, e.g. `us-east-1`. */
  region: string;
  /**
   * Credentials to sign with. A static credential object or a provider function.
   * When omitted, the standard AWS credential chain is used via the optional peer
   * dependency `@aws-sdk/credential-provider-node` (env vars, SSO cache, web identity,
   * shared config/credentials files, and the EC2/ECS/AgentCore container role).
   */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
}

export interface SignableRequest {
  method: string;
  /** Header names are treated case-insensitively; values are sent as-is. */
  headers: Record<string, string>;
  /** Request body, already serialized. */
  body?: Uint8Array;
}

export type RequestSigner = (url: URL, request: SignableRequest) => Promise<Record<string, string>>;

// Headers that `fetch`/undici computes itself and rejects (or ignores) if set explicitly.
// `host` is still part of the signature; we sign with it, then drop it before calling fetch,
// which re-derives an identical `Host` from the request URL.
const FETCH_MANAGED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive"]);

/**
 * Build a function that signs an outbound request with SigV4 and returns the
 * headers to attach to a `fetch` call for that request.
 */
export function createRequestSigner(config: SignerConfig): RequestSigner {
  const signer = new SignatureV4({
    service: config.service,
    region: config.region,
    credentials: config.credentials ?? defaultCredentialProvider(),
    sha256: Sha256,
  });

  return async function signRequest(url, request) {
    const headers: Record<string, string> = { host: url.host };
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[name.toLowerCase()] = value;
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const signed = await signer.sign({
      method: request.method.toUpperCase(),
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query,
      headers,
      body: request.body,
    });

    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(signed.headers)) {
      if (typeof value === "string" && !FETCH_MANAGED_HEADERS.has(name.toLowerCase())) {
        out[name] = value;
      }
    }
    return out;
  };
}

/**
 * Lazily loads `@aws-sdk/credential-provider-node` (an optional peer dependency)
 * the first time credentials are needed, and reuses the resolved provider so the
 * SDK's own caching/refresh applies.
 */
function defaultCredentialProvider(): AwsCredentialIdentityProvider {
  let provider: Promise<AwsCredentialIdentityProvider> | undefined;
  return async () => {
    provider ??= (async () => {
      let mod: typeof import("@aws-sdk/credential-provider-node");
      try {
        mod = await import("@aws-sdk/credential-provider-node");
      } catch {
        throw new Error(
          "No AWS credentials were provided and the optional peer dependency " +
            "'@aws-sdk/credential-provider-node' is not installed. Either pass `credentials` " +
            "explicitly or install it: npm i @aws-sdk/credential-provider-node",
        );
      }
      return mod.defaultProvider();
    })();
    return (await provider)();
  };
}
