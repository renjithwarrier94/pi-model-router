import type { BeforeAgentStartEvent, ToolInfo } from "@earendil-works/pi-coding-agent";

export type LocalCapacityEstimate =
  | { readonly status: "estimated"; readonly capacityNeeded: number; readonly imageCount: number; readonly maxImagesPerMessage: number }
  | { readonly status: "unavailable" };

/** Version 1: deliberately generous byte-based heuristic, not a tokenizer or request guarantee. */
export function estimateContextCapacity(
  messages: readonly unknown[], event: BeforeAgentStartEvent, tools: readonly ToolInfo[], signal?: AbortSignal,
): LocalCapacityEstimate {
  try {
    let bytes = 0, overhead = 0, imageCount = 0, maxImagesPerMessage = 0;
    const check = () => { if (signal?.aborted) throw Error(); };
    const text = (value: unknown) => {
      check();
      if (typeof value !== "string" || value.length > 2_000_000) throw Error();
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > 2_000_000) throw Error();
    };
    const ancestors = new Set<object>();
    const json = (value: unknown, depth = 0): void => {
      check();
      if (depth > 32) throw Error();
      if (value === null || typeof value === "boolean") { text(String(value)); return; }
      if (typeof value === "number" && Number.isFinite(value)) { text(String(value)); return; }
      if (typeof value === "string") {
        if (value.length > 2_000_000) throw Error();
        text(JSON.stringify(value)); return;
      }
      if (typeof value !== "object" || !value || ancestors.has(value)) throw Error();
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw Error();
      ancestors.add(value);
      text(Array.isArray(value) ? "[" : "{");
      let first = true;
      for (const key of Object.keys(value)) {
        if (!first) text(","); first = false;
        if (!Array.isArray(value)) { text(JSON.stringify(key)); text(":"); }
        json((value as Record<string, unknown>)[key], depth + 1);
      }
      text(Array.isArray(value) ? "]" : "}");
      ancestors.delete(value);
    };
    const content = (value: unknown, role: string): number => {
      if (typeof value === "string") { text(value); return 0; }
      if (!Array.isArray(value)) throw Error();
      let images = 0;
      for (const block of value) {
        check();
        if (!block || typeof block !== "object") throw Error();
        switch (block.type) {
          case "text": text(block.text); break;
          case "thinking": if (role !== "assistant") throw Error(); text(block.thinking); break;
          case "toolCall":
            if (role !== "assistant") throw Error();
            text(block.id); text(block.name); json(block.arguments); break;
          case "image":
            if (typeof block.data !== "string" || typeof block.mimeType !== "string") throw Error();
            images++; break;
          default: throw Error();
        }
      }
      return images;
    };
    const message = (value: unknown) => {
      check();
      if (!value || typeof value !== "object") throw Error();
      const m = value as Record<string, unknown>;
      let images = 0;
      switch (m.role) {
        case "system":
          images = content(m.content, "system");
          if (m.sections !== undefined) json(m.sections);
          if (m.toolsAdded !== undefined) json(m.toolsAdded);
          if (m.toolsRemoved !== undefined) json(m.toolsRemoved);
          break;
        case "user": case "assistant": case "custom": case "toolResult":
          images = content(m.content, m.role);
          if (m.role === "toolResult") { text(m.toolCallId); text(m.toolName); }
          break;
        case "bashExecution": text(m.command); text(m.output); break;
        case "branchSummary": case "compactionSummary": text(m.summary); break;
        default: throw Error();
      }
      overhead += 256;
      imageCount += images;
      maxImagesPerMessage = Math.max(maxImagesPerMessage, images);
    };
    check();
    if (!Array.isArray(messages) || messages.length > 10_000 || !Array.isArray(tools)) throw Error();
    for (const m of messages) message(m);
    message({ role: "system", content: event.systemPrompt });
    message({ role: "user", content: [{ type: "text", text: event.prompt }, ...(event.images ?? [])] });
    const selected = event.systemPromptOptions?.selectedTools;
    if (!Array.isArray(selected) || selected.some(name => typeof name !== "string")) throw Error();
    for (const name of new Set(selected)) {
      check();
      const tool = tools.find(t => t.name === name);
      if (!tool) throw Error();
      json({ name: tool.name, description: tool.description, parameters: tool.parameters,
        ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }) });
    }
    return { status: "estimated", capacityNeeded: Math.ceil((bytes + overhead + imageCount * 8192) * 1.25) + 16384,
      imageCount, maxImagesPerMessage };
  } catch {
    return { status: "unavailable" };
  }
}
