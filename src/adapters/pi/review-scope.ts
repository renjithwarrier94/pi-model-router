import { execFile } from "node:child_process";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import type { ReviewScope } from "../../application/use-cases/select-model.js";

const exec = promisify(execFile);
const MAX_FILES = 200;
const MAX_UNTRACKED_BYTES = 512_000;

export type ReviewPreflightErrorCode = "invalid-base" | "base-not-found" | "no-merge-base" |
  "repository-unavailable" | "not-repository-root" | "no-changes" | "file-limit" |
  "git-timeout" | "git-output-limit" | "git-failed" | "invalid-git-output" | "filesystem-failed";

export class ReviewPreflightError extends Error {
  constructor(readonly code: ReviewPreflightErrorCode) {
    super(`Review preflight failed (${code}).`);
    this.name = "ReviewPreflightError";
  }
}

function records(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new ReviewPreflightError("invalid-git-output");
  return output.slice(0, -1).split("\0");
}

/** Local-only, bounded Git metadata. Unknown line counts force conservative review selection. */
export async function getReviewScope(cwd: string, base: string, signal: AbortSignal): Promise<ReviewScope> {
  const check = () => signal.throwIfAborted();
  check();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(base) || base.includes("..") || base.endsWith(".lock")) {
    throw new ReviewPreflightError("invalid-base");
  }
  const run = async (failure: ReviewPreflightErrorCode, ...args: string[]) => {
    check();
    try {
      const { stdout } = await exec("git", ["-C", cwd, ...args], {
        encoding: "utf8", maxBuffer: 2_000_000, timeout: 4_000, signal,
      });
      check();
      return stdout;
    } catch (error) {
      check();
      const details = error as { code?: string | number; killed?: boolean };
      if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new ReviewPreflightError("git-output-limit");
      if (details.killed) throw new ReviewPreflightError("git-timeout");
      // Only the expected Git exit status indicates a missing ref/ancestor.
      if (failure === "base-not-found" && details.code !== 128 && details.code !== 1) failure = "git-failed";
      if (failure === "no-merge-base" && details.code !== 1) failure = "git-failed";
      throw new ReviewPreflightError(failure);
    }
  };
  const root = (await run("repository-unavailable", "rev-parse", "--show-toplevel")).replace(/\r?\n$/, "");
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
    if (await realpath(root) !== canonicalCwd) throw new ReviewPreflightError("not-repository-root");
  } catch (error) {
    check();
    if (error instanceof ReviewPreflightError) throw error;
    throw new ReviewPreflightError("filesystem-failed");
  }
  const commit = (await run("base-not-found", "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`)).trim();
  const mergeBase = (await run("no-merge-base", "merge-base", "HEAD", commit)).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(mergeBase)) {
    throw new ReviewPreflightError("invalid-git-output");
  }
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none"];
  const tracked = await run("git-failed", ...diffArgs, "--numstat", "-z", mergeBase, "--");
  const raw = await run("git-failed", ...diffArgs, "--raw", "--no-abbrev", "-z", mergeBase, "--");
  const untracked = await run("git-failed", "ls-files", "--others", "--exclude-standard", "-z");
  const files = new Set<string>();
  const directories = new Set<string>();
  const gitlinks = new Set<string>();
  const validatePath = (path: string) => {
    if (!path || path.startsWith("/") || path.split("/").some(part => part === ".." || part === "." || !part)) {
      throw new ReviewPreflightError("invalid-git-output");
    }
  };
  const rawRecords = records(raw);
  if (rawRecords.length % 2 !== 0) throw new ReviewPreflightError("invalid-git-output");
  const rawPaths = new Set<string>();
  for (let i = 0; i < rawRecords.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40,64} [a-f0-9]{40,64} [A-Z](?:\d+)?$/.exec(rawRecords[i]!);
    const path = rawRecords[i + 1]!;
    validatePath(path);
    if (!match || rawPaths.has(path)) throw new ReviewPreflightError("invalid-git-output");
    rawPaths.add(path);
    if (match[1] === "160000" || match[2] === "160000") gitlinks.add(path);
  }
  let changedLines = 0;
  let lineCountsComplete = true;
  const add = (path: string) => {
    validatePath(path);
    files.add(path);
    directories.add(dirname(path));
    if (files.size > MAX_FILES) throw new ReviewPreflightError("file-limit");
  };
  for (const record of records(tracked)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!match || (match[1] === "-") !== (match[2] === "-")) throw new ReviewPreflightError("invalid-git-output");
    const path = match[3]!;
    if (!rawPaths.delete(path)) throw new ReviewPreflightError("invalid-git-output");
    add(path);
    if (match[1] === "-" || gitlinks.has(path)) lineCountsComplete = false;
    else changedLines += Number(match[1]) + Number(match[2]);
    if (!Number.isSafeInteger(changedLines)) throw new ReviewPreflightError("invalid-git-output");
  }
  // Different change sets between Git commands indicate a race; never silently omit changes.
  if (rawPaths.size) throw new ReviewPreflightError("invalid-git-output");
  for (const path of records(untracked)) {
    check();
    add(path);
    const filename = resolve(canonicalCwd, path);
    try {
      const stats = await lstat(filename);
      check();
      if (stats.isSymbolicLink()) { lineCountsComplete = false; continue; }
      if (!stats.isFile()) throw new ReviewPreflightError("filesystem-failed");
      if (stats.size > MAX_UNTRACKED_BYTES) { lineCountsComplete = false; continue; }
      // Reject symlinked parent directories as well as symlink leaf files.
      if (await realpath(filename) !== filename) throw new ReviewPreflightError("filesystem-failed");
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.dev !== stats.dev || before.ino !== stats.ino ||
            before.size !== stats.size || before.mtimeMs !== stats.mtimeMs || before.ctimeMs !== stats.ctimeMs) {
          throw new ReviewPreflightError("filesystem-failed");
        }
        const buffer = Buffer.alloc(MAX_UNTRACKED_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          check();
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        check();
        const after = await file.stat();
        const current = await lstat(filename);
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
          throw new ReviewPreflightError("filesystem-failed");
        }
        const content = buffer.subarray(0, length);
        if (content.includes(0)) { lineCountsComplete = false; continue; }
        let lines = length && content[length - 1] !== 10 ? 1 : 0;
        for (const byte of content) if (byte === 10) lines++;
        changedLines += lines;
        if (!Number.isSafeInteger(changedLines)) throw new ReviewPreflightError("invalid-git-output");
      } finally { await file.close(); }
    } catch (error) {
      check();
      if (error instanceof ReviewPreflightError) throw error;
      throw new ReviewPreflightError("filesystem-failed");
    }
  }
  check();
  if (!files.size) throw new ReviewPreflightError("no-changes");
  return { changedFiles: files.size, changedLines, directories: directories.size, lineCountsComplete };
}
