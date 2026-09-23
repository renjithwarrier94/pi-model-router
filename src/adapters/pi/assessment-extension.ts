import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../application/ports/judgment-provider.js";
import { prepareContext } from "../../application/use-cases/prepare-context.js";
import { assessTask } from "../../application/use-cases/assess-task.js";
import { JevJudgmentProvider } from "../typesafe/jev-judgment-provider.js";
import { mapContext } from "./map-context.js";

/** Allow a mocked provider for host-hook tests; default is the production adapter. */
export function createAssessmentExtension(
  createProvider: () => JudgmentProvider = () => new JevJudgmentProvider(),
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let approvedOnce = false;
    let generation = 0;

    const reset = () => {
      generation += 1;
      approvedOnce = false;
    };
    pi.on("session_start", reset);
    pi.on("session_shutdown", reset);
    pi.on("session_tree", reset);

    pi.registerCommand("model-router-assess", {
      description: "Consent to assess the next prompt with Jev (sends selected unredacted conversation to TypeSafe); or cancel with off",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "once":
            approvedOnce = true;
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

    pi.on("before_agent_start", async (event, ctx) => {
      if (!approvedOnce) return;
      approvedOnce = false; // Consume permission before any asynchronous operation or error.
      const run = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const isCurrent = () => generation === run && !ctx.signal?.aborted
        && ctx.sessionManager.getSessionId() === sessionId
        && ctx.sessionManager.getLeafId() === leafId;
      if (!isCurrent()) return;

      try {
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
        notify(ctx, `Assessment only (model unchanged): ${assessment.workCategory.choice}; reasoning ${assessment.reasoningDemand.score.toFixed(2)}/2; scope ${assessment.dependencyScope.score.toFixed(2)}/2; integration ${assessment.contextIntegrationDemand.score.toFixed(2)}/2; missing critical evidence P(yes) ${assessment.missingCriticalEvidence.probability.toFixed(2)}.`, "info");
      } catch {
        // No error messages/causes: projection and remote errors can contain prompt text.
        if (isCurrent()) notify(ctx, "Model-router assessment failed; current model unchanged.", "warning");
      }
    });
  };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
