import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";
import { createAssessmentExtension } from "../../../src/adapters/pi/assessment-extension.js";

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

function harness(provider: JudgmentProvider, hasUI = true) {
  const handlers = new Map<string, (...params: any[]) => unknown>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const notifications: { message: string; level: string }[] = [];
  const sessionManager = SessionManager.inMemory();
  const context = {
    sessionManager,
    hasUI,
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
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
  createAssessmentExtension(() => provider)(pi);
  const run = async (prompt: string) => handlers.get("before_agent_start")?.({
    type: "before_agent_start", prompt,
  } satisfies Pick<BeforeAgentStartEvent, "type" | "prompt">, context);
  const invoke = async (args: string) => {
    assert.ok(command);
    await command(args, context);
  };
  const fire = async (event: string) => handlers.get(event)?.({}, context);
  return { run, invoke, fire, context, sessionManager, notifications };
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
  assert.ok(h.notifications.some(n => n.message.includes("reasoning 1.25/2")));
  assert.ok(h.notifications.some(n => n.message.includes("missing critical evidence P(yes) 0.40")));
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
  assert.ok(finish);
  await h.invoke("off");
  await h.fire("session_start");
  finish({ answers });
  await pending;
  assert.ok(!h.notifications.some(n => n.message.includes("reasoning")));
});

test("no UI can still assess without logging or injecting data", async () => {
  let calls = 0;
  const h = harness({ async judge() { calls++; return { answers } as never; } }, false);
  await h.invoke("once");
  await h.run("prompt");
  assert.equal(calls, 1);
  assert.deepEqual(h.notifications, []);
});
