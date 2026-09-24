import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ModelRouterConfigError,
  parseModelRouterConfigJson,
  type ModelRouterConfig,
} from "../src/adapters/config/config-schema.js";

/** Authoring checks beyond the router's partial-config schema. Pure and offline. */
export function validateAuthoredConfig(text: string): ModelRouterConfig {
  const config = parseModelRouterConfigJson(text);
  if (!config.options?.length) {
    throw new ModelRouterConfigError("$.options", "must be a nonempty list for a complete routing config");
  }
  if (!config.policy) {
    throw new ModelRouterConfigError("$.policy", "is required for a complete routing config");
  }
  const generalists = config.options.filter(option => option.categories.includes("general"));
  if (generalists.length !== 1) {
    throw new ModelRouterConfigError("$.options", "must contain exactly one option with categories [general]");
  }
  return config;
}

/** Explicit file path, no network or modification; diagnostics never echo file contents. */
export async function validateConfigFile(path: string): Promise<ModelRouterConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("Configuration file could not be read.");
  }
  return validateAuthoredConfig(text);
}

async function main(args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
    console.error("Usage: npm run config:validate -- /absolute/path/to/model-router.json");
    return 2;
  }
  try {
    const config = await validateConfigFile(args[0]);
    console.log(`Config valid: ${config.options!.length} options, one generalist, policy present.`);
    return 0;
  } catch (error) {
    // Schema errors have safe paths/rules; other errors may contain private data.
    console.error(error instanceof ModelRouterConfigError ? error.message : "Configuration file could not be read.");
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
