---
name: model-router-config
description: Create or update a Pi Model Router model-router.json from user-supplied models and thinking levels. Research DeepSWE scores and per-task costs, choose categories and a generalist, and validate the finished configuration.
disable-model-invocation: true
---

# Configure the Pi Model Router

This skill ships **with the pi-prompt-router package**. Resolve paths relative to this `SKILL.md`; the package root is `../..`. Read the package root's `docs/configuration.md` and `examples/router.config.json` before preparing a file. The validator is `scripts/validate-config.ts` under that package root. Do not change the router's schema or policy without an explicit request.

## Gather inputs and establish scope

1. Ask for exact Pi `provider/model` IDs and **each** requested thinking level per model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and the destination: global Pi agent directory (`${PI_CODING_AGENT_DIR:-~/.pi/agent}/model-router.json`) or a trusted project's `.pi/model-router.json`. Expand the home path before writing. If IDs/levels are missing, ask; don't guess from display names. `pi --list-models` can check model identity, but not guarantee credential availability or support for every thinking level. Do not access or print API keys. Each provider/model/level is a separate option with a stable unique ID.
2. Read the destination if present. A project `options` list replaces global options, while an omitted project `policy` inherits the global policy; a policy is replaced as a unit. This skill produces a **complete self-contained config** (nonempty `options`, `policy`, exactly one generalist option), because the bundled validator checks a complete config rather than a partial override. Preserve existing policy only if it remains valid with the new option IDs. If the destination already has options, ask whether to replace or retain them; do not silently discard them.
3. Do not write to a live config while researching. Do not enable automatic routing. Agree on any new or altered policy with the user: use their supplied policy, preserve a valid existing one, or **offer** the example's explicitly uncalibrated weights, difficulty curve, evidence gate, and review tier for their approval. Never present illustrative policy numbers as measured facts. If the allowed review option IDs disappear, update that tier with explicit user approval or remove the optional tier with approval. The validator will reject broken references.

## Research each option; record evidence before assigning numbers

4. Use an available web-search/browsing tool to research an **exact model, exact thinking level, and same DeepSWE benchmark/version**. Do not rely on remembered prices or benchmark results. Prefer official benchmark tables or the benchmark maintainer; cross-check with provider documentation. Capture the source URL, publication/access date, benchmark version, score as percentage points [0,100], and exact model/effort identity. Do not substitute another model, effort level, benchmark, or a model-family average. Do not convert an unrelated score into `deepSweScore`. If no comparable figure exists, stop and explain the gap; ask the user for comparable measured scores or whether to omit the option. Clearly label user-supplied estimates and their origin in the **review table**, not in the JSON (the schema rejects extra keys). Never invent a score.
5. For `costPerTaskUsd`, look for **observed per-task cost** for that same model/level/workload first. Otherwise find official, dated input/output pricing and ask the user for one **shared representative workload** (billable input/output tokens per task, and cache/other billing assumptions). Calculate for every option using the same workload: `sum(billableTokensInClass * usdPerMillionForClass) / 1_000_000` (ordinary input, cached input, output, and other billed classes as applicable). Count reasoning tokens in the billed class specified by the provider. Show the inputs, source URLs, arithmetic, date, and whether the figure is an estimate. Pricing per million tokens is NOT cost per task; never copy it directly. If the price or task volume is unknown, ask rather than insert zero or invent a value. Keep USD amounts unrounded enough to distinguish options; do not claim cross-provider comparability unless the workload is consistent.
6. Recommend categories (`explain`, `implement`, `diagnose`, `review`, `design`, `research`) from documented capabilities and cited evidence; label these **recommendations**, not benchmark results. Ask the user to confirm categories. Exactly one option must use `["general"]` alone. If the user has not **already explicitly designated a particular model + thinking level** as generalist, ask which exact combination should be the generalist **before finalizing**, even if you have a preferred recommendation. Do not choose one silently. Present the option IDs, provider/model/level, scores, costs, categories, and evidence links together for review. Do not persist sources or private conversation text inside router JSON; unknown properties are rejected.

## Create, validate, and hand off

7. Draft strict version-1 JSON with `options` and `policy`, no extra keys. Show proposed changes, identify missing/unverified evidence and illustrative policy choices, and ask for approval before replacing an existing live config. Write the approved draft to a separate file first (outside the active global/project config). Do not copy secrets, credentials, or raw research notes into it.
8. Run the **offline deterministic** validator with an **absolute path**:

   ```sh
   npm --prefix /absolute/path/to/pi-prompt-router run config:validate -- /absolute/path/to/draft.json
   ```

   Obtain the package root from this skill directory (`../..`), not from the user's working directory. Fix any errors and rerun. The script checks strict router schema, policy/review references, a nonempty list, and exactly one generalist; it **cannot verify benchmark claims, price sources, Pi credentials, live thinking-level availability, or routing quality**. Do not represent a pass as proof of these claims.
9. Only after successful validation and approval, place the draft at the agreed destination (back up a pre-existing file first with user approval), run the same validator on the final path, and report its output and the evidence gaps. If the user declines a required input, do not create a plausible-looking config. Remind the user that runtime availability is filtered by Pi and automatic routing stays off until they opt in.
