import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ModelRouterConfigError,
  parseModelRouterConfig,
  parseModelRouterConfigJson,
} from "../../../src/adapters/config/config-schema.js";
import { TASK_CATEGORIES, THINKING_LEVELS } from "../../../src/domain/model-option.js";

function option(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate",
    provider: "provider",
    model: "namespace/model-v1",
    thinkingLevel: "medium",
    deepSweScore: 65.5,
    costPerTaskUsd: 0.15,
    categories: ["implement", "diagnose", "review"],
    ...overrides,
  };
}

function rejects(value: unknown, path: string) {
  assert.throws(() => parseModelRouterConfig(value), (error: unknown) => {
    assert.ok(error instanceof ModelRouterConfigError);
    assert.equal(error.path, path);
    assert.equal(error.name, "ModelRouterConfigError");
    return true;
  });
}

function rejectsOption(overrides: Record<string, unknown>, path: string) {
  rejects({ version: 1, options: [option(overrides)] }, `$.options[0].${path}`);
}

test("parses valid JSON into a detached config without altering identifiers", () => {
  const input = { version: 1, options: [option()] };
  assert.deepEqual(parseModelRouterConfigJson(JSON.stringify(input)), input);
  const parsed = parseModelRouterConfig(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.options, input.options);
  assert.notEqual(parsed.options?.[0], input.options[0]);
  assert.notEqual(parsed.options?.[0]?.categories, input.options[0]?.categories);
  input.options[0]!.categories.push("design");
  input.options[0]!.model = "changed";
  assert.equal(parsed.options?.[0]?.model, "namespace/model-v1");
  assert.deepEqual(parsed.options?.[0]?.categories, ["implement", "diagnose", "review"]);
});

test("preserves omitted versus empty options for later override resolution", () => {
  assert.deepEqual(parseModelRouterConfig({ version: 1 }), { version: 1 });
  assert.deepEqual(parseModelRouterConfig({ version: 1, options: [] }), { version: 1, options: [] });
  assert.equal(Object.hasOwn(parseModelRouterConfig({ version: 1 }), "options"), false);
});

test("accepts every named thinking level as a separate candidate", () => {
  const options = THINKING_LEVELS.map((thinkingLevel) => option({ id: thinkingLevel, thinkingLevel }));
  assert.deepEqual(parseModelRouterConfig({ version: 1, options }).options, options);
});

test("accepts all task categories and general by itself", () => {
  for (const categories of [[...TASK_CATEGORIES], ["general"]]) {
    const input = { version: 1, options: [option({ categories })] };
    assert.deepEqual(parseModelRouterConfig(input), input);
  }
  assert.equal((TASK_CATEGORIES as readonly string[]).includes("general"), false);
});

test("accepts score boundaries and zero cost", () => {
  for (const deepSweScore of [0, 100]) {
    const input = { version: 1, options: [option({ deepSweScore, costPerTaskUsd: 0 })] };
    assert.deepEqual(parseModelRouterConfig(input), input);
  }
});

for (const [name, value, path] of [
  ["null root", null, "$"],
  ["array root", [], "$"],
  ["string root", "config", "$"],
  ["missing version", {}, "$.version"],
  ["unknown version", { version: 2 }, "$.version"],
  ["string version", { version: "1" }, "$.version"],
  ["unknown root field", { version: 1, option: [] }, "$"],
  ["null options", { version: 1, options: null }, "$.options"],
  ["undefined options", { version: 1, options: undefined }, "$.options"],
  ["object options", { version: 1, options: {} }, "$.options"],
  ["null option", { version: 1, options: [null] }, "$.options[0]"],
  ["array option", { version: 1, options: [[]] }, "$.options[0]"],
  ["sparse options", { version: 1, options: Array(1) }, "$.options[0]"],
  ["unknown option field", { version: 1, options: [option({ typo: true })] }, "$.options[0]"],
] as const) {
  test(`rejects ${name}`, () => rejects(value, path));
}

for (const key of Object.keys(option())) {
  test(`requires option field ${key}`, () => {
    const candidate: Record<string, unknown> = option();
    delete candidate[key];
    rejects({ version: 1, options: [candidate] }, `$.options[0].${key}`);
  });
}

for (const field of ["id", "provider", "model"]) {
  test(`rejects invalid ${field} without coercion or trimming`, () => {
    for (const value of ["", " ", " leading", "trailing\n", 1, null, false, undefined]) {
      rejectsOption({ [field]: value }, field);
    }
  });
}

for (const field of ["deepSweScore", "costPerTaskUsd"]) {
  test(`rejects invalid ${field}`, () => {
    for (const value of [-1, NaN, Infinity, -Infinity, "0.5", null, true, undefined]) {
      rejectsOption({ [field]: value }, field);
    }
  });
}

test("rejects scores above 100 but does not impose an arbitrary cost ceiling", () => {
  rejectsOption({ deepSweScore: 100.01 }, "deepSweScore");
  assert.equal(parseModelRouterConfig({ version: 1, options: [option({ costPerTaskUsd: 1000 })] }).options?.[0]?.costPerTaskUsd, 1000);
});

test("rejects unknown or non-string thinking levels", () => {
  for (const thinkingLevel of ["auto", "High", " high", "", 1, null, undefined]) {
    rejectsOption({ thinkingLevel }, "thinkingLevel");
  }
});

test("rejects invalid category arrays", () => {
  for (const categories of [[], "general", null, undefined]) {
    rejectsOption({ categories }, "categories");
  }
  for (const categories of [["unknown"], ["Implement"], [1], [null], Array(1)]) {
    rejectsOption({ categories }, "categories[0]");
  }
  rejectsOption({ categories: ["review", "review"] }, "categories[1]");
  rejectsOption({ categories: ["general", "general"] }, "categories[1]");
  rejectsOption({ categories: ["general", "review"] }, "categories");
  rejectsOption({ categories: ["review", "general"] }, "categories");
});

test("rejects duplicate IDs even across different models", () => {
  rejects({ version: 1, options: [option(), option({ model: "other" })] }, "$.options[1].id");
});

test("rejects duplicate provider/model/thinking combinations even across categories", () => {
  rejects({ version: 1, options: [option(), option({ id: "other", categories: ["general"] })] }, "$.options[1]");
});

test("allows the same model with a different provider or thinking level", () => {
  const options = [option(), option({ id: "other-provider", provider: "other" }), option({ id: "high", thinkingLevel: "high" })];
  assert.deepEqual(parseModelRouterConfig({ version: 1, options }).options, options);
});

test("combination keys do not collide on identifier separators", () => {
  const options = [option({ provider: "a/b", model: "c" }), option({ id: "other", provider: "a", model: "b/c" })];
  assert.deepEqual(parseModelRouterConfig({ version: 1, options }).options, options);
});

test("JSON syntax errors do not leak input or a parser cause", () => {
  assert.throws(() => parseModelRouterConfigJson('{"secret": "PRIVATE_VALUE"'), (error: unknown) => {
    assert.ok(error instanceof ModelRouterConfigError);
    assert.equal(error.path, "$");
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("validation errors do not echo rejected values or unknown property names", () => {
  for (const value of [
    { version: "PRIVATE_VALUE" },
    { version: 1, PRIVATE_VALUE: true },
    { version: 1, options: [option({ thinkingLevel: "PRIVATE_VALUE" })] },
  ]) {
    assert.throws(() => parseModelRouterConfig(value), (error: unknown) => {
      assert.ok(error instanceof ModelRouterConfigError);
      assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
      return true;
    });
  }
});

test("rejects inherited configuration, accessors, and unexpected symbol keys", () => {
  rejects(Object.create({ version: 1 }), "$");
  rejects({ get version() { throw new Error("must not run"); } }, "$");
  rejects({ version: 1, [Symbol("unknown")]: true }, "$");
  rejects(JSON.parse('{"version":1,"__proto__":{}}'), "$");
});

test("the checked-in example satisfies the schema", async () => {
  const json = await readFile(new URL("../../../examples/router.config.json", import.meta.url), "utf8");
  assert.equal(parseModelRouterConfigJson(json).options?.length, 3);
});

const policy = {
  weights: { reasoningDemand: 0.5, dependencyScope: 0.3, contextIntegrationDemand: 0.2 },
  difficultyToDeepSweScore: [
    { difficulty: 0, score: 45 }, { difficulty: 0.5, score: 60 }, { difficulty: 1, score: 75 },
  ],
  maxMissingCriticalEvidenceProbability: 0.7,
};

function rejectsPolicy(bad: unknown, path: string) {
  rejects({ version: 1, policy: bad }, `$.policy${path}`);
}

test("optional policy is detached and valid in a config without options", () => {
  const input = { version: 1 as const, policy };
  const result = parseModelRouterConfig(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.policy, policy);
  assert.notEqual(result.policy?.weights, policy.weights);
  assert.notEqual(result.policy?.difficultyToDeepSweScore, policy.difficultyToDeepSweScore);
  assert.notEqual(result.policy?.difficultyToDeepSweScore[1], policy.difficultyToDeepSweScore[1]);
  const original = policy.difficultyToDeepSweScore[1]!.score;
  policy.difficultyToDeepSweScore[1]!.score = 99;
  assert.equal(result.policy?.difficultyToDeepSweScore[1]?.score, original);
  policy.difficultyToDeepSweScore[1]!.score = original;
});

test("policy requires complete finite nonnegative weights and positive finite sum", () => {
  rejectsPolicy(null, "");
  rejectsPolicy({ ...policy, extra: "private" }, "");
  rejectsPolicy({ ...policy, weights: { ...policy.weights, typo: 1 } }, ".weights");
  rejectsPolicy({ ...policy, weights: { reasoningDemand: 1 } }, ".weights.dependencyScope");
  for (const v of [-1, NaN, Infinity, null, "0.5", undefined]) {
    rejectsPolicy({ ...policy, weights: { ...policy.weights, reasoningDemand: v } }, ".weights.reasoningDemand");
  }
  rejectsPolicy({ ...policy, weights: { reasoningDemand: 0, dependencyScope: 0, contextIntegrationDemand: 0 } }, ".weights");
  rejectsPolicy({ ...policy, weights: { reasoningDemand: Number.MAX_VALUE, dependencyScope: Number.MAX_VALUE, contextIntegrationDemand: 1 } }, ".weights");
});

test("curve rejects holes, out-of-range, unordered, decreasing, and missing endpoints", () => {
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [] }, ".difficultyToDeepSweScore");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: Array(2) }, ".difficultyToDeepSweScore[0]");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 0, score: 45 }] }, ".difficultyToDeepSweScore[1].difficulty");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 60 }, { difficulty: 1, score: 40 }] }, ".difficultyToDeepSweScore[1].score");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0.1, score: 40 }, { difficulty: 1, score: 45 }] }, ".difficultyToDeepSweScore[0].difficulty");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 0.9, score: 45 }] }, ".difficultyToDeepSweScore[1].difficulty");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 40, secret: true }, { difficulty: 1, score: 45 }] }, ".difficultyToDeepSweScore[0]");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1, score: 101 }] }, ".difficultyToDeepSweScore[1].score");
  rejectsPolicy({ ...policy, difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1.1, score: 45 }] }, ".difficultyToDeepSweScore[1].difficulty");
});

test("missing-evidence threshold requires a probability", () => {
  for (const v of [-1, 1.1, NaN, Infinity, "0.7", undefined]) {
    rejectsPolicy({ ...policy, maxMissingCriticalEvidenceProbability: v }, ".maxMissingCriticalEvidenceProbability");
  }
});

test("validates frozen input without mutating it", () => {
  const candidate = Object.freeze(option({ categories: Object.freeze(["general"]) }));
  const input = Object.freeze({ version: 1, options: Object.freeze([candidate]) });
  assert.deepEqual(parseModelRouterConfig(input), input);
});
