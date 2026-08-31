import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_CORE_SERVICE, agentCoreInvocationUrl, regionFromArn } from "../dist/agentcore.js";

const ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_mcp-Ab1Cd2Ef3G";

test("regionFromArn returns the region segment", () => {
  assert.equal(regionFromArn(ARN), "us-east-1");
  assert.equal(regionFromArn("arn:aws:s3:eu-west-2:123:bucket"), "eu-west-2");
});

test("regionFromArn rejects malformed input", () => {
  assert.throws(() => regionFromArn("not-an-arn"), /Not a valid ARN/);
  assert.throws(() => regionFromArn("arn:aws:s3"), /Not a valid ARN/);
  assert.throws(() => regionFromArn("arn:aws:iam::123:role/x"), /no region segment/);
});

test("agentCoreInvocationUrl builds the invoke URL with defaults", () => {
  assert.equal(
    agentCoreInvocationUrl(ARN),
    `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(ARN)}/invocations?qualifier=DEFAULT`,
  );
});

test("agentCoreInvocationUrl url-encodes the ARN (slashes included)", () => {
  const url = agentCoreInvocationUrl(ARN);
  assert.ok(url.includes("runtime%2Fmy_mcp-Ab1Cd2Ef3G"));
  assert.ok(!url.includes("runtime/my_mcp"));
});

test("agentCoreInvocationUrl honors region, qualifier and dnsSuffix overrides", () => {
  const url = agentCoreInvocationUrl(ARN, { region: "us-west-2", qualifier: "v2", dnsSuffix: "amazonaws.com.cn" });
  assert.ok(url.startsWith("https://bedrock-agentcore.us-west-2.amazonaws.com.cn/runtimes/"));
  assert.ok(url.endsWith("/invocations?qualifier=v2"));
});

test("agentCoreInvocationUrl rejects a non-ARN", () => {
  assert.throws(() => agentCoreInvocationUrl("https://example.com"), /Expected a Bedrock AgentCore runtime ARN/);
});

test("AGENT_CORE_SERVICE is the data-plane signing name", () => {
  assert.equal(AGENT_CORE_SERVICE, "bedrock-agentcore");
});
