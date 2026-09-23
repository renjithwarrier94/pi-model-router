import type { TaskAssessment } from "../../application/models/task-assessment.js";

export const ROUTER_STATUS_KEY = "model-router";
export const ROUTER_AUTO_STATUS_KEY = "model-router-auto";

/** Compact, single-line summary; W is policy-weighted demand on a 0..1 scale. */
export function formatAssessmentStatus(assessment: TaskAssessment, weightedDifficulty?: number): string {
  return `Router: ${assessment.workCategory.choice}` +
    ` R${assessment.reasoningDemand.score.toFixed(2)}` +
    ` S${assessment.dependencyScope.score.toFixed(2)}` +
    ` I${assessment.contextIntegrationDemand.score.toFixed(2)}` +
    ` M${Math.round(assessment.missingCriticalEvidence.probability * 100)}%` +
    ` W${weightedDifficulty === undefined ? "–" : weightedDifficulty.toFixed(2)}`;
}
