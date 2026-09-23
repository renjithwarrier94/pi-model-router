import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessTask,
  buildTaskAssessmentRequest,
  TASK_ASSESSMENT_QUESTIONS,
  TASK_ASSESSMENT_QUESTIONS_VERSION,
} from "../../../src/application/use-cases/assess-task.js";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";
import type { TaskAssessment } from "../../../src/application/models/task-assessment.js";

const distribution = {
  explain: 0, implement: 0, diagnose: 0, review: 0,
  design: 0, research: 0, other: 0, unclear: 1,
};
const score = { type: "score" as const, score: 1, probabilities: [0, 1, 0], confidence: 1 };
const answers = {
  workCategory: { type: "choice" as const, choice: "unclear" as const, probabilities: distribution, confidence: 1 },
  reasoningDemand: score,
  dependencyScope: score,
  contextIntegrationDemand: score,
  missingCriticalEvidence: { type: "noul" as const, probability: 0.9 },
} satisfies TaskAssessment;

test("question set covers five independent judgments and all task categories", () => {
  assert.equal(TASK_ASSESSMENT_QUESTIONS_VERSION, 1);
  assert.deepEqual(Object.keys(TASK_ASSESSMENT_QUESTIONS), [
    "workCategory", "reasoningDemand", "dependencyScope", "contextIntegrationDemand", "missingCriticalEvidence",
  ]);
  const category = TASK_ASSESSMENT_QUESTIONS.workCategory;
  assert.deepEqual(Object.keys(category.options), [
    "explain", "implement", "diagnose", "review", "design", "research", "other", "unclear",
  ]);
  assert.doesNotMatch(Object.keys(category.options).join(" "), /general/);
  assert.match(category.options.other, /clear next deliverable/);
  assert.match(category.options.unclear, /does not identify/);
  for (const name of ["reasoningDemand", "dependencyScope", "contextIntegrationDemand"] as const) {
    const question = TASK_ASSESSMENT_QUESTIONS[name];
    assert.equal(question.type, "score");
    assert.equal(question.levels.length, 3);
    assert.match(question.instructions, /next deliverable/);
    assert.ok(question.levels.every(level => level.length > 25));
  }
  assert.match(TASK_ASSESSMENT_QUESTIONS.missingCriticalEvidence.instructions, /next action/);
  assert.match(TASK_ASSESSMENT_QUESTIONS.missingCriticalEvidence.criteria.yes, /absent/);
  assert.match(TASK_ASSESSMENT_QUESTIONS.missingCriticalEvidence.criteria.no, /suffices/);
});

test("builds one shared-context request without adding metadata or changing text", () => {
  const context = "PRIVATE_CONTEXT\nCurrent user question: `fix`";
  const request = buildTaskAssessmentRequest(context);
  assert.equal(request.context, context);
  assert.equal(request.questions, TASK_ASSESSMENT_QUESTIONS);
  assert.deepEqual(Object.keys(request), ["context", "questions"]);
});

test("asks all five at once, forwards cancellation and preserves raw answers", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const provider: JudgmentProvider = {
    async judge(request, options) {
      calls++;
      assert.equal(request.context, "APPROVED_CONTEXT");
      assert.equal(request.questions, TASK_ASSESSMENT_QUESTIONS);
      assert.equal(options?.signal, signal);
      // The fake implements the port and returns a response matching this request.
      return { answers } as never;
    },
  };
  const result = await assessTask("APPROVED_CONTEXT", provider, { signal });
  assert.equal(calls, 1);
  assert.equal(result.workCategory.choice, "unclear");
  assert.deepEqual(result.reasoningDemand.probabilities, [0, 1, 0]);
  assert.equal(result.missingCriticalEvidence.probability, 0.9);
  assert.deepEqual(result, answers);
});

test("does not mask provider failure or invent a fallback assessment", async () => {
  const failure = new Error("provider failed");
  let calls = 0;
  const provider: JudgmentProvider = { async judge() { calls++; throw failure; } };
  await assert.rejects(assessTask("APPROVED_CONTEXT", provider), error => error === failure);
  assert.equal(calls, 1);
});
