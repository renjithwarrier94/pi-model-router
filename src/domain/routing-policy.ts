/** Experimental, uncalibrated difficulty-to-benchmark mapping. */
export interface DifficultyScorePoint {
  readonly difficulty: number;
  readonly score: number;
}

export interface RoutingPolicy {
  readonly weights: {
    readonly reasoningDemand: number;
    readonly dependencyScope: number;
    readonly contextIntegrationDemand: number;
  };
  /** Piecewise linear; endpoints at difficulty 0 and 1. */
  readonly difficultyToDeepSweScore: readonly DifficultyScorePoint[];
  /** At or above this P(yes), leave the model unchanged. */
  readonly maxMissingCriticalEvidenceProbability: number;
}
