import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelOption } from "../../../src/domain/model-option.js";
import type { RoutingPolicy } from "../../../src/domain/routing-policy.js";
import type { TaskAssessment } from "../../../src/application/models/task-assessment.js";
import { selectModel } from "../../../src/application/use-cases/select-model.js";

const policy: RoutingPolicy = {
  weights: { reasoningDemand: 0.5, dependencyScope: 0.3, contextIntegrationDemand: 0.2 },
  difficultyToDeepSweScore: [
    { difficulty: 0, score: 45 }, { difficulty: 0.5, score: 60 }, { difficulty: 1, score: 75 },
  ],
  maxMissingCriticalEvidenceProbability: 0.7,
};
function assessment(overrides: Partial<TaskAssessment> = {}): TaskAssessment {
  return {
    workCategory: { type: "choice", choice: "implement", confidence: 1, probabilities: {} as never },
    reasoningDemand: { type: "score", score: 1.4, probabilities: [0, 0.6, 0.4], confidence: 0.5 },
    dependencyScope: { type: "score", score: 0.8, probabilities: [0.2, 0.8, 0], confidence: 0.5 },
    contextIntegrationDemand: { type: "score", score: 1.6, probabilities: [0, 0.4, 0.6], confidence: 0.5 },
    missingCriticalEvidence: { type: "noul", probability: 0.2 },
    ...overrides,
  };
}
function option(id: string, score: number, cost: number, categories: ModelOption["categories"] = ["implement"]): ModelOption {
  return { id, provider: id, model: id, thinkingLevel: "high", deepSweScore: score, costPerTaskUsd: cost, categories };
}

test("weighted normalized score interpolates curve; cheapest qualified model wins independent of order", () => {
  const options = [option("strong", 90, 0.5), option("cheap", 64, 0.1), option("too-weak", 63, 0.01)];
  for (const list of [options, [...options].reverse()]) {
    const result = selectModel(assessment(), list, policy);
    assert.equal(result.status, "selected");
    if (result.status !== "selected") return;
    assert.equal(result.option.id, "cheap");
    assert.ok(Math.abs(result.difficulty - 0.63) < 1e-12);
    assert.ok(Math.abs(result.requiredDeepSweScore - 63.9) < 1e-12);
    assert.equal(result.shortfall, 0);
  }
});

test("qualified ties break by score then ID", () => {
  const options = [option("z", 80, 0.2), option("a", 80, 0.2), option("lower", 70, 0.2)];
  const decision = selectModel(assessment(), options, policy);
  assert.equal(decision.status, "selected");
  assert.equal(decision.option.id, "a");
});

test("if no option meets threshold, highest score wins, then cost, then ID", () => {
  const options = [option("z", 61, 0.1), option("a", 61, 0.1), option("costlier", 61, 0.2), option("weak", 60, 0)];
  const result = selectModel(assessment(), options, policy);
  assert.equal(result.status, "threshold-unmet");
  if (result.status !== "threshold-unmet") return;
  assert.equal(result.option.id, "a");
  assert.ok(Math.abs(result.shortfall - 2.9) < 1e-12);
});

test("category matching includes general but never an unrelated specialist", () => {
  const options = [option("wrong", 100, 0, ["review"]), option("general", 65, 1, ["general"])];
  const result = selectModel(assessment(), options, policy);
  assert.equal(result.status === "selected" && result.option.id, "general");
  const other = assessment({ workCategory: { ...assessment().workCategory, choice: "other" } });
  assert.equal(selectModel(other, options, policy).status === "selected" &&
    (selectModel(other, options, policy) as { option: ModelOption }).option.id, "general");
  assert.deepEqual(selectModel(assessment(), [options[0]!], policy), { status: "unchanged", reason: "no-category-match" });
});

test("critical evidence and unclear category prohibit switching (including fallback)", () => {
  const missing = assessment({ missingCriticalEvidence: { type: "noul", probability: 0.7 } });
  assert.deepEqual(selectModel(missing, [option("model", 100, 1)], policy), { status: "unchanged", reason: "critical-evidence" });
  const unclear = assessment({ workCategory: { ...assessment().workCategory, choice: "unclear" } });
  assert.deepEqual(selectModel(unclear, [option("model", 100, 1, ["general"])], policy), { status: "unchanged", reason: "unclear-category" });
  assert.deepEqual(selectModel(assessment(), [], policy), { status: "unchanged", reason: "no-eligible-model" });
});

test("zero and maximum difficulty use exact endpoint scores; weight scale is irrelevant", () => {
  const scaled = { ...policy, weights: { reasoningDemand: 5, dependencyScope: 3, contextIntegrationDemand: 2 } };
  const zero = assessment({
    reasoningDemand: { ...assessment().reasoningDemand, score: 0 },
    dependencyScope: { ...assessment().dependencyScope, score: 0 },
    contextIntegrationDemand: { ...assessment().contextIntegrationDemand, score: 0 },
  });
  const max = assessment({
    reasoningDemand: { ...assessment().reasoningDemand, score: 2 },
    dependencyScope: { ...assessment().dependencyScope, score: 2 },
    contextIntegrationDemand: { ...assessment().contextIntegrationDemand, score: 2 },
  });
  for (const [input, expected] of [[zero, 45], [max, 75]] as const) {
    const result = selectModel(input, [option("choice", 100, 1)], scaled);
    assert.equal(result.status !== "unchanged" && result.requiredDeepSweScore, expected);
  }
});
