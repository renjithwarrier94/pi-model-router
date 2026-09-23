# Pi assessment and routing (one-shot opt-in)

`src/index.ts` loads the Pi hook in `src/adapters/pi/assessment-extension.ts`. **Neither operation runs automatically.** Install dependencies, then load from the repository root with `pi --extension ./src/index.ts`. The TypeSafe SDK reads `TYPESAFE_API_KEY` from the Pi process environment; do not put the key in router config.

## Commands

- `/model-router-assess once`: assess the next prompt and display five judgments; **never switch the model**.
- `/model-router-route once`: assess the next prompt, select an eligible configured option, and change the **session model and thinking level** before Pi sends the prompt. A later prompt keeps the selected model until you change it; the *permission to reassess and switch* applies only to this one prompt.
- `/model-router-assess off` or `/model-router-route off`: cancel either pending one-shot command. Issuing `once` for either command replaces the previous pending command. Invalid arguments do not grant consent.

Either `once` command explicitly consents to sending the **current prompt and selected, unredacted historical user/assistant text** to TypeSafe. The hook runs `mapContext()` → `prepareContext()` → `assessTask()`; routing additionally loads configuration, filters Pi candidates, calls pure `selectModel()`, then applies Pi's `setModel()` and `setThinkingLevel()`. Permission is consumed before I/O, even on failure or oversized input, and reset on session start/shutdown or tree navigation. Responses from cancelled/changed sessions or branches are ignored. No results or raw input are injected into the model transcript or stored as extension entries. Pi's own model-change entry is recorded when switching. Results appear as UI notifications (TUI/RPC); non-UI modes still perform an explicitly requested route but cannot show notifications.

## Configuration and safety

Routing needs both a `policy` and nonempty `options` in `~/.pi/agent/model-router.json` (or Pi's `PI_CODING_AGENT_DIR`) and/or a **trusted** `.pi/model-router.json`. See [configuration](configuration.md) and the uncalibrated [example](../examples/router.config.json). Invalid or unreadable configuration, no runtime-eligible options, unknown context usage, oversized current requests, assessment failure, `unclear` category, or high missing-evidence probability leave the current model unchanged. When no category-compatible model meets the required score, the best-scoring compatible option is chosen with a threshold-unmet warning. A failed switch does not change thinking level; if an error occurs *after* switching, inspect the current Pi model.

**Privacy:** opt-in is **not redaction**. Selected text can contain secrets; tool calls/results, system messages, thinking blocks, and image bytes are not sent by the context mapper, but selected user/assistant text, counts and omission notices are. Do not grant consent for material you do not want sent to TypeSafe. No automatic transmission is enabled. Jev instructions distinguish evidence from instructions, but prompt-injection resistance is not guaranteed.

**Quality:** weights and benchmark mappings are uncalibrated; DeepSWE measures coding, not all task categories. Context capacity uses Pi's usage estimate with a safety reserve; it is not a guarantee of provider acceptance. Neither cost nor score is verified at runtime. Tests exercise hooks, loader, eligibility, and selection without calling the real TypeSafe API; separate transport tests use a mocked SDK.
