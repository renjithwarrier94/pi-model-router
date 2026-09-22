import type {
  AnswerFor,
  ChoiceAnswer,
  JudgmentResponse,
  NoulAnswer,
  Question,
  ScoreAnswer,
  ScoreQuestion,
} from "../../../src/application/models/judgment.js";
import type { JudgmentProvider } from "../../../src/application/ports/judgment-provider.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// Compile-only: this function is never invoked and requires no provider or network.
export async function checkInference(provider: JudgmentProvider): Promise<void> {
  const result = await provider.judge({
    context: { prompt: "Refactor authentication", history: [], metadata: null },
    questions: {
      taskType: {
        type: "choice",
        instructions: "What is the primary task?",
        options: {
          implementation: "Change behavior",
          refactoring: { description: "Preserve behavior while restructuring" },
        },
      },
      complexity: {
        type: "score",
        instructions: ["Assess implementation complexity"],
        levels: ["Localized change", "Cross-component change", "Architectural change"],
      },
      needsRepositoryContext: {
        type: "noul",
        instructions: "Does this require inspecting existing code?",
        criteria: { yes: "Repository inspection is needed", no: "Self-contained" },
      },
    },
  }, { signal: new AbortController().signal });

  const checks: [
    Expect<Equal<typeof result.answers.taskType, ChoiceAnswer<"implementation" | "refactoring">>>,
    Expect<Equal<typeof result.answers.complexity, ScoreAnswer>>,
    Expect<Equal<typeof result.answers.needsRepositoryContext, NoulAnswer>>,
  ] = [true, true, true];
  void checks;

  // @ts-expect-error Unknown question IDs cannot be accessed.
  result.answers.missing;
  // @ts-expect-error Noul has no separate confidence.
  result.answers.needsRepositoryContext.confidence;
  // @ts-expect-error Unknown choice options cannot be accessed.
  result.answers.taskType.probabilities.other;
  // @ts-expect-error Responses are readonly.
  result.answers.complexity.score = 1;
  // @ts-expect-error All requested answers are required.
  const incomplete: typeof result = { answers: { taskType: result.answers.taskType } };
  void incomplete;
}

// @ts-expect-error A score requires at least two levels.
const invalidScore: ScoreQuestion = { type: "score", instructions: "Rate complexity", levels: ["Low"] };
void invalidScore;

export type UnionAnswerCheck = Expect<Equal<
  AnswerFor<Question>,
  ChoiceAnswer | ScoreAnswer | NoulAnswer
>>;

// Dynamic question sets still produce a discriminated answer union.
export function narrowDynamicAnswer(response: JudgmentResponse): number | undefined {
  const answer = response.answers["dynamic"];
  if (answer?.type === "noul") return answer.probability;
  return undefined;
}
