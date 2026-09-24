import type { TaskAssessment, WorkCategory } from "../../src/application/models/task-assessment.js";
import type { EvaluationCase, ExpectedDecision } from "../evaluate.js";

const categories: readonly WorkCategory[] = ["explain", "implement", "diagnose", "review", "design", "research", "other", "unclear"];

/** One-hot, hand-authored assessment signals. These are NOT Jev outputs. */
function assessment(category: WorkCategory, [reasoning, scope, integration]: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2], missing = 0): TaskAssessment {
  const score = (level: 0 | 1 | 2) => ({
    type: "score" as const, score: level,
    probabilities: [0, 1, 2].map(index => Number(index === level)), confidence: 1,
  });
  return {
    workCategory: {
      type: "choice", choice: category,
      probabilities: Object.fromEntries(categories.map(name => [name, Number(name === category)])) as Record<WorkCategory, number>,
      confidence: 1,
    },
    reasoningDemand: score(reasoning), dependencyScope: score(scope), contextIntegrationDemand: score(integration),
    missingCriticalEvidence: { type: "noul", probability: missing },
  };
}

function sample(
  id: string, prompt: string, category: WorkCategory,
  levels: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2], expectedDecision: ExpectedDecision,
  options?: { readonly missing?: number; readonly eligibleOptionIds?: readonly string[];
    readonly reviewScope?: { readonly changedFiles: number; readonly changedLines: number; readonly directories: number } },
): EvaluationCase {
  return {
    id, prompt, source: "synthetic", expectedCategory: category, expectedDecision,
    assessment: assessment(category, levels, options?.missing),
    ...(options?.eligibleOptionIds ? { eligibleOptionIds: options.eligibleOptionIds } : {}),
    ...(options?.reviewScope ? { reviewScope: options.reviewScope } : {}),
  };
}

/** Golden policy cases for examples/router.config.json; no API requests or quality labels. */
export const syntheticCases: readonly EvaluationCase[] = [
  sample("explain-simple", "Explain what a unit test is in one sentence.", "explain", [0, 0, 0], { status: "selected", optionId: "gpt-general" }),
  sample("implement-local", "Add a unit test for a pure string formatter.", "implement", [0, 0, 0], { status: "selected", optionId: "gpt-general" }),
  sample("implement-coordinated", "Update the API and its callers across several modules.", "implement", [1, 1, 1], { status: "selected", optionId: "gpt-general" }),
  sample("implement-system", "Migrate shared contracts across the whole application.", "implement", [2, 2, 2], { status: "threshold-unmet", optionId: "sonnet-high" }),
  sample("diagnose-interactions", "Find why two interacting modules disagree about state.", "diagnose", [1, 2, 1], { status: "selected", optionId: "sonnet-medium" }),
  sample("review-small", "Review this isolated function for correctness.", "review", [1, 1, 1], { status: "selected", optionId: "gpt-general" }),
  sample("review-branch-large", "Review a broad branch diff.", "review", [0, 1, 0],
    { status: "selected", optionId: "sonnet-medium" },
    { reviewScope: { changedFiles: 8, changedLines: 100, directories: 2 } }),
  sample("review-branch-cross-directory", "Review changes across related modules.", "review", [0, 1, 0],
    { status: "selected", optionId: "sonnet-medium" },
    { reviewScope: { changedFiles: 3, changedLines: 80, directories: 3 } }),
  sample("review-branch-tier-unavailable", "Review a broad branch diff with restricted models.", "review", [0, 1, 0],
    { status: "unchanged", reason: "review-tier-unavailable" },
    { reviewScope: { changedFiles: 8, changedLines: 100, directories: 2 }, eligibleOptionIds: ["gpt-general"] }),
  sample("design-system", "Design a migration of shared interfaces across consumers.", "design", [2, 1, 2], { status: "threshold-unmet", optionId: "sonnet-high" }),
  sample("research-simple", "Find a public reference for this term.", "research", [0, 1, 1], { status: "selected", optionId: "gpt-general" }),
  sample("other-clear", "Translate this short sentence into French.", "other", [0, 0, 0], { status: "selected", optionId: "gpt-general" }),
  sample("unclear-request", "Take care of it.", "unclear", [0, 0, 0], { status: "unchanged", reason: "unclear-category" }),
  sample("missing-critical", "Fix the unspecified failure without showing the error.", "diagnose", [2, 2, 2], { status: "unchanged", reason: "critical-evidence" }, { missing: 0.7 }),
  sample("evidence-below-gate", "Find the cause of a reported regression.", "diagnose", [0, 0, 0], { status: "selected", optionId: "gpt-general" }, { missing: 0.69 }),
  sample("no-eligible", "Explain this self-contained concept.", "explain", [0, 0, 0], { status: "unchanged", reason: "no-eligible-model" }, { eligibleOptionIds: [] }),
  sample("no-category-match", "Explain this self-contained concept.", "explain", [0, 0, 0], { status: "unchanged", reason: "no-category-match" }, { eligibleOptionIds: ["sonnet-medium", "sonnet-high"] }),
];
