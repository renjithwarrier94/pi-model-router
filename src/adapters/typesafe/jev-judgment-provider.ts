import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import type { JudgmentRequest, JudgmentResponse, QuestionSet } from "../../application/models/judgment.js";
import {
  JudgmentProviderError,
  type JudgmentOptions,
  type JudgmentProvider,
  type JudgmentProviderErrorCode,
} from "../../application/ports/judgment-provider.js";
import { mapRequest, mapResponse } from "./map-judgment.js";

/** SDK configuration is confined to the adapter boundary. */
export type JevJudgmentProviderConfig = Pick<
  TypeSafeClientConfig,
  "apiKey" | "baseURL" | "defaultModel" | "timeout" | "retry" | "fetch"
>;

function normalizeError(error: unknown): JudgmentProviderError {
  if (error instanceof JudgmentProviderError) return error;
  let code: JudgmentProviderErrorCode = "unavailable";
  if (error instanceof APIUserAbortError) code = "cancelled";
  else if (error instanceof APITimeoutError) code = "timeout";
  else if (error instanceof SyntaxError) code = "invalid-response";
  else if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) code = "unauthorized";
    else if (error.status === 429) code = "rate-limited";
    else if (error.status === 400 || error.status === 422) code = "invalid-request";
    else if (error.status === 408 || error.status === 504) code = "timeout";
  }
  // Never retain SDK messages, payloads, headers, or causes at this boundary.
  return new JudgmentProviderError(code, `TypeSafe judgment failed (${code}).`);
}

export class JevJudgmentProvider implements JudgmentProvider {
  private readonly client: TypeSafeClient;

  constructor(config: JevJudgmentProviderConfig = {}) {
    try {
      this.client = new TypeSafeClient({
        ...config,
        // Explicitly override TYPESAFE_LOG_LEVEL to prevent raw context logging.
        logLevel: "off",
        timeout: config.timeout ?? 10_000,
        // Retry only transient HTTP server errors: two additional attempts, fixed 100 ms delay.
        // Do not retry network/timeout failures, rate limits, or honor server Retry-After by default.
        retry: {
          maxRetries: 2,
          backoffInitialMs: 100,
          backoffMaxMs: 100,
          backoffJitter: 0,
          httpStatuses: new Set(Array.from({ length: 100 }, (_, index) => 500 + index)),
          respectRetryAfter: false,
          apiConnectionError: false,
          apiTimeoutError: false,
          ...config.retry,
        },
      });
    } catch {
      throw new JudgmentProviderError("invalid-request", "Invalid TypeSafe client configuration; check credentials and options.");
    }
  }

  async judge<const Q extends QuestionSet>(
    request: JudgmentRequest<Q>,
    options?: JudgmentOptions,
  ): Promise<JudgmentResponse<Q>> {
    try {
      if (options?.signal?.aborted) throw new JudgmentProviderError("cancelled", "Judgment request cancelled.");
      const mapped = mapRequest(request);
      const response: unknown = await this.client.systemOne(mapped, options?.signal ? { signal: options.signal } : {});
      if (options?.signal?.aborted) throw new JudgmentProviderError("cancelled", "Judgment request cancelled.");
      return mapResponse<Q>(response, mapped.questions);
    } catch (error) {
      throw normalizeError(error);
    }
  }
}
