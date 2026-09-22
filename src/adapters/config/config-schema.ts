import {
  TASK_CATEGORIES,
  THINKING_LEVELS,
  type ModelCategory,
  type ModelOption,
  type ThinkingLevel,
} from "../../domain/model-option.js";

/** On-disk configuration shape, not the routing use case's input contract. */
export interface ModelRouterConfig {
  readonly version: 1;
  /** Omitted: inherit. Present (including []): replace the inherited list. */
  readonly options?: readonly ModelOption[];
}

/** Validation errors report a location and rule, never the supplied value. */
export class ModelRouterConfigError extends Error {
  constructor(
    readonly path: string,
    rule: string,
  ) {
    super(`${path}: ${rule}`);
    this.name = "ModelRouterConfigError";
  }
}

const optionKeys = [
  "id", "provider", "model", "thinkingLevel", "deepSweScore",
  "costPerTaskUsd", "categories",
] as const;
const categoryNames: readonly string[] = [...TASK_CATEGORIES, "general"];
const thinkingNames: readonly string[] = THINKING_LEVELS;

/** Parse JSON text without leaking syntax-error excerpts of user configuration. */
export function parseModelRouterConfigJson(text: string): ModelRouterConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelRouterConfigError("$", "must be valid JSON");
  }
  return parseModelRouterConfig(value);
}

/**
 * Validate unknown configuration and return a detached, typed copy.
 * No coercion, defaults, trimming, file access, or host registry checks.
 * Throws on the first invalid field. Unknown properties are rejected.
 */
export function parseModelRouterConfig(value: unknown): ModelRouterConfig {
  const config = object(value, "$", ["version", "options"]);
  if (!Object.hasOwn(config, "version") || config.version !== 1) {
    throw new ModelRouterConfigError("$.version", "must be 1");
  }
  if (!Object.hasOwn(config, "options")) return { version: 1 };
  if (!Array.isArray(config.options)) {
    throw new ModelRouterConfigError("$.options", "must be an array");
  }

  const options: ModelOption[] = [];
  const ids = new Set<string>();
  const combinations = new Set<string>();
  // Indexed iteration also rejects sparse array entries supplied by JS callers.
  for (let index = 0; index < config.options.length; index += 1) {
    const path = `$.options[${index}]`;
    const option = parseOption(config.options[index], path);
    if (ids.has(option.id)) {
      throw new ModelRouterConfigError(`${path}.id`, "must be unique");
    }
    // Tuple encoding avoids collisions from separators inside registry IDs.
    const combination = JSON.stringify([
      option.provider, option.model, option.thinkingLevel,
    ]);
    if (combinations.has(combination)) {
      throw new ModelRouterConfigError(path, "provider/model/thinkingLevel combination must be unique");
    }
    ids.add(option.id);
    combinations.add(combination);
    options.push(option);
  }
  return { version: 1, options };
}

function parseOption(value: unknown, path: string): ModelOption {
  const option = object(value, path, optionKeys);
  for (const key of optionKeys) {
    if (!Object.hasOwn(option, key)) {
      throw new ModelRouterConfigError(`${path}.${key}`, "is required");
    }
  }
  const id = identifier(option.id, `${path}.id`);
  const provider = identifier(option.provider, `${path}.provider`);
  const model = identifier(option.model, `${path}.model`);
  if (typeof option.thinkingLevel !== "string" || !thinkingNames.includes(option.thinkingLevel)) {
    throw new ModelRouterConfigError(`${path}.thinkingLevel`, `must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const deepSweScore = nonnegativeNumber(option.deepSweScore, `${path}.deepSweScore`);
  if (deepSweScore > 100) {
    throw new ModelRouterConfigError(`${path}.deepSweScore`, "must be at most 100");
  }
  const costPerTaskUsd = nonnegativeNumber(option.costPerTaskUsd, `${path}.costPerTaskUsd`);
  if (!Array.isArray(option.categories) || option.categories.length === 0) {
    throw new ModelRouterConfigError(`${path}.categories`, "must be a nonempty array");
  }
  const categories: ModelCategory[] = [];
  for (let index = 0; index < option.categories.length; index += 1) {
    const category: unknown = option.categories[index];
    if (typeof category !== "string" || !categoryNames.includes(category)) {
      throw new ModelRouterConfigError(`${path}.categories[${index}]`, `must be one of: ${categoryNames.join(", ")}`);
    }
    if (categories.includes(category as ModelCategory)) {
      throw new ModelRouterConfigError(`${path}.categories[${index}]`, "must be unique");
    }
    categories.push(category as ModelCategory);
  }
  if (categories.includes("general") && categories.length !== 1) {
    throw new ModelRouterConfigError(`${path}.categories`, "general must appear alone");
  }
  return {
    id, provider, model,
    thinkingLevel: option.thinkingLevel as ThinkingLevel,
    deepSweScore, costPerTaskUsd, categories,
  };
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRouterConfigError(path, "must be an object");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelRouterConfigError(path, "must be a plain object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) {
      throw new ModelRouterConfigError(path, `contains an unknown property; allowed: ${keys.join(", ")}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new ModelRouterConfigError(path, "must contain data properties only");
    }
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ModelRouterConfigError(path, "must be a nonempty string without surrounding whitespace");
  }
  return value;
}

function nonnegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ModelRouterConfigError(path, "must be a finite, nonnegative number");
  }
  return value;
}
