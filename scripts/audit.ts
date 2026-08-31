#!/usr/bin/env bun
/**
 * audit.ts
 *
 * Read-only integration audit. Checks whether a target repo carries the full
 * keepwright surface: CLAUDE.md (pointing to every rule), the rules set, the
 * expected workflows, validators, and hooks.
 *
 * Usage:
 *   bun scripts/audit.ts [--repo-path <path>]
 *   npx tsx scripts/audit.ts [--repo-path <path>]
 *
 * Output: JSON `{ coverage: 0..100, missing: [...], present: [...] }`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SELF_DIR, "..");
const TEMPLATES = join(PLUGIN_ROOT, "templates");

function argRepoPath(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--repo-path");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

function listTemplateNames(subdir: string, suffix = ".template"): string[] {
  const dir = join(TEMPLATES, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => e.name.replace(/\.template$/, ""));
}

/** Marker the generated workflows and hooks carry, so the audit can tell a
 *  keepwright-installed file from one the repo already had. */
const OWNERSHIP_MARKER = "keepwright:managed";
const MARKED_PATHS = [join(".github", "workflows"), "lefthook.yml"];

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build the list of expected destination paths the audit checks for, derived
 * from the templates shipped in this plugin (so it tracks template changes).
 * Deploy is checked as the single installed `deploy.yml` when any deploy
 * workflow exists in the repo.
 */
function expectedPaths(): string[] {
  const paths: string[] = ["CLAUDE.md", "REVIEW.md"];

  paths.push(join(".claude", "settings.json"));
  paths.push(join(".claude", "agents", "worker.md"));

  for (const r of listTemplateNames("rules")) {
    paths.push(join(".claude", "rules", r));
  }
  for (const v of listTemplateNames("validators")) {
    paths.push(join("scripts", "validators", v));
  }
  for (const h of listTemplateNames("hooks")) {
    paths.push(join("scripts", "hooks", h));
  }
  for (const w of listTemplateNames("workflows")) {
    if (!w.endsWith(".yml")) continue;
    paths.push(join(".github", "workflows", w));
  }

  return paths;
}

function main(): void {
  const root = argRepoPath();
  if (!existsSync(root)) {
    console.error(JSON.stringify({ error: `repo-path not found: ${root}` }));
    process.exit(1);
  }

  // Each check contributes one unit to coverage: every expected file plus one
  // pointer check per rule (CLAUDE.md must reference each installed rule).
  const present: string[] = [];
  const missing: string[] = [];

  for (const rel of expectedPaths()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    // A path existing is not the same as keepwright owning it. A repo that
    // already had its own `.github/workflows/ci.yml` used to count as covered,
    // reporting a green coverage for a pipeline that runs none of these checks.
    // Generated workflows and hooks carry a marker, so the audit can tell the
    // difference; everything else is judged by presence, as before.
    if (MARKED_PATHS.some((p) => rel === p || rel.startsWith(p))) {
      const text = readSafe(abs) ?? "";
      if (text.includes(OWNERSHIP_MARKER)) present.push(rel);
      else missing.push(`${rel} (exists, but is not the keepwright one)`);
      continue;
    }
    present.push(rel);
  }

  // CLAUDE.md must point to every installed rule. A rule present but not
  // referenced in CLAUDE.md is "invisible" to whoever reads only CLAUDE.md.
  const claudeMd = readSafe(join(root, "CLAUDE.md")) ?? "";
  for (const rule of listTemplateNames("rules")) {
    const ref = `.claude/rules/${rule}`;
    const check = `CLAUDE.md → ${ref}`;
    const installed = existsSync(join(root, ".claude", "rules", rule));
    if (installed && claudeMd.includes(ref)) present.push(check);
    else missing.push(check);
  }

  const total = present.length + missing.length;
  const coverage = total === 0 ? 0 : Math.round((present.length / total) * 100);

  console.log(JSON.stringify({ coverage, missing, present }, null, 2));
}

main();
