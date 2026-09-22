import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatMessage,
  ConversationSnapshot,
  ConversationSummary,
} from "../../application/models/conversation-snapshot.js";

/**
 * Capture context at before_agent_start, before Pi persists the new request.
 * Pi owns branch selection, compaction, and context edits. This mapper only
 * translates the resulting projection; selection/redaction belongs downstream.
 */
export function mapContext(
  event: Pick<BeforeAgentStartEvent, "prompt" | "images">,
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "buildSessionProjection"
  >,
): ConversationSnapshot {
  const { messages } = sessionManager.buildSessionProjection();
  const history: ChatMessage[] = [];
  const summaries: ConversationSummary[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
      case "assistant": {
        const textParts: string[] = [];
        let imageCount = 0;
        if (typeof message.content === "string") {
          textParts.push(message.content);
        } else {
          for (const block of message.content) {
            if (block.type === "text") textParts.push(block.text);
            else if (block.type === "image") imageCount += 1;
          }
        }
        // Keep empty/image-only messages; deciding relevance is application policy.
        history.push({
          role: message.role,
          text: textParts.join("\n"),
          imageCount,
        });
        break;
      }
      case "compactionSummary":
        summaries.push({ kind: "compaction", text: message.summary });
        break;
      case "branchSummary":
        summaries.push({ kind: "branch", text: message.summary });
        break;
      // System, tool results, bash execution, custom/extension, and unknown roles
      // are intentionally excluded. Never spread Pi objects into the snapshot.
      default:
        break;
    }
  }

  return {
    history,
    summaries,
    currentRequest: {
      text: event.prompt,
      imageCount: event.images?.length ?? 0,
    },
  };
}
