/** Minimal JSON-RPC 2.0 helpers used to shape transport failures for MCP clients. */

export type JsonRpcId = string | number | null;

/**
 * Best-effort extraction of the `id` from an incoming JSON-RPC request body so a
 * transport failure can be returned as a matching JSON-RPC error. Returns `null`
 * for batches, notifications, and unparseable bodies.
 */
export function parseRequestId(body: Uint8Array | string | undefined): JsonRpcId {
  if (body === undefined || (typeof body !== "string" && body.length === 0)) return null;
  try {
    const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** JSON-RPC error object with an implementation-defined code in the -32000 range. */
export function jsonRpcError(id: JsonRpcId, message: string, code = -32001): {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
} {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function jsonRpcErrorString(id: JsonRpcId, message: string, code = -32001): string {
  return JSON.stringify(jsonRpcError(id, message, code));
}

/**
 * The `id` of a JSON-RPC message that is owed a response — a single request
 * carrying both a `method` and an `id` — or `null` for anything else (a
 * notification, a client's response to a server request, a batch, or an
 * unparseable body).
 */
export function owedResponseId(body: Uint8Array | string): JsonRpcId {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  return owedResponseIdOf(parsed);
}

/** {@link owedResponseId} for an already-parsed message. */
export function owedResponseIdOf(message: unknown): JsonRpcId {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const { id, method } = message as { id?: unknown; method?: unknown };
  if (typeof method !== "string") return null;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
