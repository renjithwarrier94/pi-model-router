import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ConversationSnapshot } from "../../../src/application/models/conversation-snapshot.js";
import type { ContextPreparationResult } from "../../../src/application/models/prepared-context.js";
import { countWords, prepareContext } from "../../../src/application/use-cases/prepare-context.js";

const words = (n: number) => Array(n).fill("word").join(" ");
const message = (text: string, role: ChatMessage["role"] = "user", imageCount = 0): ChatMessage => ({ role, text, imageCount });
function snapshot(history: readonly ChatMessage[] = [], text = "current"): ConversationSnapshot {
  return { history, summaries: [], currentRequest: { text, imageCount: 0 } };
}
function prepared(result: ContextPreparationResult) {
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") throw new Error("Expected prepared context");
  assert.equal(result.metadata.wordCount, countWords(result.context));
  assert.equal(result.metadata.characterCount, result.context.length);
  return result;
}
const baseWords = prepared(prepareContext(snapshot())).metadata.wordCount;
const messageWords = countWords("User: Images unavailable: 0") + 1;

test("word counting uses Unicode whitespace, not a tokenizer", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords(" \n\t\u2003 "), 0);
  assert.equal(countWords("  one\t two\nthree\u2003four  "), 4);
  assert.equal(countWords("foo.bar(a,b);你好"), 1);
});

test("preserves the current prompt verbatim and labels it separately", () => {
  const text = "  Please explain\n\n```ts\na.b();\n```  ";
  const result = prepared(prepareContext(snapshot([], text)));
  assert.ok(result.context.includes(text));
  assert.ok(result.context.includes("Current user question:"));
  assert.equal(result.metadata.selectedHistoryMessages, 0);
  assert.equal(result.metadata.omittedHistoryMessages, 0);
  assert.equal(result.metadata.usedBoundaryAllowance, false);
});

test("history is ordered chronologically, with roles and no current-prompt duplication", () => {
  const result = prepared(prepareContext(snapshot([
    message("first-marker"), message("second-marker", "assistant"), message("third-marker"),
  ], "current-marker")));
  assert.ok(result.context.indexOf("first-marker") < result.context.indexOf("second-marker"));
  assert.ok(result.context.indexOf("second-marker") < result.context.indexOf("third-marker"));
  assert.ok(result.context.includes("Assistant:\nImages unavailable: 0\nsecond-marker"));
  assert.equal(result.context.split("current-marker").length, 2);
});

test("an exact soft-budget fit retains complete messages without allowance", () => {
  const result = prepared(prepareContext(snapshot([message("old"), message("new")]), {
    wordBudget: baseWords + messageWords,
    boundaryAllowanceWords: 0,
  }));
  assert.equal(result.metadata.selectedHistoryMessages, 1);
  assert.equal(result.metadata.omittedHistoryMessages, 1);
  assert.equal(result.metadata.wordCount, baseWords + messageWords);
  assert.equal(result.metadata.usedBoundaryAllowance, false);
  assert.ok(result.context.includes("\nnew\n"));
  assert.ok(!result.context.includes("\nold\n"));
});

test("includes one boundary message at the exact extended limit, then stops", () => {
  const result = prepared(prepareContext(snapshot([
    message("old"), message("boundary"), message("new"),
  ]), {
    wordBudget: baseWords + messageWords,
    boundaryAllowanceWords: messageWords,
  }));
  assert.equal(result.metadata.selectedHistoryMessages, 2);
  assert.equal(result.metadata.wordCount, baseWords + 2 * messageWords);
  assert.equal(result.metadata.usedBoundaryAllowance, true);
  assert.equal(result.metadata.omittedHistoryMessages, 1);
});

test("does not use spare allowance for another older message", () => {
  const result = prepared(prepareContext(snapshot([
    message("older"), message("boundary"), message("newest"),
  ]), {
    wordBudget: baseWords + messageWords,
    boundaryAllowanceWords: 100,
  }));
  assert.equal(result.metadata.selectedHistoryMessages, 2);
  assert.ok(!result.context.includes("\nolder\n"));
});

test("does not skip a too-large boundary message to find smaller older messages", () => {
  const result = prepared(prepareContext(snapshot([
    message("tiny"), message(words(100)), message("newest"),
  ]), { wordBudget: baseWords + messageWords, boundaryAllowanceWords: 10 }));
  assert.equal(result.metadata.selectedHistoryMessages, 1);
  assert.equal(result.metadata.omittedHistoryMessages, 2);
  assert.ok(!result.context.includes("tiny"));
});

test("latest historical message too large results in no history, not truncation", () => {
  const result = prepared(prepareContext(snapshot([message(words(100))]), {
    wordBudget: baseWords, boundaryAllowanceWords: 1,
  }));
  assert.equal(result.metadata.selectedHistoryMessages, 0);
  assert.equal(result.metadata.omittedHistoryMessages, 1);
});

test("current prompt may consume allowance but then receives no history", () => {
  const result = prepared(prepareContext(snapshot([message("old")]), {
    wordBudget: baseWords - 1, boundaryAllowanceWords: 1,
  }));
  assert.equal(result.metadata.selectedHistoryMessages, 0);
  assert.equal(result.metadata.usedBoundaryAllowance, true);
});

test("oversized current prompt returns a content-free skip result", () => {
  const result = prepareContext(snapshot([], "PRIVATE_PROMPT"), {
    wordBudget: baseWords - 1, boundaryAllowanceWords: 0,
  });
  assert.equal(result.status, "skipped");
  if (result.status === "skipped") assert.equal(result.reason, "current-request-too-large");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_PROMPT"));
});

test("default limits are 5600 words and a 1000-word allowance, including formatting", () => {
  const atSoft = prepared(prepareContext(snapshot([], words(5600 - baseWords + 1))));
  assert.equal(atSoft.metadata.wordCount, 5600);
  assert.equal(atSoft.metadata.usedBoundaryAllowance, false);
  const atMax = prepared(prepareContext(snapshot([], words(6600 - baseWords + 1))));
  assert.equal(atMax.metadata.wordCount, 6600);
  assert.equal(atMax.metadata.usedBoundaryAllowance, true);
  assert.equal(prepareContext(snapshot([], words(6601 - baseWords + 1))).status, "skipped");
});

test("optional message count caps count individual messages, including zero", () => {
  const input = snapshot([message("one"), message("two", "assistant"), message("three")]);
  assert.equal(prepared(prepareContext(input, { maxHistoryMessages: 2 })).metadata.selectedHistoryMessages, 2);
  assert.equal(prepared(prepareContext(input, { maxHistoryMessages: 0 })).metadata.selectedHistoryMessages, 0);
});

test("reports omitted summaries and unavailable images without transmitting summary text", () => {
  const input: ConversationSnapshot = {
    history: [message("old", "user", 10), message("", "assistant", 2)],
    currentRequest: { text: "", imageCount: 3 },
    summaries: [{ kind: "compaction", text: "PRIVATE_SUMMARY" }, { kind: "branch", text: "PRIVATE_BRANCH" }],
  };
  const result = prepared(prepareContext(input, { maxHistoryMessages: 1 }));
  assert.equal(result.metadata.omittedSummaries, 2);
  assert.equal(result.metadata.unavailableImages, 5);
  assert.equal(result.metadata.omittedHistoryMessages, 1);
  assert.ok(result.context.includes("Omitted summaries: 2"));
  assert.ok(result.context.includes("Omitted older messages: 1"));
  assert.ok(result.context.includes("Images unavailable: 3"));
  assert.doesNotMatch(result.context, /PRIVATE/);
});

test("empty and image-only messages are retained as complete entries", () => {
  const result = prepared(prepareContext(snapshot([message(""), message("", "user", 1)])));
  assert.equal(result.metadata.selectedHistoryMessages, 2);
  assert.equal(result.metadata.unavailableImages, 1);
});

test("character safety limit catches long whitespace-free code and current prompts", () => {
  assert.equal(prepareContext(snapshot([], "x".repeat(100_001))).status, "skipped");
  const input = snapshot([message("older"), message("x".repeat(100_001)), message("new")]);
  assert.equal(prepared(prepareContext(input)).metadata.selectedHistoryMessages, 1);
  const baseline = prepared(prepareContext(snapshot()));
  assert.equal(prepareContext(snapshot(), { maxCharacters: baseline.context.length }).status, "prepared");
  assert.equal(prepareContext(snapshot(), { maxCharacters: baseline.context.length - 1 }).status, "skipped");
});

test("does not mutate frozen inputs and is deterministic", () => {
  const input = Object.freeze({
    history: Object.freeze([Object.freeze(message("text"))]),
    summaries: Object.freeze([]),
    currentRequest: Object.freeze({ text: "current", imageCount: 0 }),
  });
  assert.deepEqual(prepareContext(input), prepareContext(input));
});

test("rejects invalid policy numbers and overflow", () => {
  for (const key of ["wordBudget", "boundaryAllowanceWords", "maxHistoryMessages", "maxCharacters"]) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => prepareContext(snapshot(), { [key]: value }), RangeError);
    }
  }
  assert.throws(() => prepareContext(snapshot(), { wordBudget: 0 }), RangeError);
  assert.throws(() => prepareContext(snapshot(), { maxCharacters: 0 }), RangeError);
  assert.throws(() => prepareContext(snapshot(), { wordBudget: Number.MAX_SAFE_INTEGER }), RangeError);
});
