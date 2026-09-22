import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { startStdioProxy, type StdioProxy } from "../dist/stdio.js";
import { MessageReader, startMockUpstream, TEST_CREDENTIALS, type MockUpstream } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

function makeStreams(): { input: PassThrough; output: PassThrough; reader: MessageReader } {
  const output = new PassThrough();
  return { input: new PassThrough(), output, reader: new MessageReader(output) };
}

function track(proxy: StdioProxy, upstream: MockUpstream): void {
  cleanups.push(() => proxy.close(), () => upstream.close());
}

test("bridges an initialize round-trip and tracks the session id", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.setHeader("content-type", "application/json");
    const parsed = JSON.parse(req.body) as { id: number; method: string };
    if (parsed.method === "initialize") {
      res.setHeader("mcp-session-id", "sess-abc");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18" } }));
    } else {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { echoed: parsed.method } }));
    }
  });
  const { input, output, reader } = makeStreams();
  const proxy = await startStdioProxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
    input,
    output,
    serverStream: false,
  });
  track(proxy, upstream);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
  assert.deepEqual(await reader.take(), { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  assert.deepEqual(await reader.take(), { jsonrpc: "2.0", id: 2, result: { echoed: "tools/list" } });

  const secondUpstream = upstream.requests[1]!;
  assert.equal(secondUpstream.headers["mcp-session-id"], "sess-abc");
  assert.equal(secondUpstream.headers["mcp-protocol-version"], "2025-06-18");
  assert.ok(typeof secondUpstream.headers["authorization"] === "string");
});

test("expands a text/event-stream response into multiple stdio messages", async () => {
  const upstream = await startMockUpstream((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"n":1}}\n\n');
    res.write('data: {"jsonrpc":"2.0","id":7,"result":{"done":true}}\n\n');
    res.end();
  });
  const { input, output, reader } = makeStreams();
  const proxy = await startStdioProxy({
    targetUrl: upstream.url,
    service: "lambda",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
    input,
    output,
    serverStream: false,
  });
  track(proxy, upstream);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" }) + "\n");
  assert.deepEqual(await reader.take(), { jsonrpc: "2.0", method: "notifications/progress", params: { n: 1 } });
  assert.deepEqual(await reader.take(), { jsonrpc: "2.0", id: 7, result: { done: true } });
});

test("emits a JSON-RPC error when the upstream returns a 5xx", async () => {
  const upstream = await startMockUpstream((_req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  const { input, output, reader } = makeStreams();
  const proxy = await startStdioProxy({
    targetUrl: upstream.url,
    service: "bedrock-agentcore",
    region: "us-east-1",
    credentials: TEST_CREDENTIALS,
    input,
    output,
    serverStream: false,
  });
  track(proxy, upstream);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n");
  const message = (await reader.take()) as { id: number; error: { code: number; message: string } };
  assert.equal(message.id, 9);
  assert.equal(message.error.code, -32001);
  assert.match(message.error.message, /HTTP 500/);
});
