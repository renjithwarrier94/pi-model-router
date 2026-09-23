# Pi assessment integration (opt-in preview)

`src/index.ts` is the Pi package entry point. Its manifest is `package.json` → `pi.extensions`. The hook is in `src/adapters/pi/assessment-extension.ts` and only performs a one-shot **assessment**, not model selection or switching.

## Try it

Install dependencies in this package, then load the extension from the repository root:

```sh
pi --extension ./src/index.ts
```

Set `TYPESAFE_API_KEY` in the Pi process environment. This key is read by the TypeSafe SDK; do not put it in `model-router.json`. In an interactive session, run:

```text
/model-router-assess once
```

Then submit the next prompt. The command explicitly consents to sending **the current prompt and selected, unredacted historical user/assistant text** to TypeSafe for this one assessment. The hook uses `mapContext()` → `prepareContext()` → `assessTask()` with the `JevJudgmentProvider`. It displays the primary category, three raw 0–2 scores, and the probability that critical evidence is missing. It makes no changes to the Pi model, thinking level, prompt, or transcript. It does not persist results. Other existing Pi/provider calls proceed normally.

Without the command, the hook is inert: no TypeSafe client construction, provider call, or context access. Run `/model-router-assess off` before the next prompt to cancel. An unrecognized argument shows usage and grants no consent. Consent is consumed **before** snapshot preparation, including on errors or skipped/oversized prompts; to retry, run `once` again. It is reset at session start, shutdown, or tree navigation (including reload/session replacement). Late results from a cancelled or changed session/branch are ignored. The current Pi operation signal is forwarded to the provider. Notifications are shown only when Pi reports UI availability; no raw context or SDK error messages are shown in notifications.

**Privacy:** this is deliberate opt-in to external transmission, **not redaction**. Text may contain secrets even when Pi's mapper excludes tools, images, thinking blocks, and system messages. Conversation summaries are omitted by the preparer. Image counts, omission notices, and selected message text are still transmitted; no image bytes are included. Do not enable this command for prompts or historical text you do not wish to send to TypeSafe. Per-prompt approval does not solve the need for a stricter policy before enabling fully automatic routing. Jev instructions distinguish conversation evidence from instructions, but prompt-injection resistance is not guaranteed.

`~/.pi/agent/model-router.json` and `.pi/model-router.json` are **not yet loaded**. No candidate validation, score aggregation, model selection, fallbacks, or Pi model switching is performed. A response is diagnostic only; high missing-evidence probability does not select a stronger model. There is no live API call in tests: integration tests simulate Pi hooks and a fake port; separate tests exercise the real SDK adapter with mocked transport.
