/** JSON-compatible context. Callers must exclude cycles and non-finite numbers. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Instructions and criteria may use text or structured descriptions. */
export type Description =
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface QuestionBase {
  /** Complete question meaning; question IDs are only for correlation. */
  readonly instructions: Description;
}

export interface ChoiceQuestion extends QuestionBase {
  readonly type: "choice";
  /** Non-empty candidate set; keys are stable option IDs. */
  readonly options: Readonly<Record<string, Description>>;
}

export interface ScoreQuestion extends QuestionBase {
  readonly type: "score";
  /** Ordered lowest to highest; each level describes a concrete situation. */
  readonly levels: readonly [Description, Description, ...Description[]];
}

export interface NoulQuestion extends QuestionBase {
  readonly type: "noul";
  readonly criteria?: {
    readonly yes: Description;
    readonly no: Description;
  };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** A request must contain at least one question, checked at runtime. */
export type QuestionSet = Readonly<Record<string, Question>>;

export interface JudgmentRequest<Q extends QuestionSet = QuestionSet> {
  readonly context: JsonValue;
  /** Questions share context but cannot consume one another's answers. */
  readonly questions: Q;
}

export interface ChoiceAnswer<Option extends string = string> {
  readonly type: "choice";
  readonly choice: Option;
  /** All supplied options, with finite probabilities in [0, 1] summing to 1. */
  readonly probabilities: Readonly<Record<Option, number>>;
  /** Distribution concentration in [0, 1], not a correctness guarantee. */
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  /** Expected zero-based level index: sum(i * probabilities[i]). */
  readonly score: number;
  /** One finite probability per input level, in order, summing to 1. */
  readonly probabilities: readonly number[];
  /** Distribution concentration in [0, 1], not a correctness guarantee. */
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: "noul";
  /** Finite P(yes) in [0, 1]; there is no separate confidence value. */
  readonly probability: number;
}

export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion
    ? ChoiceAnswer<Extract<keyof Q["options"], string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : Q extends NoulQuestion
        ? NoulAnswer
        : never;

export interface JudgmentResponse<Q extends QuestionSet = QuestionSet> {
  readonly answers: {
    readonly [K in keyof Q]: AnswerFor<Q[K]>;
  };
}
