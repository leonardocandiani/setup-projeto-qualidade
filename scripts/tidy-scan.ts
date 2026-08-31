#!/usr/bin/env bun
/**
 * tidy-scan.ts
 *
 * Read-only clutter scanner. Inventories a repo and reports what is junk,
 * scratch, duplicated, orphaned, oversized or misplaced, with the EVIDENCE for
 * each claim, and prints JSON to stdout. It never writes, moves or deletes
 * anything: applying a cleanup is a separate script that only runs from a plan
 * a human approved.
 *
 * Every finding carries a confidence. `high` means a mechanical proof (identical
 * bytes, zero resolved importers AND zero textual mentions, git itself saying
 * the path is ignored). `medium` and `low` mean a human still has to look.
 *
 * Usage:
 *   bun scripts/tidy-scan.ts [--repo-path <path>] [--stale-days N]
 *                            [--max-findings N] [--heavy-mb N]
 *
 * Exit codes: 0 scan completed, 1 execution error, 2 usage error.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import {
  isGitRepo,
  lastTouchedMap,
  trackedButIgnored,
  trackedFiles,
  type GitDegradation,
} from "./lib/gitx.ts";
import { buildGraph, importersOf, isSource, type Graph } from "./lib/graph.ts";

type Confidence = "high" | "medium" | "low";
type Action = "quarantine" | "untrack" | "review";

interface Finding {
  class: string;
  path: string;
  bytes: number;
  /** Downgraded by the mention safety net when another file names this path. */
  confidence: Confidence;
  action: Action;
  evidence: string;
}

interface Options {
  repoPath: string;
  staleDays: number;
  maxFindings: number;
  heavyBytes: number;
}

const ENV_FILE_RE = new RegExp("(^|/)\\.env(\\.|$)(?!example|sample|template)");

/**
 * `safe: true` means untracking the path cannot break anything: the file is
 * machine-local noise that no build, deploy or import ever reads. `safe: false`
 * covers paths that are usually noise but that SOME repos publish on purpose
 * (a site that deploys `dist/` straight from git, a fixture log a test asserts
 * against), so those only ever get proposed for review, never auto-untracked.
 */
const JUNK_PATTERNS: { re: RegExp; why: string; safe: boolean }[] = [
  { re: /(^|\/)\.DS_Store$/, why: "macOS Finder metadata", safe: true },
  { re: /(^|\/)Thumbs\.db$/i, why: "Windows thumbnail cache", safe: true },
  { re: /(^|\/)desktop\.ini$/i, why: "Windows folder metadata", safe: true },
  { re: /\.(swp|swo)$/, why: "editor swap file", safe: true },
  { re: /(^|\/)\.idea\//, why: "IDE settings committed to git", safe: true },
  { re: /(^|\/)__pycache__\//, why: "Python bytecode cache", safe: true },
  { re: /\.pyc$/, why: "compiled Python bytecode", safe: true },
  { re: /(^|\/)\.venv\//, why: "virtualenv committed to git", safe: true },
  { re: /(^|\/)node_modules\//, why: "installed dependencies committed to git", safe: true },
  { re: /(^|\/)(dist|build|out)\//, why: "build output committed to git", safe: false },
  { re: /(^|\/)\.next\//, why: "Next.js build cache committed to git", safe: false },
  { re: /(^|\/)coverage\//, why: "coverage report committed to git", safe: false },
  { re: /\.log$/, why: "log file committed to git", safe: false },
  { re: ENV_FILE_RE, why: "environment file tracked in git; check it for live secrets", safe: false },
];

const SCRATCH_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\.(bak|old|orig|rej|tmp|temp)$/i, why: "backup or leftover merge artifact" },
  { re: /~$/, why: "editor backup file" },
  { re: /(^|\/)[^/]*\bcopy\b[^/]*$/i, why: "the filename says it is a copy" },
  {
    re: /(^|\/)[^/]*[-_ ](final|final2|new|novo|antigo|backup|bkp|deprecated)\.[^/.]+$/i,
    why: "the filename marks it as a superseded version",
  },
  {
    re: /(^|\/)(untitled|sem-titulo|asdf|aaa|teste?[0-9]*)\.[^/.]+$/i,
    why: "placeholder filename",
  },
  {
    re: /(^|\/)(fix|debug|check|scratch)[-_][^/]*\.(js|ts|mjs|cjs|py|sh)$/i,
    why: "one-off script filename",
  },
];

/** Files whose presence at the repo root is conventional. */
const ROOT_ALLOWLIST = new Set([
  "README.md", "LICENSE", "LICENSE.md", "CHANGELOG.md", "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md", "SECURITY.md", "AUTHORS.md", "CLAUDE.md", "AGENTS.md",
  "REVIEW.md", "Makefile", "Dockerfile", "docker-compose.yml", "lefthook.yml",
  ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc",
  ".dockerignore", ".prettierrc", ".eslintrc.json", "package.json",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "tsconfig.json", "jsconfig.json", "deno.json", "deno.jsonc", "pyproject.toml",
  "requirements.txt", "setup.py", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
  "vercel.json", "turbo.json", "lerna.json", "pnpm-workspace.yaml",
  "index.html", "robots.txt", "keepwright.config.json",
]);

const ROOT_ALLOWED_RE = [
  /^\..*rc(\.[a-z]+)?$/,
  /\.config\.[cm]?[jt]s$/,
  /^(next|vite|tailwind|postcss|jest|vitest|playwright|drizzle|eslint)\./,
  /^\.env\.(example|sample|template)$/,
];

function fail(message: string, code: 1 | 2): never {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(code);
}

function parseOptions(): Options {
  const argv = process.argv.slice(2);
  const known = ["--repo-path", "--stale-days", "--max-findings", "--heavy-mb"];
  for (const a of argv) {
    if (a.startsWith("--") && !known.includes(a)) {
      fail(`unknown flag: ${a} (known: ${known.join(", ")})`, 2);
    }
  }
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      fail(`${flag} expects a positive number, got: ${raw}`, 2);
    }
    return n;
  };
  return {
    repoPath: value("--repo-path") ?? process.cwd(),
    staleDays: num("--stale-days", 180),
    maxFindings: num("--max-findings", 400),
    heavyBytes: num("--heavy-mb", 1) * 1024 * 1024,
  };
}

function sizeOf(root: string, rel: string): number {
  try {
    return statSync(join(root, rel)).size;
  } catch {
    return 0;
  }
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rb",
  ".go", ".rs", ".java", ".kt", ".swift", ".php", ".sh", ".bash", ".zsh",
  ".md", ".mdx", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".css", ".scss", ".html", ".sql", ".graphql", ".template", ".xml",
]);

function isTextLike(rel: string): boolean {
  const ext = extname(rel).toLowerCase();
  return ext === "" ? false : TEXT_EXT.has(ext);
}

/**
 * How many OTHER tracked text files name this path or its basename. A file that
 * no document, config or script even mentions is a much safer quarantine
 * candidate than one merely absent from the import graph.
 */
function buildCorpus(root: string, tracked: string[]): { path: string; text: string }[] {
  const corpus: { path: string; text: string }[] = [];
  for (const rel of tracked) {
    if (!isTextLike(rel)) continue;
    if (sizeOf(root, rel) > 2 * 1024 * 1024) continue;
    const text = readSafe(join(root, rel));
    if (text !== null) corpus.push({ path: rel, text });
  }
  return corpus;
}

const GENERIC_STEMS = new Set(["index", "utils", "types", "config", "main", "route", "page"]);

/** The needles that count as naming `rel`: its path, its basename, and, when
 *  distinctive enough to mean something, its bare stem. */
function needlesFor(rel: string): string[] {
  const base = basename(rel);
  const stem = base.replace(/\.[^.]+$/, "");
  const needles = [rel, base];
  if (stem.length >= 5 && !GENERIC_STEMS.has(stem)) needles.push(stem);
  return needles;
}

function buildMentionIndex(root: string, tracked: string[]): Map<string, number> {
  const corpus = buildCorpus(root, tracked);
  const counts = new Map<string, number>();
  for (const rel of tracked) {
    const needles = needlesFor(rel);
    const hits = corpus.filter(
      (doc) => doc.path !== rel && needles.some((n) => doc.text.includes(n)),
    );
    counts.set(rel, hits.length);
  }
  return counts;
}

function hashFile(root: string, rel: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  } catch {
    return null;
  }
}

function ageInDays(stamp: number | undefined): number | null {
  if (stamp === undefined) return null;
  return Math.floor((Date.now() / 1000 - stamp) / 86_400);
}

function junkEvidence(hit: { why: string; safe: boolean }, isEnvFile: boolean): string {
  if (isEnvFile) {
    return `${hit.why}; untracking does not scrub history, so rotate any live credential it holds`;
  }
  if (hit.safe) {
    return `${hit.why}; machine-local and regenerable, so untracking loses nothing on disk`;
  }
  return `${hit.why}; usually noise, but some repos publish this path on purpose, so confirm nothing deploys from it`;
}

function collectJunk(tracked: string[], root: string, out: Finding[]): void {
  for (const rel of tracked) {
    const hit = JUNK_PATTERNS.find((p) => p.re.test(rel));
    if (hit === undefined) continue;
    const isEnvFile = ENV_FILE_RE.test(rel);
    out.push({
      class: isEnvFile ? "secret-risk" : "junk",
      path: rel,
      bytes: sizeOf(root, rel),
      confidence: "high",
      action: hit.safe && !isEnvFile ? "untrack" : "review",
      evidence: junkEvidence(hit, isEnvFile),
    });
  }
}

function collectIgnored(root: string, out: Finding[]): void {
  for (const rel of trackedButIgnored(root)) {
    out.push({
      class: "gitignore-gap",
      path: rel,
      bytes: sizeOf(root, rel),
      confidence: "high",
      action: "review",
      // The disagreement is proven; which side is wrong is not. A repo that
      // deploys by cloning needs the file tracked and the pattern narrowed.
      evidence:
        "the repo's own .gitignore matches this path, yet git still tracks it; resolve it by untracking the file OR by narrowing the ignore pattern, never by guessing",
    });
  }
}

function collectScratch(tracked: string[], root: string, out: Finding[]): void {
  for (const rel of tracked) {
    if (JUNK_PATTERNS.some((p) => p.re.test(rel))) continue;
    const hit = SCRATCH_PATTERNS.find((p) => p.re.test(rel));
    if (!hit) continue;
    out.push({
      class: "scratch",
      path: rel,
      bytes: sizeOf(root, rel),
      confidence: "medium",
      action: "quarantine",
      evidence: hit.why,
    });
  }
}

function collectEmpty(tracked: string[], root: string, out: Finding[]): void {
  for (const rel of tracked) {
    if (sizeOf(root, rel) !== 0) continue;
    if (/(^|\/)(\.gitkeep|\.keep|__init__\.py|py\.typed)$/.test(rel)) continue;
    out.push({
      class: "empty",
      path: rel,
      bytes: 0,
      confidence: "high",
      action: "quarantine",
      evidence: "zero-byte tracked file",
    });
  }
}

function collectDuplicates(tracked: string[], root: string, out: Finding[]): void {
  const byHash = new Map<string, string[]>();
  for (const rel of tracked) {
    const size = sizeOf(root, rel);
    if (size === 0 || size > 5 * 1024 * 1024) continue;
    const h = hashFile(root, rel);
    if (h === null) continue;
    const list = byHash.get(h) ?? [];
    list.push(rel);
    byHash.set(h, list);
  }
  for (const paths of byHash.values()) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const [keep, ...rest] = sorted;
    for (const rel of rest) {
      out.push({
        class: "duplicate",
        path: rel,
        bytes: sizeOf(root, rel),
        confidence: "high",
        action: "review",
        evidence: `byte-identical to ${keep}; keep one and import it from the other call site`,
      });
    }
  }
}

/** Everything the orphan pass needs to judge one file, gathered once. */
interface ScanContext {
  root: string;
  opts: Options;
  graph: Graph;
  mentions: Map<string, number>;
  touched: Map<string, number> | null;
}

/** A source file nothing runs and nothing imports, or null when it is used. */
function judgeOrphan(rel: string, ctx: ScanContext): Finding | null {
  if (!isSource(rel)) return null;
  if (ctx.graph.reachable.has(rel)) return null;
  if (JUNK_PATTERNS.some((p) => p.re.test(rel))) return null;
  // Imported by something, even if that something is itself unreachable: the
  // pair travels together, so it gets judged as a cluster, not as a lone file.
  if (importersOf(ctx.graph, rel).length > 0) return null;

  const mentioned = ctx.mentions.get(rel) ?? 0;
  const age = ageInDays(ctx.touched?.get(rel));
  const ageNote = age === null ? "file age unknown" : `last commit ${age}d ago`;
  const bytes = sizeOf(ctx.root, rel);

  if (mentioned > 0) {
    return {
      class: "unreferenced-code",
      path: rel,
      bytes,
      confidence: "low",
      action: "review",
      evidence: `no entry point reaches it and zero files import it, but ${mentioned} tracked file(s) name it in prose or config; ${ageNote}`,
    };
  }
  return {
    class: "orphan",
    path: rel,
    bytes,
    confidence: age !== null && age >= ctx.opts.staleDays ? "high" : "medium",
    action: "quarantine",
    evidence: `no entry point reaches it, zero files import it, and no other tracked file mentions it by name; ${ageNote}`,
  };
}

function collectOrphans(tracked: string[], ctx: ScanContext, out: Finding[]): void {
  for (const rel of tracked) {
    const finding = judgeOrphan(rel, ctx);
    if (finding !== null) out.push(finding);
  }
}

function collectHeavy(tracked: string[], root: string, opts: Options, out: Finding[]): void {
  for (const rel of tracked) {
    const size = sizeOf(root, rel);
    if (size < opts.heavyBytes) continue;
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum)$/.test(rel)) {
      continue;
    }
    out.push({
      class: "heavy",
      path: rel,
      bytes: size,
      confidence: "medium",
      action: "review",
      evidence: `${(size / 1024 / 1024).toFixed(1)} MB tracked in git; every clone pays for it forever`,
    });
  }
}

function collectRootClutter(tracked: string[], root: string, out: Finding[]): void {
  for (const rel of tracked) {
    if (rel.includes("/")) continue;
    if (ROOT_ALLOWLIST.has(rel)) continue;
    if (ROOT_ALLOWED_RE.some((re) => re.test(rel))) continue;
    if (JUNK_PATTERNS.some((p) => p.re.test(rel))) continue;
    out.push({
      class: "root-clutter",
      path: rel,
      bytes: sizeOf(root, rel),
      confidence: "low",
      action: "review",
      evidence: "loose file at the repo root, outside the conventional set; it likely belongs in docs/, scripts/ or src/",
    });
  }
}

function collectDeadScripts(root: string, tracked: Set<string>, out: Finding[]): void {
  const raw = readSafe(join(root, "package.json"));
  if (raw === null) return;
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    out.push({
      class: "dead-script",
      path: "package.json",
      bytes: 0,
      confidence: "high",
      action: "review",
      evidence: "package.json is not valid JSON, so no tooling that reads it can be working",
    });
    return;
  }

  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (typeof cmd !== "string") continue;
    for (const token of cmd.split(/[\s'"=]+/)) {
      const cleaned = token.replace(/^\.\//, "");
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|sh)$/.test(cleaned)) continue;
      if (tracked.has(cleaned) || existsSync(join(root, cleaned))) continue;
      out.push({
        class: "dead-script",
        path: "package.json",
        bytes: 0,
        confidence: "high",
        action: "review",
        evidence: `script "${name}" runs ${cleaned}, which does not exist in the repo`,
      });
    }
  }
}

function summarize(findings: Finding[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const f of findings) by[f.class] = (by[f.class] ?? 0) + 1;
  return by;
}

function main(): void {
  const opts = parseOptions();
  const root = opts.repoPath;

  if (!existsSync(root)) fail(`repo-path not found: ${root}`, 1);
  if (!isGitRepo(root)) {
    fail(
      `not a git repository: ${root}. tidy proves what is unused from git history and tracked paths; run 'git init' and commit first`,
      1,
    );
  }

  const degraded: GitDegradation[] = [];
  const tracked = trackedFiles(root).filter((p) => !p.startsWith(".attic/"));

  if (tracked.length === 0) {
    console.log(JSON.stringify({
      repoPath: root,
      scannedAt: new Date().toISOString().slice(0, 10),
      totals: { trackedFiles: 0, findings: 0 },
      byClass: {},
      findings: [],
      note: "0 tracked files: nothing is committed yet, so there is nothing to tidy",
    }, null, 2));
    return;
  }

  const touched = lastTouchedMap(root);
  if (touched === null) {
    degraded.push({
      source: "git log",
      error: "history walk failed or timed out; file age is unknown, so staleness never raises a finding's confidence",
    });
  }

  const graph = buildGraph(root, tracked);
  const mentions = buildMentionIndex(root, tracked);

  // Collector order is the precedence order: the first one to claim a path wins,
  // so a committed build artifact is reported as junk and not again as an orphan.
  const findings: Finding[] = [];
  collectJunk(tracked, root, findings);
  collectIgnored(root, findings);
  collectScratch(tracked, root, findings);
  collectEmpty(tracked, root, findings);
  collectDuplicates(tracked, root, findings);
  collectOrphans(tracked, { root, opts, graph, mentions, touched }, findings);
  collectHeavy(tracked, root, opts, findings);
  collectRootClutter(tracked, root, findings);
  collectDeadScripts(root, new Set(tracked), findings);

  // Cross-cutting safety net. A quarantine is a proposal to move a file out of
  // its place, so it only survives when NOTHING else in the repo names it. A
  // doc, a config or a script that mentions the path is enough to turn the
  // proposal back into a question, whichever collector raised it.
  for (const f of findings) {
    if (f.action !== "quarantine") continue;
    const mentioned = mentions.get(f.path) ?? 0;
    if (mentioned === 0) continue;
    f.action = "review";
    f.confidence = "low";
    f.evidence = `${f.evidence}; held back because ${mentioned} other tracked file(s) name this path`;
  }

  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    // dead-script findings all sit on package.json, so their evidence is what
    // makes each one distinct.
    const key = f.class === "dead-script" ? `${f.path}::${f.evidence}` : f.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.bytes - a.bytes);

  const shown = deduped.slice(0, opts.maxFindings);
  const bytesTracked = tracked.reduce((n, rel) => n + sizeOf(root, rel), 0);
  const bytesFlagged = deduped.reduce((n, f) => n + f.bytes, 0);

  const result: Record<string, unknown> = {
    repoPath: root,
    scannedAt: new Date().toISOString().slice(0, 10),
    totals: {
      trackedFiles: tracked.length,
      sourceFiles: tracked.filter(isSource).length,
      entryPoints: graph.entries.length,
      bytesTracked,
      findings: deduped.length,
      bytesFlagged,
      highConfidence: deduped.filter((f) => f.confidence === "high").length,
    },
    byClass: summarize(deduped),
    findings: shown,
  };

  if (degraded.length > 0) {
    result.degraded = degraded;
    result.warning = "one or more evidence sources failed, so the findings below are INCOMPLETE";
  }
  if (deduped.length > shown.length) {
    result.truncated = `showing ${shown.length} of ${deduped.length} findings; raise --max-findings to see the rest`;
  }
  if (deduped.length === 0) {
    result.note = `0 findings across ${tracked.length} tracked files: this repo is already tidy by every check tidy-scan runs`;
  }
  result.help = "nothing was modified. Run /keepwright:tidy to turn this scan into a reviewed, reversible cleanup plan";

  console.log(JSON.stringify(result, null, 2));
}

main();
