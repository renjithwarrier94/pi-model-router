import { ReviewPreflightError, type ReviewPreflightErrorCode } from "./review-scope.js";

const messages: Record<ReviewPreflightErrorCode, string> = {
  "invalid-base": "Review preflight: invalid base syntax. Use a branch name or commit ID.",
  "base-not-found": "Review preflight: base is unavailable locally. Check the ref or fetch/create it before retrying.",
  "no-merge-base": "Review preflight: HEAD and the base have no shared ancestor. Choose a related base.",
  "repository-unavailable": "Review preflight: Git repository unavailable. Check that Git is installed and the working directory is a repository.",
  "not-repository-root": "Review preflight: launch Pi from the Git repository root.",
  "no-changes": "Review preflight: no changes found against the merge base. Check the base and review scope.",
  "file-limit": "Review preflight: more than 200 changed files. Narrow the review scope before retrying.",
  "git-timeout": "Review preflight: a Git command exceeded the 4-second limit. Check repository responsiveness before retrying.",
  "git-output-limit": "Review preflight: Git output exceeded the measurement limit. Narrow the review scope before retrying.",
  "git-failed": "Review preflight: Git could not measure changes. Check repository health before retrying.",
  "invalid-git-output": "Review preflight: inconsistent or unrecognized Git metadata. Stop concurrent changes and retry.",
  "filesystem-failed": "Review preflight: a file could not be read safely or changed during measurement. Check local files and retry.",
};

/** Fixed UI copy only: never expose raw errors, Git output, paths, or refs. */
export function formatReviewPreflightFailure(error: unknown): string {
  const message = error instanceof ReviewPreflightError ? messages[error.code] : undefined;
  return `${message ?? "Review preflight could not measure the local diff."} No assessment sent; model unchanged.`;
}
