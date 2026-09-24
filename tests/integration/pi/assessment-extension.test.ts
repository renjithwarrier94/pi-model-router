import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";
import { createAssessmentExtension, type RoutingAdapters } from "../../../src/adapters/pi/assessment-extension.js";
import type { JudgmentBackend } from "../../../src/adapters/pi/resolve-judgment-provider.js";

const answers = {
  workCategory: {
    type: "choice", choice: "implement", confidence: 1,
    probabilities: { explain: 0, implement: 1, diagnose: 0, review: 0, design: 0, research: 0, other: 0, unclear: 0 },
  },
  reasoningDemand: { type: "score", score: 1.25, probabilities: [0, 0.75, 0.25], confidence: 0.5 },
  dependencyScope: { type: "score", score: 1, probabilities: [0, 1, 0], confidence: 1 },
  contextIntegrationDemand: { type: "score", score: 0, probabilities: [1, 0, 0], confidence: 1 },
  missingCriticalEvidence: { type: "noul", probability: 0.4 },
};

function harness(provider: JudgmentProvider, hasUI = true, resolve?: () => Promise<JudgmentBackend>, config?: RoutingAdapters["loadConfig"], mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, (...params: any[]) => unknown>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const notifications: { message: string; level: string }[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  const widgets: { key: string; content: string[] | undefined }[] = [];
  const sessionManager = SessionManager.inMemory();
  const context = {
    sessionManager,
    hasUI,
    mode,
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
      setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
      setWidget(key: string, content: string[] | undefined) { widgets.push({ key, content }); },
    },
    signal: undefined as AbortSignal | undefined,
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: (...params: any[]) => unknown) { handlers.set(event, handler); return () => {}; },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      if (name === "model-router-assess") command = options.handler;
    },
    setModel() { assert.fail("assessment must not switch models"); },
    setThinkingLevel() { assert.fail("assessment must not switch thinking level"); },
    appendEntry() { assert.fail("assessment must not persist prompt or result"); },
    sendMessage() { assert.fail("assessment must not inject text into model context"); },
  } as unknown as ExtensionAPI;
  createAssessmentExtension(resolve ?? (async () => ({ provider, recipient: "TypeSafe" })), {
    loadConfig: config ?? (async () => ({ version: 1, options: [] })),
    candidates: async () => [],
  })(pi);
  const run = async (prompt: string) => handlers.get("before_agent_start")?.({
    type: "before_agent_start", prompt,
  } satisfies Pick<BeforeAgentStartEvent, "type" | "prompt">, context);
  const invoke = async (args: string) => {
    assert.ok(command);
    await command(args, context);
  };
  const fire = async (event: string) => handlers.get(event)?.({}, context);
  return { run, invoke, fire, context, sessionManager, notifications, statuses, widgets };
}

test("disabled by default and invalid command arguments never send conversation", async () => {
  let calls = 0;
  const h = harness({ async judge() { calls++; throw Error("unexpected"); } });
  await h.run("PRIVATE_CURRENT");
  await h.invoke("on"); // no durable blanket consent
  await h.run("PRIVATE_CURRENT");
  assert.equal(calls, 0);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!.message, /once/);
});

test("once consents for exactly one next prompt, sends selected history through port and reports only scores", async () => {
  const sent: unknown[] = [];
  const h = harness({
    async judge(request) {
      sent.push(request);
      return { answers } as never;
    },
  });
  h.sessionManager.appendMessage({ role: "user", content: "PRIVATE_HISTORY", timestamp: 0 });
  await h.invoke("once");
  await h.run("PRIVATE_CURRENT");
  await h.run("PRIVATE_SUBSEQUENT");
  assert.equal(sent.length, 1);
  const request = sent[0] as { context: string; questions: Record<string, unknown> };
  assert.match(request.context, /PRIVATE_CURRENT/);
  assert.match(request.context, /PRIVATE_HISTORY/);
  assert.equal(Object.keys(request.questions).length, 5);
  assert.deepEqual(h.widgets.at(-1), { key: "model-router-result", content: ["Router: implement R1.25 S1.00 I0.00 M40% W–"] });
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("assessment-only displays policy-weighted score when configured", async () => {
  const h = harness({ async judge() { return { answers } as never; } }, true, undefined,
    async () => ({ version: 1, options: [], policy: {
      weights: { reasoningDemand: 2, dependencyScope: 1, contextIntegrationDemand: 1 },
      difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1, score: 80 }],
      maxMissingCriticalEvidenceProbability: 0.7,
    } }));
  await h.invoke("once");
  await h.run("prompt");
  assert.deepEqual(h.widgets.at(-1)?.content, ["Router: implement R1.25 S1.00 I0.00 M40% W0.44"]);
});

test("assessment stays visible without policy even if config cannot load, and clears on session changes", async () => {
  const h = harness({ async judge() { return { answers } as never; } }, true, undefined,
    async () => { throw Error("PRIVATE_CONFIG"); });
  await h.invoke("once");
  await h.run("prompt");
  assert.deepEqual(h.widgets.at(-1)?.content, ["Router: implement R1.25 S1.00 I0.00 M40% W–"]);
  await h.fire("session_tree");
  assert.deepEqual(h.widgets.at(-1), { key: "model-router-result", content: undefined });
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("an oversized prompt consumes once consent but does not call the provider", async () => {
  const h = harness({ async judge() { assert.fail("no request expected"); } });
  await h.invoke("once");
  await h.run("x".repeat(100_001));
  await h.run("later prompt");
  assert.match(h.notifications.at(-1)?.message ?? "", /skipped/);
});

test("off and session start/shutdown/tree discard consent", async () => {
  const h = harness({ async judge() { assert.fail("no request expected"); } });
  for (const event of ["session_start", "session_shutdown", "session_tree"]) {
    await h.invoke("once");
    await h.fire(event);
    await h.run("prompt");
  }
  await h.invoke("once");
  await h.invoke("off");
  await h.run("prompt");
});

test("failed projection or provider call produces no raw error or fallback result", async () => {
  const h = harness({ async judge() { throw new Error("PRIVATE_PROVIDER_SECRET"); } });
  await h.invoke("once");
  await h.run("PRIVATE_PROMPT");
  await h.run("another prompt");
  assert.match(h.notifications.at(-1)?.message ?? "", /failed/);
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("stale asynchronous answers are ignored after off or session replacement", async () => {
  let finish: ((value: { answers: typeof answers }) => void) | undefined;
  const h = harness({ judge: async () => new Promise<{ answers: typeof answers }>(resolve => { finish = resolve; }) as never });
  await h.invoke("once");
  const pending = h.run("current");
  await new Promise<void>(done => setImmediate(done));
  assert.ok(finish);
  await h.invoke("off");
  await h.fire("session_start");
  finish({ answers });
  await pending;
  assert.ok(!h.notifications.some(n => n.message.includes("reasoning")));
  assert.ok(!h.widgets.some(s => s.content?.some(line => line.includes("R1.25"))));
});

test("missing credentials fail at once and never grant consent", async () => {
  let calls = 0;
  const h = harness({ async judge() { calls++; assert.fail("no send"); } }, true,
    async () => { throw Error("PRIVATE_KEY_FAILURE"); });
  await h.invoke("once");
  await h.run("PRIVATE_PROMPT");
  assert.equal(calls, 0);
  assert.match(h.notifications.at(-1)?.message ?? "", /No consent granted/);
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("missing credentials in a non-UI command reject explicitly", async () => {
  const h = harness({ async judge(): Promise<never> { assert.fail("no send"); } }, false,
    async () => { throw Error("PRIVATE_KEY_FAILURE"); });
  await assert.rejects(h.invoke("once"), /No consent granted/);
  await h.run("PRIVATE_PROMPT");
  assert.deepEqual(h.notifications, []);
});

test("lost credentials after consent skip before assessment", async () => {
  let configured = true;
  let calls = 0;
  const provider = { async judge(): Promise<never> { calls++; assert.fail("no send"); } };
  const h = harness(provider, true, async () => {
    if (!configured) throw Error("PRIVATE_KEY_FAILURE");
    return { provider, recipient: "OpenRouter" };
  });
  await h.invoke("once");
  assert.match(h.notifications.at(-1)?.message ?? "", /via OpenRouter/);
  configured = false;
  await h.run("PRIVATE_PROMPT");
  assert.equal(calls, 0);
  assert.match(h.notifications.at(-1)?.message ?? "", /failed/);
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("a recipient change after consent cannot send the prompt elsewhere", async () => {
  let recipient: JudgmentBackend["recipient"] = "TypeSafe";
  let calls = 0;
  const provider = { async judge(): Promise<never> { calls++; assert.fail("no send"); } };
  const h = harness(provider, true, async () => ({ provider, recipient }));
  await h.invoke("once");
  recipient = "OpenRouter";
  await h.run("PRIVATE_PROMPT");
  assert.equal(calls, 0);
  assert.match(h.notifications.at(-1)?.message ?? "", /recipient changed/);
  assert.doesNotMatch(JSON.stringify(h.notifications), /PRIVATE_/);
});

test("off during credential lookup cannot re-arm one-shot consent", async () => {
  let resolve: ((value: JudgmentBackend) => void) | undefined;
  let calls = 0;
  const provider = { async judge(): Promise<never> { calls++; assert.fail("no send"); } };
  const h = harness(provider, true, () => new Promise<JudgmentBackend>(done => { resolve = done; }));
  const pending = h.invoke("once");
  assert.ok(resolve);
  await h.invoke("off");
  resolve({ provider, recipient: "OpenRouter" });
  await pending;
  await h.run("PRIVATE_PROMPT");
  assert.equal(calls, 0);
});

test("no UI can still assess without logging or injecting data", async () => {
  let calls = 0;
  const h = harness({ async judge() { calls++; return { answers } as never; } }, false);
  await h.invoke("once");
  await h.run("prompt");
  assert.equal(calls, 1);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.widgets, []);
});

test("RPC mode publishes the same result through its extension status channel", async () => {
  const h = harness({ async judge() { return { answers } as never; } }, true, undefined, undefined, "rpc");
  await h.invoke("once");
  await h.run("prompt");
  assert.deepEqual(h.statuses.at(-1), { key: "model-router", text: "Router: implement R1.25 S1.00 I0.00 M40% W–" });
  assert.deepEqual(h.widgets, []);
});

test("print mode writes the result to stderr without changing stdout", async () => {
  const h = harness({ async judge() { return { answers } as never; } }, false, undefined, undefined, "print");
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await h.invoke("once");
    await h.run("prompt");
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(stderr, "Router: implement R1.25 S1.00 I0.00 M40% W–\n");
});
