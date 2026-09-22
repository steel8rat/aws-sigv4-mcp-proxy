import { setTimeout as sleep } from "node:timers/promises";
import { owedResponseId } from "./jsonrpc.js";

/**
 * A SigV4 target can answer a JSON-RPC request with HTTP 200 and an empty body.
 * An MCP client then sees a 200 with no response and reports "Transport closed",
 * naming neither the cause nor the layer.
 *
 * Observed against Bedrock AgentCore, where it is how the platform surfaces a
 * container that died or was not yet listening; the same image run locally never
 * produced one. So the empty body is a symptom of an upstream fault, not a
 * protocol state: the proxy reports it as a JSON-RPC error (always), and can
 * optionally retry it first, in case the replay reaches a healthy instance.
 */

/** Message of the JSON-RPC error synthesized for a terminal empty 200. */
export const EMPTY_RESPONSE_MESSAGE = "Upstream returned HTTP 200 with an empty body";

/** JSON-RPC "Internal error" code used for the synthesized error. */
export const EMPTY_RESPONSE_CODE = -32603;

export interface EmptyResponseRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Backoff ceiling for the first retry; doubles per attempt, with full jitter applied. Default 150ms. */
  backoffMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 150;

/**
 * Resolve the public `retryEmptyResponse` option. Returns `undefined` when the
 * retry is off (the default). Throws on invalid values so misconfiguration fails
 * at startup rather than on the first empty response.
 */
export function resolveRetryOptions(
  option: boolean | EmptyResponseRetryOptions | undefined,
): Required<EmptyResponseRetryOptions> | undefined {
  if (!option) return undefined;
  const { attempts = DEFAULT_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS } = option === true ? {} : option;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`retryEmptyResponse.attempts must be an integer >= 1, got ${attempts}`);
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(`retryEmptyResponse.backoffMs must be a number >= 0, got ${backoffMs}`);
  }
  return { attempts, backoffMs };
}

/**
 * Whether a request is owed a response: a POST whose body is a single JSON-RPC
 * request with an `id`. Only these can be answered with a synthesized error or
 * retried; notifications, client responses, batches, `GET` streams and `DELETE`
 * can all legitimately receive an empty 200.
 */
export function isOwedResponse(method: string | undefined, body: unknown): boolean {
  if ((method ?? "GET").toUpperCase() !== "POST") return false;
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return false;
  return owedResponseId(body) !== null;
}

export interface PeekedResponse {
  /** True when the body held no non-whitespace byte before it ended. */
  empty: boolean;
  /** Equivalent response to use in place of the original; its body is intact when not empty. */
  response: Response;
}

/**
 * Read just far enough into a response to tell whether it is empty: up to the
 * first non-whitespace byte, or the end of the stream. The bytes read are
 * re-attached in front of the remainder, so `text/event-stream` bodies keep
 * streaming instead of being buffered whole.
 */
export async function peekResponse(response: Response): Promise<PeekedResponse> {
  if (!response.body) return { empty: true, response };

  const reader = response.body.getReader();
  const retained: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      reader.releaseLock();
      return { empty: true, response: rebuild(response, null) };
    }
    retained.push(next.value);
    if (hasNonWhitespace(next.value)) break;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of retained) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { empty: false, response: rebuild(response, stream) };
}

/**
 * Wrap `fetch` so an empty 200 to a request that is owed a response is replayed,
 * up to `attempts` in total, with exponentially growing, fully jittered backoff.
 * The replay reuses the already-signed headers (they stay valid for minutes),
 * so signing happens once, outside this wrapper. Once attempts run out, the
 * empty 200 is returned for the caller to turn into a JSON-RPC error.
 *
 * A replay is at-least-once: a container that dies while writing its response
 * has already run the tool. That is why the retry is off by default.
 */
export function withEmptyResponseRetry(
  baseFetch: typeof fetch,
  options: Required<EmptyResponseRetryOptions>,
  warn: (message: string) => void,
): typeof fetch {
  const { attempts, backoffMs } = options;

  return async function retryingFetch(input, init) {
    if (!isOwedResponse(init?.method, init?.body)) return baseFetch(input, init);

    for (let attempt = 1; ; attempt++) {
      const response = await baseFetch(input, init);
      // Only the empty-200 signature is retryable. Real errors and real bodies
      // go straight back so the client sees them unchanged.
      if (response.status !== 200) return response;

      const peeked = await peekResponse(response);
      if (!peeked.empty || attempt >= attempts || init?.signal?.aborted) return peeked.response;

      // Full jitter: random in [0, base). Keeps concurrent clients out of lockstep.
      const delay = Math.round(Math.random() * backoffMs * 2 ** (attempt - 1));
      warn(`empty 200 from upstream; attempt ${attempt} of ${attempts} failed, retrying in ${delay}ms`);
      // Rejects with an AbortError if the request is aborted mid-backoff.
      await sleep(delay, undefined, { signal: init?.signal ?? undefined });
    }
  };
}

function rebuild(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function hasNonWhitespace(chunk: Uint8Array): boolean {
  for (const byte of chunk) {
    // JSON insignificant whitespace: space, tab, line feed, carriage return.
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return true;
  }
  return false;
}
