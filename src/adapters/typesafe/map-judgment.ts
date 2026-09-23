import type { EntryType, Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import type { JudgmentRequest, JudgmentResponse, QuestionSet } from "../../application/models/judgment.js";
import { JudgmentProviderError } from "../../application/ports/judgment-provider.js";

const TOLERANCE = 1e-6;
// Live Jev may round each score probability to 0.01 while computing its score
// from finer precision; with three levels, their expectations can differ by ~0.02.
const SCORE_ROUNDING_TOLERANCE = 0.02 + TOLERANCE;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function requireValid(condition: unknown, response = false): asserts condition {
  if (!condition) throw new JudgmentProviderError(
    response ? "invalid-response" : "invalid-request",
    response ? "TypeSafe returned an invalid judgment response." : "Invalid judgment request.",
  );
}

/** Copy JSON data, rejecting silent JSON.stringify coercions and cycles. */
function copyJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValid(Number.isFinite(value));
    return value;
  }
  requireValid(Array.isArray(value) || (record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)));
  requireValid(!ancestors.has(value));
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = Array.from(value, (entry) => copyJson(entry, ancestors));
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyJson(entry, ancestors)]));
  }
  ancestors.delete(value);
  return result;
}

function description(value: unknown): asserts value is EntryType {
  requireValid(typeof value === "string" || Array.isArray(value) || record(value));
}

/** Returns a detached snapshot so caller mutation cannot affect validation after await. */
export function mapRequest(request: JudgmentRequest): SystemOneRequest {
  const snapshot = copyJson(request);
  requireValid(record(snapshot) && Object.hasOwn(snapshot, "context") && record(snapshot.questions));
  const entries = Object.entries(snapshot.questions);
  requireValid(entries.length > 0);
  const questions: Questions = Object.create(null) as Questions;
  for (const [id, question] of entries) {
    requireValid(record(question));
    description(question.instructions);
    const instructions = question.instructions;
    switch (question.type) {
      case "choice": {
        requireValid(record(question.options));
        const options = Object.entries(question.options);
        requireValid(options.length > 0 && options.length <= 255);
        for (const [, value] of options) description(value);
        questions[id] = { type: "choice", instructions, criteria: question.options as Record<string, EntryType> };
        break;
      }
      case "score": {
        requireValid(Array.isArray(question.levels) && question.levels.length >= 2 && question.levels.length <= 10);
        for (const level of question.levels) description(level);
        questions[id] = { type: "score", instructions, criteria: question.levels as [EntryType, EntryType, ...EntryType[]] };
        break;
      }
      case "noul": {
        questions[id] = { type: "noul", instructions };
        if (question.criteria !== undefined) {
          requireValid(record(question.criteria));
          description(question.criteria.yes);
          description(question.criteria.no);
          questions[id] = { type: "noul", instructions, criteria: { true: question.criteria.yes, false: question.criteria.no } };
        }
        break;
      }
      default: requireValid(false);
    }
  }
  // The port allows primitive JSON context; wrap numbers/booleans for SDK state.
  const context = snapshot.context;
  const state = typeof context === "number" || typeof context === "boolean"
    ? { context } : context as EntryType;
  return { state, questions };
}

function probability(value: unknown): number {
  requireValid(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, true);
  return value;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function distribution(value: unknown, keys: readonly string[]): number[] {
  requireValid(record(value) && sameKeys(value, keys), true);
  const values = keys.map((key) => probability(value[key]));
  requireValid(Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= TOLERANCE, true);
  return values;
}

export function mapResponse<Q extends QuestionSet>(raw: unknown, questions: Questions): JudgmentResponse<Q> {
  requireValid(record(raw) && record(raw.answers) && sameKeys(raw.answers, Object.keys(questions)), true);
  const answers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    requireValid(record(answer) && answer.type === question.type, true);
    switch (question.type) {
      case "choice": {
        const keys = Object.keys(question.criteria);
        const values = distribution(answer.probabilities, keys);
        requireValid(typeof answer.choice === "string" && keys.includes(answer.choice), true);
        const selected = values[keys.indexOf(answer.choice)]!;
        requireValid(selected + TOLERANCE >= Math.max(...values), true);
        answers[id] = { type: "choice", choice: answer.choice, probabilities: Object.fromEntries(keys.map((key, i) => [key, values[i]])), confidence: probability(answer.confidence) };
        break;
      }
      case "score": {
        const keys = question.criteria.map((_, index) => String(index));
        const values = distribution(answer.probabilities, keys);
        const expected = values.reduce((sum, p, index) => sum + p * index, 0);
        requireValid(typeof answer.score === "number" && Number.isFinite(answer.score) &&
          answer.score >= 0 && answer.score <= keys.length - 1 && Math.abs(answer.score - expected) <= SCORE_ROUNDING_TOLERANCE, true);
        answers[id] = { type: "score", score: answer.score, probabilities: values, confidence: probability(answer.confidence) };
        break;
      }
      case "noul": answers[id] = { type: "noul", probability: probability(answer.noul) };
    }
  }
  // Runtime correlation and per-kind validation above establish this mapped type.
  return { answers } as JudgmentResponse<Q>;
}
