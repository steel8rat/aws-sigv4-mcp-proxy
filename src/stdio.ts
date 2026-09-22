import { createInterface } from "node:readline";
import {
  EMPTY_RESPONSE_CODE,
  EMPTY_RESPONSE_MESSAGE,
  resolveRetryOptions,
  withEmptyResponseRetry,
  type EmptyResponseRetryOptions,
} from "./empty.js";
import { forwardSigned, parseTargetUrl } from "./forward.js";
import { jsonRpcError, owedResponseIdOf, type JsonRpcId } from "./jsonrpc.js";
import { parseSseStream } from "./sse.js";
import { createRequestSigner, type SignerConfig } from "./signer.js";

export interface StdioProxyOptions extends SignerConfig {
  /** Fully-qualified URL of the SigV4-gated MCP endpoint (Streamable HTTP). */
  targetUrl: string;
  /** Message source. Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Message sink. Defaults to `process.stdout`. */
  output?: NodeJS.WritableStream;
  /** Inject a custom `fetch` (used by tests). */
  fetch?: typeof fetch;
  /** Initial `MCP-Protocol-Version` header value; updated from the `initialize` result. */
  protocolVersion?: string;
  /**
   * Open a standalone GET SSE stream after initialization to receive
   * server-initiated messages. Disabled automatically if the upstream returns
   * 4xx/5xx for the GET. Default `true`.
   */
  serverStream?: boolean;
  /** Called for recoverable errors (default: write to `process.stderr`). */
  onError?: (error: Error) => void;
  /**
   * Replay a JSON-RPC request that gets HTTP 200 with an empty body before reporting
   * it as an error. Default off: a replay is at-least-once, so a tool whose response
   * was lost may run twice. `true` uses 3 attempts with a 150ms backoff.
   */
  retryEmptyResponse?: boolean | EmptyResponseRetryOptions;
  /** Called with non-fatal warnings such as retries (default: write to `process.stderr`). */
  onWarn?: (message: string) => void;
}

/** Message of the JSON-RPC error sent when an SSE response ends without answering the request. */
const NO_RESPONSE_IN_STREAM_MESSAGE = "Upstream stream ended without a response";

export interface StdioProxy {
  /** Resolves once the input stream has ended and every in-flight message has been flushed. */
  readonly done: Promise<void>;
  /** Stop forwarding, abort in-flight requests and stop reading input. */
  close(): Promise<void>;
}

/**
 * Bridge a newline-delimited JSON-RPC stdio stream to a SigV4-gated MCP
 * "Streamable HTTP" endpoint: every client message is POSTed (signed) upstream,
 * and JSON or `text/event-stream` responses are written back as stdio messages.
 * The MCP session id and negotiated protocol version are tracked automatically.
 */
export async function startStdioProxy(options: StdioProxyOptions): Promise<StdioProxy> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const warn =
    options.onWarn ??
    ((message: string) => {
      process.stderr.write(`[aws-sigv4-mcp-proxy] ${message}\n`);
    });
  const retry = resolveRetryOptions(options.retryEmptyResponse);
  const baseFetch = options.fetch ?? fetch;
  const fetchImpl = retry ? withEmptyResponseRetry(baseFetch, retry, warn) : baseFetch;
  const target = parseTargetUrl(options.targetUrl);
  const sign = createRequestSigner(options);
  const abort = new AbortController();
  const reportError =
    options.onError ??
    ((error: Error) => {
      process.stderr.write(`[aws-sigv4-mcp-proxy] ${error.stack ?? error.message}\n`);
    });

  let sessionId: string | undefined;
  let protocolVersion = options.protocolVersion;
  let serverStreamEnabled = options.serverStream !== false;
  let serverStreamRunning = false;
  let closed = false;

  function send(message: unknown): void {
    inspectServerMessage(message);
    output.write(`${JSON.stringify(message)}\n`);
  }

  function inspectServerMessage(message: unknown): void {
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const result = (message as { result?: { protocolVersion?: unknown } }).result;
      if (result && typeof result.protocolVersion === "string") {
        protocolVersion = result.protocolVersion;
      }
    }
  }

  function upstreamHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = { accept };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    return headers;
  }

  /**
   * Forward every SSE message to the client. Returns whether one of them answered
   * `requestId` (a result or error carrying that id).
   */
  async function drainSse(response: Response, requestId: JsonRpcId = null): Promise<boolean> {
    let answered = false;
    if (!response.body) return answered;
    for await (const event of parseSseStream(response.body as unknown as ReadableStream<Uint8Array>)) {
      if (event.event !== undefined && event.event !== "message") continue;
      if (!event.data) continue;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        reportError(new Error(`Discarding non-JSON SSE data from upstream: ${event.data.slice(0, 200)}`));
        continue;
      }
      if (requestId !== null && answersRequest(message, requestId)) answered = true;
      send(message);
    }
    return answered;
  }

  async function handleClientLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      reportError(new Error(`Ignoring non-JSON line from client: ${line.slice(0, 200)}`));
      return;
    }
    const id = jsonRpcIdOf(message);
    // Only a request (method + id) is owed a response; silence to anything else is fine.
    const owedId = owedResponseIdOf(message);

    let response: Response;
    try {
      response = await forwardSigned(sign, target, {
        method: "POST",
        headers: { ...upstreamHeaders("application/json, text/event-stream"), "content-type": "application/json" },
        body: Buffer.from(line, "utf8"),
        signal: abort.signal,
        fetchImpl,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      send(jsonRpcError(id, `SigV4 proxy transport error: ${(error as Error).message}`));
      return;
    }

    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;

    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel().catch(() => {});
      startServerStream();
      return;
    }

    if (!response.ok) {
      const detail = await safeText(response);
      send(jsonRpcError(id, `Upstream returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`));
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    // An owed response that never arrives must become an error, or the client
    // waits forever for it.
    if (contentType.includes("text/event-stream")) {
      const answered = await drainSse(response, owedId);
      if (owedId !== null && !answered && !abort.signal.aborted) {
        send(jsonRpcError(owedId, NO_RESPONSE_IN_STREAM_MESSAGE, EMPTY_RESPONSE_CODE));
      }
    } else {
      const text = await response.text();
      if (text.trim()) {
        try {
          send(JSON.parse(text));
        } catch {
          reportError(new Error(`Upstream sent a non-JSON body: ${text.slice(0, 200)}`));
        }
      } else if (owedId !== null) {
        send(jsonRpcError(owedId, EMPTY_RESPONSE_MESSAGE, EMPTY_RESPONSE_CODE));
      }
    }
    startServerStream();
  }

  function startServerStream(): void {
    if (!serverStreamEnabled || serverStreamRunning || closed || !sessionId) return;
    serverStreamRunning = true;
    void runServerStream().finally(() => {
      serverStreamRunning = false;
    });
  }

  async function runServerStream(): Promise<void> {
    let response: Response;
    try {
      response = await forwardSigned(sign, target, {
        method: "GET",
        headers: upstreamHeaders("text/event-stream"),
        signal: abort.signal,
        fetchImpl,
      });
    } catch (error) {
      if (!abort.signal.aborted) reportError(error as Error);
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      // 405 = server has no standalone stream; anything else non-2xx: don't retry.
      serverStreamEnabled = false;
      await response.body?.cancel().catch(() => {});
      return;
    }
    try {
      await drainSse(response);
    } catch (error) {
      if (!abort.signal.aborted) reportError(error as Error);
    }
  }

  const rl = createInterface({ input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  rl.on("line", (line) => {
    if (line.trim() === "") return;
    queue = queue.then(() => handleClientLine(line)).catch((error: unknown) => reportError(error as Error));
  });
  rl.on("close", () => {
    // Input ended: let queued work finish, then signal completion.
    void queue.catch(() => {}).then(() => resolveDone());
  });

  async function close(): Promise<void> {
    if (!closed) {
      closed = true;
      abort.abort();
      rl.close();
    }
    await queue.catch(() => {});
    resolveDone();
  }

  return { done, close };
}

function jsonRpcIdOf(message: unknown): JsonRpcId {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const id = (message as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function answersRequest(message: unknown, id: JsonRpcId): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as { id?: unknown; result?: unknown; error?: unknown };
  return candidate.id === id && ("result" in candidate || "error" in candidate);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
