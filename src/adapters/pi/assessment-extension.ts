import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRouterConfig } from "../config/config-schema.js";
import { loadModelRouterConfig } from "../config/load-config.js";
import type { RuntimeCandidate } from "./runtime-candidates.js";
import { getRuntimeCandidates } from "./runtime-candidates.js";
import { calculateWeightedDifficulty, selectModel } from "../../application/use-cases/select-model.js";
import type { TaskAssessment } from "../../application/models/task-assessment.js";
import { prepareContext } from "../../application/use-cases/prepare-context.js";
import { assessTask } from "../../application/use-cases/assess-task.js";
import { resolveJudgmentBackend, type JudgmentBackend } from "./resolve-judgment-provider.js";
import { JudgmentProviderError } from "../../application/ports/judgment-provider.js";
import { mapContext } from "./map-context.js";
import { formatAssessmentStatus, ROUTER_AUTO_STATUS_KEY, ROUTER_STATUS_KEY } from "./format-status.js";

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
  resolveBackend: (ctx: ExtensionContext) => Promise<JudgmentBackend> = resolveJudgmentBackend,
  routing: RoutingAdapters = defaultRoutingAdapters,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let next: { intent: "assess" | "route"; recipient: JudgmentBackend["recipient"] } | null = null;
    let automatic: { recipient: JudgmentBackend["recipient"]; sessionId: string | undefined } | null = null;
    let activeAssessment: AbortController | null = null;
    let generation = 0;

    const reset = (ctx: ExtensionContext) => {
      generation += 1;
      next = null;
      automatic = null;
      activeAssessment?.abort();
      activeAssessment = null;
      setAutoStatus(ctx);
      setStatus(ctx);
    };
    pi.on("session_start", (_event, ctx) => reset(ctx));
    pi.on("session_shutdown", (_event, ctx) => reset(ctx));
    pi.on("session_tree", (_event, ctx) => reset(ctx));

    pi.registerCommand("model-router-assess", {
      description: "Consent to assess the next prompt with Jev (sends selected unredacted conversation via OpenRouter or TypeSafe); or cancel with off",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "once": {
            reset(ctx);
            const run = generation;
            try {
              const backend = await resolveBackend(ctx);
              if (generation !== run) break;
              next = { intent: "assess", recipient: backend.recipient };
              notify(ctx, `Next prompt only: selected, unredacted conversation and current prompt will be sent via ${backend.recipient} to Jev for assessment. No model will be switched.`, "warning");
            } catch {
              if (generation === run) credentialsUnavailable(ctx, "Assessment");
            }
            break;
          }
          case "off":
            reset(ctx);
            notify(ctx, "Model-router one-shot and automatic consent revoked.", "info");
            break;
          default:
            notify(ctx, "Usage: /model-router-assess once | off. Default is off. 'once' may send selected, unredacted conversation and the next prompt via OpenRouter or TypeSafe.", "info");
        }
      },
    });

    pi.registerCommand("model-router-route", {
      description: "Consent to assess the next prompt with Jev and select a configured model (one prompt only)",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "once": {
            reset(ctx);
            const run = generation;
            try {
              const backend = await resolveBackend(ctx);
              if (generation !== run) break;
              next = { intent: "route", recipient: backend.recipient };
              notify(ctx, `Next prompt only: selected, unredacted conversation and current prompt may be sent via ${backend.recipient} to Jev; an eligible configured model and thinking level may be selected. Uncalibrated policy.`, "warning");
            } catch {
              if (generation === run) credentialsUnavailable(ctx, "Routing");
            }
            break;
          }
          case "off":
            reset(ctx);
            notify(ctx, "Model-router one-shot and automatic consent revoked.", "info");
            break;
          default:
            notify(ctx, "Usage: /model-router-route once | off. Default is off. 'once' may send unredacted context via OpenRouter or TypeSafe and switch the model for the next prompt.", "info");
        }
      },
    });

    pi.registerCommand("model-router-auto", {
      description: "Enable session-only automatic routing with explicit confirmation, or revoke it with off",
      handler: async (args, ctx) => {
        switch (args.trim()) {
          case "on": {
            reset(ctx); // Supersedes one-shot consent and cancels any in-flight assessment.
            const run = generation;
            const sessionId = ctx.sessionManager.getSessionId();
            if (!ctx.hasUI) {
              throw new JudgmentProviderError("invalid-request", "Automatic routing requires an interactive consent UI. No consent granted.");
            }
            if (!ctx.isProjectTrusted()) {
              notify(ctx, "Automatic routing requires a trusted project. No consent granted.", "warning");
              return;
            }
            let backend: JudgmentBackend;
            try {
              backend = await resolveBackend(ctx);
            } catch {
              if (generation === run) credentialsUnavailable(ctx, "Automatic routing");
              return;
            }
            if (generation !== run || ctx.sessionManager.getSessionId() !== sessionId) return;
            try {
              const config = await routing.loadConfig(ctx);
              if (generation !== run || ctx.sessionManager.getSessionId() !== sessionId) return;
              if (!config.policy || !config.options?.length) {
                notify(ctx, "Automatic routing requires a configured policy and options. No consent granted.", "warning");
                return;
              }
            } catch {
              if (generation === run) notify(ctx, "Automatic routing configuration unavailable. No consent granted.", "warning");
              return;
            }
            let confirmed = false;
            try {
              confirmed = await ctx.ui.confirm("Enable automatic routing for this session?",
                `Future prompts and selected, unredacted user/assistant conversation text may be sent via ${backend.recipient} to Jev without further approval. Image counts and omission notices may be included, not image bytes or tool data. Jev may route each prompt to a configured coding model. The policy is uncalibrated; no results are stored by this extension. Use /model-router-auto off to stop. Consent ends on session/tree changes or extension reload.`,
                { timeout: 30_000 });
            } catch {
              if (generation === run) notify(ctx, "Automatic routing consent unavailable. No consent granted.", "warning");
              return;
            }
            if (!confirmed || generation !== run || ctx.sessionManager.getSessionId() !== sessionId || !ctx.isProjectTrusted()) return;
            automatic = { recipient: backend.recipient, sessionId };
            setAutoStatus(ctx, backend.recipient);
            notify(ctx, `Automatic routing enabled for this session via ${backend.recipient}. Unredacted context may be sent on future prompts; /model-router-auto off revokes consent.`, "warning");
            break;
          }
          case "off":
            reset(ctx);
            notify(ctx, "Model-router automatic and one-shot consent revoked.", "info");
            break;
          default:
            notify(ctx, "Usage: /model-router-auto on | off. 'on' requires explicit session consent to send future unredacted prompts and selected history to Jev.", "info");
        }
      },
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const pending = next ?? (automatic ? { intent: "route" as const, recipient: automatic.recipient } : null);
      if (!pending) return;
      if (automatic && (!ctx.isProjectTrusted() || automatic.sessionId !== ctx.sessionManager.getSessionId())) {
        reset(ctx);
        notify(ctx, "Automatic routing stopped: session or project trust changed. Current model unchanged.", "warning");
        return;
      }
      const intent = pending.intent;
      next = null; // Consume one-shot permission before any asynchronous operation or error.
      activeAssessment?.abort(); // A newer prompt invalidates an older pending assessment.
      activeAssessment = null;
      const run = ++generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const isCurrent = () => {
        if (generation !== run || ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId ||
            ctx.sessionManager.getLeafId() !== leafId) return false;
        if (automatic && !ctx.isProjectTrusted()) {
          reset(ctx);
          notify(ctx, "Automatic routing stopped: project trust changed. Current model unchanged.", "warning");
          return false;
        }
        return true;
      };
      if (!isCurrent()) return;
      setStatus(ctx);

      try {
        // Re-resolve before reading context; credentials may have changed since consent.
        const backend = await resolveBackend(ctx);
        if (!isCurrent()) return;
        if (backend.recipient !== pending.recipient) {
          if (automatic) reset(ctx);
          notify(ctx, "Model-router recipient changed since consent; consent again. Current model unchanged.", "warning");
          return;
        }
        let candidates: RuntimeCandidate[] = [];
        let config: ModelRouterConfig | undefined;
        if (intent === "route") {
          config = await routing.loadConfig(ctx);
          if (!isCurrent()) return;
          if (!config.policy || !config.options?.length) {
            if (automatic) reset(ctx);
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
        const controller = new AbortController();
        activeAssessment = controller;
        const turnSignal = ctx.signal;
        const abortWithTurn = () => controller.abort();
        turnSignal?.addEventListener("abort", abortWithTurn, { once: true });
        if (turnSignal?.aborted) controller.abort();
        let assessment: TaskAssessment;
        try {
          assessment = await assessTask(prepared.context, backend.provider, { signal: controller.signal });
        } finally {
          turnSignal?.removeEventListener("abort", abortWithTurn);
          if (activeAssessment === controller) activeAssessment = null;
        }
        if (!isCurrent()) return;
        // Assessment-only tolerates absent/invalid routing configuration: no policy means no weighted score.
        if (intent === "assess") {
          try {
            config = await routing.loadConfig(ctx);
          } catch {
            // The five judgments are still useful without a configured routing policy.
          }
          if (!isCurrent()) return;
        }
        // Never put results or raw input into the model-facing transcript.
        const weightedDifficulty = config?.policy
          ? calculateWeightedDifficulty(assessment, config.policy) : undefined;
        setStatus(ctx, formatAssessmentStatus(assessment, weightedDifficulty));
        if (intent === "assess") return;
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
          if (automatic) reset(ctx);
          notify(ctx, "Model-router route failed: selected model unavailable. Current model unchanged.", "warning");
          return;
        }
        pi.setThinkingLevel(selected.option.thinkingLevel);
        if (ctx.model?.provider !== selected.model.provider || ctx.model?.id !== selected.model.id ||
            pi.getThinkingLevel() !== selected.option.thinkingLevel) {
          if (automatic) reset(ctx);
          notify(ctx, "Model-router route could not confirm model/thinking level; inspect the current Pi model.", "warning");
          return;
        }
        if (decision.status === "threshold-unmet") {
          notify(ctx, `Model-router threshold unmet by ${decision.shortfall.toFixed(2)} points; fallback applied.`, "warning");
        }
      } catch {
        // No error messages/causes: projection and remote errors can contain prompt text.
        if (isCurrent()) {
          if (automatic) reset(ctx); // Re-consent before retrying after an unexpected automatic failure.
          notify(ctx, intent === "route"
            ? "Model-router route failed; inspect the current Pi model before proceeding."
            : "Model-router assessment failed; current model unchanged.", "warning");
        }
      }
    });
  };
}

function credentialsUnavailable(ctx: ExtensionContext, operation: string): void {
  const message = `${operation} unavailable: configure OpenRouter in Pi, OPENROUTER_API_KEY, or TYPESAFE_API_KEY. No consent granted.`;
  if (!ctx.hasUI) throw new JudgmentProviderError("unauthorized", message);
  notify(ctx, message, "warning");
}

function setStatus(ctx: ExtensionContext, text?: string): void {
  if (ctx.hasUI) ctx.ui.setStatus(ROUTER_STATUS_KEY, text);
}

function setAutoStatus(ctx: ExtensionContext, recipient?: JudgmentBackend["recipient"]): void {
  if (ctx.hasUI) ctx.ui.setStatus(ROUTER_AUTO_STATUS_KEY, recipient ? `Router auto: ${recipient}` : undefined);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
