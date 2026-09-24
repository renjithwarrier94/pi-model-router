import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getReviewScope } from "../../../src/adapters/pi/review-scope.js";

test("measures committed, staged, unstaged and untracked local changes without exposing content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-review-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "before\n");
    git("add", "."); git("commit", "-qm", "base");
    await writeFile(join(dir, "src", "a.ts"), "after\n");
    git("add", "."); git("commit", "-qm", "next");
    await writeFile(join(dir, "src", "a.ts"), "after\nmore\n");
    await mkdir(join(dir, "test"));
    await writeFile(join(dir, "test", "staged.ts"), "one\n");
    git("add", "test/staged.ts");
    await writeFile(join(dir, "test", "untracked.ts"), "two\nthree\n");
    const base = git("rev-parse", "HEAD^").toString().trim();
    const result = await getReviewScope(dir, base, new AbortController().signal);
    assert.deepEqual(result, { changedFiles: 3, changedLines: 6, directories: 2 });
    await assert.rejects(getReviewScope(dir, "missing", new AbortController().signal));
    await assert.rejects(getReviewScope(dir, "--bad", new AbortController().signal));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(getReviewScope(dir, base, aborted.signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unmeasurable untracked content fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-review-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    await writeFile(join(dir, "start"), "base");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
    await writeFile(join(dir, "binary"), Buffer.from([1, 0, 2]));
    await assert.rejects(getReviewScope(dir, "HEAD", new AbortController().signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
