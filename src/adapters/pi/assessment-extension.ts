import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRouterConfig } from "../config/config-schema.js";
import { loadModelRouterConfig } from "../config/load-config.js";
import type { RuntimeCandidate } from "./runtime-candidates.js";
import { getRuntimeCandidates } from "./runtime-candidates.js";
import { calculateWeightedDifficulty, isSubstantialReview, selectModel, type ReviewScope } from "../../application/use-cases/select-model.js";
import { getReviewScope } from "./review-scope.js";
import type { TaskAssessment } from "../../application/models/task-assessment.js";
import { prepareContext } from "../../application/use-cases/prepare-context.js";
import { assessTask } from "../../application/use-cases/assess-task.js";
import { resolveJudgmentBackend, type JudgmentBackend } from "./resolve-judgment-provider.js";
import { JudgmentProviderError } from "../../application/ports/judgment-provider.js";
import { mapContext } from "./map-context.js";
import { formatAssessmentStatus, ROUTER_AUTO_STATUS_KEY, ROUTER_STATUS_KEY, ROUTER_WIDGET_KEY } from "./format-status.js";

export interface RoutingAdapters {
  readonly loadConfig: (ctx: ExtensionContext) => Promise<ModelRouterConfig>;
  readonly candidates: (ctx: ExtensionContext, event: BeforeAgentStartEvent, config: ModelRouterConfig, signal?: AbortSignal) => Promise<RuntimeCandidate[]>;
  readonly reviewScope?: (cwd: string, base: string, signal: AbortSignal) => Promise<ReviewScope>;
}

const defaultRoutingAdapters: RoutingAdapters = {
  loadConfig: ctx => loadModelRouterConfig(ctx.cwd, ctx.isProjectTrusted()),
  candidates: (ctx, event, config, signal) => getRuntimeCandidates(config.options ?? [], ctx, event, signal),
  reviewScope: getReviewScope,
};

/** Provider and host adapters may be supplied for hook tests; production uses Pi and TypeSafe. */
export function createAssessmentExtension(
  resolveBackend: (ctx: ExtensionContext) => Promise<JudgmentBackend> = resolveJudgmentBackend,
  routing: RoutingAdapters = defaultRoutingAdapters,
  options: { readonly routingTimeoutMs?: number } = {},
): (pi: ExtensionAPI) => void {
  const routingTimeoutMs = options.routingTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(routingTimeoutMs) || routingTimeoutMs <= 0) throw new Error("Invalid routing deadline.");
  return (pi) => {
    let next: { intent: "assess" | "route"; recipient: JudgmentBackend["recipient"]; base?: string } | null = null;
    let automatic: { recipient: JudgmentBackend["recipient"]; sessionId: string | undefined } | null = null;
    let activeRun: AbortController | null = null;
    let routerSwitch: { provider: string; id: string } | null = null;
    let lastRouted: { provider: string; id: string; level: string } | null = null;
    // Pi emits thinking_level_select without awaiting it. Expected transitions may
    // arrive after setModel/setThinkingLevel resolves and routerSwitch is cleared.
    let expectedThinking: { previousLevel: string; level: string }[] = [];
    let seenDuringSwitch: { previousLevel: string; level: string }[] = [];
    let generation = 0;

    const reset = (ctx: ExtensionContext) => {
      generation += 1;
      next = null;
      automatic = null;
      lastRouted = null;
      expectedThinking = [];
      seenDuringSwitch = [];
      activeRun?.abort();
      activeRun = null;
      setAutoStatus(ctx);
      setStatus(ctx);
    };
    pi.on("session_start", (_event, ctx) => reset(ctx));
    pi.on("session_shutdown", (_event, ctx) => reset(ctx));
    pi.on("session_tree", (_event, ctx) => {
      // Tree navigation changes the active branch, not the session to which the
      // user consented. Invalidate old work, but retain the recipient-locked opt-in.
      if (automatic && (automatic.sessionId !== ctx.sessionManager.getSessionId() || !ctx.isProjectTrusted())) {
        reset(ctx);
        notify(ctx, "Automatic routing stopped: session or project trust changed.", "warning");
        return;
      }
      if (routerSwitch) {
        reset(ctx); // An already-started switch cannot safely be reconciled with navigation.
        notify(ctx, "Automatic routing stopped: tree navigation during a model switch; inspect Pi's active model.", "warning");
        return;
      }
      generation += 1;
      next = null;
      activeRun?.abort();
      activeRun = null;
      lastRouted = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, level: pi.getThinkingLevel() } : null;
      setStatus(ctx);
      // Keep the auto indicator and expected late events from a completed switch.
    });
    pi.on("model_select", (event, ctx) => {
      if (!automatic) return;
      if (event.source === "restore" && automatic.sessionId === ctx.sessionManager.getSessionId()) {
        lastRouted = { provider: event.model.provider, id: event.model.id, level: pi.getThinkingLevel() };
        return;
      }
      if (event.source === "set" && routerSwitch &&
          event.model.provider === routerSwitch.provider && event.model.id === routerSwitch.id) return;
      const inFlight = routerSwitch !== null;
      reset(ctx);
      notify(ctx, inFlight
        ? "Automatic routing stopped: manual model change during a router switch. Inspect Pi's active model; the pending switch may still complete."
        : "Automatic routing stopped: model changed outside the router. Enable it again to resume.", inFlight ? "warning" : "info");
    });
    pi.on("thinking_level_select", (event, ctx) => {
      if (!automatic) return;
      const matches = (change: { previousLevel: string; level: string }) =>
        change.previousLevel === event.previousLevel && change.level === event.level;
      if (routerSwitch) {
        const expected = expectedThinking.findIndex(matches);
        if (expected !== -1) expectedThinking.splice(expected, 1);
        else seenDuringSwitch.push({ previousLevel: event.previousLevel, level: event.level });
        return;
      }
      const index = expectedThinking.findIndex(matches);
      if (index !== -1) {
        expectedThinking.splice(index, 1);
        return;
      }
      reset(ctx);
      notify(ctx, "Automatic routing stopped: thinking level changed outside the router. Enable it again to resume.", "info");
    });

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
        const input = args.trim();
        if (input === "off") {
          reset(ctx);
          notify(ctx, "Model-router one-shot and automatic consent revoked.", "info");
          return;
        }
        const match = /^once(?: base=([a-zA-Z0-9][a-zA-Z0-9/_.-]*))?$/.exec(input);
        if (!match || (match[1] && (match[1].includes("..") || match[1].endsWith(".lock")))) {
          notify(ctx, "Usage: /model-router-route once [base=<ref>] | off. An explicit base measures local review scope for the next prompt only.", "info");
          return;
        }
        if (match[1] && !ctx.isProjectTrusted()) {
          notify(ctx, "Review preflight requires a trusted project. No consent granted.", "warning");
          return;
        }
        reset(ctx);
        const run = generation;
        try {
          const backend = await resolveBackend(ctx);
          if (generation !== run) return;
          next = { intent: "route", recipient: backend.recipient, ...(match[1] ? { base: match[1] } : {}) };
          notify(ctx, `Next prompt only: selected, unredacted conversation and current prompt may be sent via ${backend.recipient} to Jev; an eligible model may be selected. ${match[1] ? "Local Git review scope will be measured without sending file paths or contents to Jev." : "Uncalibrated policy."}`, "warning");
        } catch {
          if (generation === run) credentialsUnavailable(ctx, "Routing");
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
                `Future prompts and selected, unredacted user/assistant conversation text may be sent via ${backend.recipient} to Jev without further approval. Image counts and omission notices may be included, not image bytes or tool data. Jev may route each prompt to a configured coding model. The policy is uncalibrated; no results are stored by this extension. Use /model-router-auto off to stop. Consent continues across tree navigation within this session (including its other branches), but ends on a new session or extension reload.`,
                { timeout: 30_000 });
            } catch {
              if (generation === run) notify(ctx, "Automatic routing consent unavailable. No consent granted.", "warning");
              return;
            }
            if (!confirmed || generation !== run || ctx.sessionManager.getSessionId() !== sessionId || !ctx.isProjectTrusted()) return;
            automatic = { recipient: backend.recipient, sessionId };
            lastRouted = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, level: pi.getThinkingLevel() } : null;
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
      if (automatic && lastRouted && (ctx.model?.provider !== lastRouted.provider ||
          ctx.model?.id !== lastRouted.id || pi.getThinkingLevel() !== lastRouted.level)) {
        reset(ctx);
        notify(ctx, "Automatic routing stopped: model or thinking level changed outside the router.", "info");
        return;
      }
      const intent = pending.intent;
      next = null; // Consume one-shot permission before any asynchronous operation or error.
      activeRun?.abort(); // A newer prompt invalidates an older pending assessment.
      const runController = new AbortController();
      activeRun = runController;
      const run = ++generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      const turnSignal = ctx.signal;
      const abortWithTurn = () => runController.abort();
      turnSignal?.addEventListener("abort", abortWithTurn, { once: true });
      if (turnSignal?.aborted) runController.abort();
      let deadlineExpired = false;
      let switchStarted = false;
      let switchMarker: { provider: string; id: string } | null = null;
      const timer = setTimeout(() => { deadlineExpired = true; runController.abort(); }, routingTimeoutMs);
      // Race non-abortable host operations too; their late result cannot switch a model.
      const wait = <T>(start: () => Promise<T>): Promise<T> => {
        if (runController.signal.aborted) return Promise.reject(new Error("Routing interrupted."));
        return new Promise<T>((resolve, reject) => {
          const aborted = () => reject(new Error("Routing interrupted."));
          runController.signal.addEventListener("abort", aborted, { once: true });
          try {
            start().then(
              value => { runController.signal.removeEventListener("abort", aborted); resolve(value); },
              error => { runController.signal.removeEventListener("abort", aborted); reject(error); },
            );
          } catch (error) {
            runController.signal.removeEventListener("abort", aborted);
            reject(error);
          }
        });
      };
      const isCurrent = () => {
        if (generation !== run || runController.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId ||
            ctx.sessionManager.getLeafId() !== leafId) return false;
        if (automatic && !ctx.isProjectTrusted()) {
          reset(ctx);
          notify(ctx, "Automatic routing stopped: project trust changed. Current model unchanged.", "warning");
          return false;
        }
        return true;
      };
      try {
        if (!isCurrent()) return;
        setStatus(ctx);
        // Re-resolve before reading context; credentials may have changed since consent.
        const backend = await wait(() => resolveBackend(ctx));
        if (!isCurrent()) return;
        if (backend.recipient !== pending.recipient) {
          if (automatic) reset(ctx);
          notify(ctx, "Model-router recipient changed since consent; consent again. Current model unchanged.", "warning");
          return;
        }
        let candidates: RuntimeCandidate[] = [];
        let config: ModelRouterConfig | undefined;
        if (intent === "route") {
          const routeConfig = await wait(() => routing.loadConfig(ctx));
          config = routeConfig;
          if (!isCurrent()) return;
          if (!routeConfig.policy || !routeConfig.options?.length) {
            if (automatic) reset(ctx);
            notify(ctx, "Model-router route skipped: configure both policy and options. Current model unchanged.", "warning");
            return;
          }
          candidates = await wait(() => routing.candidates(ctx, event, routeConfig, runController.signal));
          if (!isCurrent()) return;
          if (candidates.length === 0) {
            const unknownUsage = ctx.getContextUsage()?.tokens == null;
            notify(ctx, unknownUsage
              ? "Model-router route skipped: Pi context usage is unknown (for example, after compaction). Current model unchanged."
              : "Model-router route skipped: no runtime-eligible models. Current model unchanged.", "warning");
            return;
          }
        }
        let reviewScope: ReviewScope | undefined;
        if (intent === "route" && pending.base) {
          if (!ctx.isProjectTrusted() || !config?.policy?.substantialReview || !routing.reviewScope) {
            notify(ctx, "Review preflight unavailable; no assessment sent and model unchanged.", "warning");
            return;
          }
          try {
            reviewScope = await wait(() => routing.reviewScope!(ctx.cwd, pending.base!, runController.signal));
          } catch {
            if (runController.signal.aborted) throw new Error("Routing interrupted.");
            notify(ctx, "Review preflight could not measure the local diff; no assessment sent and model unchanged.", "warning");
            return;
          }
          if (!isCurrent()) return;
          if (!ctx.isProjectTrusted()) {
            notify(ctx, "Review preflight stopped: project trust changed. Current model unchanged.", "warning");
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
        const assessment: TaskAssessment = await wait(() =>
          assessTask(prepared.context, backend.provider, { signal: runController.signal }));
        if (!isCurrent()) return;
        // Assessment-only tolerates absent/invalid routing configuration: no policy means no weighted score.
        if (intent === "assess") {
          try {
            config = await wait(() => routing.loadConfig(ctx));
          } catch {
            if (runController.signal.aborted) throw new Error("Routing interrupted.");
            // The five judgments are still useful without a configured routing policy.
          }
          if (!isCurrent()) return;
        }
        // Never put results or raw input into the model-facing transcript.
        const weightedDifficulty = config?.policy
          ? calculateWeightedDifficulty(assessment, config.policy) : undefined;
        setStatus(ctx, formatAssessmentStatus(assessment, weightedDifficulty));
        if (intent === "assess") return;
        if (reviewScope && assessment.workCategory.choice === "review" &&
            config!.policy!.substantialReview && isSubstantialReview(reviewScope, config!.policy!.substantialReview)) {
          notify(ctx, `Substantial review scope (${reviewScope.changedFiles} files, ${reviewScope.changedLines} changed lines, ${reviewScope.directories} directories): configured review tier applied.`, "info");
        }
        const decision = selectModel(assessment, candidates.map(c => c.option), config!.policy!, reviewScope);
        if (decision.status === "unchanged") {
          notify(ctx, `Model-router route unchanged (${decision.reason}); no model switched.`, "warning");
          return;
        }
        const selected = candidates.find(c => c.option.id === decision.option.id)!;
        if (!isCurrent()) return;
        if (pending.base && !ctx.isProjectTrusted()) {
          notify(ctx, "Review routing stopped: project trust changed. Current model unchanged.", "warning");
          return;
        }
        switchStarted = true;
        const levelBeforeSwitch = pi.getThinkingLevel();
        seenDuringSwitch = [];
        const rememberTransition = (previousLevel: string, level: string) => {
          if (!automatic || previousLevel === level) return;
          const seen = seenDuringSwitch.findIndex(change =>
            change.previousLevel === previousLevel && change.level === level);
          if (seen !== -1) seenDuringSwitch.splice(seen, 1);
          else expectedThinking.push({ previousLevel, level });
        };
        switchMarker = { provider: selected.model.provider, id: selected.model.id };
        routerSwitch = switchMarker;
        const success = await wait(() => pi.setModel(selected.model));
        // setModel itself appends a session entry and changes the leaf ID.
        if (generation !== run || runController.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) return;
        if (!success) {
          if (automatic) reset(ctx);
          notify(ctx, "Model-router route failed: selected model unavailable. Current model unchanged.", "warning");
          return;
        }
        const levelAfterModel = pi.getThinkingLevel();
        rememberTransition(levelBeforeSwitch, levelAfterModel);
        pi.setThinkingLevel(selected.option.thinkingLevel);
        rememberTransition(levelAfterModel, pi.getThinkingLevel());
        if (ctx.model?.provider !== selected.model.provider || ctx.model?.id !== selected.model.id ||
            pi.getThinkingLevel() !== selected.option.thinkingLevel) {
          if (automatic) reset(ctx);
          notify(ctx, "Model-router route could not confirm model/thinking level; inspect the current Pi model.", "warning");
          return;
        }
        if (automatic) lastRouted = { provider: selected.model.provider, id: selected.model.id, level: selected.option.thinkingLevel };
        if (decision.status === "threshold-unmet") {
          notify(ctx, `Model-router threshold unmet by ${decision.shortfall.toFixed(2)} points; fallback applied.`, "warning");
        }
      } catch {
        // No error messages/causes: projection and remote errors can contain prompt text.
        if (generation === run && deadlineExpired && ctx.sessionManager.getSessionId() === sessionId) {
          if (automatic) reset(ctx);
          notify(ctx, switchStarted
            ? "Model-router timed out during model switching; the switch may still complete. Inspect Pi's active model."
            : "Model-router timed out; current model unchanged. Automatic consent, if enabled, was revoked.", "warning");
        } else if ((switchStarted && generation === run && !runController.signal.aborted &&
                    ctx.sessionManager.getSessionId() === sessionId) || isCurrent()) {
          if (automatic) reset(ctx); // Re-consent before retrying after an unexpected automatic failure.
          notify(ctx, switchStarted
            ? "Model-router route failed during model switching; inspect Pi's active model and thinking level."
            : intent === "route"
              ? "Model-router route failed; current model unchanged."
              : "Model-router assessment failed; current model unchanged.", "warning");
        }
      } finally {
        clearTimeout(timer);
        turnSignal?.removeEventListener("abort", abortWithTurn);
        if (activeRun === runController) activeRun = null;
        if (routerSwitch === switchMarker) routerSwitch = null;
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
  if (ctx.mode === "tui") {
    if (!ctx.hasUI) return;
    // Keep the result independent of whichever footer a UI extension installs.
    ctx.ui.setStatus(ROUTER_STATUS_KEY, undefined);
    ctx.ui.setWidget(ROUTER_WIDGET_KEY, text ? [text] : undefined, { placement: "aboveEditor" });
  } else if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.setStatus(ROUTER_STATUS_KEY, text);
  } else if (text && (ctx.mode === "json" || ctx.mode === "print" || !ctx.hasUI)) {
    // Preserve JSON/print stdout for their machine-readable or prompted output.
    process.stderr.write(`${text}\n`);
  }
}

function setAutoStatus(ctx: ExtensionContext, recipient?: JudgmentBackend["recipient"]): void {
  if (ctx.hasUI) ctx.ui.setStatus(ROUTER_AUTO_STATUS_KEY, recipient ? `Router auto: ${recipient}` : undefined);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
