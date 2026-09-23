import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseModelRouterConfigJson } from "../../../src/adapters/config/config-schema.js";
import { evaluateCases } from "../../../evals/evaluate.js";
import { syntheticCases } from "../../../evals/cases/synthetic.js";
import { parseEvaluationCasesJson } from "../../../evals/parse-cases.js";

const config = parseModelRouterConfigJson(readFileSync(new URL("../../../examples/router.config.json", import.meta.url), "utf8"));

test("synthetic examples cover categories, gate, unavailable models, and fallback", () => {
  const results = evaluateCases(syntheticCases, config);
  assert.equal(results.length, 14);
  assert.ok(results.every(result => result.source === "synthetic" && result.categoryMatches && result.decisionMatches));
  assert.deepEqual(new Set(syntheticCases.map(entry => entry.expectedCategory)),
    new Set(["explain", "implement", "diagnose", "review", "design", "research", "other", "unclear"]));
  assert.equal(results.filter(result => result.actual.status === "threshold-unmet").length, 2);
  assert.deepEqual(results.find(result => result.id === "missing-critical")?.actual,
    { status: "unchanged", reason: "critical-evidence" });
});

test("a changed policy reports mismatches instead of silently recalibrating expectations", () => {
  const changed = {
    ...config,
    policy: { ...config.policy!, difficultyToDeepSweScore: [
      { difficulty: 0, score: 85 }, { difficulty: 1, score: 95 },
    ] },
  };
  const results = evaluateCases(syntheticCases, changed);
  const simple = results.find(result => result.id === "explain-simple");
  assert.equal(simple?.decisionMatches, false);
  assert.deepEqual(simple?.expected, { status: "selected", optionId: "gpt-general" });
  assert.deepEqual(simple?.actual, { status: "threshold-unmet", optionId: "gpt-general" });
});

test("bad eligibility assumptions and duplicate cases fail closed", () => {
  assert.throws(() => evaluateCases([{ ...syntheticCases[0]!, eligibleOptionIds: ["unknown"] }], config), /Unknown eligible option/);
  assert.throws(() => evaluateCases([syntheticCases[0]!, syntheticCases[0]!], config), /unique/);
  assert.throws(() => evaluateCases([{ ...syntheticCases[0]!, eligibleOptionIds: ["gpt-general", "gpt-general"] }], config), /Duplicate eligible/);
});

test("JSON cases validate scores, provenance, and recorded question version", () => {
  const sample = syntheticCases[0]!;
  assert.equal(evaluateCases(parseEvaluationCasesJson(JSON.stringify([sample])), config)[0]?.decisionMatches, true);
  const recorded = { ...sample, source: "recorded-jev", recording: {
    recipient: "OpenRouter", model: "jev-1.13", questionVersion: 1,
  } };
  assert.equal(parseEvaluationCasesJson(JSON.stringify([recorded]))[0]?.source, "recorded-jev");
  assert.throws(() => parseEvaluationCasesJson(JSON.stringify([{ ...recorded, recording: {
    ...recorded.recording, questionVersion: 2,
  } }])), /recording.questionVersion/);
  assert.throws(() => parseEvaluationCasesJson(JSON.stringify([{ ...sample, assessment: {
    ...sample.assessment, reasoningDemand: { type: "score", score: 2, probabilities: [1, 0, 0], confidence: 1 },
  } }])), /reasoningDemand.score/);
  assert.throws(() => parseEvaluationCasesJson(JSON.stringify([{ ...sample, eligibleOptionIds: "all" }])), /eligibleOptionIds/);
});

test("recorded assessments can be compared to independent expected categories", () => {
  const result = evaluateCases([{ ...syntheticCases[0]!, source: "recorded-jev",
    recording: { recipient: "OpenRouter", model: "jev-1.13", questionVersion: 1 }, assessment: {
    ...syntheticCases[0]!.assessment,
    workCategory: { ...syntheticCases[0]!.assessment.workCategory, choice: "research" },
  } }], config)[0]!;
  assert.equal(result.categoryMatches, false);
  assert.equal(result.decisionMatches, true); // Both categories use the general option.
});
