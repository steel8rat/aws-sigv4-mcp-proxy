import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { forwardSigned, parseTargetUrl } from "./forward.js";
import { DEFAULT_FORWARDED_REQUEST_HEADERS, DEFAULT_FORWARDED_RESPONSE_HEADERS } from "./headers.js";
import { jsonRpcErrorString, parseRequestId } from "./jsonrpc.js";
import { createRequestSigner, type SignerConfig } from "./signer.js";

export interface SigV4ProxyOptions extends SignerConfig {
  /** Fully-qualified URL of the SigV4-gated endpoint every request is forwarded to. */
  targetUrl: string;
  /** Local port to listen on. Defaults to an OS-assigned ephemeral port. */
  port?: number;
  /** Local interface to bind. Defaults to loopback only (`127.0.0.1`). */
  host?: string;
  /** Local path reported on {@link SigV4Proxy.url}. Defaults to `/mcp`. Requests to any path are forwarded. */
  path?: string;
  /** Override the request header allowlist (lower-case names). */
  forwardRequestHeaders?: readonly string[];
  /** Override the response header allowlist (lower-case names). */
  forwardResponseHeaders?: readonly string[];
  /** Inject a custom `fetch` (used by tests). */
  fetch?: typeof fetch;
}

export interface SigV4Proxy {
  /** `http://<host>:<port><path>` — point the MCP client here. */
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

/**
 * Start a local HTTP listener that forwards every request to {@link SigV4ProxyOptions.targetUrl},
 * signing each one with SigV4. Upstream responses (including `text/event-stream`) are streamed
 * straight back to the caller.
 */
export async function startSigV4Proxy(options: SigV4ProxyOptions): Promise<SigV4Proxy> {
  const host = options.host ?? "127.0.0.1";
  // Resolved once at startup from operator config. Every forwarded request goes here
  // regardless of the incoming request's path, so client input can never redirect the
  // upstream fetch (no SSRF surface).
  const target = parseTargetUrl(options.targetUrl);
  const path = normalizePath(options.path);
  const requestAllowlist = (options.forwardRequestHeaders ?? DEFAULT_FORWARDED_REQUEST_HEADERS).map((h) => h.toLowerCase());
  const responseAllowlist = (options.forwardResponseHeaders ?? DEFAULT_FORWARDED_RESPONSE_HEADERS).map((h) => h.toLowerCase());
  const sign = createRequestSigner(options);
  const fetchImpl = options.fetch ?? fetch;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("SigV4 proxy request failed:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      res.end(jsonRpcErrorString(null, "Internal server error", -32603));
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "POST").toUpperCase();
    const body = METHODS_WITHOUT_BODY.has(method) ? undefined : await readBody(req);

    const headers: Record<string, string> = {};
    for (const name of requestAllowlist) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    // MCP Streamable HTTP requires both media types; normalize a missing or wildcard Accept.
    if (!headers["accept"] || headers["accept"].trim() === "*/*") {
      headers["accept"] = "application/json, text/event-stream";
    }
    if (body && body.length > 0 && !headers["content-type"]) headers["content-type"] = "application/json";

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    let upstream: Response;
    try {
      upstream = await forwardSigned(sign, target, { method, headers, body, signal: abort.signal, fetchImpl });
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error("SigV4 proxy could not reach upstream:", err);
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(jsonRpcErrorString(parseRequestId(body), "Upstream service unavailable"));
      return;
    }

    res.statusCode = upstream.status;
    for (const name of responseAllowlist) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }

    if (!upstream.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream<Uint8Array>);
    try {
      await pipe(nodeStream, res);
    } catch {
      // Client hung up or upstream aborted mid-stream; nothing useful to send.
      res.destroy();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Proxy server did not bind to a TCP port");
  }
  const port = address.port;

  return {
    url: `http://${formatHost(host)}:${port}${path}`,
    port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function normalizePath(path: string | undefined): string {
  if (!path || path === "/") return "/mcp";
  return path.startsWith("/") ? path : `/${path}`;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pipe(source: Readable, destination: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    source.on("error", reject);
    destination.on("error", reject);
    destination.on("close", resolve);
    source.pipe(destination);
  });
}
