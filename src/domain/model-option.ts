/** Task categories that a classifier may assign. `general` is not a task type. */
export const TASK_CATEGORIES = [
  "explain",
  "implement",
  "diagnose",
  "review",
  "design",
  "research",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** `general` makes an option eligible for every task category. */
export type ModelCategory = TaskCategory | "general";

/** Host-neutral names; actual model support must be checked by the Pi adapter. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One independently measured provider/model/thinking-level combination. */
export interface ModelOption {
  readonly id: string;
  readonly provider: string;
  /** Exact registry identifier, not a display name. */
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  /** Finite percentage in [0, 100]; not a general-purpose quality score. */
  readonly deepSweScore: number;
  /** Finite, nonnegative estimated average total task cost in USD. */
  readonly costPerTaskUsd: number;
  /** Nonempty, unique categories; `general` must appear alone. */
  readonly categories: readonly ModelCategory[];
}
