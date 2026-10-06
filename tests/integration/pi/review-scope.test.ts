import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm, symlink, chmod, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getReviewScope, ReviewPreflightError } from "../../../src/adapters/pi/review-scope.js";

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
    assert.deepEqual(result, { changedFiles: 3, changedLines: 6, directories: 2, lineCountsComplete: true });
    await assert.rejects(getReviewScope(dir, "missing", new AbortController().signal));
    await assert.rejects(getReviewScope(dir, "--bad", new AbortController().signal));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(getReviewScope(dir, base, aborted.signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unmeasurable untracked content produces incomplete counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-review-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    await writeFile(join(dir, "start"), "base");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
    await writeFile(join(dir, "binary"), Buffer.from([1, 0, 2]));
    assert.deepEqual(await getReviewScope(dir, "HEAD", new AbortController().signal), {
      changedFiles: 1, changedLines: 0, directories: 1, lineCountsComplete: false,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


async function repository(run: (dir: string, git: (...args: string[]) => Buffer) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "router-review-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test");
    await writeFile(join(dir, "start"), "base\n"); git("add", "."); git("commit", "-qm", "base");
    await run(dir, git);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const scope = (dir: string, base = "HEAD") => getReviewScope(dir, base, new AbortController().signal);
const code = (expected: string) => (error: unknown) => error instanceof ReviewPreflightError && error.code === expected;

test("binary, oversized and dangling symlink changes count files without inventing lines", async () => {
  await repository(async (dir, git) => {
    await writeFile(join(dir, "tracked-binary"), Buffer.from([0, 1]));
    git("add", "."); git("commit", "-qm", "binary base");
    await writeFile(join(dir, "tracked-binary"), Buffer.from([0, 2]));
    await writeFile(join(dir, "large"), Buffer.alloc(512_001, 65));
    await symlink("absent-secret-target", join(dir, "link"));
    await writeFile(join(dir, "text"), "one\ntwo");
    assert.deepEqual(await scope(dir), { changedFiles: 4, changedLines: 2, directories: 1, lineCountsComplete: false });
  });
});

test("local branch refs work and trailing whitespace in filenames is preserved", async () => {
  await repository(async (dir, git) => {
    git("branch", "local-base");
    await writeFile(join(dir, "name \n"), "one\n");
    assert.deepEqual(await scope(dir, "local-base"), { changedFiles: 1, changedLines: 1, directories: 1, lineCountsComplete: true });
    git("add", "."); git("commit", "-qm", "next");
    assert.equal((await scope(dir, "local-base")).changedLines, 1);
  });
});

test("fatal failures have typed codes and abort stays cancellation", async () => {
  await repository(async (dir, git) => {
    await assert.rejects(scope(dir, "--bad"), code("invalid-base"));
    await assert.rejects(scope(dir, "missing"), code("base-not-found"));
    await assert.rejects(scope(dir), code("no-changes"));
    await mkdir(join(dir, "nested"));
    await assert.rejects(scope(join(dir, "nested")), code("not-repository-root"));
    const original = git("rev-parse", "HEAD").toString().trim();
    git("checkout", "--orphan", "unrelated"); git("commit", "-qm", "unrelated");
    await assert.rejects(scope(dir, original), code("no-merge-base"));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(getReviewScope(dir, "HEAD", aborted.signal), error => !(error instanceof ReviewPreflightError));
    for (let i = 0; i < 201; i++) await writeFile(join(dir, `new-${i}`), "line\n");
    await assert.rejects(scope(dir), code("file-limit"));
  });
});

test("changed gitlinks are incomplete even with numeric numstat", async () => {
  await repository(async (dir, git) => {
    const first = git("rev-parse", "HEAD").toString().trim();
    git("update-index", "--add", "--cacheinfo", `160000,${first},submodule`);
    git("commit", "-qm", "submodule base");
    const second = git("rev-parse", "HEAD").toString().trim();
    git("update-index", "--cacheinfo", `160000,${second},submodule`);
    assert.deepEqual(await scope(dir), { changedFiles: 1, changedLines: 0, directories: 1, lineCountsComplete: false });
  });
});

test("file growth and replacement during bounded reads fail safely", async t => {
  await repository(async dir => {
    const filename = join(dir, "untracked");
    await writeFile(filename, "small\n");
    const probe = await open(filename);
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.read;
    await probe.close();
    for (const replacement of [false, true]) {
      await writeFile(filename, "small\n");
      let reads = 0;
      const mocked = t.mock.method(prototype, "read", async function(this: any, buffer: Buffer, offset: number, length: number, position: number) {
        assert.ok(buffer.length <= 512_001);
        assert.ok(length <= 512_001);
        if (++reads === 1) {
          if (replacement) { await rm(filename); await writeFile(filename, "replacement\n"); }
          else await writeFile(filename, Buffer.alloc(600_000, 65));
        }
        return original.call(this, buffer, offset, length, position);
      });
      try { await assert.rejects(scope(dir), code("filesystem-failed")); }
      finally { mocked.mock.restore(); }
      assert.ok(reads > 0);
    }
  });
});

test("unsafe file identity and filesystem read failures have sanitized errors", async t => {
  await repository(async dir => {
    const filename = join(dir, "untracked");
    await writeFile(filename, "text\n");
    const probe = await open(filename);
    const prototype = Object.getPrototypeOf(probe);
    const originalStat = prototype.stat;
    await probe.close();
    const stat = t.mock.method(prototype, "stat", async function(this: any) {
      const actual = await originalStat.call(this);
      actual.ino += 1;
      return actual;
    });
    try { await assert.rejects(scope(dir), code("filesystem-failed")); }
    finally { stat.mock.restore(); }
    const read = t.mock.method(prototype, "read", async () => { throw new Error("SECRET_CONTENT_PATH"); });
    try {
      await assert.rejects(scope(dir), error => code("filesystem-failed")(error) && !String(error).includes("SECRET"));
    } finally { read.mock.restore(); }
  });
});

test("symlink targets and oversized files are never read", async t => {
  await repository(async dir => {
    await writeFile(join(dir, "large"), Buffer.alloc(512_001, 65));
    await symlink("large", join(dir, "link"));
    await symlink("absent", join(dir, "dangling"));
    const probe = await open(join(dir, "start"));
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const read = t.mock.method(prototype, "read", async () => { assert.fail("Unmeasurable file must not be read"); });
    try {
      assert.deepEqual(await scope(dir), { changedFiles: 3, changedLines: 0, directories: 1, lineCountsComplete: false });
      assert.equal(read.mock.callCount(), 0);
    } finally { read.mock.restore(); }
  });
});

test("Git output and execution failures are sanitized, bounded and cancellable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-fake-git-"));
  const oldPath = process.env.PATH;
  try {
    const binary = join(dir, "git");
    const script = (body: string) => `#!${process.execPath}\n${body}\n`;
    await writeFile(binary, script('process.stdout.write("x".repeat(2_100_000))'));
    await chmod(binary, 0o755);
    process.env.PATH = dir;
    await assert.rejects(scope(dir), code("git-output-limit"));
    await writeFile(binary, script('process.stderr.write("SECRET"); process.exit(2)'));
    await assert.rejects(scope(dir), error => code("repository-unavailable")(error) && !String(error).includes("SECRET"));
    await writeFile(binary, script('setTimeout(()=>{}, 10000)'));
    await assert.rejects(scope(dir), code("git-timeout"));
    const controller = new AbortController();
    const pending = getReviewScope(dir, "HEAD", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, error => !(error instanceof ReviewPreflightError));
    await writeFile(binary, script(`const args=process.argv.slice(2); if(args.includes("--show-toplevel")) console.log(${JSON.stringify(dir)}); else if(args.includes("--verify") || args.includes("merge-base")) console.log("a".repeat(40)); else if(args.includes("--numstat")) process.stdout.write("malformed\\0");`));
    await assert.rejects(scope(dir), code("invalid-git-output"));
  } finally { process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); }
});
