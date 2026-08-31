/**
 * placeholders.ts
 *
 * Placeholder substitution for keepwright templates.
 *
 * Templates carry two kinds of `{{TOKEN}}`:
 *   - config-derived tokens (PROJECT, REPO, STACK, ...) — filled from the
 *     keepwright config here;
 *   - free-text tokens (ARCHITECTURE, DESCRIPTION, lesson narrative, ...) — the
 *     maintainer fills these by hand after install.
 *
 * We only replace tokens we KNOW. Unknown `{{...}}` are left intact on purpose
 * so the human can spot and fill them. This also keeps GitHub Actions
 * expressions (`${{ secrets.X }}`, `${{ github.event... }}`) untouched, since
 * those keys are never in our map.
 */

export interface KeepwrightConfig {
  project: string;
  repo: string;
  repoOwner?: string;
  maintainer?: string;
  language?: string;
  stack: string;
  layers?: string[];
  deploy:
    | "vercel"
    | "supabase-functions"
    | "docker-ghcr"
    | "npm-publish"
    | "static-pages"
    | "none";
  runner?: "self-hosted" | "github";
  auth?: "oauth" | "apikey";
  criticalFiles?: string[];
  issues?: {
    /** Issue triage workflow. `github-models` runs free in Actions; `off` disables it. */
    triage?: "off" | "github-models";
    /** GitHub Models model id for the classify step. */
    model?: string;
  };
  derivedPatterns?: {
    design?: string[];
    voice?: string[];
  };
}

import { commandsFor } from "./stacks.ts";

/**
 * Grep pattern used when the maintainer declared no critical files. It is valid
 * ERE and cannot match a real path, so the warning step stays inert and visible
 * rather than quietly matching nothing.
 */
const NO_CRITICAL_FILE = "__keepwright_no_critical_file_configured__";

/** Recommended Claude model for the AI review/mention workflows. */
export const DEFAULT_REVIEW_MODEL = "claude-opus-4-8[1m]";

/**
 * Render the patterns the derive-patterns workflow mined from the repo as a
 * markdown list the review can actually read. The schema declared these and the
 * workflow produced them, but nothing injected them anywhere, so the standard a
 * PR was held to stayed generic instead of being the repo's own. An empty list
 * says so plainly rather than leaving a blank the reviewer has to interpret.
 */
function renderPatterns(patterns: string[] | undefined, kind: string): string {
  if (!patterns || patterns.length === 0) {
    return `_No ${kind} patterns derived yet. Run \`/keepwright:setup --mode maintain\` to mine them from this repo._`;
  }
  return patterns.map((p) => `- ${p}`).join("\n");
}

/** Derive repoOwner from `owner/name` when not set explicitly. */
function ownerOf(config: KeepwrightConfig): string {
  if (config.repoOwner) return config.repoOwner;
  const slash = config.repo.indexOf("/");
  return slash > 0 ? config.repo.slice(0, slash) : config.repo;
}

/**
 * Build the token → value map for a config. Only config-derivable tokens are
 * present; everything else stays as a literal `{{TOKEN}}` in the output.
 */
export function buildPlaceholderMap(
  config: KeepwrightConfig,
): Record<string, string> {
  const today = new Date().toISOString().slice(0, 10);
  const crit = config.criticalFiles ?? [];
  // lefthook.yml EXECUTES these, so they can never ship as a literal token.
  const cmds = commandsFor(config.stack);
  return {
    PROJECT: config.project,
    // Used to build shell variable names (e.g. {{PROJECT_UPPER}}_MERGE_UNSAFE).
    // A project called "my-app" would otherwise yield ${MY-APP_MERGE_UNSAFE:-},
    // which bash reads as the default-value form ${VAR-word} and silently
    // expands to the literal word instead of the variable.
    PROJECT_UPPER: config.project.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    REPO: config.repo,
    REPO_OWNER: ownerOf(config),
    MAINTAINER: config.maintainer ?? ownerOf(config),
    STACK: config.stack,
    LAYERS_REF: (config.layers ?? []).join(", "),
    REVIEW_MODEL: DEFAULT_REVIEW_MODEL,
    CMD_TYPECHECK: cmds.typecheck,
    SOURCE_GLOB: cmds.sourceGlob,
    // Referenced by the PR auto-review comment; without a value the bot posts
    // the raw token into every PR that touches a critical file.
    INVARIANT_REFS: (config.layers ?? []).length
      ? `the invariants for ${(config.layers ?? []).join(", ")}`
      : "the invariants in this repo",
    // GitHub Actions runner. self-hosted only when the config asks for it;
    // otherwise the generic GitHub-hosted runner, so workflows run in any repo.
    RUNNER: config.runner === "self-hosted" ? "[self-hosted, linux, x64]" : "ubuntu-latest",
    // Issue triage. `github-models` runs the classifier free in Actions over the
    // GITHUB_TOKEN; `off` makes the triage workflow a no-op via its top-level if.
    ISSUES_TRIAGE: config.issues?.triage ?? "github-models",
    TRIAGE_MODEL: config.issues?.model ?? "openai/gpt-4o-mini",
    CURRENT_DATE: today,
    DATE_YYYY_MM_DD: today,
    DATE: today,
    // criticalFiles[0..1] become grep patterns in the PR auto-review workflow.
    // These used to be left literal when unset, which made the workflow grep the
    // changed-file list for the string "{{CRITICAL_FILE_1}}": it never matched,
    // so the critical-file warning silently never fired and the repo looked
    // protected while nothing watched it. When the maintainer declared no
    // critical files, the pattern is now an explicit sentinel that matches no
    // real path, so the step is visibly inert instead of invisibly broken.
    DERIVED_DESIGN: renderPatterns(config.derivedPatterns?.design, "design"),
    DERIVED_VOICE: renderPatterns(config.derivedPatterns?.voice, "voice"),
    CRITICAL_FILE_1: crit[0] ?? NO_CRITICAL_FILE,
    CRITICAL_FILE_2: crit[1] ?? NO_CRITICAL_FILE,
  };
}

/**
 * Substitute known placeholders in `text`. Unknown `{{TOKEN}}` are preserved.
 */
export function substitute(text: string, config: KeepwrightConfig): string {
  const map = buildPlaceholderMap(config);
  // Match {{ NAME }} with optional inner spacing, uppercase + underscore only.
  // GitHub Actions expressions use `${{ ... }}` (leading `$`) and lowercase
  // dotted keys, so they never match this and never live in our map anyway.
  return text.replace(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g, (whole, key) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole;
  });
}
