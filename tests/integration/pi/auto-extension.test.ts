import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";
import type { ModelOption } from "../../../src/domain/model-option.js";
import { createAssessmentExtension } from "../../../src/adapters/pi/assessment-extension.js";
import type { JudgmentBackend } from "../../../src/adapters/pi/resolve-judgment-provider.js";
import type { RoutingAdapters } from "../../../src/adapters/pi/assessment-extension.js";

const option: ModelOption = {
  id: "candidate", provider: "test", model: "cheap", thinkingLevel: "off",
  deepSweScore: 80, costPerTaskUsd: 0.01, categories: ["general"],
};
const config = {
  version: 1 as const, options: [option], policy: {
    weights: { reasoningDemand: 1, dependencyScope: 1, contextIntegrationDemand: 1 },
    difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1, score: 70 }],
    maxMissingCriticalEvidenceProbability: 0.7,
  },
};
const answers = {
  workCategory: { type: "choice", choice: "explain", confidence: 1, probabilities: {} },
  reasoningDemand: { type: "score", score: 0, confidence: 1, probabilities: [1, 0, 0] },
  dependencyScope: { type: "score", score: 0, confidence: 1, probabilities: [1, 0, 0] },
  contextIntegrationDemand: { type: "score", score: 0, confidence: 1, probabilities: [1, 0, 0] },
  missingCriticalEvidence: { type: "noul", probability: 0 },
};

function harness(overrides: {
  readonly provider?: JudgmentProvider;
  readonly resolveBackend?: (ctx: ExtensionContext) => Promise<JudgmentBackend>;
  readonly loadConfig?: RoutingAdapters["loadConfig"];
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly trusted?: boolean;
  readonly hasUI?: boolean;
  readonly switchModel?: () => Promise<boolean>;
  readonly failThinking?: boolean;
  readonly routingTimeoutMs?: number;
  readonly unknownUsage?: boolean;
  readonly initialLevel?: string;
} = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, (arg: string, ctx: ExtensionContext) => Promise<void>>();
  const notices: string[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  const widgets: { key: string; content: string[] | undefined }[] = [];
  const confirmations: string[] = [];
  const sessionManager = SessionManager.inMemory();
  let trusted = overrides.trusted ?? true;
  let confirm = overrides.confirm ?? (async () => true);
  let activeModel: { provider: string; id: string } | undefined;
  let currentLevel = overrides.initialLevel ?? "off";
  let calls = 0;
  let switches = 0;
  let thinkingCalls = 0;
  const provider = overrides.provider ?? { async judge() { calls++; return { answers } as never; } };
  const ctx = {
    sessionManager, hasUI: overrides.hasUI ?? true, mode: "tui",
    signal: undefined,
    get model() { return activeModel; },
    isProjectTrusted: () => trusted,
    getContextUsage: () => ({ tokens: overrides.unknownUsage ? null : 100 }),
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
      setWidget(key: string, content: string[] | undefined) { widgets.push({ key, content }); },
      async confirm(_title: string, message: string) { confirmations.push(message); return confirm(message); },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); return () => {}; },
    registerCommand(name: string, spec: { handler: (arg: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, spec.handler);
    },
    async setModel(model: { provider: string; id: string }) {
      switches++;
      if (overrides.switchModel && !await overrides.switchModel()) return false;
      const previousModel = activeModel;
      activeModel = model;
      sessionManager.appendModelChange(model.provider, model.id);
      if (currentLevel !== "off") {
        const previousLevel = currentLevel;
        currentLevel = "off"; // Pi may clamp thinking while changing models.
        void handlers.get("thinking_level_select")?.({ level: "off", previousLevel }, ctx);
      }
      await handlers.get("model_select")?.({ source: "set", model, previousModel }, ctx);
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingCalls++;
      if (overrides.failThinking) throw new Error("PRIVATE_THINKING_FAILURE");
      if (level !== currentLevel) {
        const previousLevel = currentLevel;
        currentLevel = level;
        void handlers.get("thinking_level_select")?.({ level, previousLevel }, ctx);
      }
    },
    getThinkingLevel() { return currentLevel; },
    appendEntry() { assert.fail("no data persisted"); },
    sendMessage() { assert.fail("no model-facing router content"); },
  } as unknown as ExtensionAPI;
  createAssessmentExtension(overrides.resolveBackend ?? (async () => ({ provider, recipient: "OpenRouter" })), {
    loadConfig: overrides.loadConfig ?? (async () => config),
    candidates: async () => overrides.unknownUsage ? [] :
      [{ option, model: { provider: option.provider, id: option.model } as never }],
  }, overrides.routingTimeoutMs === undefined ? {} : { routingTimeoutMs: overrides.routingTimeoutMs })(pi);
  return {
    notices, statuses, widgets, confirmations, ctx,
    calls: () => calls, switches: () => switches, thinkingCalls: () => thinkingCalls,
    setTrusted(value: boolean) { trusted = value; },
    async manualModel(model: { provider: string; id: string }) {
      const previousModel = activeModel;
      activeModel = model;
      await handlers.get("model_select")?.({ source: "set", model, previousModel }, ctx);
    },
    async manualThinking(level: string) {
      const previousLevel = currentLevel;
      currentLevel = level;
      await handlers.get("thinking_level_select")?.({ level, previousLevel }, ctx);
    },
    model: () => activeModel,
    level: () => currentLevel,
    setConfirm(value: (message: string) => Promise<boolean>) { confirm = value; },
    async command(name: string, arg: string) { const command = commands.get(name); assert.ok(command); await command(arg, ctx); },
    async run(prompt: string) { await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, ctx); },
    async event(name: string) { await handlers.get(name)?.({}, ctx); },
  };
}

test("automatic routing needs one explicit confirmation, then routes subsequent prompts and shows a persistent indicator", async () => {
  const h = harness();
  await h.run("before consent");
  assert.equal(h.calls(), 0);
  await h.command("model-router-auto", "on");
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0]!, /unredacted user\/assistant conversation/);
  assert.match(h.confirmations[0]!, /via OpenRouter/);
  assert.equal(h.statuses.at(-1)?.text, "Router auto: OpenRouter");
  await h.run("PRIVATE_FIRST");
  await h.run("PRIVATE_SECOND");
  assert.equal(h.calls(), 2);
  assert.equal(h.switches(), 2);
  assert.deepEqual(h.widgets.at(-1)?.content, ["Router: explain R0.00 S0.00 I0.00 M0% W0.00"]);
  assert.doesNotMatch(JSON.stringify(h.notices) + JSON.stringify(h.statuses) + JSON.stringify(h.widgets), /PRIVATE_/);
  await h.command("model-router-auto", "off");
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  await h.run("PRIVATE_AFTER_OFF");
  assert.equal(h.calls(), 2);
});

test("declining confirmation, untrusted projects, no UI, and absent config never grant automatic consent", async () => {
  const declined = harness({ confirm: async () => false });
  await declined.command("model-router-auto", "on");
  await declined.run("private");
  assert.equal(declined.calls(), 0);
  const untrusted = harness({ trusted: false });
  await untrusted.command("model-router-auto", "on");
  await untrusted.run("private");
  assert.equal(untrusted.confirmations.length, 0);
  assert.equal(untrusted.calls(), 0);
  const headless = harness({ hasUI: false });
  await assert.rejects(headless.command("model-router-auto", "on"), /requires an interactive consent UI/);
  await headless.run("private");
  assert.equal(headless.calls(), 0);
  const missing = harness({ loadConfig: async () => ({ version: 1 }) });
  await missing.command("model-router-auto", "on");
  await missing.run("private");
  assert.equal(missing.confirmations.length, 0);
  assert.equal(missing.calls(), 0);
});

test("revocation while confirmation is pending cannot enable automatic routing later", async () => {
  let accept: ((value: boolean) => void) | undefined;
  const h = harness({ confirm: async () => new Promise<boolean>(done => { accept = done; }) });
  const pending = h.command("model-router-auto", "on");
  await new Promise<void>(done => setImmediate(done));
  assert.ok(accept);
  await h.command("model-router-auto", "off");
  accept(true);
  await pending;
  await h.run("PRIVATE_PROMPT");
  assert.equal(h.calls(), 0);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
});

test("off aborts an in-flight assessment and session/tree changes revoke automatic routing", async () => {
  let aborted = false;
  let started: (() => void) | undefined;
  const start = new Promise<void>(resolve => { started = resolve; });
  const h = harness({ provider: { judge: async (_request, opts) => {
    started?.();
    return new Promise<never>((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("PRIVATE_ABORT")); }, { once: true });
    });
  } } });
  await h.command("model-router-auto", "on");
  const running = h.run("PRIVATE_IN_FLIGHT");
  await start;
  await h.command("model-router-auto", "off");
  await running;
  assert.equal(aborted, true);
  assert.equal(h.switches(), 0);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
  for (const event of ["session_start", "session_tree", "session_shutdown"]) {
    await h.command("model-router-auto", "on");
    await h.event(event);
    await h.run("PRIVATE_AFTER_SESSION_CHANGE");
    assert.equal(h.switches(), 0);
  }
});

test("routing config removal after consent revokes auto without contacting Jev", async () => {
  let configured = true;
  let loads = 0;
  const h = harness({
    loadConfig: async () => { loads++; return configured ? config : { version: 1 }; },
    provider: { async judge(): Promise<never> { assert.fail("must not send without config"); } },
  });
  await h.command("model-router-auto", "on");
  configured = false;
  await h.run("PRIVATE_FIRST");
  await h.run("PRIVATE_SECOND");
  assert.equal(loads, 2); // Consent preflight plus one skipped prompt.
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
});

test("credential loss after confirmation revokes automatic consent before sending context", async () => {
  let keyAvailable = true;
  let attempts = 0;
  const provider = { async judge(): Promise<never> { assert.fail("must not send after credential loss"); } };
  const h = harness({ resolveBackend: async () => {
    attempts++;
    if (!keyAvailable) throw new Error("PRIVATE_CREDENTIAL");
    return { recipient: "OpenRouter", provider };
  } });
  await h.command("model-router-auto", "on");
  keyAvailable = false;
  await h.run("PRIVATE_FIRST");
  await h.run("PRIVATE_SECOND");
  assert.equal(attempts, 2); // Initial preflight plus a single aborted prompt.
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("recipient changes revoke auto before transmission, and loss of trust revokes it", async () => {
  let recipient: JudgmentBackend["recipient"] = "OpenRouter";
  let sent = 0;
  const provider = { async judge(): Promise<never> { sent++; assert.fail("must not send"); } };
  const h = harness({ resolveBackend: async () => ({ recipient, provider }) });
  await h.command("model-router-auto", "on");
  recipient = "TypeSafe";
  await h.run("PRIVATE_AFTER_CHANGE");
  assert.equal(sent, 0);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.match(h.notices.at(-1) ?? "", /recipient changed/);
  recipient = "OpenRouter";
  await h.command("model-router-auto", "on");
  h.setTrusted(false);
  await h.run("PRIVATE_UNTRUSTED");
  assert.equal(sent, 0);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
});

test("trust revoked during asynchronous credential lookup stops before context transmission", async () => {
  let finish: ((value: JudgmentBackend) => void) | undefined;
  let lookups = 0;
  const provider = { async judge(): Promise<never> { assert.fail("must not send after trust loss"); } };
  const h = harness({ resolveBackend: async () => {
    lookups++;
    if (lookups === 1) return { recipient: "OpenRouter", provider };
    return new Promise<JudgmentBackend>(done => { finish = done; });
  } });
  await h.command("model-router-auto", "on");
  const pending = h.run("PRIVATE_AFTER_CONSENT");
  assert.ok(finish);
  h.setTrusted(false);
  finish({ recipient: "OpenRouter", provider });
  await pending;
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("a failed Pi model switch revokes automatic consent instead of retrying every prompt", async () => {
  let calls = 0;
  const h = harness({
    switchModel: async () => false,
    provider: { async judge() { calls++; return { answers } as never; } },
  });
  await h.command("model-router-auto", "on");
  await h.run("synthetic first");
  await h.run("synthetic second");
  assert.equal(calls, 1);
  assert.equal(h.switches(), 1);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.match(h.notices.at(-1) ?? "", /selected model unavailable/);
});

test("manual model or thinking-level changes suspend auto, but router-origin changes do not", async () => {
  const h = harness({ initialLevel: "high" });
  await h.command("model-router-auto", "on");
  await h.run("first");
  await h.run("second");
  assert.equal(h.calls(), 2);
  assert.equal(h.statuses.filter(s => s.key === "model-router-auto" && s.text).length, 1);
  await h.manualModel({ provider: "test", id: "manual" });
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  await h.run("after manual model");
  assert.equal(h.calls(), 2);
  await h.command("model-router-auto", "on");
  await h.run("third");
  assert.equal(h.calls(), 3);
  await h.manualThinking("high");
  await h.run("after manual level");
  assert.equal(h.calls(), 3);
  assert.equal(h.level(), "high");
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("unknown Pi context usage gives a specific skip message without contacting Jev", async () => {
  const h = harness({ unknownUsage: true, provider: { async judge(): Promise<never> { assert.fail("unknown usage must not send"); } } });
  await h.command("model-router-auto", "on");
  await h.run("first turn after compaction");
  assert.equal(h.switches(), 0);
  assert.match(h.notices.at(-1) ?? "", /context usage is unknown/);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, "Router auto: OpenRouter");
});

test("a partial model switch that fails to set thinking level revokes auto and warns", async () => {
  const h = harness({ failThinking: true });
  await h.command("model-router-auto", "on");
  await h.run("one");
  assert.equal(h.switches(), 1);
  assert.deepEqual(h.model(), { provider: "test", id: "cheap" });
  assert.match(h.notices.at(-1) ?? "", /failed during model switching; inspect Pi's active model and thinking level/);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  await h.run("two");
  assert.equal(h.switches(), 1);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("a hung credential lookup times out, fails closed, and ignores late results", async () => {
  let finish: ((backend: JudgmentBackend) => void) | undefined;
  let count = 0;
  const provider = { async judge(): Promise<never> { assert.fail("late resolution must not send"); } };
  const h = harness({ routingTimeoutMs: 30, resolveBackend: async () => {
    if (++count === 1) return { recipient: "OpenRouter", provider };
    return new Promise<JudgmentBackend>(done => { finish = done; });
  } });
  await h.command("model-router-auto", "on");
  await h.run("PRIVATE_HUNG_LOOKUP");
  assert.match(h.notices.at(-1) ?? "", /timed out; current model unchanged/);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.ok(finish);
  finish({ recipient: "OpenRouter", provider });
  await Promise.resolve();
  await h.run("PRIVATE_AFTER_TIMEOUT");
  assert.equal(count, 2);
  assert.equal(h.switches(), 0);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("a hung Jev assessment is aborted by the deadline and never switches", async () => {
  let aborted = false;
  const h = harness({ routingTimeoutMs: 30, provider: { async judge(_request, opts): Promise<never> {
    return new Promise<never>((_resolve, reject) => opts?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("PRIVATE_DEADLINE"));
    }, { once: true }));
  } } });
  await h.command("model-router-auto", "on");
  await h.run("PRIVATE_SLOW_JEV");
  assert.equal(aborted, true);
  assert.equal(h.switches(), 0);
  assert.match(h.notices.at(-1) ?? "", /timed out; current model unchanged/);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("timeout during a non-abortable model switch warns and does not set thinking level later", async () => {
  let finish: ((result: boolean) => void) | undefined;
  const h = harness({ routingTimeoutMs: 30, switchModel: () => new Promise<boolean>(done => { finish = done; }) });
  await h.command("model-router-auto", "on");
  await h.run("PRIVATE_SWITCH");
  assert.ok(finish);
  assert.match(h.notices.at(-1) ?? "", /timed out during model switching; the switch may still complete/);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  finish(true);
  await new Promise<void>(done => setImmediate(done));
  assert.deepEqual(h.model(), { provider: "test", id: "cheap" });
  assert.equal(h.level(), "off");
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("off during a pending Pi model switch returns promptly; a late switch cannot set thinking", async () => {
  let finish: ((result: boolean) => void) | undefined;
  const h = harness({ initialLevel: "high", switchModel: () => new Promise<boolean>(done => { finish = done; }) });
  await h.command("model-router-auto", "on");
  const pending = h.run("PRIVATE_SWITCH_OFF");
  await new Promise<void>(done => setImmediate(done));
  assert.ok(finish);
  await h.command("model-router-auto", "off");
  await pending;
  finish(true);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(h.level(), "off"); // Pi's implicit level change is possible; router's explicit call is not.
  assert.equal(h.thinkingCalls(), 0);
  assert.equal(h.switches(), 1);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
  assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE_/);
});

test("a one-shot command replaces automatic consent instead of silently resuming it", async () => {
  const h = harness();
  await h.command("model-router-auto", "on");
  await h.command("model-router-assess", "once");
  await h.run("one-shot");
  await h.run("PRIVATE_LATER");
  assert.equal(h.calls(), 1);
  assert.equal(h.switches(), 0);
  assert.equal([...h.statuses].reverse().find(s => s.key === "model-router-auto")?.text, undefined);
});
