import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateContextCapacity } from "./estimate-context-capacity.js";
import type { ModelOption } from "../../domain/model-option.js";

export interface RuntimeCandidate {
  readonly option: ModelOption;
  readonly model: Model<any>;
}

export interface RuntimeCandidateResult {
  readonly candidates: RuntimeCandidate[];
  readonly capacitySource: "pi" | "estimated" | "unavailable";
}

/** List-only compatibility entry point for callers not displaying capacity diagnostics. */
export async function getRuntimeCandidates(
  options: readonly ModelOption[], ctx: ExtensionContext, event: BeforeAgentStartEvent, signal?: AbortSignal,
  getTools?: () => readonly ToolInfo[],
): Promise<RuntimeCandidate[]> {
  return (await inspectRuntimeCandidates(options, ctx, event, signal, getTools)).candidates;
}

/** Fail closed on unavailable capacity/auth information. All estimation is local. */
export async function inspectRuntimeCandidates(
  options: readonly ModelOption[], ctx: ExtensionContext, event: BeforeAgentStartEvent, signal?: AbortSignal,
  getTools?: () => readonly ToolInfo[],
): Promise<RuntimeCandidateResult> {
  let capacitySource: RuntimeCandidateResult["capacitySource"] = "unavailable";
  const empty = (): RuntimeCandidateResult => ({ candidates: [], capacitySource });
  const aborted = () => signal?.aborted || ctx.signal?.aborted;
  if (aborted()) return empty();
  let capacityNeeded: number, imageCount = 0, maxImagesPerMessage = 0;
  try {
    const usage = ctx.getContextUsage();
    const projection = ctx.sessionManager.buildSessionProjection();
    if (usage?.tokens == null) {
      if (!getTools) return empty();
      const estimate = estimateContextCapacity(projection.messages, event, getTools(),
        signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal);
      if (estimate.status === "unavailable") return empty();
      ({ capacityNeeded, imageCount, maxImagesPerMessage } = estimate);
      capacitySource = "estimated";
    } else {
      if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0) return empty();
      imageCount = event.images?.length ?? 0;
      maxImagesPerMessage = imageCount;
      for (const entry of projection.entries) {
        if (aborted()) return empty();
        for (const message of entry.messages) {
          if (!("content" in message) || !Array.isArray(message.content)) continue;
          const count = message.content.filter(part => part.type === "image").length;
          imageCount += count;
          maxImagesPerMessage = Math.max(maxImagesPerMessage, count);
        }
      }
      capacityNeeded = usage.tokens + event.prompt.length + 8192 + imageCount * 8192;
      capacitySource = "pi";
    }
  } catch { return empty(); }
  if (aborted()) return empty();
  const available = ctx.modelRegistry.getAvailable();
  const candidates: RuntimeCandidate[] = [];
  for (const option of options) {
    if (signal?.aborted || ctx.signal?.aborted) break;
    const model = available.find(model => model.provider === option.provider && model.id === option.model);
    if (!model || !model.input.includes("text")) continue;
    // We cannot verify a serialized-request byte cap before Pi constructs its payload.
    if (model.inputLimits?.maxRequestBytes !== undefined) continue;
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || model.contextWindow < capacityNeeded) continue;
    if (imageCount > 0 && !model.input.includes("image")) continue;
    if (model.inputLimits?.images?.maxPerMessage !== undefined &&
        maxImagesPerMessage > model.inputLimits.images.maxPerMessage) continue;
    if (model.inputLimits?.images?.maxPerRequest !== undefined &&
        imageCount > model.inputLimits.images.maxPerRequest) continue;
    if (!getSupportedThinkingLevels(model).includes(option.thinkingLevel)) continue;
    if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some(scoped =>
      scoped.model.provider === option.provider && scoped.model.id === option.model &&
      (scoped.thinkingLevel === undefined || scoped.thinkingLevel === option.thinkingLevel))) continue;
    try {
      // `getAvailable()` checks configured auth; this check resolves credentials at request time.
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (signal?.aborted || ctx.signal?.aborted) break;
      if (auth.ok) candidates.push({ option, model });
    } catch {
      // A failing credential command never makes a model eligible.
    }
  }
  return { candidates: aborted() ? [] : candidates, capacitySource };
}
