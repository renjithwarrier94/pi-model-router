import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionContext, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { ModelOption } from "../../../src/domain/model-option.js";
import { getRuntimeCandidates, inspectRuntimeCandidates } from "../../../src/adapters/pi/runtime-candidates.js";
import { estimateContextCapacity } from "../../../src/adapters/pi/estimate-context-capacity.js";

const fallbackEvent = { type: "before_agent_start", prompt: "x", systemPrompt: "y", systemPromptOptions: { selectedTools: [] } } as unknown as BeforeAgentStartEvent;

test("unknown usage uses structured local estimates with exact capacity boundaries", async () => {
  const h = host({ getContextUsage: () => ({ tokens: null }), model: { contextWindow: 17027 } });
  assert.equal((await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => [])).candidates.length, 1);
  assert.equal((await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => [])).capacitySource, "estimated");
  h.model.contextWindow = 17026;
  const small = await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => []);
  assert.deepEqual(small, { candidates: [], capacitySource: "estimated" });
  assert.deepEqual(await inspectRuntimeCandidates([base], h.context, fallbackEvent), { candidates: [], capacitySource: "unavailable" });
});

test("fallback counts only active post-compaction projection and context replacements", async () => {
  const h = host({ getContextUsage: () => undefined });
  h.sessionManager.appendMessage({ role: "user", content: "x".repeat(2_000_001), timestamp: 0 });
  const kept = h.sessionManager.appendMessage({ role: "user", content: "kept", timestamp: 0 });
  h.sessionManager.appendCompaction("summary", kept, 3_000_000);
  h.sessionManager.appendContextEdit(kept, { content: "replacement" });
  const branchPoint = h.sessionManager.getLeafId()!;
  h.sessionManager.appendMessage({ role: "user", content: "x".repeat(2_000_001), timestamp: 0 });
  h.sessionManager.branchWithSummary(branchPoint, "branch");
  const projected = h.sessionManager.buildSessionProjection().messages;
  assert.equal(estimateContextCapacity(projected, fallbackEvent, []).status, "estimated");
  assert.equal((await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => [])).candidates.length, 1);
  h.sessionManager.appendMessage({ role: "user", content: "x".repeat(2_000_001), timestamp: 0 });
  assert.equal((await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => [])).capacitySource, "unavailable");
});

test("invalid usage and missing or throwing fallback APIs fail before auth", async () => {
  for (const tokens of [-1, NaN, Infinity, 1.5]) {
    const h = host({ getContextUsage: () => ({ tokens }) });
    assert.deepEqual(await inspectRuntimeCandidates([base], h.context, fallbackEvent), { candidates: [], capacitySource: "unavailable" });
  }
  const h = host({ getContextUsage: () => ({ tokens: null }), modelRegistry: {
    getAvailable: () => { assert.fail("must not resolve auth"); },
  } });
  assert.equal((await inspectRuntimeCandidates([base], h.context, fallbackEvent, undefined, () => { throw Error("PRIVATE"); })).capacitySource, "unavailable");
  const valid = host();
  assert.equal((await inspectRuntimeCandidates([base], valid.context, event, undefined, () => { assert.fail("fallback only"); })).capacitySource, "pi");
});

const base: ModelOption = {
  id: "candidate", provider: "provider", model: "model", thinkingLevel: "high",
  deepSweScore: 70, costPerTaskUsd: 0.2, categories: ["general"],
};
const hostModel = {
  provider: "provider", id: "model", reasoning: true, input: ["text", "image"], contextWindow: 200_000,
};
const event = { type: "before_agent_start", prompt: "prompt" } as BeforeAgentStartEvent;
function host(overrides: Record<string, unknown> = {}) {
  const sessionManager = SessionManager.inMemory();
  const model = { ...hostModel, ...(overrides.model as object ?? {}) };
  const auth = { ok: true };
  const context = {
    sessionManager,
    signal: undefined,
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [model],
      getApiKeyAndHeaders: async () => auth,
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 1 }),
    ...overrides,
  } as unknown as ExtensionContext;
  return { sessionManager, context, model };
}

test("exact registry identity, usable auth and context capacity are required", async () => {
  const h = host();
  assert.equal((await getRuntimeCandidates([base], h.context, event)).length, 1);
  assert.deepEqual(await getRuntimeCandidates([{ ...base, provider: "other" }], h.context, event), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ model: { contextWindow: 8200 } }).context, event), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ model: { inputLimits: { maxRequestBytes: 100_000 } } }).context, event), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ getContextUsage: () => ({ tokens: null }) }).context, event), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ modelRegistry: {
    getAvailable: () => [h.model], getApiKeyAndHeaders: async () => ({ ok: false, error: "private" }),
  } }).context, event), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ modelRegistry: {
    getAvailable: () => [h.model], getApiKeyAndHeaders: async () => { throw Error("private"); },
  } }).context, event), []);
});

test("Pi-supported thinking levels must match exactly, never clamp", async () => {
  assert.deepEqual(await getRuntimeCandidates([base], host({ model: { reasoning: false } }).context, event), []);
  assert.deepEqual(await getRuntimeCandidates([{ ...base, thinkingLevel: "xhigh" }], host().context, event), []);
  assert.equal((await getRuntimeCandidates([{ ...base, thinkingLevel: "off" }], host({ model: { reasoning: false } }).context, event)).length, 1);
});

test("session model scope may specify an exact thinking level", async () => {
  const h = host();
  const scope = [{ model: h.model, thinkingLevel: "low" }];
  assert.deepEqual(await getRuntimeCandidates([base], host({ scopedModels: scope }).context, event), []);
  assert.equal((await getRuntimeCandidates([{ ...base, thinkingLevel: "low" }], host({ scopedModels: scope }).context, event)).length, 1);
});

test("images in the current prompt or historical tool messages require compatible limits", async () => {
  const h = host();
  const image = { type: "image", data: "a", mimeType: "image/png" } as const;
  const withImage = { ...event, images: [image] } as BeforeAgentStartEvent;
  assert.deepEqual(await getRuntimeCandidates([base], host({ model: { input: ["text"] } }).context, withImage), []);
  assert.deepEqual(await getRuntimeCandidates([base], host({ model: { inputLimits: { images: { maxPerRequest: 0 } } } }).context, withImage), []);
  assert.equal((await getRuntimeCandidates([base], h.context, withImage)).length, 1);
  h.sessionManager.appendMessage({ role: "user", timestamp: 0, content: [image] });
  assert.deepEqual(await getRuntimeCandidates([base], host({
    sessionManager: h.sessionManager, model: { input: ["text"] },
  }).context, event), []);
});

test("aborted runs do not resolve candidate credentials", async () => {
  const h = host({ signal: AbortSignal.abort() });
  assert.deepEqual(await getRuntimeCandidates([base], h.context, event), []);
});

test("router deadline stops further credential lookups after an in-flight lookup completes", async () => {
  const controller = new AbortController();
  let finish: ((value: { ok: true }) => void) | undefined;
  let lookups = 0;
  const h = host({ modelRegistry: {
    getAvailable: () => [hostModel],
    getApiKeyAndHeaders: () => {
      lookups++;
      return new Promise<{ ok: true }>(done => { finish = done; });
    },
  } });
  const pending = getRuntimeCandidates([base, { ...base, id: "second" }], h.context, event, controller.signal);
  assert.ok(finish);
  controller.abort();
  finish({ ok: true });
  assert.deepEqual(await pending, []);
  assert.equal(lookups, 1);
});
