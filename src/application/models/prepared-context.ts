/** Application policy, independent of the on-disk router configuration. */
export interface ContextPreparationOptions {
  readonly wordBudget?: number;
  readonly boundaryAllowanceWords?: number;
  /** Individual messages, not user/assistant pairs. Default: no extra count cap. */
  readonly maxHistoryMessages?: number;
  /** UTF-16 code units; guards against code/long strings defeating word counts. */
  readonly maxCharacters?: number;
}

export interface ContextPreparationMetadata {
  readonly selectedHistoryMessages: number;
  readonly omittedHistoryMessages: number;
  readonly omittedSummaries: number;
  /** Images in the retained history and current prompt; bytes are never included. */
  readonly unavailableImages: number;
  /** Includes labels and omission notices in the actual rendered context. */
  readonly wordCount: number;
  readonly characterCount: number;
  readonly usedBoundaryAllowance: boolean;
}

export type ContextPreparationResult =
  | {
      readonly status: "prepared";
      /** Suitable as JudgmentRequest.context after the transmission/privacy policy. */
      readonly context: string;
      readonly metadata: ContextPreparationMetadata;
    }
  | {
      readonly status: "skipped";
      readonly reason: "current-request-too-large";
      /** Counts include mandatory formatting; no prompt content is returned. */
      readonly wordCount: number;
      readonly characterCount: number;
    };
