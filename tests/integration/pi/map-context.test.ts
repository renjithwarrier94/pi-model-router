import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionManager,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { mapContext } from "../../../src/adapters/pi/map-context.js";

type Message = SessionProjection["messages"][number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const image = { type: "image" as const, data: "PRIVATE_IMAGE", mimeType: "image/png" };

function project(messages: Message[]) {
  return {
    buildSessionProjection(): SessionProjection {
      return { entries: [], messages, thinkingLevel: "off", model: null };
    },
  };
}

test("maps an empty session and keeps the current request separate", () => {
  assert.deepEqual(mapContext({ prompt: "  new request\n" }, SessionManager.inMemory()), {
    history: [],
    summaries: [],
    currentRequest: { text: "  new request\n", imageCount: 0 },
  });
});

test("retains text order, whitespace, empty messages, and image counts only", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "  first\n", timestamp: 0 });
  session.appendMessage(assistant([
    { type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
    { type: "text", text: "before" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "PRIVATE_ARGS" } },
    { type: "text", text: "after" },
  ]));
  session.appendMessage({ role: "user", content: [image, { type: "text", text: "look" }, image], timestamp: 0 });
  session.appendMessage({ role: "user", content: [image], timestamp: 0 });
  session.appendMessage({ role: "user", content: [], timestamp: 0 });
  session.appendMessage(assistant([{ type: "toolCall", id: "call2", name: "bash", arguments: {} }]));
  session.appendMessage(assistant([{ type: "thinking", thinking: "PRIVATE_ONLY_THINKING" }]));
  const before = structuredClone(session.getEntries());

  const snapshot = mapContext({ prompt: "current", images: [image, image] }, session);
  assert.deepEqual(snapshot, {
    history: [
      { role: "user", text: "  first\n", imageCount: 0 },
      { role: "assistant", text: "before\nafter", imageCount: 0 },
      { role: "user", text: "look", imageCount: 2 },
      { role: "user", text: "", imageCount: 1 },
      { role: "user", text: "", imageCount: 0 },
      { role: "assistant", text: "", imageCount: 0 },
      { role: "assistant", text: "", imageCount: 0 },
    ],
    summaries: [],
    currentRequest: { text: "current", imageCount: 2 },
  });
  assert.deepEqual(session.getEntries(), before);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test("excludes system, tool results, bash, extension messages, and session state", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "system", content: "PRIVATE_SYSTEM", timestamp: 0 });
  session.appendMessage({
    role: "toolResult", toolCallId: "call", toolName: "read",
    content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }, image],
    details: { secret: "PRIVATE_DETAILS" }, isError: false, timestamp: 0,
  });
  session.appendMessage({
    role: "bashExecution", command: "PRIVATE_COMMAND", output: "PRIVATE_OUTPUT",
    exitCode: 0, cancelled: false, truncated: false, timestamp: 0,
  });
  session.appendMessage({ role: "custom", customType: "test", content: "PRIVATE_CUSTOM", display: true, timestamp: 0 });
  session.appendCustomMessageEntry("test", "PRIVATE_EXTENSION", false);
  session.appendCustomEntry("test", { secret: "PRIVATE_STATE" });
  session.appendModelChange("PRIVATE_PROVIDER", "PRIVATE_MODEL");

  assert.deepEqual(mapContext({ prompt: "" }, session), {
    history: [], summaries: [], currentRequest: { text: "", imageCount: 0 },
  });
});

test("uses the active projection with compaction, context edits, and branch summaries", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "summarized original", timestamp: 0 });
  const kept = session.appendMessage({ role: "user", content: "original kept", timestamp: 0 });
  const removed = session.appendMessage(assistant([{ type: "text", text: "removed answer" }]));
  session.appendCompaction("Earlier goals", kept, 1000);
  session.appendContextEdit(kept, { content: "replacement kept" });
  session.appendContextEdit(removed, null);
  const branchPoint = session.getLeafId()!;
  session.appendMessage({ role: "user", content: "abandoned branch", timestamp: 0 });
  session.branchWithSummary(branchPoint, "Alternative explored");
  session.appendMessage({ role: "user", content: "active branch", timestamp: 0 });

  assert.deepEqual(mapContext({ prompt: "next" }, session), {
    history: [
      { role: "user", text: "replacement kept", imageCount: 0 },
      { role: "user", text: "active branch", imageCount: 0 },
    ],
    summaries: [
      { kind: "compaction", text: "Earlier goals" },
      { kind: "branch", text: "Alternative explored" },
    ],
    currentRequest: { text: "next", imageCount: 0 },
  });
});

test("calls only buildSessionProjection once and detaches output from host objects", () => {
  const block = { type: "text" as const, text: "original" };
  const summary = { role: "branchSummary" as const, summary: "branch", fromId: null, timestamp: 0 };
  const messages: Message[] = [{ role: "user", content: [block, image], timestamp: 0 }, summary];
  const event = { prompt: "request", images: [image] };
  let calls = 0;
  const snapshot = mapContext(event, {
    buildSessionProjection() {
      calls += 1;
      return project(messages).buildSessionProjection();
    },
  });
  block.text = "changed";
  summary.summary = "changed";
  messages.length = 0;
  event.prompt = "changed";
  event.images.length = 0;

  assert.equal(calls, 1);
  assert.deepEqual(snapshot, {
    history: [{ role: "user", text: "original", imageCount: 1 }],
    summaries: [{ kind: "branch", text: "branch" }],
    currentRequest: { text: "request", imageCount: 1 },
  });
});

test("does not silently fall back to raw history when projection fails", () => {
  const failure = new Error("projection unavailable");
  assert.throws(() => mapContext({ prompt: "new" }, {
    buildSessionProjection() { throw failure; },
  }), (error) => error === failure);
});
