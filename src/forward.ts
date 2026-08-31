import type { RequestSigner } from "./signer.js";

export interface ForwardOptions {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Parse and validate the operator-configured upstream URL once, at startup. Every
 * forwarded request targets this exact URL regardless of the incoming request path,
 * so client-controlled input can never redirect the upstream `fetch` (no SSRF surface).
 */
export function parseTargetUrl(targetUrl: string): URL {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid target URL: ${targetUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported target URL protocol: ${url.protocol} (expected http: or https:)`);
  }
  return url;
}

/**
 * Sign a request with SigV4 and send it upstream with `fetch`. Returns the raw
 * `Response` so callers decide whether to buffer or stream the body.
 */
export async function forwardSigned(
  sign: RequestSigner,
  target: URL,
  options: ForwardOptions,
): Promise<Response> {
  const hasBody = options.body !== undefined && options.body.length > 0;
  const signedHeaders = await sign(target, {
    method: options.method,
    headers: options.headers,
    body: hasBody ? options.body : undefined,
  });

  const doFetch = options.fetchImpl ?? fetch;
  return doFetch(target, {
    method: options.method,
    headers: signedHeaders,
    body: hasBody ? options.body : undefined,
    signal: options.signal,
  });
}
