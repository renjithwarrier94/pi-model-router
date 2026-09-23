import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";
import type { ModelOption } from "../../../src/domain/model-option.js";
import type { RoutingAdapters } from "../../../src/adapters/pi/assessment-extension.js";
import { createAssessmentExtension } from "../../../src/adapters/pi/assessment-extension.js";

const policy = {
  weights: { reasoningDemand: 1, dependencyScope: 0, contextIntegrationDemand: 0 },
  difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1, score: 80 }],
  maxMissingCriticalEvidenceProbability: 0.7,
};
const option: ModelOption = {
  id: "cheapest", provider: "provider", model: "model", thinkingLevel: "high", deepSweScore: 60,
  costPerTaskUsd: 0.1, categories: ["implement"],
};
function runHarness(overrides: {
  provider?: JudgmentProvider;
  config?: RoutingAdapters["loadConfig"];
  candidates?: RoutingAdapters["candidates"];
  switchModel?: (model: unknown) => Promise<boolean>;
} = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, (arg: string, ctx: ExtensionContext) => Promise<void>>();
  const notifications: string[] = [];
  const switched: unknown[] = [];
  const levels: string[] = [];
  const sessionManager = SessionManager.inMemory();
  let activeModel: { provider: string; id: string } | undefined;
  let currentLevel = "off";
  const ctx = {
    hasUI: true, signal: undefined, sessionManager,
    get model() { return activeModel; },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  let calls = 0;
  const provider = overrides.provider ?? {
    async judge() {
      calls++;
      return { answers: {
        workCategory: { type: "choice", choice: "implement", confidence: 1, probabilities: {} },
        reasoningDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
        dependencyScope: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
        contextIntegrationDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
        missingCriticalEvidence: { type: "noul", probability: 0.2 },
      } } as never;
    },
  };
  const routing: RoutingAdapters = {
    loadConfig: overrides.config ?? (async () => ({ version: 1, options: [option], policy })),
    candidates: overrides.candidates ?? (async () => [{ option, model: { provider: "provider", id: "model" } as never }]),
  };
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); return () => {}; },
    registerCommand(name: string, spec: { handler: (arg: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, spec.handler);
    },
    async setModel(model: unknown) {
      switched.push(model);
      const success = overrides.switchModel ? await overrides.switchModel(model) : true;
      if (success) {
        activeModel = model as { provider: string; id: string };
        sessionManager.appendModelChange(activeModel.provider, activeModel.id); // Pi advances the session leaf.
      }
      return success;
    },
    setThinkingLevel(level: string) { levels.push(level); currentLevel = level; },
    getThinkingLevel() { return currentLevel; },
    sendMessage() { assert.fail("route must not inject context"); },
    appendEntry() { assert.fail("route must not persist context"); },
  } as unknown as ExtensionAPI;
  createAssessmentExtension(() => provider, routing)(pi);
  return {
    ctx, notifications, switched, levels, calls: () => calls,
    async command(name: string, arg: string) { await commands.get(name)?.(arg, ctx); },
    async run(prompt: string) { await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, ctx); },
    async event(name: string) { await handlers.get(name)?.({}, ctx); },
  };
}

test("route once selects a model and configured thinking level, while assessment command remains diagnostic", async () => {
  const h = runHarness();
  await h.run("no consent");
  assert.equal(h.calls(), 0);
  await h.command("model-router-assess", "once");
  await h.run("diagnostic");
  assert.equal(h.switched.length, 0);
  await h.command("model-router-route", "once");
  await h.run("PRIVATE_NEXT_PROMPT");
  assert.equal(h.calls(), 2);
  assert.equal(h.switched.length, 1);
  assert.deepEqual(h.levels, ["high"]);
  await h.run("no second permission");
  assert.equal(h.calls(), 2);
  assert.ok(h.notifications.some(n => n.includes("difficulty 0.50, required score 60.00")));
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_NEXT_PROMPT/);
});

test("absent policy, options, or eligible models skip without a TypeSafe request", async () => {
  const h = runHarness({ config: async () => ({ version: 1, options: [option] }) });
  await h.command("model-router-route", "once");
  await h.run("prompt");
  assert.equal(h.calls(), 0);
  assert.equal(h.switched.length, 0);
  const empty = runHarness({ candidates: async () => [] });
  await empty.command("model-router-route", "once");
  await empty.run("prompt");
  assert.equal(empty.calls(), 0);
});

test("threshold-unmet fallback selects highest-scoring compatible option with diagnostic", async () => {
  const cheap = { ...option, id: "weak", deepSweScore: 58, costPerTaskUsd: 0.01 };
  const h = runHarness({
    config: async () => ({ version: 1, policy: { ...policy, difficultyToDeepSweScore: [
      { difficulty: 0, score: 80 }, { difficulty: 1, score: 90 },
    ] }, options: [cheap, option] }),
    candidates: async () => [cheap, option].map(o => ({ option: o, model: { provider: o.provider, id: o.id } as never })),
  });
  await h.command("model-router-route", "once");
  await h.run("prompt");
  assert.deepEqual(h.switched, [{ provider: "provider", id: "cheapest" }]);
  assert.ok(h.notifications.at(-1)?.includes("threshold unmet by 25.00"));
});

test("no category match, high missing evidence or failed model switch leave thinking level unchanged", async () => {
  const review = { ...option, categories: ["review"] as const };
  const h = runHarness({ candidates: async () => [{ option: review, model: {} as never }] });
  await h.command("model-router-route", "once");
  await h.run("prompt");
  assert.equal(h.switched.length, 0);
  assert.ok(h.notifications.at(-1)?.includes("no-category-match"));
  const failed = runHarness({ switchModel: async () => false });
  await failed.command("model-router-route", "once");
  await failed.run("prompt");
  assert.equal(failed.switched.length, 1);
  assert.equal(failed.levels.length, 0);
});

test("critical-evidence gate leaves the model untouched even when an option qualifies", async () => {
  const h = runHarness({ provider: { async judge() { return { answers: {
    workCategory: { type: "choice", choice: "implement", confidence: 1, probabilities: {} },
    reasoningDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    dependencyScope: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    contextIntegrationDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    missingCriticalEvidence: { type: "noul", probability: 0.8 },
  } } as never; } } });
  await h.command("model-router-route", "once");
  await h.run("prompt");
  assert.equal(h.switched.length, 0);
  assert.ok(h.notifications.at(-1)?.includes("critical-evidence"));
});

test("an in-flight route cancelled before assessment returns never switches models", async () => {
  let resolve: ((answer: unknown) => void) | undefined;
  const h = runHarness({ provider: { async judge() {
    return new Promise<unknown>(done => { resolve = done; }) as never;
  } } });
  await h.command("model-router-route", "once");
  const pending = h.run("prompt");
  await new Promise<void>(done => setImmediate(done));
  assert.ok(resolve);
  await h.command("model-router-route", "off");
  resolve({ answers: {
    workCategory: { type: "choice", choice: "implement", confidence: 1, probabilities: {} },
    reasoningDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    dependencyScope: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    contextIntegrationDemand: { type: "score", score: 1, confidence: 1, probabilities: [0, 1, 0] },
    missingCriticalEvidence: { type: "noul", probability: 0 },
  } });
  await pending;
  assert.deepEqual(h.switched, []);
});

test("off and session replacement revoke route permission", async () => {
  const h = runHarness();
  await h.command("model-router-route", "once");
  await h.command("model-router-route", "off");
  await h.run("prompt");
  await h.command("model-router-route", "once");
  await h.event("session_start");
  await h.run("prompt");
  assert.equal(h.calls(), 0);
});
