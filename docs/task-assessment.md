# Task assessment questions (v1)

`src/application/use-cases/assess-task.ts` defines five application-owned questions. `assessTask(context, provider, { signal? })` submits them together through `JudgmentProvider` and returns `TaskAssessment` from `src/application/models/task-assessment.ts`. The TypeSafe adapter translates these definitions to Jev's Choice, Score, and Noul primitives; no SDK types enter the application. The questions share the same context and are independent; none sees another question's answer.

**Scope:** `context` must have been approved for external transmission by the caller. `prepareContext()` selects and bounds text but does **not** redact it. The Pi hook invokes this operation **only after an explicit `/model-router-assess once` or `/model-router-route once` command**: this is per-prompt consent to send the selected, unredacted text. Without that command, no assessment or network call occurs. Tests use approved literal strings and mocked transport. No credentials or live Jev calls are needed for tests.

## Judgments

All questions refer to the **primary next deliverable under `Current user question`**, using past context only to clarify that deliverable—not the overall project's complexity. Each question includes its own complete instructions; question IDs are correlation keys and are not visible to Jev.

| Question | Type | Outcome / anchors (ordered low → high for Scores) |
| --- | --- | --- |
| `workCategory` | Choice | `explain`, `implement`, `diagnose`, `review`, `design`, `research`, `other` (clear deliverable outside taxonomy), `unclear` (deliverable not identifiable). `general` is a *model eligibility category*, not a task outcome. |
| `reasoningDemand` | Score | Apply an explicit known procedure → infer a solution from connected evidence → resolve competing explanations or design tradeoffs. |
| `dependencyScope` | Score | Self-contained result → interacting modules or concepts → shared contracts or system-wide invariants. Applies to non-coding work too. |
| `contextIntegrationDemand` | Score | One relevant passage suffices → combine several sources → reconcile dispersed or conflicting evidence. Number of supplied messages is not automatically high demand. |
| `missingCriticalEvidence` | Noul | P(yes) that information absent from the *supplied* context could materially change the appropriate next action. Omission notices and unavailable images may be relevant, but do not automatically imply a yes. Information discoverable by normal requested work need not block choosing a next action. |

Score answers retain the probability-weighted **zero-based** index on a 0–2 scale, the full distribution, and confidence. Choice retains its distribution and confidence. Noul retains the probability of *yes*, with no separate confidence. None of these is a correctness guarantee. In particular, `missingCriticalEvidence` is **uncertainty/evidence sufficiency**, not a fourth difficulty score; neither it nor an `unclear` classification is automatically converted to a model choice.

`TASK_ASSESSMENT_QUESTIONS_VERSION = 1` marks the semantics for later evals. If descriptions change in a way that changes judgments, bump this version and recalibrate any downstream policy. Changes to the Jev model version should also be recorded by evals; it is configured by the outer adapter.

## Boundaries and follow-up

`buildTaskAssessmentRequest(context)` creates the complete typed port request. `assessTask()` calls the port once, passes cancellation options through, returns validated answers without flattening distributions, and propagates errors without inventing defaults. The port adapter owns runtime validation. Configured candidates, their availability, category fallback, score aggregation, calibration, and handling of missing evidence belong to later routing policy—not these questions. The Pi adapter gates transmission with explicit one-shot consent or confirmed in-memory session-scoped auto consent. Auto mode sends subsequent prompts without fresh approval and does not redact them; persistent unattended transmission needs stronger privacy controls. Measure question/request tokens before broadening the opt-in; the existing word budget covers only rendered context, not questions or transport overhead.

Tests cover the question vocabulary and anchors, single-call behavior, option forwarding, raw-answer preservation, adapter request/response mapping, and all-or-nothing failure.
