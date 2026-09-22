# Pi context mapping

Implemented in `src/adapters/pi/map-context.ts`, returning application-owned types from `src/application/models/conversation-snapshot.ts`.

## Usage

The eventual Pi hook can pass the event and read-only session manager directly:

```ts
pi.on("before_agent_start", (event, ctx) => {
  const snapshot = mapContext(event, ctx.sessionManager);
  // Pass snapshot to the use case for selection, bounding, and redaction.
});
```

Hook registration and the use case are not implemented yet. The mapper targets Pi 0.87.0, pinned as a development dependency for typechecking and in-memory integration tests. Production imports of Pi are type-only; the mapper has no runtime SDK import.

## Contract

- Calls `buildSessionProjection()` once. Pi resolves the active branch, compaction, and context edits; the mapper never reads raw history as a fallback.
- At `before_agent_start`, the new request is not yet persisted. `event.prompt` and the count of `event.images` become `currentRequest`, not another historical message. The prompt is already expanded by Pi.
- `history` retains user/assistant roles, text, and image counts in projection order. Text blocks are joined with `\n`, without trimming or truncation. Empty, image-only, thinking-only, and tool-call-only messages remain as entries (the latter two have empty text and zero images). Relevance selection belongs to the use case.
- `summaries` retains compaction and branch summaries in projection order, with explicit kinds. Interleaving between summaries and history is not represented by this model.
- Excludes system messages, assistant thinking and tool-call blocks, tool-result messages, bash execution, custom extension messages, and other roles. No image bytes, tool arguments, metadata, signatures, usage, or Pi object references are copied.
- Creates new arrays and objects without mutating host data. Readonly types provide compile-time protection; returned objects are not runtime-frozen.
- Propagates projection errors to the caller rather than substituting empty or raw history.

## Privacy and scope

This is **not redaction** and the result must not be sent wholesale to Jev. User/assistant text can quote sensitive material, and summaries may describe excluded tool output or other content. The use case must select, bound, and redact both history and summaries before transmission. The mapper performs no network calls or logging.

Custom-role extension messages are excluded, but an extension's `sendUserMessage()` produces a normal user-role message and cannot be distinguished from human input here. This snapshot also precedes later context hooks and is not the final provider payload or a coding-model context-size estimate.

## Tests

`tests/integration/pi/map-context.test.ts` exercises the real in-memory Pi session manager for filtering, branch selection, compaction, context edits, and summary conversion. It also checks current-request separation, whitespace/block order, empty/image-only messages, image-data exclusion, non-mutation, detached snapshots, and projection failures. No network or credentials are required.
