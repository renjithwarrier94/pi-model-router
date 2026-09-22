/** Text and image presence only; never contains image bytes or host metadata. */
export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly imageCount: number;
}

export interface ConversationSummary {
  readonly kind: "compaction" | "branch";
  readonly text: string;
}

/**
 * Unbounded, unredacted input to context preparation, not a payload to send as-is.
 * History and summaries each retain their source order; their interleaving is
 * not represented. Summaries are evidence, not direct user instructions.
 */
export interface ConversationSnapshot {
  readonly history: readonly ChatMessage[];
  readonly summaries: readonly ConversationSummary[];
  /** The new request is separate from the previously persisted conversation. */
  readonly currentRequest: {
    readonly text: string;
    readonly imageCount: number;
  };
}
