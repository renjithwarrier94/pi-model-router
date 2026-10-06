import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeforeAgentStartEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateContextCapacity as estimate } from "../../../src/adapters/pi/estimate-context-capacity.js";

const event = { prompt: "x", systemPrompt: "y", systemPromptOptions: { selectedTools: [] } } as unknown as BeforeAgentStartEvent;
const capacity = (messages: unknown[] = [], e = event, tools: ToolInfo[] = []) => {
  const result = estimate(messages, e, tools);
  assert.equal(result.status, "estimated");
  if (result.status !== "estimated") throw Error();
  return result;
};
test("fallback formula uses UTF-8 bytes, message overhead, headroom and reserves", () => {
  assert.equal(capacity().capacityNeeded, 17027);
  assert.equal(capacity([], { ...event, prompt: "é" }).capacityNeeded, Math.ceil(515 * 1.25) + 16384);
  assert.equal(capacity([], { ...event, prompt: "😀" }).capacityNeeded, Math.ceil(517 * 1.25) + 16384);
  assert.equal(capacity([{ role: "user", content: "x" }]).capacityNeeded, Math.ceil(771 * 1.25) + 16384);
});
test("images use a fixed reserve, not base64 size", () => {
  const image = { type: "image", data: "a", mimeType: "image/png" } as const;
  const a = capacity([], { ...event, images: [image] });
  const b = capacity([], { ...event, images: [{ ...image, data: "a".repeat(2_000_001) }] });
  assert.deepEqual(a, b);
  assert.equal(a.capacityNeeded, Math.ceil((514 + 8192) * 1.25) + 16384);
  assert.equal(a.imageCount, 1);
});
test("retained summaries, results and tool arguments count but metadata does not", () => {
  const messages = [
    { role: "compactionSummary", summary: "summary" },
    { role: "branchSummary", summary: "branch" },
    { role: "bashExecution", command: "ls", output: "file" },
    { role: "toolResult", toolName: "read", toolCallId: "1", content: [{ type: "text", text: "result" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "think" }, { type: "toolCall", id: "1", name: "read", arguments: { path: "file" } }] },
    { role: "custom", content: "custom", details: { secret: "not measured" } },
    { role: "system", content: "system", sections: { guidelines: "guide" }, toolsAdded: [] },
  ];
  assert.ok(capacity(messages).capacityNeeded > capacity().capacityNeeded);
  assert.deepEqual(capacity(messages), capacity(messages.map(m => ({ ...m, usage: { totalTokens: 999999 }, timestamp: 42 }))));
  const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }] as unknown as ToolInfo[];
  assert.ok(capacity([], { ...event, systemPromptOptions: { selectedTools: ["read"] } } as BeforeAgentStartEvent, tools).capacityNeeded > capacity().capacityNeeded);
});
test("unsupported, missing, cyclic and invalid content fail closed", () => {
  const cycle: any = {}; cycle.self = cycle;
  for (const messages of [[{ role: "newRole" }], [{ role: "user", content: [{ type: "audio" }] }],
    [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "x", arguments: cycle }] }]]) {
    assert.deepEqual(estimate(messages, event, []), { status: "unavailable" });
  }
  assert.deepEqual(estimate([], { prompt: "x" } as BeforeAgentStartEvent, []), { status: "unavailable" });
  assert.deepEqual(estimate([], { ...event, systemPromptOptions: { selectedTools: ["missing"] } } as BeforeAgentStartEvent, []), { status: "unavailable" });
  assert.deepEqual(estimate([], event, [], AbortSignal.abort()), { status: "unavailable" });
});
test("JSON depth and primitive validation fail closed", () => {
  const withArgument = (argumentsValue: unknown) => [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "x", arguments: argumentsValue }] }];
  const nested = (depth: number): unknown => depth === 0 ? "leaf" : { child: nested(depth - 1) };
  assert.equal(estimate(withArgument(nested(32)), event, []).status, "estimated");
  assert.equal(estimate(withArgument(nested(33)), event, []).status, "unavailable");
  for (const value of [NaN, Infinity, 1n, undefined, () => {}]) {
    assert.equal(estimate(withArgument({ value }), event, []).status, "unavailable");
  }
});

test("measurement byte and message bounds are inclusive", () => {
  assert.equal(estimate([], { ...event, prompt: "x".repeat(1_999_999) }, []).status, "estimated");
  assert.equal(estimate([], { ...event, prompt: "x".repeat(2_000_000) }, []).status, "unavailable");
  assert.equal(estimate(Array.from({ length: 10_000 }, () => ({ role: "user", content: "" })), event, []).status, "estimated");
  assert.equal(estimate(Array.from({ length: 10_001 }, () => ({ role: "user", content: "" })), event, []).status, "unavailable");
});
