# Model Router Architecture

## Status and scope

This document describes the intended architecture of a model-routing extension for the Pi coding agent. The repository currently contains a directory skeleton only: implementation, dependency installation, package configuration, and tests are intentionally deferred.

Empty directories contain `.gitkeep` placeholders. The filenames below are planned responsibilities, not existing implementations or a requirement to create every module immediately.

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
  index.ts                         # Planned Pi extension entry point
  composition-root.ts              # Planned dependency wiring
  domain/
    routing-context.ts
    task-assessment.ts
    model-profile.ts
    routing-policy.ts
    routing-decision.ts
    filter-models.ts
    select-model.ts
  application/
    ports/
      context-assessor.ts
    use-cases/
      route-request.ts
    prepare-context.ts
  adapters/
    pi/
      register-hooks.ts
      map-context.ts
      map-models.ts
      apply-decision.ts
      commands.ts
      session-state.ts
    typesafe/
      jev-assessor.ts
      questions.ts
      map-assessment.ts
      client.ts
    config/
      load-config.ts
      config-schema.ts
      map-config.ts

tests/
  unit/
    domain/
    application/
  integration/
    pi/
    typesafe/
    config/
  architecture/
  fixtures/
  fakes/
    fake-context-assessor.ts

evals/
  cases/
    routing.jsonl
  run-evaluation.ts
  metrics.ts

examples/
  router.config.json

docs/
  architecture.md
  configuration.md
  decisions/
```

Package metadata, TypeScript/test-runner configuration, the README, example configuration, and all source/test files will be added during implementation. Only `docs/architecture.md` and directory placeholders are created at this stage.

## Layer responsibilities

### Domain

The domain defines the vocabulary and pure rules of routing. It must not import Pi, TypeSafe, filesystem, networking, or UI APIs.

| Module | Responsibility |
| --- | --- |
| `routing-context.ts` | Framework-neutral request and conversation snapshot, observed requirements, and context-size estimates. |
| `task-assessment.ts` | Semantic judgments such as task category and complexity, with uncertainty represented separately from observed facts. |
| `model-profile.ts` | Provider/model identity, supported inputs, context capacity, and configured capability or preference metadata. |
| `routing-policy.ts` | Eligibility constraints, ranking preferences, uncertainty thresholds, and fallback rules. |
| `routing-decision.ts` | A decision to switch, retain the current model, or report no eligible candidate, with structured reason codes. |
| `filter-models.ts` | Pure eligibility checks against hard constraints. |
| `select-model.ts` | Pure ranking, tie-breaking, and fallback selection over eligible candidates. |

Model identities are plain data rather than Pi SDK objects. Configured capability tiers are policy metadata, not claims inferred from model names.

Hard constraints must be evaluated before preferences. For example, lower cost must never compensate for missing image support or insufficient context capacity. Every fallback candidate must pass the same eligibility checks.

Domain functions should be deterministic for the same inputs. Any state that affects selection must be supplied explicitly.

### Application

The application coordinates a routing operation without knowing how Pi, Jev, or configuration files work.

`route-request.ts` is the initial use case. It receives normalized context, candidate model profiles, policy, and routing-control state as plain data. It:

1. Handles disabled routing and explicit model pinning without unnecessary classification.
2. Filters candidate models using domain eligibility rules.
3. Avoids inference when no semantic assessment is needed.
4. Prepares a bounded assessment snapshot.
5. Obtains semantic judgments through `ContextAssessor`.
6. Invokes domain selection rules.
7. Returns a routing decision without changing Pi state.

`prepare-context.ts` selects and bounds relevant evidence after Pi-specific structures have been translated. Truncation or missing evidence must remain visible in the prepared snapshot.

#### Initial port

`ContextAssessor` is owned by the application and implemented by the TypeSafe adapter. Its conceptual contract is:

```text
assess(RoutingContext, cancellation options) -> TaskAssessment
```

Its input and output are application/domain-owned types. Neither side of this contract exposes TypeSafe SDK response types.

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
- Maintain overrides and restore branch-appropriate session state.

Only this adapter and the outer entry/wiring modules may reference Pi APIs. The core must never receive an `ExtensionContext`, session manager, or Pi model object.

#### Initial routing boundary

Start with routing at `before_agent_start`, using the expanded prompt and relevant active-branch context. Hold the chosen model through the ensuing tool loop rather than reclassifying every tool result.

This is the intended v1 behavior, not a verified implementation guarantee. Integration tests must establish switch timing and behavior for retries, queued prompts, steering, other extensions, and the supported Pi version.

Hook selection remains inside this adapter so future per-turn routing does not force a redesign of domain rules.

#### State and lifecycle

Keep mutable runtime state scoped to the extension/session instance, not module-global singletons. Restore persistent overrides from the active branch, not indiscriminately from all session entries.

Session replacement, reload, navigation, and shutdown must invalidate stale routing work. Before applying an asynchronous decision, confirm that its session, request, and override state are still current.

Do not infer that every model-selection event is a manual user override. Distinguish router-owned changes from external changes explicitly. Exact pinning and manual-override semantics remain to be specified.

### TypeSafe adapter

`jev-assessor.ts` implements `ContextAssessor`. It owns the TypeSafe-specific request and response mapping, not final model selection.

| Module | Responsibility |
| --- | --- |
| `questions.ts` | Versioned Jev instructions, question definitions, and criteria. |
| `map-assessment.ts` | Validate answers and map them into domain assessment types. |
| `client.ts` | Client construction, credentials, request deadlines, bounded retries, and transport configuration. |

The core defines what assessment dimensions mean. The adapter encodes those dimensions using TypeSafe primitives, initially:

- **Choice** for primary task category.
- **Score** for complexity or reasoning demand.
- Other narrow judgments only when they materially change routing.

Ask independent questions over the same state together. Do not ask Jev to infer facts already available in code, such as model authentication, input support, or known context capacity.

Preserve uncertainty per judgment. Confidence is not a guarantee of task success; thresholds must be evaluated on representative routing cases. Service failures, invalid responses, and ambiguous assessments are distinct outcomes.

Jev and question-set versions should be recorded in evaluation results so changes can be compared meaningfully.

### Configuration adapter

The configuration adapter reads external configuration, validates its shape, and translates it into domain policy and candidate metadata.

- Filesystem paths, environment access, and schema-library types remain at this boundary.
- Domain invariants remain in the core even when external schema validation also checks them.
- Credentials must not be embedded in committed example configuration or domain objects.
- Project-local configuration must respect Pi's project-trust boundary.

Configuration filenames, precedence, reload behavior, and the public schema are deferred decisions. Document them in `docs/configuration.md` when specified.

### Composition root and entry point

`composition-root.ts` creates concrete adapters and injects the assessor into the routing use case. It is the only place that needs to know the complete dependency graph.

`index.ts` exports Pi's extension factory and delegates setup to the composition root and Pi hook registration. It must not contain routing rules.

The eventual package will explicitly declare `src/index.ts` in its Pi extension manifest. Ship all referenced source files, keep third-party runtime dependencies in `dependencies`, and follow the supported Pi distribution's peer-dependency requirements.

## Runtime flow

```text
Pi request boundary
  -> translate request and active-branch context
  -> load normalized policy and candidate availability
  -> route-request
       -> honor routing controls
       -> filter eligible candidates
       -> prepare bounded evidence
       -> ContextAssessor -> Jev
       -> apply deterministic selection policy
       -> return RoutingDecision
  -> verify the decision is still current
  -> resolve and apply the selected model through Pi
  -> report the actual outcome
```

Selecting a candidate and successfully switching to it are separate events. A failed switch must not be reported as a successful route.

## Failure behavior

| Condition | Intended behavior |
| --- | --- |
| Routing disabled | Bypass automatic selection and leave host model control unchanged. |
| Explicit model pin | Skip Jev; validate the pin against applicable constraints and availability. |
| Jev timeout or service failure | Use the configured deterministic failure policy; do not treat failure as a low-complexity judgment. |
| Ambiguous assessment | Apply an explicit uncertainty policy, potentially preferring a more capable eligible model. |
| No eligible candidate | Return a distinct outcome; never silently relax hard constraints. |
| Pi rejects a switch | Report the failure and actual model state; any retry candidate must also be eligible. |
| Cancelled or stale assessment | Discard the result and do not switch models. |

Exact timeout values, fallback ordering, uncertainty thresholds, and whether an unroutable request should continue or stop are product decisions to settle before implementation. Keeping the current model is only a valid automatic fallback when it satisfies the applicable constraints.

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
- Application tests use a fake assessor and verify orchestration, inference bypass, cancellation, and failure handling.

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
