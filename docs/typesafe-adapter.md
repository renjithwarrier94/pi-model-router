# TypeSafe judgment adapter

`src/adapters/typesafe/jev-judgment-provider.ts` implements the application-owned `JudgmentProvider` using `@typesafe-ai/sdk` 0.6.x. SDK types and transport concerns stay in the adapter layer.

```ts
import { JevJudgmentProvider } from "../src/adapters/typesafe/jev-judgment-provider.js";

const provider = new JevJudgmentProvider({
  // Alternatively read from TYPESAFE_API_KEY (the SDK default).
  apiKey: process.env.TYPESAFE_API_KEY!,
  defaultModel: "jev-latest",
  timeout: 5_000,
  retry: { maxRetries: 0 },
});

const result = await provider.judge({
  context: { prompt: "Refactor authentication" },
  questions: {
    inspect: { type: "noul", instructions: "Does this task require inspecting existing code?" },
  },
});

console.log(result.answers.inspect.probability);
```

## Configuration

The Pi integration (`src/adapters/pi/resolve-judgment-provider.ts`) chooses the recipient, independently of coding-model options. It resolves Pi's OpenRouter credential first via `ctx.modelRegistry.getApiKeyForProvider("openrouter")`, then `OPENROUTER_API_KEY`, then `TYPESAFE_API_KEY`. The first two use `baseURL: "https://openrouter.ai/api"` and `defaultModel: "jev-1.13"`; direct TypeSafe uses `baseURL: "https://api.typesafe.ai"` and `defaultModel: "jev-latest"`. If none exists, the Pi command does not grant consent. Missing credentials are not inferred from Pi's selected coding model, and no credentials are read directly from `auth.json`. This uses the same SDK/port mapping, not a separate OpenRouter chat adapter. See [Pi assessment and routing](pi-assessment.md).

The constructor accepts `apiKey`, `baseURL`, `defaultModel`, `timeout`, `retry`, and `fetch`. Omitted credentials, base URL, and model use SDK environment/default resolution. Custom `fetch` supports controlled transport tests.

Defaults are a 10-second **per-attempt** timeout and zero retries. Explicit retry configuration uses the SDK's bounded retry policy. There is no total retry deadline; callers may supply `judge(request, { signal })` for overall cancellation. A caller-provided timeout signal is classified as `cancelled`; the SDK's attempt timeout is classified as `timeout`.

SDK logging is explicitly disabled, including when `TYPESAFE_LOG_LEVEL` is set. Credentials, raw requests, SDK response bodies, and exception causes are not copied into application errors. Invalid constructor configuration produces a sanitized `invalid-request` error.

## Mapping and validation

- Requests are copied before transmission to prevent later caller mutation from changing response validation.
- Context must be finite, acyclic JSON data composed of primitives, arrays, and plain objects. Numbers and booleans are wrapped as `{ context: value }` because SDK state does not accept them at the top level.
- At least one question is required. Choice supports 1–255 options; Score requires 2–10 ordered levels. Instructions and criteria support text or structured JSON descriptions.
- Choice `options` and Score `levels` map to SDK `criteria`; Noul `yes`/`no` map to `true`/`false`.
- Responses must contain exactly the requested question IDs and matching answer types.
- Probabilities and confidence must be finite and in `[0, 1]`. Distribution sums and score expectations use absolute tolerance `1e-6`.
- Choice must select a highest-probability supplied option. Score probabilities are returned in input-level order. The input rubric is authoritative; provider legend, usage, and model metadata are not exposed by this port.
- Noul returns `probability`, without fabricated confidence.
- Invalid or incomplete responses fail atomically with `invalid-response`.

HTTP authentication/permission failures map to `unauthorized`; 429 to `rate-limited`; 400/422 to `invalid-request`; 408/504 and SDK deadlines to `timeout`; other transport/server failures to `unavailable`.

## Verification

```sh
npm ci
npm run typecheck
npm test
```

Tests use the real SDK with a mocked HTTP transport, including the OpenRouter System One URL, bearer key, and bare Jev model ID. No live API calls are made; live model behavior and production numerical precision have not been verified.
