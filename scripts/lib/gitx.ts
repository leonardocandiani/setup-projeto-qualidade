/**
 * gitx.ts
 *
 * Thin, dependency-free git helpers. Every call is read-only and time-boxed:
 * a repo big enough to blow the budget degrades into a declared partial result
 * instead of hanging or silently returning nothing.
 */

import { execFileSync } from "node:child_process";

export interface GitDegradation {
  source: string;
  error: string;
}

/** Run a git command, returning stdout or null when it fails/times out. */
export function git(
  args: string[],
  cwd: string,
  timeoutMs = 20_000,
): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], root)?.trim() === "true";
}

export function currentBranch(root: string): string | null {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], root)?.trim() ?? null;
}

/** True when the working tree has no staged or unstaged changes. */
export function isClean(root: string): boolean {
  const out = git(["status", "--porcelain"], root);
  return out !== null && out.trim() === "";
}

/** Every tracked path, repo-relative, POSIX separators. */
export function trackedFiles(root: string): string[] {
  const out = git(["ls-files", "-z"], root);
  if (out === null) return [];
  return out.split("\0").filter(Boolean);
}

/** Paths git itself considers ignored but that are nonetheless tracked. */
export function trackedButIgnored(root: string): string[] {
  const out = git(["ls-files", "-i", "-c", "--exclude-standard", "-z"], root);
  if (out === null) return [];
  return out.split("\0").filter(Boolean);
}

/**
 * Last commit timestamp (unix seconds) per tracked path, from a single
 * `git log` pass. Returns null when the walk fails or times out, so the caller
 * can declare the degradation instead of treating "no data" as "never touched".
 */
export function lastTouchedMap(
  root: string,
  timeoutMs = 60_000,
): Map<string, number> | null {
  const out = git(
    ["log", "--no-merges", "--name-only", "--format=%ct", "--diff-filter=d"],
    root,
    timeoutMs,
  );
  if (out === null) return null;

  const map = new Map<string, number>();
  let stamp = 0;
  for (const line of out.split("\n")) {
    if (line === "") continue;
    if (/^\d{9,}$/.test(line)) {
      stamp = Number(line);
      continue;
    }
    if (stamp && !map.has(line)) map.set(line, stamp);
  }
  return map;
}

/** Number of commits touching each path, as a churn signal. */
export function churnMap(root: string, timeoutMs = 60_000): Map<string, number> | null {
  const out = git(
    ["log", "--no-merges", "--name-only", "--format=%x00"],
    root,
    timeoutMs,
  );
  if (out === null) return null;
  const map = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (line === "" || line === "\0") continue;
    map.set(line, (map.get(line) ?? 0) + 1);
  }
  return map;
}
