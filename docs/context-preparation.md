# Context preparation

`src/application/use-cases/prepare-context.ts` implements a pure, synchronous application operation. It accepts a `ConversationSnapshot` and returns a `ContextPreparationResult` defined in `src/application/models/prepared-context.ts`. It imports no Pi or TypeSafe SDK code, performs no I/O, and does not mutate the snapshot.

```ts
const result = prepareContext(snapshot);
if (result.status === "skipped") {
  // Future routing orchestration: retain the current model; do not call Jev.
  return;
}
// result.context is the rendered text for JudgmentRequest.context.
// Apply the transmission/privacy policy before sending it.
```

## Selection policy

1. Preserve the current prompt verbatim under `Current user question`, with its image count. This is separate from history.
2. Include labels and omission notices in the word budget.
3. Walk historical messages backward from newest to oldest. Keep only complete messages, forming a contiguous suffix; never skip a large message to reach smaller older messages.
4. The normal budget is **5,600 words** for the entire rendered context.
5. If the next complete message crosses that budget but fits within **6,600 words**, include it and stop immediately. The **1,000-word allowance is used once**, not once per message or to fill additional older messages.
6. Present selected history chronologically, with user/assistant labels.

A current prompt plus mandatory formatting that already exceeds 5,600 words may use the allowance by itself; no history is then selected. If it exceeds 6,600 words, return `status: "skipped", reason: "current-request-too-large"`. Nothing is silently truncated. A skip result contains counts, not prompt text.

The default **100,000-character ceiling** (JavaScript UTF-16 code units) is an additional conservative guard against whitespace-free code, long identifiers, or other text that defeats word counting. It applies to the entire rendered context. An oversized historical boundary message stops selection; an oversized current prompt plus formatting skips preparation. This is a size guard, not a token estimate.

## Options

The optional second argument accepts:

- `wordBudget`: positive safe integer, default `5600`.
- `boundaryAllowanceWords`: nonnegative safe integer, default `1000`.
- `maxHistoryMessages`: nonnegative safe integer, default no additional message-count cap. Counts individual messages, not pairs. `0` selects no history.
- `maxCharacters`: positive safe integer, default `100000`.

The sum of the word budget and allowance must also be a safe integer. Invalid policy values throw `RangeError`. These are application-level options; they have **not** been added to the version-1 on-disk router configuration.

## Counting and omitted evidence

Words are whitespace-delimited nonempty runs (`/\S+/gu`), not linguistically segmented words. Whitespace and message contents are preserved. Empty and image-only messages are retained as complete entries and their labels consume budget.

The context and returned metadata report omitted older-message and summary counts. Compaction and branch summaries are **not included in v1**. Images are represented only by counts; the rendered text explicitly says their content is unavailable. Metadata totals images in the selected history and current request, not omitted history.

Only omissions from the supplied snapshot are observable. Messages filtered out by the Pi mapper and history already compacted away cannot be counted here. The preparer does not infer missing user/assistant pairs or fabricate placeholders for content it never received.

## Limits and deferred work

- At the proposed 0.7 words/token approximation, 5,600 words is about 8K tokens and 6,600 is about 9.4K. **Neither is a hard token guarantee**, especially for code or languages without whitespace-separated words.
- Counts cover the rendered context only, not Jev questions, SDK wrapping, or output tokens. Those need separate request-level headroom later.
- This step selects and bounds evidence; it does **not redact secrets**. Selected text remains unredacted. A privacy/transmission policy is still required before external calls.
- Labels are not a security boundary. The future Jev questions must treat supplied conversation as evidence, not instructions, even when it contains role-like labels or adversarial text.
- No Jev questions, network calls, model-selection logic, or Pi lifecycle wiring are implemented here.

`tests/unit/application/prepare-context.test.ts` covers exact budget boundaries, one-time allowance, contiguous selection, chronological order, oversize behavior, omission/image metadata, message caps, invalid policies, and frozen input.
