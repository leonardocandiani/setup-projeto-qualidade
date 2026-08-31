#!/usr/bin/env bun
/**
 * tidy-apply.ts
 *
 * Executes an approved tidy plan, and can undo one. It is the only part of tidy
 * that writes, and it is deliberately incapable of destroying anything:
 *
 *   - the only operations it knows are `git mv`, `git rm --cached` and an
 *     append to .gitignore. There is no delete path in this file;
 *   - quarantine MOVES a file into `.attic/<stamp>/` with its original path
 *     preserved, so the bytes stay in the working tree and in git history;
 *   - untrack removes a path from the index only. The file stays on disk;
 *   - it refuses to start on a dirty tree or on the default branch, so `git
 *     checkout .` and a branch delete are always a complete escape hatch;
 *   - every operation performed is written to a MANIFEST with its exact
 *     inverse, and `--undo <manifest>` replays those inverses.
 *
 * Dry run is the default. Nothing is written without --apply.
 *
 * Usage:
 *   bun scripts/tidy-apply.ts <plan.json> [--repo-path <p>] [--apply]
 *                             [--allow-default-branch]
 *   bun scripts/tidy-apply.ts --undo <manifest.json> [--repo-path <p>] [--apply]
 *
 * Exit codes: 0 done, 1 refused or execution error, 2 usage error.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { currentBranch, git, isClean, isGitRepo, trackedFiles } from "./lib/gitx.ts";

type OpKind = "quarantine" | "untrack" | "move";

interface PlanOp {
  op: OpKind;
  path: string;
  /** Destination for `move`. Ignored by the other kinds. */
  to?: string;
  /** Why this operation is in the plan. Copied into the manifest verbatim. */
  reason: string;
}

interface Plan {
  /** Free-form label shown in the summary, e.g. "tidy 2026-08-31". */
  label?: string;
  /** Paths the plan promises never to touch, from the interview. */
  sacred?: string[];
  operations: PlanOp[];
}

interface DoneOp extends PlanOp {
  from: string;
  landedAt: string;
  undo: string[];
  /** Present when this op appended a line to .gitignore, so undo can drop it. */
  gitignoreLineAdded?: string;
}

const PROTECTED = [".git/", ".attic/", ".keepwright/"];
const DEFAULT_BRANCHES = new Set(["main", "master"]);

function fail(message: string, code: 1 | 2, extra: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ error: message, ...extra }, null, 2));
  process.exit(code);
}

function readJson(path: string): any {
  if (!existsSync(path)) fail(`file not found: ${path}`, 1);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    fail(`file is not valid JSON: ${path} (${(e as Error).message})`, 1);
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Refuse loudly on anything that would make the run irreversible. */
function assertSafeToWrite(root: string, allowDefaultBranch: boolean): void {
  if (!isGitRepo(root)) fail(`not a git repository: ${root}`, 1);

  const branch = currentBranch(root);
  if (!allowDefaultBranch && branch !== null && DEFAULT_BRANCHES.has(branch)) {
    fail(
      `refusing to run on the default branch (${branch}). Create a branch first, e.g. 'git checkout -b tidy/${new Date().toISOString().slice(0, 10)}', so the whole cleanup can be thrown away by deleting it`,
      1,
      { branch },
    );
  }

  if (!isClean(root)) {
    fail(
      "refusing to run with uncommitted changes. Commit or stash first, so 'git checkout .' fully undoes this run",
      1,
      { hint: "git status --porcelain" },
    );
  }
}

interface PlanChecks {
  tracked: Set<string>;
  sacred: string[];
  seen: Set<string>;
}

/**
 * The guards every operation must clear, as data. Each entry rejects when
 * `rejects` is true, and the plan is only applied when no entry fires.
 */
function guardsFor(op: PlanOp, checks: PlanChecks): { rejects: boolean; why: string }[] {
  const onSacred = checks.sacred.some(
    (s) => op.path === s || op.path.startsWith(s.replace(/\/?$/, "/")),
  );
  return [
    {
      rejects: op.path.startsWith("/") || op.path.includes(".."),
      why: `path must be repo-relative and must not escape the repo: ${op.path}`,
    },
    {
      rejects: PROTECTED.some((p) => op.path.startsWith(p)),
      why: `${op.path} is protected and can never be an operand`,
    },
    { rejects: onSacred, why: `${op.path} is on the plan's own sacred list` },
    {
      rejects: !checks.tracked.has(op.path),
      why: `${op.path} is not tracked by git, so there is nothing to move or untrack`,
    },
    { rejects: checks.seen.has(op.path), why: `${op.path} appears more than once in the plan` },
    {
      rejects: op.op === "move" && (typeof op.to !== "string" || op.to === ""),
      why: 'op "move" needs a `to` destination',
    },
    {
      rejects: typeof op.reason !== "string" || op.reason.trim() === "",
      why: "every operation needs a `reason`; an unexplained change is not reviewable",
    },
  ];
}

/** Everything wrong with one operation. Empty array means it is acceptable. */
function problemsForOp(op: PlanOp, at: string, checks: PlanChecks): string[] {
  if (!["quarantine", "untrack", "move"].includes(op.op)) {
    return [`${at}: unknown op "${op.op}" (allowed: quarantine, untrack, move)`];
  }
  if (typeof op.path !== "string" || op.path === "") {
    return [`${at}: missing path`];
  }
  return guardsFor(op, checks)
    .filter((g) => g.rejects)
    .map((g) => `${at}: ${g.why}`);
}

function validatePlan(plan: Plan, root: string): void {
  if (!Array.isArray(plan.operations)) fail("plan has no `operations` array", 1);
  if (plan.operations.length === 0) fail("plan has 0 operations: nothing to apply", 1);

  const checks: PlanChecks = {
    tracked: new Set(trackedFiles(root)),
    sacred: plan.sacred ?? [],
    seen: new Set<string>(),
  };

  const problems: string[] = [];
  for (const [i, op] of plan.operations.entries()) {
    problems.push(...problemsForOp(op, `operations[${i}]`, checks));
    if (typeof op.path === "string") checks.seen.add(op.path);
  }

  if (problems.length > 0) {
    fail(`plan rejected: ${problems.length} problem(s), nothing was written`, 1, { problems });
  }
}

function runGit(root: string, args: string[], label: string): void {
  const out = git(args, root);
  if (out === null) fail(`git ${args.join(" ")} failed while ${label}`, 1);
}

/**
 * Add a literal ignore pattern once, so re-running never duplicates a line.
 * Returns the line it appended, or null when the path was already covered. The
 * caller records that line in the manifest, otherwise the undo would leave a
 * .gitignore entry behind and "fully reversible" would stop being literal.
 */
function ensureIgnored(root: string, rel: string, apply: boolean): string | null {
  const file = join(root, ".gitignore");
  const line = `/${rel}`;
  const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (current.split("\n").some((l) => l.trim() === line || l.trim() === rel)) return null;
  if (!apply) return line;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${prefix}${line}\n`, "utf-8");
  return line;
}

/** Drop a single line this run appended to .gitignore. */
function removeIgnoreLine(root: string, line: string): void {
  const file = join(root, ".gitignore");
  if (!existsSync(file)) return;
  const kept = readFileSync(file, "utf-8").split("\n");
  const at = kept.lastIndexOf(line);
  if (at === -1) return;
  kept.splice(at, 1);
  writeFileSync(file, kept.join("\n"), "utf-8");
}

function performOp(op: PlanOp, root: string, stamp: string, apply: boolean): DoneOp {
  if (op.op === "quarantine") {
    const dest = join(".attic", stamp, op.path);
    if (apply) {
      mkdirSync(join(root, dirname(dest)), { recursive: true });
      runGit(root, ["mv", op.path, dest], `quarantining ${op.path}`);
    }
    return {
      ...op,
      from: op.path,
      landedAt: dest,
      undo: ["git", "mv", dest, op.path],
    };
  }

  if (op.op === "move") {
    const dest = op.to as string;
    if (apply) {
      mkdirSync(join(root, dirname(dest)), { recursive: true });
      runGit(root, ["mv", op.path, dest], `moving ${op.path}`);
    }
    return { ...op, from: op.path, landedAt: dest, undo: ["git", "mv", dest, op.path] };
  }

  // untrack: index only. The bytes stay exactly where they are on disk.
  if (apply) runGit(root, ["rm", "--cached", "--quiet", op.path], `untracking ${op.path}`);
  const ignoreLine = ensureIgnored(root, op.path, apply);
  return {
    ...op,
    from: op.path,
    landedAt: `${op.path} (on disk, no longer tracked)`,
    undo: ["git", "add", "-f", op.path],
    ...(ignoreLine !== null ? { gitignoreLineAdded: ignoreLine } : {}),
  };
}

/** The record of what actually happened, and how to reverse each step. */
function writeManifest(
  plan: Plan,
  done: DoneOp[],
  root: string,
  stamp: string,
  apply: boolean,
): { manifest: Record<string, unknown>; manifestRel: string } {
  const manifestDir = join(".keepwright", "tidy", stamp);
  const manifestRel = join(manifestDir, "MANIFEST.json");
  const manifest = {
    label: plan.label ?? `tidy ${stamp}`,
    appliedAt: new Date().toISOString(),
    branch: currentBranch(root),
    dryRun: !apply,
    sacred: plan.sacred ?? [],
    operations: done,
    undoAll: `bun scripts/tidy-apply.ts --undo ${manifestRel} --apply`,
  };
  if (apply) {
    mkdirSync(join(root, manifestDir), { recursive: true });
    writeFileSync(join(root, manifestRel), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  }
  return { manifest, manifestRel };
}

function applyPlan(planPath: string, root: string, apply: boolean, allowDefault: boolean): void {
  const plan = readJson(planPath) as Plan;
  if (apply) assertSafeToWrite(root, allowDefault);
  else if (!isGitRepo(root)) fail(`not a git repository: ${root}`, 1);
  validatePlan(plan, root);

  const stamp = new Date().toISOString().slice(0, 10);
  const done: DoneOp[] = [];
  for (const op of plan.operations) {
    done.push(performOp(op, root, stamp, apply));
  }

  const { manifest, manifestRel } = writeManifest(plan, done, root, stamp, apply);

  const byOp: Record<string, number> = {};
  for (const d of done) byOp[d.op] = (byOp[d.op] ?? 0) + 1;

  console.log(JSON.stringify({
    dryRun: !apply,
    branch: currentBranch(root),
    totals: { operations: done.length, ...byOp },
    manifest: apply ? manifestRel : "(dry run: no manifest written)",
    operations: done.map((d) => ({ op: d.op, from: d.from, to: d.landedAt })),
    help: apply
      ? `review with 'git status', then commit. To reverse everything: ${manifest.undoAll}`
      : "nothing was written. Re-run with --apply to perform these operations",
  }, null, 2));
}

/** Load a manifest and refuse anything that cannot be replayed in reverse. */
function loadUndoableOps(manifestPath: string, root: string, apply: boolean): DoneOp[] {
  const manifest = readJson(manifestPath);
  const ops: DoneOp[] = manifest.operations ?? [];
  if (ops.length === 0) fail(`manifest has 0 operations: ${manifestPath}`, 1);
  if (manifest.dryRun === true) {
    fail(`this manifest is from a dry run, so nothing was ever applied: ${manifestPath}`, 1);
  }
  if (apply && !isGitRepo(root)) fail(`not a git repository: ${root}`, 1);
  for (const op of ops) {
    if (!Array.isArray(op.undo) || op.undo[0] !== "git") {
      fail(`manifest entry has no git undo command: ${JSON.stringify(op)}`, 1);
    }
  }
  return ops;
}

function undoManifest(manifestPath: string, root: string, apply: boolean): void {
  const ops = loadUndoableOps(manifestPath, root, apply);

  // Reverse order, so a move into a directory undoes before its parent does.
  const replayed: string[] = [];
  for (const op of [...ops].reverse()) {
    if (apply) {
      const dest = op.undo[op.undo.length - 1];
      mkdirSync(join(root, dirname(dest)), { recursive: true });
      runGit(root, op.undo.slice(1), `undoing ${op.from}`);
      if (op.gitignoreLineAdded !== undefined) removeIgnoreLine(root, op.gitignoreLineAdded);
    }
    replayed.push(op.undo.join(" "));
    if (op.gitignoreLineAdded !== undefined) {
      replayed.push(`drop "${op.gitignoreLineAdded}" from .gitignore`);
    }
  }

  console.log(JSON.stringify({
    dryRun: !apply,
    totals: { reversed: replayed.length },
    commands: replayed,
    help: apply
      ? "every operation in the manifest was reversed. Check with 'git status'"
      : "nothing was written. Re-run with --apply to reverse these operations",
  }, null, 2));
}

function main(): void {
  const argv = process.argv.slice(2);
  const known = ["--repo-path", "--apply", "--allow-default-branch", "--undo"];
  for (const a of argv) {
    if (a.startsWith("--") && !known.includes(a)) {
      fail(`unknown flag: ${a} (known: ${known.join(", ")})`, 2);
    }
  }

  const root = flagValue(argv, "--repo-path") ?? process.cwd();
  const apply = argv.includes("--apply");
  const undoPath = flagValue(argv, "--undo");

  if (undoPath !== undefined) {
    undoManifest(undoPath, root, apply);
    return;
  }

  const planPath = argv.find((a) => !a.startsWith("--") && a !== root);
  if (planPath === undefined) {
    fail(
      "usage: tidy-apply.ts <plan.json> [--repo-path <p>] [--apply] | tidy-apply.ts --undo <manifest.json> [--apply]",
      2,
    );
  }
  applyPlan(planPath, root, apply, argv.includes("--allow-default-branch"));
}

main();
