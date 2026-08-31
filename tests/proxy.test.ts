import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startSigV4Proxy, type SigV4Proxy } from "../dist/proxy.js";
import { readAll, startMockUpstream, TEST_CREDENTIALS, type MockUpstream } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

function track(proxy: SigV4Proxy, upstream: MockUpstream): void {
  cleanups.push(() => proxy.close(), () => upstream.close());
}

test("signs forwarded requests with SigV4 and round-trips the body", async () => {
  const upstream = await startMockUpstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", "sess-123");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  const proxy = await startSigV4Proxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
  });
  track(proxy, upstream);

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const res = await fetch(proxy.url, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-session-id": "sess-123" },
    body,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), "sess-123");
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: { ok: true } });

  assert.equal(upstream.requests.length, 1);
  const seen = upstream.requests[0]!;
  assert.equal(seen.body, body);
  assert.equal(seen.headers["mcp-session-id"], "sess-123");

  const auth = seen.headers["authorization"];
  assert.ok(typeof auth === "string");
  assert.match(auth, /^AWS4-HMAC-SHA256 /);
  assert.match(auth, /Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request/);
  assert.match(auth, /SignedHeaders=[^,]*host/);
  assert.match(auth, /Signature=[0-9a-f]{64}/);
  assert.ok(typeof seen.headers["x-amz-date"] === "string");
});

test("adds a default Accept header when the client omits it", async () => {
  const upstream = await startMockUpstream((_req, res) => res.end("{}"));
  const proxy = await startSigV4Proxy({
    targetUrl: upstream.url,
    service: "lambda",
    region: "eu-west-1",
    credentials: TEST_CREDENTIALS,
  });
  track(proxy, upstream);

  await fetch(proxy.url, { method: "POST", body: "{}" });
  assert.equal(upstream.requests[0]!.headers["accept"], "application/json, text/event-stream");
});

test("streams a text/event-stream response instead of buffering it", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}\n\n");
    await new Promise((r) => setTimeout(r, 50));
    res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":2}\n\n");
    res.end();
  });
  const proxy = await startSigV4Proxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
  });
  track(proxy, upstream);

  const res = await fetch(proxy.url, { method: "POST", body: "{}" });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.equal(text.match(/data:/g)?.length, 2);
  assert.ok(text.includes('"result":1'));
  assert.ok(text.includes('"result":2'));
});

test("returns a JSON-RPC error envelope when the upstream is unreachable", async () => {
  const upstream = await startMockUpstream(() => {});
  const deadUrl = upstream.url;
  await upstream.close();

  const proxy = await startSigV4Proxy({
    targetUrl: deadUrl,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
  });
  cleanups.push(() => proxy.close());

  const res = await fetch(proxy.url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }),
  });
  assert.equal(res.status, 502);
  const payload = (await res.json()) as { jsonrpc: string; id: unknown; error: { code: number; message: string } };
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.id, 42);
  assert.equal(payload.error.code, -32001);
  assert.match(payload.error.message, /could not reach upstream/);
});

test("forwards GET (no body) for the standalone SSE stream", async () => {
  const upstream = await startMockUpstream((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/ping\"}\n\n");
  });
  const proxy = await startSigV4Proxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
  });
  track(proxy, upstream);

  const res = await fetch(proxy.url, { method: "GET", headers: { accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  await readAll(res.body as unknown as NodeJS.ReadableStream);
  assert.equal(upstream.requests[0]!.method, "GET");
  assert.equal(upstream.requests[0]!.body, "");
  assert.ok(typeof upstream.requests[0]!.headers["authorization"] === "string");
});
