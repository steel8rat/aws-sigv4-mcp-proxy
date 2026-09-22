import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { resolveRetryOptions } from "../dist/empty.js";
import { startSigV4Proxy, type SigV4ProxyOptions } from "../dist/proxy.js";
import { startStdioProxy, type StdioProxyOptions } from "../dist/stdio.js";
import { MessageReader, startMockUpstream, TEST_CREDENTIALS, type CapturedRequest, type MockUpstream } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

const REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "example_tool" } };
const RESULT = { jsonrpc: "2.0", id: 1, result: { content: [] } };
const EMPTY_ERROR = {
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32603, message: "Upstream returned HTTP 200 with an empty body" },
};

type Handler = (req: CapturedRequest, res: ServerResponse, attempt: number) => void | Promise<void>;

/** Mock upstream whose handler also receives the 1-based attempt number. */
async function upstreamWith(handler: Handler): Promise<MockUpstream> {
  let attempt = 0;
  const upstream = await startMockUpstream((req, res) => handler(req, res, ++attempt));
  cleanups.push(() => upstream.close());
  return upstream;
}

const emptyReply: Handler = (_req, res) => res.end();

async function httpProxy(upstream: MockUpstream, extra: Partial<SigV4ProxyOptions> = {}): Promise<{ url: string; warnings: string[] }> {
  const warnings: string[] = [];
  const proxy = await startSigV4Proxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
    onWarn: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => proxy.close());
  return { url: proxy.url, warnings };
}

async function stdioProxy(
  upstream: MockUpstream,
  extra: Partial<StdioProxyOptions> = {},
): Promise<{ input: PassThrough; reader: MessageReader; warnings: string[]; close: () => Promise<void> }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const warnings: string[] = [];
  const proxy = await startStdioProxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
    input,
    output,
    serverStream: false,
    onWarn: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => proxy.close());
  return { input, reader: new MessageReader(output), warnings, close: () => proxy.close() };
}

function post(url: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { method: "POST", body: JSON.stringify(body), ...init });
}

/** Resolves once nothing else arrives on the reader within a short window. */
async function assertNoFurtherMessage(reader: MessageReader): Promise<void> {
  await assert.rejects(Promise.race([reader.take(), timeout(150)]), /no message/);
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("no message")), ms));
}

// --- Feature 1: a terminal empty 200 is reported, not passed through -----------------

test("http: an empty 200 to a request becomes a JSON-RPC error; retry off makes one upstream call", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { url } = await httpProxy(upstream);

  const res = await post(url, REQUEST);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), EMPTY_ERROR);
  assert.equal(upstream.requests.length, 1);
});

test("stdio: an empty 200 to a request produces exactly one JSON-RPC error instead of hanging", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { input, reader } = await stdioProxy(upstream);

  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), EMPTY_ERROR);
  await assertNoFurtherMessage(reader);
  assert.equal(upstream.requests.length, 1);
});

test("http: a declared text/event-stream with an empty body gets the error as an SSE frame", async () => {
  const upstream = await upstreamWith((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("mcp-session-id", "session-1");
    res.end();
  });
  const { url } = await httpProxy(upstream);

  const res = await post(url, REQUEST);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("mcp-session-id"), "session-1");
  assert.equal(await res.text(), `event: message\ndata: ${JSON.stringify(EMPTY_ERROR)}\n\n`);
});

test("stdio: an SSE response with zero events produces one JSON-RPC error", async () => {
  const upstream = await upstreamWith((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end();
  });
  const { input, reader } = await stdioProxy(upstream);

  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Upstream stream ended without a response" },
  });
  await assertNoFurtherMessage(reader);
});

test("stdio: an SSE response carrying only a notification still reports the missing response", async () => {
  const notification = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
  const upstream = await upstreamWith((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
  });
  const { input, reader } = await stdioProxy(upstream);

  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), notification);
  assert.deepEqual(await reader.take(), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Upstream stream ended without a response" },
  });
});

test("stdio: an SSE response that answers the request adds no error", async () => {
  const upstream = await upstreamWith((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(`event: message\ndata: ${JSON.stringify(RESULT)}\n\n`);
  });
  const { input, reader } = await stdioProxy(upstream);

  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), RESULT);
  await assertNoFurtherMessage(reader);
});

test("a whitespace-only body counts as empty in both transports", async () => {
  const upstream = await upstreamWith((_req, res) => res.end("\n \r\n"));

  const { url } = await httpProxy(upstream);
  assert.deepEqual(await (await post(url, REQUEST)).json(), EMPTY_ERROR);

  const { input, reader } = await stdioProxy(upstream);
  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), EMPTY_ERROR);
});

// --- Scope: only requests that are owed a response ------------------------------------

test("http: a notification, a client response and a batch pass an empty 200 through untouched", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { url } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  const bodies = [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 9, result: {} },
    [REQUEST],
  ];
  for (const body of bodies) {
    const res = await post(url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  }
  assert.equal(upstream.requests.length, bodies.length, "none of them retried");
});

test("http: GET and DELETE pass an empty 200 through and are never retried", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(url, { method });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  }
  assert.deepEqual(upstream.requests.map((r) => r.method), ["GET", "DELETE"]);
  assert.deepEqual(warnings, []);
});

test("stdio: a notification answered with an empty 200 produces no message", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { input, reader } = await stdioProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await assertNoFurtherMessage(reader);
  assert.equal(upstream.requests.length, 1);
});

// --- Feature 2: retrying the empty 200 -------------------------------------------------

test("http: retries an empty 200 and returns the body of the next attempt", async () => {
  const upstream = await upstreamWith((_req, res, attempt) => {
    if (attempt === 1) return res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(RESULT));
  });
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  assert.deepEqual(await (await post(url, REQUEST)).json(), RESULT);
  assert.equal(upstream.requests.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^empty 200 from upstream; attempt 1 of 3 failed, retrying in \d+ms$/);
});

test("stdio: retries an empty 200 and forwards the body of the next attempt", async () => {
  const upstream = await upstreamWith((_req, res, attempt) => {
    if (attempt === 1) return res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(RESULT));
  });
  const { input, reader, warnings } = await stdioProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  input.write(JSON.stringify(REQUEST) + "\n");
  assert.deepEqual(await reader.take(), RESULT);
  assert.equal(upstream.requests.length, 2);
  assert.equal(warnings.length, 1);
});

test("http: after every attempt comes back empty, the error is emitted once", async () => {
  const upstream = await upstreamWith(emptyReply);
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: { attempts: 3, backoffMs: 1 } });

  assert.deepEqual(await (await post(url, REQUEST)).json(), EMPTY_ERROR);
  assert.equal(upstream.requests.length, 3);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1]!, /attempt 2 of 3 failed/);
});

test("http: a non-empty 200 passes through intact, first chunk included", async () => {
  const upstream = await upstreamWith(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    const text = JSON.stringify(RESULT);
    res.write(" " + text.slice(0, 1)); // leading whitespace, then the first real byte
    await new Promise((r) => setTimeout(r, 20));
    res.end(text.slice(1));
  });
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: true });

  assert.deepEqual(await (await post(url, REQUEST)).json(), RESULT);
  assert.equal(upstream.requests.length, 1);
  assert.deepEqual(warnings, []);
});

test("http: a text/event-stream response streams chunk by chunk through the peek", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const upstream = await upstreamWith(async (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
    await gate; // the second event is only written once the client has seen the first
    res.end(`event: message\ndata: ${JSON.stringify(RESULT)}\n\n`);
  });
  const { url } = await httpProxy(upstream, { retryEmptyResponse: true });

  const res = await post(url, REQUEST);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /notifications\/progress/);
  assert.doesNotMatch(first, /"result"/);
  release();

  let rest = "";
  for (let next = await reader.read(); !next.done; next = await reader.read()) rest += new TextDecoder().decode(next.value);
  assert.match(rest, /"result"/);
});

test("http: a non-200 response is returned immediately and never retried", async () => {
  const upstream = await upstreamWith((_req, res) => {
    res.statusCode = 500;
    res.end();
  });
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 1 } });

  const res = await post(url, REQUEST);
  assert.equal(res.status, 500);
  assert.equal(upstream.requests.length, 1);
  assert.deepEqual(warnings, []);
});

test("stdio: closing mid-backoff stops the retry loop", async (t) => {
  t.mock.method(Math, "random", () => 0.99); // pin the jittered delay near its ceiling
  const upstream = await upstreamWith(emptyReply);
  const { input, reader, close } = await stdioProxy(upstream, { retryEmptyResponse: { backoffMs: 10_000 } });

  input.write(JSON.stringify(REQUEST) + "\n");
  while (upstream.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
  const started = Date.now();
  await close();

  assert.ok(Date.now() - started < 1000, "close did not wait out the backoff");
  assert.equal(upstream.requests.length, 1);
  await assertNoFurtherMessage(reader);
});

test("http: a client disconnect mid-backoff stops the retry loop", async (t) => {
  t.mock.method(Math, "random", () => 0.99);
  const upstream = await upstreamWith(emptyReply);
  const { url, warnings } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 300 } });

  const abort = new AbortController();
  const pending = post(url, REQUEST, { signal: abort.signal }).catch(() => undefined);
  while (warnings.length === 0) await new Promise((r) => setTimeout(r, 5));
  abort.abort();
  await pending;

  await new Promise((r) => setTimeout(r, 450)); // past the ~300ms backoff
  assert.equal(upstream.requests.length, 1);
});

test("retry replays the request signed once: identical authorization and x-amz-date", async (t) => {
  // Backoff pinned past one second, so a re-sign would produce a different x-amz-date.
  t.mock.method(Math, "random", () => 0.99);
  const upstream = await upstreamWith((_req, res, attempt) => {
    if (attempt === 1) return res.end();
    res.end(JSON.stringify(RESULT));
  });
  const { url } = await httpProxy(upstream, { retryEmptyResponse: { backoffMs: 1100 } });

  assert.deepEqual(await (await post(url, REQUEST)).json(), RESULT);
  assert.equal(upstream.requests.length, 2);
  const [first, second] = upstream.requests;
  assert.equal(second!.headers["authorization"], first!.headers["authorization"]);
  assert.equal(second!.headers["x-amz-date"], first!.headers["x-amz-date"]);
});

test("retryEmptyResponse: defaults, and invalid values fail at startup", async () => {
  assert.equal(resolveRetryOptions(undefined), undefined);
  assert.equal(resolveRetryOptions(false), undefined);
  assert.deepEqual(resolveRetryOptions(true), { attempts: 3, backoffMs: 150 });
  assert.deepEqual(resolveRetryOptions({ attempts: 5 }), { attempts: 5, backoffMs: 150 });
  assert.throws(() => resolveRetryOptions({ attempts: 0 }), /attempts/);
  assert.throws(() => resolveRetryOptions({ attempts: 1.5 }), /attempts/);
  assert.throws(() => resolveRetryOptions({ backoffMs: -1 }), /backoffMs/);

  const upstream = await upstreamWith(emptyReply);
  await assert.rejects(httpProxy(upstream, { retryEmptyResponse: { attempts: 0 } }), /attempts/);
});
