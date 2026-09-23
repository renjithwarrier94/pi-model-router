import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionContext, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { ModelOption } from "../../../src/domain/model-option.js";
import { getRuntimeCandidates } from "../../../src/adapters/pi/runtime-candidates.js";

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
