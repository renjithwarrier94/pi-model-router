import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseModelRouterConfigJson, type ModelRouterConfig } from "./config-schema.js";

/** Ignore untrusted project config even if it is present. Errors abort routing, not silently fall back. */
export async function loadModelRouterConfig(cwd: string, projectTrusted: boolean): Promise<ModelRouterConfig> {
  const global = await readOptionalConfig(join(getAgentDir(), "model-router.json"));
  const project = projectTrusted ? await readOptionalConfig(join(cwd, ".pi", "model-router.json")) : undefined;
  return {
    version: 1,
    ...(project?.options !== undefined ? { options: project.options } : global?.options !== undefined ? { options: global.options } : {}),
    ...(project?.policy !== undefined ? { policy: project.policy } : global?.policy !== undefined ? { policy: global.policy } : {}),
  };
}

async function readOptionalConfig(path: string): Promise<ModelRouterConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    // Do not retain file paths or error messages: they may contain sensitive data.
    throw new Error("Model router configuration could not be read.");
  }
  return parseModelRouterConfigJson(text);
}
