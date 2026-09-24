import type { TaskAssessment, WorkCategory } from "../src/application/models/task-assessment.js";
import { TASK_ASSESSMENT_QUESTIONS_VERSION } from "../src/application/use-cases/assess-task.js";
import type { EvaluationCase, ExpectedDecision } from "./evaluate.js";

const categories: readonly string[] = ["explain", "implement", "diagnose", "review", "design", "research", "other", "unclear"];
const reasons: readonly string[] = ["critical-evidence", "unclear-category", "no-eligible-model", "no-category-match", "review-tier-unavailable"];
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
function invalid(path: string): never { throw new Error(`Invalid evaluation case at ${path}.`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(path);
  return value as string;
}
function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(path);
  return value as number;
}
function category(value: unknown, path: string): WorkCategory {
  if (typeof value !== "string" || !categories.includes(value)) invalid(path);
  return value as WorkCategory;
}
function distribution(value: unknown, keys: readonly string[], path: string): number[] {
  const source = object(value, path);
  if (Object.keys(source).length !== keys.length || !keys.every(key => own(source, key))) invalid(path);
  const values = keys.map(key => probability(source[key], path));
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-6) invalid(path);
  return values;
}
function parseAssessment(value: unknown, path: string): TaskAssessment {
  const raw = object(value, path);
  const choice = object(raw.workCategory, `${path}.workCategory`);
  if (choice.type !== "choice") invalid(`${path}.workCategory.type`);
  const chosen = category(choice.choice, `${path}.workCategory.choice`);
  const choiceValues = distribution(choice.probabilities, categories, `${path}.workCategory.probabilities`);
  if (choiceValues[categories.indexOf(chosen)]! + 1e-6 < Math.max(...choiceValues)) invalid(`${path}.workCategory.choice`);
  const workCategory: TaskAssessment["workCategory"] = {
    type: "choice", choice: chosen,
    probabilities: Object.fromEntries(categories.map((key, index) => [key, choiceValues[index]!])) as Record<WorkCategory, number>,
    confidence: probability(choice.confidence, `${path}.workCategory.confidence`),
  };
  const score = (name: "reasoningDemand" | "dependencyScope" | "contextIntegrationDemand") => {
    const answer = object(raw[name], `${path}.${name}`);
    if (answer.type !== "score" || !Array.isArray(answer.probabilities) || answer.probabilities.length !== 3) invalid(`${path}.${name}`);
    const probabilities = answer.probabilities.map((entry: unknown) => probability(entry, `${path}.${name}.probabilities`));
    if (Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-6) invalid(`${path}.${name}.probabilities`);
    const value = answer.score;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2 ||
      Math.abs(value - probabilities[1]! - 2 * probabilities[2]!) > 0.02 + 1e-6) invalid(`${path}.${name}.score`);
    return { type: "score" as const, score: value, probabilities, confidence: probability(answer.confidence, `${path}.${name}.confidence`) };
  };
  const missing = object(raw.missingCriticalEvidence, `${path}.missingCriticalEvidence`);
  if (missing.type !== "noul") invalid(`${path}.missingCriticalEvidence.type`);
  return {
    workCategory,
    reasoningDemand: score("reasoningDemand"), dependencyScope: score("dependencyScope"),
    contextIntegrationDemand: score("contextIntegrationDemand"),
    missingCriticalEvidence: { type: "noul", probability: probability(missing.probability, `${path}.missingCriticalEvidence.probability`) },
  };
}

/** Validates hand-authored or consent-approved stored judgments before they reach the selection policy. */
export function parseEvaluationCasesJson(text: string): EvaluationCase[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid("$"); }
  if (!Array.isArray(value)) invalid("$");
  return value.map((entry: unknown, index: number) => {
    const path = `$[${index}]`;
    const raw = object(entry, path);
    const expected = object(raw.expectedDecision, `${path}.expectedDecision`);
    let expectedDecision: ExpectedDecision;
    if (expected.status === "unchanged" && typeof expected.reason === "string" && reasons.includes(expected.reason)) {
      expectedDecision = { status: "unchanged", reason: expected.reason as Extract<ExpectedDecision, { status: "unchanged" }>["reason"] };
    } else if (expected.status === "selected" || expected.status === "threshold-unmet") {
      expectedDecision = { status: expected.status, optionId: string(expected.optionId, `${path}.expectedDecision.optionId`) };
    } else invalid(`${path}.expectedDecision`);
    const base = {
      id: string(raw.id, `${path}.id`), prompt: string(raw.prompt, `${path}.prompt`),
      expectedCategory: category(raw.expectedCategory, `${path}.expectedCategory`),
      expectedDecision, assessment: parseAssessment(raw.assessment, `${path}.assessment`),
      ...(own(raw, "eligibleOptionIds") ? { eligibleOptionIds: parseEligible(raw.eligibleOptionIds, `${path}.eligibleOptionIds`) } : {}),
      ...(own(raw, "reviewScope") ? { reviewScope: parseScope(raw.reviewScope, `${path}.reviewScope`) } : {}),
    };
    if (raw.source === "synthetic") return { ...base, source: "synthetic" };
    if (raw.source === "recorded-jev") {
      const recording = object(raw.recording, `${path}.recording`);
      if (recording.recipient !== "OpenRouter" && recording.recipient !== "TypeSafe") invalid(`${path}.recording.recipient`);
      if (recording.questionVersion !== TASK_ASSESSMENT_QUESTIONS_VERSION) invalid(`${path}.recording.questionVersion`);
      return { ...base, source: "recorded-jev", recording: {
        recipient: recording.recipient, model: string(recording.model, `${path}.recording.model`), questionVersion: recording.questionVersion,
      } };
    }
    return invalid(`${path}.source`);
  });
}

function parseScope(value: unknown, path: string) {
  const raw = object(value, path);
  if (Object.keys(raw).length !== 3 || !["changedFiles", "changedLines", "directories"].every(key => own(raw, key))) invalid(path);
  const number = (key: string) => {
    const n = raw[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) invalid(`${path}.${key}`);
    return n as number;
  };
  return { changedFiles: number("changedFiles"), changedLines: number("changedLines"), directories: number("directories") };
}

function parseEligible(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path);
  return value.map((entry: unknown) => string(entry, path));
}
