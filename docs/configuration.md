# Model router configuration

## Status

The model types and strict configuration parser are implemented. File loading, global/project precedence resolution, project-trust checks, runtime candidate eligibility, and routing itself are **not wired yet**. No files under the user's Pi configuration directory are created or modified by the parser.

- `src/domain/model-option.ts`: SDK-independent candidate, category, and thinking-level types.
- `src/adapters/config/config-schema.ts`: versioned on-disk format and runtime validation.
- `examples/router.config.json`: example inventory. **Scores and costs are illustrative, not benchmark claims.** Replace them with comparable measurements for each model/thinking combination.

## Locations and intended precedence

- Global: `~/.pi/agent/model-router.json`
- Project: `.pi/model-router.json`

The future loader must read global configuration first, then a trusted project's configuration. An explicit project `options` array replaces the entire global array; entries are not merged by ID. Omitted `options` inherits the global list. `options: []` explicitly clears it. Every present config file requires `version: 1`.

If neither file supplies candidates, automatic routing remains inactive. Invalid configuration should produce a diagnostic and leave the current model unchanged, rather than silently using a partial list. The parser throws; the future host integration owns that behavior.

## Format

```json
{
  "version": 1,
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

## Runtime checks still required

The Pi adapter must later verify exact registry identity, authentication, thinking-level support, input modality, and context capacity. An unsupported thinking level must not be silently clamped: the metrics describe the configured level. The parser accepts recognized level names without claiming that every model supports them.

Routing thresholds, confidence handling, cost/quality trade-offs, and fallback selection are separate policy decisions and are not part of this format yet.
