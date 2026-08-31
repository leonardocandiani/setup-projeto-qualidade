#!/usr/bin/env bun
/**
 * detect.ts
 *
 * Read-only detector. Inspects a target repo and prints a PARTIAL keepwright
 * config JSON to stdout — only the fields it can confidently infer. No writes.
 *
 * Usage:
 *   bun scripts/detect.ts [--repo-path <path>]
 *   npx tsx scripts/detect.ts [--repo-path <path>]
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { resolveStack, type StackSignals } from "./lib/stacks.ts";

interface PartialConfig {
  /** False when the target is not a git repo; the wizard must stop on this. */
  isGitRepo?: boolean;
  project?: string;
  repo?: string;
  repoOwner?: string;
  language?: string;
  stack?: string;
  layers?: string[];
  deploy?: string;
  packageManager?: string;
}

function argRepoPath(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--repo-path");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

function readJsonSafe(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Parse owner/name from a git remote URL (ssh or https). */
function parseRemote(url: string): { owner: string; name: string } | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  // git@github.com:owner/name  |  https://github.com/owner/name
  const m = cleaned.match(/[:/]([^/:]+)\/([^/:]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/** Read repo owner/name from .git/config (handles worktree gitdir pointer). */
function detectRepo(root: string): { repo: string; owner: string } | null {
  let gitConfigPath = join(root, ".git", "config");
  const dotGit = join(root, ".git");
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    // Worktree: .git is a file `gitdir: <path>`; the config lives at the
    // commondir one or two levels up from the worktree gitdir.
    const pointer = readTextSafe(dotGit) ?? "";
    const m = pointer.match(/gitdir:\s*(.+)/);
    if (m) {
      const gitdir = m[1].trim();
      const commonCandidate = join(gitdir, "..", "..", "config");
      if (existsSync(commonCandidate)) gitConfigPath = commonCandidate;
    }
  }
  const cfg = readTextSafe(gitConfigPath);
  if (!cfg) return null;
  // Prefer origin; fall back to first remote url.
  const originMatch = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
  const anyMatch = cfg.match(/url\s*=\s*(.+)/);
  const url = (originMatch?.[1] ?? anyMatch?.[1])?.trim();
  if (!url) return null;
  const parsed = parseRemote(url);
  if (!parsed) return null;
  return { repo: `${parsed.owner}/${parsed.name}`, owner: parsed.owner };
}

/**
 * Where this repo actually keeps its source. A monorepo has no `src/` at the
 * root, so reading only the root used to return nothing and silently fall back
 * to the generic default layers, which is the opposite of "derived from the
 * real structure".
 */
function sourceRoot(root: string): string | null {
  const direct = ["src", "app"].map((d) => join(root, d)).find(existsSync);
  if (direct) return direct;

  for (const workspace of ["packages", "apps"]) {
    const dir = join(root, workspace);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = ["src", "app"]
          .map((d) => join(dir, entry.name, d))
          .find(existsSync);
        if (nested) return nested;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Propose layers from real source subdirectories, capped to a sane set. */
function detectLayers(root: string): string[] | null {
  const srcDir = sourceRoot(root);
  if (!srcDir) return null;
  let entries: string[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return null;
  }
  return entries.length ? entries.slice(0, 8) : null;
}

/** Read `language` from ~/.claude/settings.json if present and readable. */
function detectLanguage(): string | undefined {
  const settings = readJsonSafe(join(homedir(), ".claude", "settings.json"));
  if (settings && typeof settings.language === "string") return settings.language;
  return undefined;
}

function gatherSignals(root: string): StackSignals {
  const has = (p: string) => existsSync(join(root, p));
  const pkg = readJsonSafe(join(root, "package.json"));

  const pyproject = readTextSafe(join(root, "pyproject.toml"));
  const requirements = readTextSafe(join(root, "requirements.txt"));
  const hasFastapi =
    /fastapi/i.test(pyproject ?? "") || /fastapi/i.test(requirements ?? "");

  const isMonorepo = Boolean(
    pkg?.workspaces ||
      has("pnpm-workspace.yaml") ||
      has("lerna.json") ||
      has("turbo.json"),
  );

  const hasNextConfig =
    ["next.config.js", "next.config.mjs", "next.config.ts"].some(has) ||
    Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);

  // Static site: index.html at root, no app framework manifest.
  const isStaticSite =
    has("index.html") && !pkg && !pyproject && !has("deno.json");

  return {
    hasPackageJson: Boolean(pkg),
    hasNextConfig,
    hasVercelJson: has("vercel.json"),
    hasBin: Boolean(pkg?.bin),
    isLibrary: Boolean(pkg && !pkg.bin && pkg.main && !pkg.private),
    hasPyproject: Boolean(pyproject),
    hasRequirements: Boolean(requirements),
    hasFastapi,
    hasDenoJson: has("deno.json") || has("deno.jsonc"),
    hasGoMod: has("go.mod"),
    hasCargoToml: has("Cargo.toml"),
    hasDockerfile: has("Dockerfile"),
    hasSupabaseDir: has("supabase"),
    isMonorepo,
    isStaticSite,
  };
}

/** Detect package manager from lockfiles / manifests. */
function detectPackageManager(root: string, signals: StackSignals): string | undefined {
  const has = (p: string) => existsSync(join(root, p));
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  if (signals.hasDenoJson) return "deno";
  if (signals.hasPyproject) return "uv/pip";
  if (signals.hasRequirements) return "pip";
  if (signals.hasGoMod) return "go";
  if (signals.hasCargoToml) return "cargo";
  if (signals.hasPackageJson) return "npm";
  return undefined;
}

function main(): void {
  const root = argRepoPath();
  if (!existsSync(root)) {
    console.error(JSON.stringify({ error: `repo-path not found: ${root}` }));
    process.exit(1);
  }

  const signals = gatherSignals(root);
  const profile = resolveStack(signals);
  const repoInfo = detectRepo(root);
  const layers = detectLayers(root);
  const language = detectLanguage();
  const packageManager = detectPackageManager(root, signals);
  const pkg = readJsonSafe(join(root, "package.json"));

  const out: PartialConfig = {
    isGitRepo: existsSync(join(root, ".git")),
    project: pkg?.name ?? repoInfo?.repo.split("/")[1] ?? basename(root),
    stack: profile.stack,
    layers: layers ?? profile.defaultLayers,
    deploy: profile.defaultDeploy,
  };
  if (repoInfo) {
    out.repo = repoInfo.repo;
    out.repoOwner = repoInfo.owner;
  }
  if (language) out.language = language;
  if (packageManager) out.packageManager = packageManager;

  console.log(JSON.stringify(out, null, 2));
}

main();
