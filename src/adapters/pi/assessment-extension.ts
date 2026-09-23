import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRouterConfig } from "../config/config-schema.js";
import { loadModelRouterConfig } from "../config/load-config.js";
import type { RuntimeCandidate } from "./runtime-candidates.js";
import { getRuntimeCandidates } from "./runtime-candidates.js";
import { selectModel } from "../../application/use-cases/select-model.js";
import type { JudgmentProvider } from "../../application/ports/judgment-provider.js";
import { prepareContext } from "../../application/use-cases/prepare-context.js";
import { assessTask } from "../../application/use-cases/assess-task.js";
import { JevJudgmentProvider } from "../typesafe/jev-judgment-provider.js";
import { mapContext } from "./map-context.js";

export interface RoutingAdapters {
  readonly loadConfig: (ctx: ExtensionContext) => Promise<ModelRouterConfig>;
  readonly candidates: (ctx: ExtensionContext, event: BeforeAgentStartEvent, config: ModelRouterConfig) => Promise<RuntimeCandidate[]>;
}

const defaultRoutingAdapters: RoutingAdapters = {
  loadConfig: ctx => loadModelRouterConfig(ctx.cwd, ctx.isProjectTrusted()),
  candidates: (ctx, event, config) => getRuntimeCandidates(config.options ?? [], ctx, event),
};

/** Provider and host adapters may be supplied for hook tests; production uses Pi and TypeSafe. */
export function createAssessmentExtension(
  createProvider: () => JudgmentProvider = () => new JevJudgmentProvider(),
  routing: RoutingAdapters = defaultRoutingAdapters,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let next: "assess" | "route" | null = null;
    let generation = 0;

    const reset = () => {
      generation += 1;
      next = null;
    };
    pi.on("session_start", reset);
    pi.on("session_shutdown", reset);
    pi.on("session_tree", reset);

    pi.registerCommand("model-router-assess", {
      description: "Consent to assess the next prompt with Jev (sends selected unredacted conversation to TypeSafe); or cancel with off",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "once":
            next = "assess";
            generation += 1;
            notify(ctx, "Next prompt only: selected, unredacted conversation and current prompt will be sent to TypeSafe for assessment. No model will be switched.", "warning");
            break;
          case "off":
            reset();
            notify(ctx, "Model-router assessment consent cancelled.", "info");
            break;
          default:
            notify(ctx, "Usage: /model-router-assess once | off. Default is off. 'once' sends selected, unredacted conversation and the next prompt to TypeSafe.", "info");
        }
      },
    });

    pi.registerCommand("model-router-route", {
      description: "Consent to assess the next prompt with Jev and select a configured model (one prompt only)",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "once":
            next = "route";
            generation += 1;
            notify(ctx, "Next prompt only: selected, unredacted conversation and current prompt may be sent to TypeSafe; an eligible configured model and thinking level may be selected. Uncalibrated policy.", "warning");
            break;
          case "off":
            reset();
            notify(ctx, "Model-router route consent cancelled.", "info");
            break;
          default:
            notify(ctx, "Usage: /model-router-route once | off. Default is off. 'once' may send unredacted context to TypeSafe and switch the model for the next prompt.", "info");
        }
      },
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const intent = next;
      if (!intent) return;
      next = null; // Consume permission before any asynchronous operation or error.
      const run = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const isCurrent = () => generation === run && !ctx.signal?.aborted
        && ctx.sessionManager.getSessionId() === sessionId
        && ctx.sessionManager.getLeafId() === leafId;
      if (!isCurrent()) return;

      try {
        let candidates: RuntimeCandidate[] = [];
        let config: ModelRouterConfig | undefined;
        if (intent === "route") {
          config = await routing.loadConfig(ctx);
          if (!isCurrent()) return;
          if (!config.policy || !config.options?.length) {
            notify(ctx, "Model-router route skipped: configure both policy and options. Current model unchanged.", "warning");
            return;
          }
          candidates = await routing.candidates(ctx, event, config);
          if (!isCurrent()) return;
          if (candidates.length === 0) {
            notify(ctx, "Model-router route skipped: no runtime-eligible models. Current model unchanged.", "warning");
            return;
          }
        }
        const snapshot = mapContext(event, ctx.sessionManager);
        const prepared = prepareContext(snapshot);
        if (!isCurrent()) return;
        if (prepared.status === "skipped") {
          notify(ctx, "Model-router assessment skipped: current request exceeds context limits. Current model unchanged.", "warning");
          return;
        }
        const provider = createProvider();
        const assessment = await assessTask(prepared.context, provider, ctx.signal ? { signal: ctx.signal } : undefined);
        if (!isCurrent()) return;
        // Never put results or raw input into the model-facing transcript.
        if (intent === "assess") {
          notify(ctx, `Assessment only (model unchanged): ${assessment.workCategory.choice}; reasoning ${assessment.reasoningDemand.score.toFixed(2)}/2; scope ${assessment.dependencyScope.score.toFixed(2)}/2; integration ${assessment.contextIntegrationDemand.score.toFixed(2)}/2; missing critical evidence P(yes) ${assessment.missingCriticalEvidence.probability.toFixed(2)}.`, "info");
          return;
        }
        const decision = selectModel(assessment, candidates.map(c => c.option), config!.policy!);
        if (decision.status === "unchanged") {
          notify(ctx, `Model-router route unchanged (${decision.reason}); no model switched.`, "warning");
          return;
        }
        const selected = candidates.find(c => c.option.id === decision.option.id)!;
        if (!isCurrent()) return;
        const success = await pi.setModel(selected.model);
        // setModel itself appends a session entry and changes the leaf ID.
        if (generation !== run || ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId) return;
        if (!success) {
          notify(ctx, "Model-router route failed: selected model unavailable. Current model unchanged.", "warning");
          return;
        }
        pi.setThinkingLevel(selected.option.thinkingLevel);
        if (ctx.model?.provider !== selected.model.provider || ctx.model?.id !== selected.model.id ||
            pi.getThinkingLevel() !== selected.option.thinkingLevel) {
          notify(ctx, "Model-router route could not confirm model/thinking level; inspect the current Pi model.", "warning");
          return;
        }
        const shortfall = decision.status === "threshold-unmet"
          ? `; threshold unmet by ${decision.shortfall.toFixed(2)} points` : "";
        notify(ctx, `Model-router route (uncalibrated): ${JSON.stringify(selected.option.id)} at ${selected.option.thinkingLevel}; difficulty ${decision.difficulty.toFixed(2)}, required score ${decision.requiredDeepSweScore.toFixed(2)}${shortfall}.`, decision.status === "threshold-unmet" ? "warning" : "info");
      } catch {
        // No error messages/causes: projection and remote errors can contain prompt text.
        if (isCurrent()) notify(ctx, intent === "route"
          ? "Model-router route failed; inspect the current Pi model before proceeding."
          : "Model-router assessment failed; current model unchanged.", "warning");
      }
    });
  };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
