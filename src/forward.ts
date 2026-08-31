import type { RequestSigner } from "./signer.js";

export interface ForwardOptions {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Sign a request with SigV4 and send it upstream with `fetch`. Returns the raw
 * `Response` so callers decide whether to buffer or stream the body.
 */
export async function forwardSigned(
  sign: RequestSigner,
  targetUrl: string,
  options: ForwardOptions,
): Promise<Response> {
  const url = new URL(targetUrl);
  const hasBody = options.body !== undefined && options.body.length > 0;
  const signedHeaders = await sign(url, {
    method: options.method,
    headers: options.headers,
    body: hasBody ? options.body : undefined,
  });

  const doFetch = options.fetchImpl ?? fetch;
  return doFetch(targetUrl, {
    method: options.method,
    headers: signedHeaders,
    body: hasBody ? options.body : undefined,
    signal: options.signal,
  });
}
