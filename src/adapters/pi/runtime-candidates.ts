import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelOption } from "../../domain/model-option.js";

export interface RuntimeCandidate {
  readonly option: ModelOption;
  readonly model: Model<any>;
}

/** Fail closed on missing capacity/auth information. This is a conservative capacity estimate, not tokenization. */
export async function getRuntimeCandidates(
  options: readonly ModelOption[], ctx: ExtensionContext, event: BeforeAgentStartEvent, signal?: AbortSignal,
): Promise<RuntimeCandidate[]> {
  if (signal?.aborted || ctx.signal?.aborted) return [];
  const usage = ctx.getContextUsage();
  if (usage?.tokens === null || usage?.tokens === undefined) return [];
  const projection = ctx.sessionManager.buildSessionProjection();
  let imageCount = event.images?.length ?? 0;
  let maxImagesPerMessage = imageCount;
  for (const entry of projection.entries) {
    for (const message of entry.messages) {
      if (!("content" in message) || !Array.isArray(message.content)) continue;
      const count = message.content.filter(part => part.type === "image").length;
      imageCount += count;
      maxImagesPerMessage = Math.max(maxImagesPerMessage, count);
    }
  }
  // Include prompt, likely system/tool overhead, and an output reserve. Host still owns final context handling.
  const capacityNeeded = usage.tokens + event.prompt.length + 8192 + imageCount * 8192;
  const available = ctx.modelRegistry.getAvailable();
  const candidates: RuntimeCandidate[] = [];
  for (const option of options) {
    if (signal?.aborted || ctx.signal?.aborted) break;
    const model = available.find(model => model.provider === option.provider && model.id === option.model);
    if (!model || !model.input.includes("text")) continue;
    // We cannot verify a serialized-request byte cap before Pi constructs its payload.
    if (model.inputLimits?.maxRequestBytes !== undefined) continue;
    if (model.contextWindow < capacityNeeded) continue;
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
  return candidates;
}
