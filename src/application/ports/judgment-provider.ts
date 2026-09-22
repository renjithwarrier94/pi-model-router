import type {
  JudgmentRequest,
  JudgmentResponse,
  QuestionSet,
} from "../models/judgment.js";

export interface JudgmentOptions {
  readonly signal?: AbortSignal;
}

/**
 * Answers independent typed questions against shared context.
 *
 * Implementations must validate requests and external responses at runtime.
 * A successful response contains exactly one matching answer per question,
 * valid option IDs, and finite probabilities/confidences in [0, 1]. Choice
 * distributions cover every option; score distributions match the input levels.
 * Distributions sum to 1 within floating-point tolerance; scores match their
 * expected level index. No missing or invalid answer is replaced by a default.
 *
 * Reject with JudgmentProviderError on failure, including invalid requests,
 * invalid responses, and cancellation (also for an already-aborted signal).
 * No partial responses are returned. SDK errors must not cross this boundary.
 * Credentials, model version, deadlines, and retries are adapter configuration.
 */
export interface JudgmentProvider {
  judge<const Q extends QuestionSet>(
    request: JudgmentRequest<Q>,
    options?: JudgmentOptions,
  ): Promise<JudgmentResponse<Q>>;
}

export type JudgmentProviderErrorCode =
  | "invalid-request"
  | "unauthorized"
  | "rate-limited"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "invalid-response";

/** Messages must be sanitized: no credentials, raw context, or SDK payloads. */
export class JudgmentProviderError extends Error {
  readonly code: JudgmentProviderErrorCode;

  constructor(code: JudgmentProviderErrorCode, message: string) {
    super(message);
    this.name = "JudgmentProviderError";
    this.code = code;
  }
}
