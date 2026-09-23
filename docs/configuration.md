# Model router configuration

## Status

The model types, strict configuration parser, global/project file loader, project-trust checks, runtime eligibility checks, and one-shot route selection are implemented. Automatic routing remains **off by default**. See [Pi assessment and routing](pi-assessment.md). No files under the user's Pi configuration directory are created or modified by this extension.

- `src/domain/model-option.ts`: SDK-independent candidate, category, and thinking-level types.
- `src/adapters/config/config-schema.ts`: versioned on-disk format and runtime validation.
- `examples/router.config.json`: example inventory. **Scores and costs are illustrative, not benchmark claims.** Replace them with comparable measurements for each model/thinking combination.

## Locations and precedence

- Global: `~/.pi/agent/model-router.json`
- Project: `.pi/model-router.json`

The loader reads global configuration first, then a trusted project's configuration. An explicit project `options` array replaces the entire global array; entries are not merged by ID. Omitted `options` inherits the global list. `options: []` explicitly clears it. A project `policy` replaces the global policy **as a unit**; if omitted, it inherits the global policy, independently of `options`. Every present config file requires `version: 1`. Global location follows Pi's `PI_CODING_AGENT_DIR` environment variable where set.

Routing requires both `policy` and nonempty `options`. Without them it skips and leaves the current model unchanged. Invalid configuration produces a sanitized diagnostic and leaves the model unchanged rather than using a partial list. Untrusted project configuration is never read. Routing is one-shot and only runs after explicit per-prompt consent.

## Format

```json
{
  "version": 1,
  "policy": {
    "weights": { "reasoningDemand": 0.5, "dependencyScope": 0.3, "contextIntegrationDemand": 0.2 },
    "difficultyToDeepSweScore": [
      { "difficulty": 0, "score": 45 },
      { "difficulty": 0.5, "score": 60 },
      { "difficulty": 1, "score": 75 }
    ],
    "maxMissingCriticalEvidenceProbability": 0.7
  },
  "options": [
    {
      "id": "my-model-high",
      "provider": "provider-id",
      "model": "model-id",
      "thinkingLevel": "high",
      "deepSweScore": 70,
      "costPerTaskUsd": 0.25,
      "categories": ["implement", "diagnose", "review"]
    }
  ]
}
```

Each option is a distinct provider/model/thinking-level combination. All option fields are required:

| Field | Validation / meaning |
| --- | --- |
| `id` | Nonempty, unique option ID. |
| `provider` | Nonempty exact Pi provider ID. |
| `model` | Nonempty exact Pi model ID, not a display name. |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `deepSweScore` | Finite number in `[0, 100]`, expressed as percentage points. A fractional value is not automatically converted to a percentage. |
| `costPerTaskUsd` | Finite, nonnegative average total cost per task at this thinking level, in USD; not per-token pricing. Zero is valid. |
| `categories` | Nonempty array of unique category names. |

Task categories: `explain`, `implement`, `diagnose`, `review`, `design`, `research`.

`["general"]` makes the option eligible for all task categories. It must appear alone and is not a category for Jev to classify a task into.

Duplicate provider/model/thinking-level combinations are rejected even if IDs, metrics, or categories differ. Identifiers are case-sensitive, preserved verbatim, and may not have surrounding whitespace. Unknown fields are rejected at both root and option level. There is no coercion, trimming, implicit thinking level, or implicit category default.

DeepSWE is coding benchmark evidence, not a calibrated score for explanation, design, or research. Cost comparisons should use a consistent measurement basis. Neither capability nor cost estimates are automatically inferred from model names.

## Parser API

```ts
import {
  ModelRouterConfigError,
  parseModelRouterConfig,
  parseModelRouterConfigJson,
} from "../src/adapters/config/config-schema.js";

// Unknown already-parsed input:
const config = parseModelRouterConfig({ version: 1, options: [] });

// JSON text, including sanitized JSON syntax errors:
const inherited = parseModelRouterConfigJson('{"version":1}');
```

Both functions return a detached typed copy and throw `ModelRouterConfigError` on the first failure. The error's `path` identifies the invalid location, such as `$.options[0].deepSweScore`. Messages describe the violated rule without echoing supplied values. Outputs are readonly in TypeScript, not runtime-frozen.

These functions perform no I/O, registry lookup, logging, or network calls. Static model types alone do not guarantee runtime validity; external configuration must pass through the parser.

## Selection policy (experimental, uncalibrated)

The three weights must be finite, nonnegative, and have a finite positive sum. Score levels are normalized from 0–2 to 0–1 before computing their weighted average. The curve has at least two points, begins at difficulty 0 and ends at 1, with strictly increasing difficulty and nondecreasing score values in [0,100]. Linear interpolation yields the required DeepSWE score. Scores and costs must be comparable across all configured thinking levels. A `missingCriticalEvidence` P(yes) **at or above** `maxMissingCriticalEvidenceProbability` leaves the current model unchanged; it is not a difficulty dimension. Jev's `unclear` category also leaves the model unchanged; `other` can match only `general` options.

Eligible category-specific options and `general` options meeting the required score are ranked by lowest cost, then highest DeepSWE score, then lexicographically lowest option ID. If no eligible category-compatible option meets the threshold, the highest-scoring compatible option wins, then lowest cost, then lowest ID, with an explicit `threshold-unmet` diagnostic. If no compatible option exists, the model stays unchanged. The tiny 1e-9 score comparison tolerance avoids rejecting a decimal score due solely to interpolation rounding. These are **illustrative, uncalibrated** numbers: DeepSWE is a coding benchmark, not validated for explanation, design, or research. Calibrate with representative labeled cases before trusting unattended selection. The offline synthetic regression suite in [evals](../evals/README.md) checks policy behavior against the example configuration, but does not measure Jev accuracy, model quality, or real cost.

## Runtime checks

The Pi adapter checks exact registered model identity, available credentials, session model scope (including explicit thinking level), Pi-supported thinking level (no clamping), text/image input capability and image count limits, and a conservative context capacity estimate. Models with a hard `maxRequestBytes` limit are excluded until a provider-payload byte preflight exists. If context usage is unknown, no candidate is eligible. The estimate adds the current prompt length, an 8,192-token system/output reserve and an 8,192-token allowance per observed image to Pi's estimated context usage; it is **not a tokenizer or a guarantee of request acceptance**. Pi/provider context handling remains authoritative. These checks only filter candidates: an ineligible model is never resurrected by the score fallback. A failed or unreadable config, unavailable credentials, or unrecognized capability leaves the current model unchanged. See [Pi assessment and routing](pi-assessment.md).
