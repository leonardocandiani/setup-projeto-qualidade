#!/usr/bin/env bun
/**
 * apply.ts
 *
 * Deterministic apply engine. Reads a keepwright config JSON, substitutes
 * placeholders into every template, and writes each to its destination,
 * idempotently. Before any write, runs an anti-secret scan over the resolved
 * contents and aborts if a forbidden pattern is found.
 *
 * Usage:
 *   bun scripts/apply.ts <config.json> [--repo-path <path>]
 *   npx tsx scripts/apply.ts <config.json> [--repo-path <path>]
 *
 * Output: JSON summary `{ created: [], skipped: [], updated: [] }`.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { substitute, type KeepwrightConfig } from "./lib/placeholders.ts";
import { copyTemplate, type WriteResult } from "./lib/fsx.ts";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at repo root → plugin root is one level up.
const PLUGIN_ROOT = resolve(SELF_DIR, "..");
const TEMPLATES = join(PLUGIN_ROOT, "templates");

/**
 * The secret shapes every check in keepwright shares, read from the single
 * source in `templates/validators/secret-patterns.ere`. That file is data: the
 * shell greps in the workflows read it with `grep -E -f` and this engine reads
 * it with `new RegExp`, so a pattern added there arms all of them at once.
 * There used to be five hand-maintained copies of this list, already diverging,
 * and that divergence is what produced the banned-terms false positive that
 * blocked any PR editing REVIEW.md.
 */
const PATTERN_FILE = join(TEMPLATES, "validators", "secret-patterns.ere.template");

function loadSecretPatterns(): RegExp[] {
  const raw = readFileSync(PATTERN_FILE, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => new RegExp(l, "m"));
}

const SECRET_PATTERNS: RegExp[] = loadSecretPatterns();

/**
 * A real git trailer, anchored to the start of a line. Kept out of the shared
 * pattern file on purpose: it is authorship, not a credential, and the anchor
 * is what stops it from matching prose that merely documents the string.
 */
const AI_AUTHORSHIP = /^Co-Authored-By: Claude/m;

interface Summary {
  created: string[];
  skipped: string[];
  updated: string[];
}

function argRepoPath(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--repo-path");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

function loadConfig(path: string): KeepwrightConfig {
  const raw = readFileSync(path, "utf-8");
  const cfg = JSON.parse(raw) as KeepwrightConfig;
  if (!cfg.project || !cfg.repo || !cfg.stack || !cfg.deploy) {
    throw new Error(
      "config missing required fields (project, repo, stack, deploy)",
    );
  }
  return cfg;
}

/**
 * Files whose content is EXECUTED or consumed by a machine. A `{{TOKEN}}` that
 * survives substitution is fine in prose a human fills in later, and fatal
 * here: `lefthook.yml` would try to run the literal string as a command, a
 * workflow would post the raw token into a pull request.
 *
 * Docs are the exception, not the rule, so the list below is what stays
 * tolerant, and everything else is checked.
 */
function toleratesPlaceholders(dest: string): boolean {
  return (
    dest.endsWith(".md") &&
    !dest.startsWith(join(".github", "workflows")) &&
    dest !== "lefthook.yml"
  );
}

/**
 * Two placeholders are legitimately left for the maintainer even in an
 * executable file, because only they know the value. Each one is guarded at
 * runtime by a fail-fast step in its own workflow, so a forgotten value stops
 * the job on its first step with a message naming what to set.
 */
const HUMAN_FILLED = new Set(["BUILD_DIR", "SUPABASE_PROJECT_REF"]);

/** Placeholders left unresolved in a file that a machine will execute. */
function unresolvedPlaceholders(text: string, dest: string): string[] {
  if (toleratesPlaceholders(dest)) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
    if (!HUMAN_FILLED.has(m[1])) found.add(m[1]);
  }
  return [...found];
}

/**
 * Resolve every template in memory and refuse the whole run if any of them
 * carries a secret or would ship a literal placeholder into an executable file.
 * Nothing is written before this passes, so a rejected install leaves the repo
 * exactly as it was.
 */
function assertResolvable(
  mapping: { src: string; dest: string }[],
  config: KeepwrightConfig,
): void {
  const stranded: string[] = [];
  for (const { src, dest } of mapping) {
    if (!existsSync(src)) continue;
    const resolved = substitute(readFileSync(src, "utf-8"), config);
    scanSecrets(resolved, dest);
    for (const token of unresolvedPlaceholders(resolved, dest)) {
      stranded.push(`${dest}: {{${token}}}`);
    }
  }
  if (stranded.length === 0) return;
  throw new Error(
    `refusing to install: ${stranded.length} placeholder(s) would ship literal into a file that gets executed, ` +
      `which breaks it at runtime instead of at install time. Add the token to buildPlaceholderMap in ` +
      `scripts/lib/placeholders.ts, or give it a fail-fast guard and list it in HUMAN_FILLED. ` +
      `Stranded: ${stranded.join("; ")}`,
  );
}

/** Scan resolved text for a credential shape or a real AI authorship trailer. */
function scanSecrets(text: string, label: string): void {
  // The pattern file itself holds patterns, never values. Scanning it would
  // mean a pattern that happens to match its own text blocks every install.
  if (label.endsWith("secret-patterns.ere")) return;

  for (const p of [...SECRET_PATTERNS, AI_AUTHORSHIP]) {
    if (p.test(text)) {
      throw new Error(`anti-secret scan blocked ${label}: matched ${p}`);
    }
  }
}

/** List files in a dir (non-recursive); empty array if dir is absent. */
function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

/**
 * Build the full (srcTemplate → destRelative) mapping for a config.
 * Deploy is resolved to a single variant by config.deploy.
 */
function buildMapping(config: KeepwrightConfig): { src: string; dest: string }[] {
  const t = (p: string) => join(TEMPLATES, p);
  const pairs: { src: string; dest: string }[] = [];

  // Root docs.
  pairs.push({ src: t("CLAUDE.md.template"), dest: "CLAUDE.md" });
  pairs.push({ src: t("REVIEW.md.template"), dest: "REVIEW.md" });
  pairs.push({ src: t("lefthook.yml.template"), dest: "lefthook.yml" });
  pairs.push({
    src: t("PULL_REQUEST_TEMPLATE.md.template"),
    dest: join(".github", "PULL_REQUEST_TEMPLATE.md"),
  });
  pairs.push({
    src: t("settings.json.template"),
    dest: join(".claude", "settings.json"),
  });
  pairs.push({
    src: t("agents/worker.md.template"),
    dest: join(".claude", "agents", "worker.md"),
  });

  // Rules: NN-*.md.template → .claude/rules/NN-*.md
  for (const f of listDir(t("rules"))) {
    pairs.push({
      src: t(join("rules", f)),
      dest: join(".claude", "rules", f.replace(/\.template$/, "")),
    });
  }

  // Validators: *.ts.template → scripts/validators/*.ts
  for (const f of listDir(t("validators"))) {
    pairs.push({
      src: t(join("validators", f)),
      dest: join("scripts", "validators", f.replace(/\.template$/, "")),
    });
  }

  // Hooks: gen-*.ts.template → scripts/hooks/gen-*.ts
  for (const f of listDir(t("hooks"))) {
    pairs.push({
      src: t(join("hooks", f)),
      dest: join("scripts", "hooks", f.replace(/\.template$/, "")),
    });
  }

  // Shell scripts: *.sh.template → scripts/*.sh
  for (const f of listDir(t("scripts"))) {
    pairs.push({
      src: t(join("scripts", f)),
      dest: join("scripts", f.replace(/\.template$/, "")),
    });
  }

  // Lessons: *.md.template → docs/lessons/*.md (keep filenames)
  for (const f of listDir(t("lessons"))) {
    pairs.push({
      src: t(join("lessons", f)),
      dest: join("docs", "lessons", f.replace(/\.template$/, "")),
    });
  }

  // Workflows (non-deploy): ci, claude-mention, pr-auto-merge, pr-auto-review.
  for (const f of listDir(t("workflows"))) {
    if (!f.endsWith(".yml.template")) continue;
    pairs.push({
      src: t(join("workflows", f)),
      dest: join(".github", "workflows", f.replace(/\.template$/, "")),
    });
  }

  // Issue templates: *.template → .github/ISSUE_TEMPLATE/* (bug_report, feature_request, config)
  for (const f of listDir(t(join(".github", "ISSUE_TEMPLATE")))) {
    pairs.push({
      src: t(join(".github", "ISSUE_TEMPLATE", f)),
      dest: join(".github", "ISSUE_TEMPLATE", f.replace(/\.template$/, "")),
    });
  }

  // Deploy: pick the single variant by config.deploy → .github/workflows/deploy.yml
  if (config.deploy !== "none") {
    const variant = t(join("workflows", "deploy", `${config.deploy}.yml.template`));
    if (existsSync(variant)) {
      pairs.push({
        src: variant,
        dest: join(".github", "workflows", "deploy.yml"),
      });
    }
  }

  return pairs;
}

/**
 * Equalization for a repo that already had its own CLAUDE.md.
 *
 * `copyTemplate` never clobbers an existing file, which is right: the
 * maintainer's constitution is theirs. But the same run installs the rules AND
 * the validator that fails CI when a rule has no pointer, so a brownfield repo
 * used to end up with a red pipeline on its first push. This closes that by
 * APPENDING the missing pointers, never rewriting a line the maintainer wrote,
 * and it is a no-op once the pointers are there.
 */
function equalizeExistingClaudeMd(
  repoPath: string,
  installedRules: string[],
): string[] {
  const claudeMdPath = join(repoPath, "CLAUDE.md");
  if (!existsSync(claudeMdPath) || installedRules.length === 0) return [];

  const current = readFileSync(claudeMdPath, "utf-8");
  const missing = installedRules.filter((rule) => !current.includes(`.claude/rules/${rule}`));
  if (missing.length === 0) return [];

  const lines = missing.map((rule) => {
    const title = rule.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/-/g, " ");
    return `- [\`${rule}\`](.claude/rules/${rule}) — ${title}`;
  });
  const section = [
    "",
    "## Rules index",
    "",
    "Every rule under `.claude/rules/` needs a pointer here; a rule with no",
    "pointer is a rule nobody reads, and CI fails on the mismatch. Rewrite this",
    "section in your own words whenever you like, as long as the links survive.",
    "",
    ...lines,
    "",
  ].join("\n");

  const prefix = current.endsWith("\n") ? "" : "\n";
  writeFileSync(claudeMdPath, `${current}${prefix}${section}`, "utf-8");
  return missing;
}

function main(): void {
  const configPath = process.argv[2];
  if (!configPath || configPath.startsWith("--")) {
    console.error(
      JSON.stringify({ error: "usage: apply.ts <config.json> [--repo-path <p>]" }),
    );
    process.exit(2);
  }

  const config = loadConfig(configPath);
  const repoPath = argRepoPath();

  const summary: Summary = { created: [], skipped: [], updated: [] };
  const record = (dest: string, r: WriteResult) => {
    summary[r].push(dest);
  };

  // --- Pass 1: resolve everything in memory + run the anti-secret scan.
  // Abort before ANY write if a forbidden pattern surfaces.
  const mapping = buildMapping(config);
  assertResolvable(mapping, config);

  // --- Pass 2: write idempotently.
  //
  // The orchestration workflows (workflows/*.js) are deliberately NOT copied
  // into the target repo. Nothing there invokes them, and they cannot run
  // standalone: they depend on globals the Workflow tool injects (agent,
  // parallel, phase). The copy never overwrote, so it silently aged while the
  // plugin evolved, and it read like live code to anyone browsing the repo. The
  // commands load them from the plugin root instead.
  for (const { src, dest } of mapping) {
    if (!existsSync(src)) continue;
    const r = copyTemplate(src, join(repoPath, dest), config);
    record(dest, r);
  }
  // Brownfield equalization: a pre-existing CLAUDE.md keeps every word it had,
  // and gains pointers to the rules this run just installed.
  const installedRules = listDir(join(TEMPLATES, "rules")).map((f) =>
    f.replace(/\.template$/, ""),
  );
  const equalized = equalizeExistingClaudeMd(repoPath, installedRules);

  console.log(JSON.stringify(
    equalized.length > 0 ? { ...summary, equalized } : summary,
    null,
    2,
  ));
}

main();
