import assert from "node:assert/strict";
import { test } from "node:test";
import { JevJudgmentProvider } from "../../../src/adapters/typesafe/jev-judgment-provider.js";
import { JudgmentProviderError } from "../../../src/application/ports/judgment-provider.js";
import type { JudgmentRequest } from "../../../src/application/models/judgment.js";

const request = {
  context: { prompt: "Refactor authentication", history: [] },
  questions: {
    task: { type: "choice", instructions: "Primary task?", options: { edit: "Edit", refactor: "Refactor" } },
    complexity: { type: "score", instructions: "Complexity?", levels: ["Low", "High"] },
    inspect: { type: "noul", instructions: "Inspect code?", criteria: { yes: "Needed", no: "Not needed" } },
  },
} as const;
const response = () => ({
  model: "jev-test", usage: { input_tokens: 10, output_tokens: 10 },
  answers: {
    task: { type: "choice", choice: "refactor", probabilities: { edit: 0.2, refactor: 0.8 }, confidence: 0.6 },
    complexity: { type: "score", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 }, legend: { "0": "Low", "1": "High" }, confidence: 0.4 },
    inspect: { type: "noul", noul: 0.9 },
  },
});
const errorCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof JudgmentProviderError);
  assert.equal(error.code, code);
  assert.ok(!error.message.includes("SECRET"));
  assert.equal(error.cause, undefined);
  return true;
};

function provider(body: unknown = response(), status = 200) {
  return new JevJudgmentProvider({ apiKey: "test", fetch: async () => Response.json(body, { status }) });
}

test("maps all question types through the real SDK and normalizes answers", async () => {
  const adapter = new JevJudgmentProvider({
    apiKey: "test", defaultModel: "jev-test",
    fetch: async (url, init) => {
      assert.ok(url.endsWith("/v1/systemone"));
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.state, request.context);
      assert.equal(body.model, "jev-test");
      assert.deepEqual(body.questions.task.criteria, request.questions.task.options);
      assert.deepEqual(body.questions.complexity.criteria, request.questions.complexity.levels);
      assert.deepEqual(body.questions.inspect.criteria, { true: "Needed", false: "Not needed" });
      return Response.json(response());
    },
  });
  const result = await adapter.judge(request);
  assert.equal(result.answers.task.choice, "refactor");
  assert.deepEqual(result.answers.complexity.probabilities, [0.3, 0.7]);
  assert.deepEqual(result.answers.inspect, { type: "noul", probability: 0.9 });
});

test("OpenRouter System One uses the supported SDK endpoint, key, and bare Jev model", async () => {
  const adapter = new JevJudgmentProvider({
    apiKey: "PRIVATE_OPENROUTER_KEY", baseURL: "https://openrouter.ai/api", defaultModel: "jev-1.13",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://openrouter.ai/api/v1/systemone");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer PRIVATE_OPENROUTER_KEY");
      assert.equal(JSON.parse(String(init?.body)).model, "jev-1.13");
      return Response.json(response());
    },
  });
  const result = await adapter.judge(request);
  assert.equal(result.answers.task.choice, "refactor");
});

for (const [status, code] of [[400, "invalid-request"], [401, "unauthorized"], [403, "unauthorized"], [422, "invalid-request"], [429, "rate-limited"], [500, "unavailable"], [408, "timeout"], [504, "timeout"]] as const) {
  test(`normalizes HTTP ${status} without exposing payloads`, async () => {
    await assert.rejects(provider({ error: "SECRET" }, status).judge(request), errorCode(code));
  });
}

for (const [name, mutate] of Object.entries({
  missing: (r: any) => { delete r.answers.inspect; },
  extra: (r: any) => { r.answers.extra = r.answers.inspect; },
  wrongType: (r: any) => { r.answers.inspect.type = "choice"; },
  unknownChoice: (r: any) => { r.answers.task.choice = "other"; },
  nonWinningChoice: (r: any) => { r.answers.task.choice = "edit"; },
  missingProbability: (r: any) => { delete r.answers.task.probabilities.edit; },
  badSum: (r: any) => { r.answers.task.probabilities.edit = 0.5; },
  badScore: (r: any) => { r.answers.complexity.score = 0.2; },
  badScoreKeys: (r: any) => { r.answers.complexity.probabilities = { "1": 0.3, "2": 0.7 }; },
  badConfidence: (r: any) => { r.answers.task.confidence = 2; },
  badNoul: (r: any) => { r.answers.inspect.noul = -1; },
})) {
  test(`rejects malformed response: ${name}`, async () => {
    const body = response(); mutate(body);
    await assert.rejects(provider(body).judge(request), errorCode("invalid-response"));
  });
}

test("rejects non-JSON responses", async () => {
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: async () => new Response("not json", { headers: { "content-type": "application/json" } }) });
  await assert.rejects(adapter.judge(request), errorCode("invalid-response"));
});

test("invalid input never reaches transport", async () => {
  let calls = 0;
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: async () => { calls++; return Response.json(response()); } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const bad of [
    { context: "x", questions: {} },
    { ...request, context: cycle },
    { ...request, context: NaN },
    { ...request, context: new Date() },
    { ...request, context: undefined },
    { context: "x", questions: { q: { type: "score", instructions: "?", levels: ["one"] } } },
    { context: "x", questions: { q: { type: "choice", instructions: "?", options: {} } } },
    { context: "x", questions: { q: { type: "noul", instructions: "?", criteria: { yes: "yes" } } } },
  ]) await assert.rejects(adapter.judge(bad as JudgmentRequest), errorCode("invalid-request"));
  assert.equal(calls, 0);
});

test("pre-aborted signals skip transport", async () => {
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: async () => { assert.fail("must not fetch"); } });
  await assert.rejects(adapter.judge(request, { signal: AbortSignal.abort() }), errorCode("cancelled"));
});

// Abort-aware pending transport, so SDK timers/cancellation are exercised.
const pendingFetch = async (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) => {
    const abort = () => reject(new Error("SECRET"));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  });

test("in-flight cancellation", async () => {
  const controller = new AbortController();
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: pendingFetch });
  const promise = adapter.judge(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, errorCode("cancelled"));
});

test("SDK deadline becomes timeout", async () => {
  const adapter = new JevJudgmentProvider({ apiKey: "test", timeout: 10, fetch: pendingFetch });
  await assert.rejects(adapter.judge(request), errorCode("timeout"));
});

test("network failures are sanitized and not retried by default", async () => {
  let calls = 0;
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: async () => { calls++; throw new Error("SECRET"); } });
  await assert.rejects(adapter.judge(request), errorCode("unavailable"));
  assert.equal(calls, 1);
});

test("configured retries are honored", async () => {
  let calls = 0;
  const adapter = new JevJudgmentProvider({ apiKey: "test", retry: { maxRetries: 1, backoffInitialMs: 1 }, fetch: async () => {
    calls++;
    return calls === 1 ? Response.json({}, { status: 503 }) : Response.json(response());
  } });
  await adapter.judge(request);
  assert.equal(calls, 2);
});

test("request snapshot is unaffected by mutation while awaiting response", async () => {
  const mutable = structuredClone(request);
  const adapter = new JevJudgmentProvider({ apiKey: "test", fetch: async () => {
    delete (mutable.questions as Record<string, unknown>).task;
    return Response.json(response());
  } });
  const result = await adapter.judge(mutable);
  assert.equal(result.answers.task.choice, "refactor");
});
