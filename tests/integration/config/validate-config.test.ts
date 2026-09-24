import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateAuthoredConfig, validateConfigFile } from "../../../scripts/validate-config.js";

const sample = new URL("../../../examples/router.config.json", import.meta.url);

test("authoring validator accepts complete examples and rejects missing or multiple generalists", async () => {
  const text = await readFile(sample, "utf8");
  const config = validateAuthoredConfig(text);
  assert.equal(config.options?.length, 3);
  assert.equal(config.options?.filter(o => o.categories.includes("general")).length, 1);
  assert.equal((await validateConfigFile(new URL(sample).pathname)).options?.length, 3);
  const parsed = JSON.parse(text);
  const withoutTier = { ...parsed, policy: { ...parsed.policy, substantialReview: undefined } };
  assert.throws(() => validateAuthoredConfig(JSON.stringify({ ...withoutTier, options: [] })), /\$\.options/);
  assert.throws(() => validateAuthoredConfig(JSON.stringify({ ...parsed, policy: undefined })), /\$\.policy/);
  assert.throws(() => validateAuthoredConfig(JSON.stringify({ ...withoutTier,
    options: parsed.options.map((o: { categories: string[] }) => ({ ...o, categories: ["review"] })),
  })), /exactly one option/);
  assert.throws(() => validateAuthoredConfig(JSON.stringify({ ...withoutTier,
    options: parsed.options.map((o: { categories: string[] }) => ({ ...o, categories: ["general"] })),
  })), /exactly one option/);
});

test("validator CLI is read-only, deterministic, and does not echo private invalid content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-config-validator-"));
  const path = join(dir, "draft.json");
  const cli = new URL("../../../scripts/validate-config.ts", import.meta.url).pathname;
  const tsx = new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [tsx, cli, path], { encoding: "utf8" });
  try {
    const original = await readFile(sample, "utf8");
    await writeFile(path, original);
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(await readFile(path, "utf8"), original);
    await writeFile(path, '{"SECRET_IN_CONFIG":');
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.includes("SECRET_IN_CONFIG"), false);
    assert.equal(invalid.stderr.includes(path), false);
    assert.equal(invalid.stdout, "");
    assert.equal(spawnSync(process.execPath, [tsx, cli], { encoding: "utf8" }).status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
