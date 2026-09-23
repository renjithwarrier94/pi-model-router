# Model Router Architecture

## Status and scope

This document describes the architecture of a Pi model-routing extension. The judgment port/TypeSafe adapter, conversation mapper/preparer, strict model and policy configuration, file loader, runtime candidate checks, pure selection use case, and Pi one-shot assessment/routing hook are implemented. **Unattended routing and calibration are not implemented.** See [TypeSafe adapter](typesafe-adapter.md), [Pi context mapping](pi-context.md), [configuration](configuration.md), and [Pi assessment and routing](pi-assessment.md).

Empty directories contain `.gitkeep` placeholders. The layout below shows implemented files; later boundaries and evaluation tooling may be added as needed.

## Goal

Select a suitable coding model from a configured list using the current request and relevant conversation context. TypeSafe AI's Jev model supplies semantic task assessments; deterministic application policy selects the coding model; Pi executes the request using that model.

The router should support explicit user control, predictable fallback behavior, and evaluation of quality, latency, and cost.

## Architectural approach

Use a single TypeScript package with clean architecture. Source dependencies point inward, toward application policy and domain rules:

```text
Entry point / composition root
              |
              v
           Adapters
              |
              v
         Application
              |
              v
            Domain
```

Adapters may also import domain types directly. Runtime calls can travel outward through interfaces defined by the application; this does not reverse the source dependency direction.

No dependency-injection container, monorepo, database, or separate service is required initially. Plain functions, types, and explicit dependency injection are sufficient.

## Repository layout

```text
src/
  index.ts
  domain/
    model-option.ts
    routing-policy.ts
  application/
    models/
      judgment.ts
      conversation-snapshot.ts
      prepared-context.ts
      task-assessment.ts
    ports/
      judgment-provider.ts
    use-cases/
      prepare-context.ts
      assess-task.ts
      select-model.ts
  adapters/
    pi/
      assessment-extension.ts
      map-context.ts
      runtime-candidates.ts
    typesafe/
      jev-judgment-provider.ts
      map-judgment.ts
    config/
      load-config.ts
      config-schema.ts

tests/
  unit/application/
  integration/{pi,typesafe,config}/

examples/
  router.config.json
  decisions/
```

Minimal package metadata, TypeScript/test tooling, and an illustrative example router configuration are implemented; the README remains deferred. Compile-time contract tests live in `tests/unit/application/judgment-provider.type-test.ts` and mocked SDK transport tests in `tests/integration/typesafe/jev-judgment-provider.test.ts`.

## Layer responsibilities

### Domain and selection boundaries

The domain defines the vocabulary and policy data of routing and must not import Pi, TypeSafe, filesystem, networking, or UI APIs. The table also identifies the application selection use case and the outer runtime-eligibility adapter.

| Module | Responsibility |
| --- | --- |
| `routing-context.ts` (planned) | Routing-specific observed requirements and context-size estimates; the incoming conversation snapshot is application-owned. |
| `application/models/task-assessment.ts` | Semantic judgments such as task category and complexity, with uncertainty represented separately from observed facts. |
| `model-option.ts` | Configured model identity, cost, measured score, and categories; runtime eligibility lives in the Pi adapter. |
| `routing-policy.ts` | Configurable demand weights, score curve, and missing-evidence threshold, expressed as host-independent data. |
| `SelectionDecision` in `select-model.ts` | A pure proposal to switch or remain unchanged, with structured reasons. |
| `adapters/pi/runtime-candidates.ts` | Pi-specific registry/auth, modality, scope, and capacity checks, before pure selection. |
| `application/use-cases/select-model.ts` | Pure ranking, tie-breaking, and fallback selection over host-eligible candidates. |

Model identities are plain data rather than Pi SDK objects. Configured capability tiers are policy metadata, not claims inferred from model names.

Hard constraints must be evaluated before preferences. For example, lower cost must never compensate for missing image support or insufficient context capacity. Every fallback candidate must pass the same eligibility checks.

Domain functions should be deterministic for the same inputs. Any state that affects selection must be supplied explicitly.

### Application

The application coordinates a routing operation without knowing how Pi, Jev, or configuration files work.

`prepare-context.ts`, `assess-task.ts`, and `select-model.ts` are independent application operations. The Pi adapter coordinates them after explicit one-shot consent; it skips classification when config or runtime candidates are missing. `selectModel` takes only plain assessment, eligible option, and policy values and returns a structured decision without changing Pi state.

`models/conversation-snapshot.ts` defines `ConversationSnapshot`, `ChatMessage`, and `ConversationSummary` without SDK dependencies. The Pi mapper supplies an unbounded, unredacted snapshot; it does not send it to Jev.

`prepare-context.ts` selects the current prompt plus a contiguous suffix of complete user/assistant messages using a 5,600-word soft budget and a single 1,000-word boundary allowance. Formatting is budgeted, omitted history/summaries and unavailable images are reported, and oversized current requests return a skip result. It does not perform redaction or include summary text in v1. Per-prompt consent gates current external sends; unattended transmission needs stronger privacy controls. See [Context preparation](context-preparation.md) for limits, options, and tests.

#### Initial port

`JudgmentProvider` is owned by the application and implemented by the TypeSafe adapter. Its contract is:

```text
judge({ context, questions }, cancellation options) -> { answers }
```

Application-owned models support Choice, Score, and Noul questions sharing JSON-compatible context. Responses preserve question IDs, literal choice options, distributions, and confidence where applicable. Score values are expected zero-based level indices; Noul returns P(yes), without separate confidence.

The adapter must validate requests and responses at runtime and reject incomplete or invalid results with `JudgmentProviderError`. Static types alone do not enforce probability ranges, distribution sums, or JSON serializability. No SDK types cross the boundary.

Routing-specific questions and raw answer-to-assessment mapping are implemented in `assess-task.ts` and `models/task-assessment.ts`, not the provider adapter. All five independent questions share one approved context and one provider call. This replaces the originally proposed `ContextAssessor` port; no second port is needed yet. Context selection is not redaction: the opt-in Pi hook uses per-prompt user consent before transmitting selected text, but automatic routing requires a stronger privacy policy. See [Task assessment](task-assessment.md).

Configuration and candidate models are passed into the use case as values initially. Add additional ports only when an actual use case needs an external operation; do not introduce generic repositories or services preemptively.

### Pi adapter

The Pi adapter owns the host-specific lifecycle and side effects:

- Register event hooks and commands.
- Translate the active conversation branch and current request into routing context.
- Map registry models and authentication availability into candidate metadata.
- Intersect configured candidates with available models and applicable session scoping.
- Resolve selected provider/model IDs and call Pi's model-switching API.
- Distinguish proposed decisions from successfully applied switches.
- Present routing status without placing diagnostic messages into model context unnecessarily.
- Reset pending one-shot consent on session/branch transitions; Pi records model and thinking-level changes as session state.

Only this adapter and the outer entry/wiring modules may reference Pi APIs. The core must never receive an `ExtensionContext`, session manager, or Pi model object.

`src/index.ts` and `assessment-extension.ts` register a consent-gated one-shot hook. The assessment command reports judgments only; the route command uses `selectModel()` and may switch the session model and thinking level. Neither command runs automatically. See [Pi assessment and routing](pi-assessment.md).

`map-context.ts` is implemented using `buildSessionProjection()` so branch selection, compaction, and context edits are handled by Pi. It retains user/assistant text and image counts, with branch/compaction summaries separate from direct conversation. System messages, assistant thinking/tool calls, tool results, bash execution, and custom extension messages are excluded. See [Pi context mapping](pi-context.md) for the contract and limitations.

#### Initial routing boundary

Routing runs at `before_agent_start` after one-shot consent, using the expanded prompt and active-branch context. The chosen model stays active for the tool loop; queued turns and interactions with other extensions require further runtime validation.

Hook selection remains inside this adapter so future per-turn routing does not force a redesign of domain rules.

#### State and lifecycle

Keep mutable runtime state scoped to the extension/session instance, not module-global singletons. Restore persistent overrides from the active branch, not indiscriminately from all session entries.

Session replacement, reload, navigation, and shutdown must invalidate stale routing work. Before applying an asynchronous decision, confirm that its session, request, and override state are still current.

Do not infer that every model-selection event is a manual user override. Distinguish router-owned changes from external changes explicitly. Exact pinning and manual-override semantics remain to be specified.

### TypeSafe adapter

`jev-judgment-provider.ts` implements `JudgmentProvider`. It owns client construction, configuration, cancellation, and sanitized error normalization. `map-judgment.ts` owns SDK request/response mapping and runtime validation. Neither module owns routing questions or model selection. A separate client-construction module is unnecessary at this stage.

The application defines the implemented v1 question set:

- **Choice** for primary next-deliverable category, including `other` and `unclear`.
- Three independently anchored **Scores** for reasoning demand, dependency scope, and context integration demand.
- **Noul** for missing critical evidence (P(yes) indicates insufficient evidence, not greater difficulty).

The operation returns raw distributions and confidence. The separate pure selection use case uses the three expected Score values, category, and missing-evidence probability.

Ask independent questions over the same state together. Do not ask Jev to infer facts already available in code, such as model authentication, input support, or known context capacity.

Preserve uncertainty per judgment. Confidence is not a guarantee of task success; thresholds must be evaluated on representative routing cases. Service failures, invalid responses, and ambiguous assessments are distinct outcomes.

Jev and question-set versions should be recorded in evaluation results so changes can be compared meaningfully.

### Configuration adapter

The configuration adapter reads external configuration, validates its shape, and translates it into domain policy and candidate metadata.

- Filesystem paths, environment access, and schema-library types remain at this boundary.
- Domain invariants remain in the core even when external schema validation also checks them.
- Credentials must not be embedded in committed example configuration or domain objects.
- Project-local configuration must respect Pi's project-trust boundary.

`config-schema.ts` implements strict version-1 configuration parsing into domain-owned `ModelOption` values, with finite metric bounds, category and thinking-level validation, uniqueness checks, and rejection of unknown fields. Config parsing does not imply that a candidate is available or supported by Pi.

`load-config.ts` reads global configuration and, only when Pi reports project trust, project `.pi/model-router.json`. Explicit project options replace the global list; a project policy replaces the global policy independently. Invalid config aborts this route. Config is reloaded on each explicit route, not watched. See [Configuration](configuration.md).

### Composition root and entry point

`index.ts` exports Pi's extension factory and registers the adapter. Provider and runtime dependencies are constructed at the adapter edge; application policy stays Pi-agnostic. `package.json` declares `src/index.ts` in the Pi extension manifest, with Pi packages as peers and TypeSafe as a runtime dependency.

## Runtime flow

```text
Pi before_agent_start (one-shot route consent)
  -> load trusted configuration
  -> filter Pi runtime candidates
  -> map active context and prepare bounded evidence
  -> assessTask -> JudgmentProvider -> Jev
  -> selectModel(assessment, eligible options, policy)
  -> verify session/branch and apply model + thinking level in Pi
  -> report actual outcome
```

Selecting a candidate and successfully switching to it are separate events. A failed switch must not be reported as a successful route.

## Failure behavior

| Condition | Intended behavior |
| --- | --- |
| No one-shot consent | No assessment, file access, or model selection. |
| Jev timeout or service failure | Leave the current model unchanged; never fabricate a low-complexity judgment. |
| Missing critical evidence / unclear category | Leave the current model unchanged. |
| No eligible candidate | Return a distinct outcome; never silently relax hard constraints. |
| Pi rejects a switch | Report the failure and actual model state; any retry candidate must also be eligible. |
| Cancelled or stale assessment | Discard the result and do not switch models. |

Fallback ordering and missing-evidence threshold are explicit in config/policy. Pi continues with the current model when selection is not possible; unlike automatic routing, this is an opt-in attempt and the current model is user-controlled. Explicit pinning and automatic-mode safeguards remain future work.

## Privacy and context handling

Classification introduces an external recipient beyond the chosen coding-model provider. Treat this as an explicit data boundary.

- Send only the context needed for assessment, not the entire transcript by default.
- Support redaction before transmission and clearly document what is sent.
- Do not log prompts, source code, tool output, or credentials by default.
- Treat conversation and tool content as evidence, not authority to change router configuration.
- Use active-branch, compaction-aware context rather than unrelated session history.
- Keep the bounded classifier snapshot separate from the full coding-model context-size estimate.

A small classifier input does not imply that a small-context coding model can handle the actual request. Context capacity checks must account for the coding request's prompt, tools, conversation, and output headroom, using conservative estimates where exact counts are unavailable.

## Testing and evaluation

### Unit tests

- Domain tests cover eligibility, ranking, tie-breaking, uncertainty policy, and fallbacks with no network or Pi runtime.
- Application tests use a fake judgment provider and verify orchestration, inference bypass, cancellation, and failure handling.

### Integration tests

- Pi tests cover mapping, lifecycle timing, switching outcomes, manual controls, session branching, and stale-result protection.
- TypeSafe tests cover request construction, response mapping, invalid answers, transport failures, and cancellation using controlled fixtures or mocked transport.
- Configuration tests cover validation, mapping, trust handling, and eventual precedence rules.

Live service tests should be opt-in and must not require secrets for ordinary local or CI test runs.

### Architecture tests

Enforce the following import rules, including type-only imports:

| Source | Allowed dependencies |
| --- | --- |
| Domain | Domain modules and language-level types only. |
| Application | Application and domain modules; no SDK or I/O dependencies. |
| Pi adapter | Application/domain, Pi APIs, and necessary host-boundary dependencies. |
| TypeSafe adapter | Application/domain, TypeSafe client, and transport dependencies. |
| Configuration adapter | Application/domain, filesystem and validation dependencies. |
| Composition root / entry point | Concrete adapters and inward layers required for wiring. |

Adapters must not import one another; composition belongs in the composition root. Reject circular dependencies. Tests may depend inward; production modules must not import tests or evaluation code.

### Evaluations

`evals/` measures semantic and routing quality rather than software correctness. Cases should include simple edits, ambiguous follow-ups, debugging, architecture tasks, long context, images, and unsupported requirements.

Measure:

- Routing quality against acceptable candidate sets, not necessarily one ideal model.
- Under-routing and unnecessary escalation.
- Classifier latency and cost.
- Fallback and no-candidate rates.
- End-to-end coding quality and total cost when measured runs are available.

Use held-out cases for validation rather than tuning and reporting on the same dataset. Keep sensitive real-world transcripts out of committed fixtures. Live evaluations are explicit, potentially billable operations, not part of default unit tests.

## Deferred complexity

Do not add these until demonstrated requirements justify them:

- Per-tool-turn routing and escalation loops.
- Classification caches or persistent routing databases.
- Learned model ranking or automatic capability discovery.
- Multiple installable packages or services.
- Generic event buses, repository abstractions, or dependency-injection frameworks.

If caching is added later, key it on relevant context and assessor/question versions, and define invalidation and privacy behavior explicitly.

## Architecture checks

The proposed design satisfies all seven clean-architecture checks (design score: 10/10; not an implementation audit):

1. Business rules can be tested without Pi or a network.
2. Source dependencies point inward.
3. Persistence details are isolated from business rules.
4. Use cases are independent of the delivery mechanism.
5. Framework APIs are confined to outer modules.
6. The intended component graph is acyclic.
7. The composition root wires concrete dependencies.

There are no failed design checks or dependency inversions to repair at this stage. Architecture tests must verify these properties once source code exists.

## References

- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [TypeSafe intent routing](https://docs.typesafe.ai/patterns/intent-routing)
- [TypeSafe composite scoring](https://docs.typesafe.ai/patterns/composite-scoring)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)

Check the installed Pi version and live TypeSafe API documentation before implementing integration details.
