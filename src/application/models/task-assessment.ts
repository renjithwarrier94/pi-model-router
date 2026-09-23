import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./judgment.js";
import type { TaskCategory } from "../../domain/model-option.js";

/** `other` is outside the taxonomy; `unclear` means the next deliverable cannot be identified. */
export type WorkCategory = TaskCategory | "other" | "unclear";

/** Raw judgments, not a difficulty threshold or a model-selection decision. */
export interface TaskAssessment {
  readonly workCategory: ChoiceAnswer<WorkCategory>;
  /** Expected index on a three-level scale (0..2), plus its distribution. */
  readonly reasoningDemand: ScoreAnswer;
  readonly dependencyScope: ScoreAnswer;
  readonly contextIntegrationDemand: ScoreAnswer;
  /** P(yes): critical evidence is missing; NOT a difficulty score. */
  readonly missingCriticalEvidence: NoulAnswer;
}
