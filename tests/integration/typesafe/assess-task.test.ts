import assert from "node:assert/strict";
import { test } from "node:test";
import { JevJudgmentProvider } from "../../../src/adapters/typesafe/jev-judgment-provider.js";
import {
  assessTask, TASK_ASSESSMENT_QUESTIONS,
} from "../../../src/application/use-cases/assess-task.js";
import { JudgmentProviderError } from "../../../src/application/ports/judgment-provider.js";

test("five assessment questions traverse the real adapter in one request", async () => {
  const keys = Object.keys(TASK_ASSESSMENT_QUESTIONS.workCategory.options);
  let calls = 0;
  const provider = new JevJudgmentProvider({
    apiKey: "test", defaultModel: "jev-test",
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.state, "APPROVED_CONTEXT");
      assert.deepEqual(Object.keys(body.questions), Object.keys(TASK_ASSESSMENT_QUESTIONS));
      assert.deepEqual(Object.keys(body.questions.workCategory.criteria), keys);
      assert.deepEqual(body.questions.reasoningDemand.criteria, TASK_ASSESSMENT_QUESTIONS.reasoningDemand.levels);
      assert.deepEqual(body.questions.dependencyScope.criteria, TASK_ASSESSMENT_QUESTIONS.dependencyScope.levels);
      assert.deepEqual(body.questions.contextIntegrationDemand.criteria, TASK_ASSESSMENT_QUESTIONS.contextIntegrationDemand.levels);
      assert.deepEqual(body.questions.missingCriticalEvidence.criteria, {
        true: TASK_ASSESSMENT_QUESTIONS.missingCriticalEvidence.criteria.yes,
        false: TASK_ASSESSMENT_QUESTIONS.missingCriticalEvidence.criteria.no,
      });
      assert.equal(body.model, "jev-test");
      const probabilities = Object.fromEntries(keys.map(k => [k, k === "implement" ? 1 : 0]));
      const score = (levels: readonly string[], winner: number) => ({
        type: "score", score: winner, confidence: 1,
        probabilities: Object.fromEntries(levels.map((_, i) => [i, i === winner ? 1 : 0])),
        legend: Object.fromEntries(levels.map((level, i) => [i, level])),
      });
      return Response.json({
        model: "jev-test", usage: { input_tokens: 10, output_tokens: 10 },
        answers: {
          workCategory: { type: "choice", choice: "implement", probabilities, confidence: 1 },
          reasoningDemand: score(TASK_ASSESSMENT_QUESTIONS.reasoningDemand.levels, 2),
          dependencyScope: score(TASK_ASSESSMENT_QUESTIONS.dependencyScope.levels, 1),
          contextIntegrationDemand: score(TASK_ASSESSMENT_QUESTIONS.contextIntegrationDemand.levels, 0),
          missingCriticalEvidence: { type: "noul", noul: 0.85 },
        },
      });
    },
  });
  const assessment = await assessTask("APPROVED_CONTEXT", provider);
  assert.equal(calls, 1);
  assert.equal(assessment.workCategory.choice, "implement");
  assert.deepEqual(assessment.reasoningDemand.probabilities, [0, 0, 1]);
  assert.equal(assessment.reasoningDemand.score, 2);
  assert.equal(assessment.dependencyScope.score, 1);
  assert.equal(assessment.contextIntegrationDemand.score, 0);
  assert.equal(assessment.missingCriticalEvidence.probability, 0.85);
});

test("malformed answers reject the entire assessment with no partial result", async () => {
  const provider = new JevJudgmentProvider({
    apiKey: "test",
    fetch: async () => Response.json({
      model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 },
      answers: { missingCriticalEvidence: { type: "noul", noul: 1 } },
    }),
  });
  await assert.rejects(assessTask("APPROVED_CONTEXT", provider), error => {
    assert.ok(error instanceof JudgmentProviderError);
    assert.equal(error.code, "invalid-response");
    return true;
  });
});
