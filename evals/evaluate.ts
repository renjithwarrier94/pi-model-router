import type { ModelRouterConfig } from "../src/adapters/config/config-schema.js";
import type { TaskAssessment } from "../src/application/models/task-assessment.js";
import type { WorkCategory } from "../src/application/models/task-assessment.js";
import { selectModel, type SelectionDecision } from "../src/application/use-cases/select-model.js";

export type ExpectedDecision =
  | { readonly status: "selected" | "threshold-unmet"; readonly optionId: string }
  | { readonly status: "unchanged"; readonly reason: Extract<SelectionDecision, { status: "unchanged" }>["reason"] };

export type EvaluationCase = {
  readonly id: string;
  /** Only use shareable synthetic prompts or prompts explicitly approved for storage. */
  readonly prompt: string;
  /** Synthetic signals test policy behavior, NOT Jev accuracy or model quality. */
  readonly expectedCategory: WorkCategory;
  readonly expectedDecision: ExpectedDecision;
  readonly assessment: TaskAssessment;
  /** Simulated Pi eligibility, not a runtime check. Omitted means all configured options. */
  readonly eligibleOptionIds?: readonly string[];
} & (
  | { readonly source: "synthetic" }
  | { readonly source: "recorded-jev"; readonly recording: {
      readonly recipient: "OpenRouter" | "TypeSafe";
      readonly model: string;
      readonly questionVersion: number;
    } }
);

export interface EvaluationResult {
  readonly id: string;
  readonly source: EvaluationCase["source"];
  readonly categoryMatches: boolean;
  readonly decisionMatches: boolean;
  readonly expected: ExpectedDecision;
  readonly actual: ExpectedDecision;
  readonly difficulty?: number;
  readonly requiredDeepSweScore?: number;
}

export function evaluateCases(cases: readonly EvaluationCase[], config: ModelRouterConfig): EvaluationResult[] {
  if (!config.policy || !config.options?.length) throw new Error("Evals require a policy and at least one option.");
  const options = new Map(config.options.map(option => [option.id, option]));
  const ids = new Set<string>();
  return cases.map(testCase => {
    if (!testCase.id || ids.has(testCase.id)) throw new Error("Eval case IDs must be unique and nonempty.");
    ids.add(testCase.id);
    const eligibleIds = testCase.eligibleOptionIds ?? [...options.keys()];
    if (new Set(eligibleIds).size !== eligibleIds.length) throw new Error(`Duplicate eligible option in ${testCase.id}.`);
    const eligible = eligibleIds.map(id => {
      const option = options.get(id);
      if (!option) throw new Error(`Unknown eligible option in ${testCase.id}: ${id}`);
      return option;
    });
    const decision = selectModel(testCase.assessment, eligible, config.policy!);
    const actual: ExpectedDecision = decision.status === "unchanged"
      ? { status: "unchanged", reason: decision.reason }
      : { status: decision.status, optionId: decision.option.id };
    return {
      id: testCase.id, source: testCase.source,
      categoryMatches: testCase.assessment.workCategory.choice === testCase.expectedCategory,
      decisionMatches: actual.status === testCase.expectedDecision.status &&
        (actual.status === "unchanged"
          ? testCase.expectedDecision.status === "unchanged" && actual.reason === testCase.expectedDecision.reason
          : testCase.expectedDecision.status !== "unchanged" && actual.optionId === testCase.expectedDecision.optionId),
      expected: testCase.expectedDecision, actual,
      ...(decision.status === "unchanged" ? {} : {
        difficulty: decision.difficulty, requiredDeepSweScore: decision.requiredDeepSweScore,
      }),
    };
  });
}
