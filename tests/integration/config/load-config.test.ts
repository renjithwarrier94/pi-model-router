import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadModelRouterConfig } from "../../../src/adapters/config/load-config.js";

const globalConfig = { version: 1, options: [{
  id: "global", provider: "provider", model: "model", thinkingLevel: "off", deepSweScore: 50,
  costPerTaskUsd: 0.1, categories: ["general"],
}], policy: {
  weights: { reasoningDemand: 1, dependencyScope: 0, contextIntegrationDemand: 0 },
  difficultyToDeepSweScore: [{ difficulty: 0, score: 40 }, { difficulty: 1, score: 70 }],
  maxMissingCriticalEvidenceProbability: 0.7,
} };

async function fixture(run: (agentDir: string, cwd: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "model-router-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(agentDir);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir, cwd);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("absent config leaves routing inactive", async () => fixture(async (_agent, cwd) => {
  assert.deepEqual(await loadModelRouterConfig(cwd, false), { version: 1 });
}));

test("trusted project overrides options and policy independently; untrusted project is ignored", async () => fixture(async (agent, cwd) => {
  await writeFile(join(agent, "model-router.json"), JSON.stringify(globalConfig));
  await writeFile(join(cwd, ".pi", "model-router.json"), JSON.stringify({ version: 1, options: [] }));
  const trusted = await loadModelRouterConfig(cwd, true);
  assert.deepEqual(trusted.options, []);
  assert.deepEqual(trusted.policy, globalConfig.policy);
  const untrusted = await loadModelRouterConfig(cwd, false);
  assert.deepEqual(untrusted.options, globalConfig.options);
  assert.deepEqual(untrusted.policy, globalConfig.policy);
  await writeFile(join(cwd, ".pi", "model-router.json"), JSON.stringify({ version: 1, policy: {
    ...globalConfig.policy, maxMissingCriticalEvidenceProbability: 0.5,
  } }));
  const replaced = await loadModelRouterConfig(cwd, true);
  assert.deepEqual(replaced.options, globalConfig.options);
  assert.equal(replaced.policy?.maxMissingCriticalEvidenceProbability, 0.5);
}));

test("invalid trusted project fails closed; invalid untrusted project is not opened", async () => fixture(async (agent, cwd) => {
  await writeFile(join(agent, "model-router.json"), JSON.stringify(globalConfig));
  await writeFile(join(cwd, ".pi", "model-router.json"), "PRIVATE_INVALID_CONTENT");
  await assert.rejects(() => loadModelRouterConfig(cwd, true));
  assert.deepEqual((await loadModelRouterConfig(cwd, false)).options, globalConfig.options);
}));

test("review option IDs are checked against the final inherited/overridden list", async () => fixture(async (agent, cwd) => {
  const floor = { minChangedFiles: 8, minChangedLines: 250, minDirectories: 3, allowedOptionIds: ["global"] };
  await writeFile(join(agent, "model-router.json"), JSON.stringify({ ...globalConfig, policy: {
    ...globalConfig.policy, substantialReview: floor,
  } }));
  await writeFile(join(cwd, ".pi", "model-router.json"), JSON.stringify({ version: 1, options: [] }));
  await assert.rejects(() => loadModelRouterConfig(cwd, true), /review policy references unavailable options/);
  assert.deepEqual((await loadModelRouterConfig(cwd, false)).policy?.substantialReview, floor);
  await writeFile(join(cwd, ".pi", "model-router.json"), JSON.stringify({ version: 1, policy: {
    ...globalConfig.policy, substantialReview: floor,
  } }));
  assert.deepEqual((await loadModelRouterConfig(cwd, true)).policy?.substantialReview, floor);
}));

test("unreadable global config does not silently fall back to project", async () => fixture(async (agent, cwd) => {
  await mkdir(join(agent, "model-router.json"));
  await writeFile(join(cwd, ".pi", "model-router.json"), JSON.stringify(globalConfig));
  await assert.rejects(() => loadModelRouterConfig(cwd, true), /could not be read/);
}));
