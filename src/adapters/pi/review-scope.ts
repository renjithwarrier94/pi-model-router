import { execFile } from "node:child_process";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import type { ReviewScope } from "../../application/use-cases/select-model.js";

const exec = promisify(execFile);
const MAX_FILES = 200;
const MAX_UNTRACKED_BYTES = 512_000;

/** Local-only, bounded Git metadata; neither paths nor file contents go to Jev. Throws closed on uncertainty. */
export async function getReviewScope(cwd: string, base: string, signal: AbortSignal): Promise<ReviewScope> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(base) || base.includes("..") || base.endsWith(".lock")) {
    throw new Error("Invalid review base.");
  }
  const run = async (...args: string[]) => {
    if (signal.aborted) throw new Error("Review preflight interrupted.");
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8", maxBuffer: 2_000_000, timeout: 4_000, signal,
    });
    return stdout.trimEnd();
  };
  const root = await run("rev-parse", "--show-toplevel");
  if (await realpath(root) !== await realpath(cwd)) throw new Error("Review preflight requires the repository root.");
  const commit = await run("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`);
  const mergeBase = await run("merge-base", "HEAD", commit);
  const tracked = await run("diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", mergeBase, "--");
  const untracked = await run("ls-files", "--others", "--exclude-standard", "-z");
  const files = new Set<string>();
  const directories = new Set<string>();
  let changedLines = 0;
  const add = (path: string) => {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid Git path.");
    files.add(path);
    directories.add(dirname(path));
    if (files.size > MAX_FILES) throw new Error("Review scope exceeds preflight limits.");
  };
  for (const record of tracked.split("\0")) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!match || match[1] === "-" || match[2] === "-") throw new Error("Unmeasurable Git diff.");
    add(match[3]!);
    changedLines += Number(match[1]) + Number(match[2]);
    if (!Number.isSafeInteger(changedLines)) throw new Error("Review scope exceeds preflight limits.");
  }
  for (const path of untracked.split("\0")) {
    if (!path) continue;
    add(path);
    const filename = resolve(cwd, path);
    const stats = await lstat(filename);
    if (!stats.isFile() || stats.size > MAX_UNTRACKED_BYTES || signal.aborted) throw new Error("Unmeasurable untracked file.");
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = await file.readFile();
      if (signal.aborted || content.includes(0)) throw new Error("Unmeasurable untracked file.");
      let lines = content.length && content[content.length - 1] !== 10 ? 1 : 0;
      for (const byte of content) if (byte === 10) lines += 1;
      changedLines += lines;
      if (!Number.isSafeInteger(changedLines)) throw new Error("Review scope exceeds preflight limits.");
    } finally { await file.close(); }
  }
  if (files.size === 0) throw new Error("No review changes found.");
  return { changedFiles: files.size, changedLines, directories: directories.size };
}
