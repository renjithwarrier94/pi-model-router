# Pi Model Router

A Pi extension that uses Jev to assess a prompt and choose a configured coding model. Routing is off by default.

## Set up

1. Clone this repository. From its root, install dependencies and run the following setup commands:
   ```bash
   npm install
   ```
2. Add the local package to Pi (use the repository's absolute path):
   ```bash
   pi install /absolute/path/to/prompt-router
   ```
   For a one-time trial instead, run `pi --extension /absolute/path/to/prompt-router/src/index.ts` from any directory.
3. Set up Jev credentials: sign in to OpenRouter in Pi with `/login openrouter`, or set `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`. The router prefers Pi's OpenRouter credentials, then the OpenRouter environment variable, then TypeSafe.
4. Create your routing config:
   ```bash
   mkdir -p ~/.pi/agent
   cp examples/router.config.json ~/.pi/agent/model-router.json
   ```
   Edit the options to match **models available in your Pi** (`pi --list-models`). Set their provider, model ID, thinking level, cost, and capability scores. The example's scores, costs, and policy are illustrative, not calibrated. You can instead use `.pi/model-router.json` in a trusted project; see [configuration](docs/configuration.md) for precedence and format. Make sure Pi can access the coding models you configure.

## Commands in Pi

| Command | Effect |
| --- | --- |
| `/model-router-assess once` | Assess the **next prompt** and show the judgments; do not switch models. |
| `/model-router-route once` | Assess the **next prompt** and choose a model/thinking level. |
| `/model-router-route once base=main` | For the **next prompt only**, measure local branch-review scope against an explicit base and apply the configured review tier if substantial. Requires a trusted Git repository root and `substantialReview` policy; does not detect skill names. |
| `/model-router-auto on` | Ask for confirmation, then route subsequent prompts in this session (trusted project and interactive UI required). |
| `/model-router-auto off` | Stop automatic routing and cancel pending one-shot permission. |

`/model-router-assess off` and `/model-router-route off` also cancel permission. One-shot commands replace auto mode; a manual model or thinking-level change stops auto mode. To resume, run `/model-router-auto on` and confirm again. A one-shot route changes the active Pi model until you change it again.

**Privacy:** With consent, Jev receives selected **unredacted** user/assistant text and the current prompt via OpenRouter or TypeSafe. Auto mode covers future prompts without asking again. Do not use it for sensitive conversations. Details and limits: [Pi assessment and routing](docs/pi-assessment.md).
