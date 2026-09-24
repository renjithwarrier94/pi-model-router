import type { ModelOption, TaskCategory } from "../../domain/model-option.js";
import type { RoutingPolicy, SubstantialReviewPolicy } from "../../domain/routing-policy.js";
import type { TaskAssessment } from "../models/task-assessment.js";

export interface ReviewScope {
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly directories: number;
}

export type SelectionDecision =
  | { readonly status: "selected" | "threshold-unmet"; readonly option: ModelOption; readonly difficulty: number; readonly requiredDeepSweScore: number; readonly shortfall: number }
  | { readonly status: "unchanged"; readonly reason: "critical-evidence" | "unclear-category" | "no-eligible-model" | "no-category-match" | "review-tier-unavailable" };

/** Only already runtime-eligible candidates enter this pure decision. Do not pass unchecked external configuration. */
export function selectModel(
  assessment: TaskAssessment,
  eligible: readonly ModelOption[],
  policy: RoutingPolicy,
  reviewScope?: ReviewScope,
): SelectionDecision {
  if (assessment.missingCriticalEvidence.probability >= policy.maxMissingCriticalEvidenceProbability) {
    return { status: "unchanged", reason: "critical-evidence" };
  }
  const category = assessment.workCategory.choice;
  if (category === "unclear") return { status: "unchanged", reason: "unclear-category" };
  if (eligible.length === 0) return { status: "unchanged", reason: "no-eligible-model" };
  let compatible = eligible.filter(option => option.categories.includes("general") ||
    (category !== "other" && option.categories.includes(category as TaskCategory)));
  if (compatible.length === 0) return { status: "unchanged", reason: "no-category-match" };
  const floor = policy.substantialReview;
  if (category === "review" && reviewScope && floor && isSubstantialReview(reviewScope, floor)) {
    const allowed = new Set(floor.allowedOptionIds);
    compatible = compatible.filter(option => allowed.has(option.id));
    if (compatible.length === 0) return { status: "unchanged", reason: "review-tier-unavailable" };
  }

  const { difficultyToDeepSweScore: points } = policy;
  const boundedDifficulty = calculateWeightedDifficulty(assessment, policy);
  let requiredDeepSweScore = points[points.length - 1]!.score;
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1]!;
    const right = points[i]!;
    if (boundedDifficulty <= right.difficulty) {
      requiredDeepSweScore = left.score +
        (right.score - left.score) * (boundedDifficulty - left.difficulty) / (right.difficulty - left.difficulty);
      break;
    }
  }
  const sufficient = compatible.filter(option => option.deepSweScore + 1e-9 >= requiredDeepSweScore);
  if (sufficient.length > 0) {
    const option = [...sufficient].sort((a, b) =>
      a.costPerTaskUsd - b.costPerTaskUsd || b.deepSweScore - a.deepSweScore || idOrder(a.id, b.id))[0]!;
    return { status: "selected", option, difficulty: boundedDifficulty, requiredDeepSweScore, shortfall: 0 };
  }
  // Shortfall never bypasses category or runtime eligibility.
  const option = [...compatible].sort((a, b) =>
    b.deepSweScore - a.deepSweScore || a.costPerTaskUsd - b.costPerTaskUsd || idOrder(a.id, b.id))[0]!;
  return {
    status: "threshold-unmet", option, difficulty: boundedDifficulty,
    requiredDeepSweScore, shortfall: Math.max(0, requiredDeepSweScore - option.deepSweScore),
  };
}

export function isSubstantialReview(scope: ReviewScope, policy: SubstantialReviewPolicy): boolean {
  return scope.changedFiles >= policy.minChangedFiles ||
    scope.changedLines >= policy.minChangedLines ||
    scope.directories >= policy.minDirectories;
}

/** Normalized weighted demand (0..1), shared by selection and the diagnostic status line. */
export function calculateWeightedDifficulty(assessment: TaskAssessment, policy: RoutingPolicy): number {
  const { weights } = policy;
  const totalWeight = weights.reasoningDemand + weights.dependencyScope + weights.contextIntegrationDemand;
  const difficulty = (
    weights.reasoningDemand * (assessment.reasoningDemand.score / 2) +
    weights.dependencyScope * (assessment.dependencyScope.score / 2) +
    weights.contextIntegrationDemand * (assessment.contextIntegrationDemand.score / 2)
  ) / totalWeight;
  // A validated score is in [0,2]. Clamp only floating-point error at the endpoints.
  return Math.max(0, Math.min(1, difficulty));
}

function idOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
