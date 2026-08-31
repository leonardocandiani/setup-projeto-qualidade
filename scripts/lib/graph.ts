/**
 * graph.ts
 *
 * Module reachability for the tidy scanner. Builds an import graph over the
 * repo's own source files and walks it from the real entry points, so an
 * "unused file" claim rests on a resolved edge that does not exist, not on a
 * basename that happens not to appear in a grep.
 *
 * Deliberately conservative: anything it cannot resolve is treated as
 * REACHABLE. A false "still used" costs nothing; a false "unused" would ask a
 * human to quarantine a live file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

const SOURCE_EXT = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py",
];

const INDEX_BASENAMES = ["index", "__init__", "main", "mod"];

/** Files a runner or framework starts from, even with zero inbound imports. */
const ENTRY_PATTERNS: RegExp[] = [
  /^index\.[cm]?[jt]sx?$/,
  /^src\/(index|main|cli|server|app)\.[cm]?[jt]sx?$/,
  // Next.js app and pages routers, with or without the src/ layout.
  /^(?:src\/)?app\/(?:.*\/)?(page|layout|route|loading|error|not-found|template|default|global-error|sitemap|robots|opengraph-image|icon|manifest)\.[jt]sx?$/,
  /^(?:src\/)?pages\/.*\.[jt]sx?$/,
  /^(?:src\/)?(middleware|instrumentation)\.[jt]s$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)(tests?|e2e)\/.*\.[cm]?[jt]sx?$/,
  /(^|\/)conftest\.py$/,
  /(^|\/)test_[^/]+\.py$/,
  /\.config\.[cm]?[jt]s$/,
  /^supabase\/functions\/[^/]+\/index\.ts$/,
  /^functions\/[^/]+\/index\.[jt]s$/,
  /^(?:src\/)?api\/.*\.[jt]s$/,
]

const IMPORT_RE = [
  // Any `from "y"` clause. Deliberately loose so a multi-line import list still
  // resolves; an extra match only ever marks more files reachable.
  /\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\s)import\s*["']([^"']+)["']/g,
  // require("y") / import("y")
  /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
  // python: from a.b import c / import a.b
  /^\s*from\s+([.\w]+)\s+import\s/gm,
  /^\s*import\s+([.\w]+)\s*$/gm,
];

export interface Graph {
  /** repo-relative path -> set of repo-relative paths it imports */
  edges: Map<string, Set<string>>;
  /** repo-relative paths reachable from an entry point */
  reachable: Set<string>;
  /** entry points the walk started from */
  entries: string[];
  /** specifiers that could not be resolved to a repo file (bare deps included) */
  unresolved: Map<string, Set<string>>;
}

function isSource(path: string): boolean {
  return SOURCE_EXT.some((e) => path.endsWith(e));
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Candidate repo-relative paths a specifier could resolve to. */
function candidates(base: string): string[] {
  const out = [base];
  for (const ext of SOURCE_EXT) out.push(base + ext);
  for (const idx of INDEX_BASENAMES) {
    for (const ext of SOURCE_EXT) out.push(posix.join(base, idx + ext));
  }
  return out;
}

/** Alias prefixes from tsconfig/jsconfig `paths`, e.g. `@/*` -> `src/*`. */
function readAliases(root: string): { prefix: string; target: string }[] {
  const aliases: { prefix: string; target: string }[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const raw = readSafe(join(root, name));
    if (!raw) continue;
    // Strip comments/trailing commas enough for the paths block to parse.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1");
    let cfg: any;
    try {
      cfg = JSON.parse(stripped);
    } catch {
      continue;
    }
    const baseUrl: string = cfg?.compilerOptions?.baseUrl ?? ".";
    const paths: Record<string, string[]> = cfg?.compilerOptions?.paths ?? {};
    for (const [from, targets] of Object.entries(paths)) {
      const target = targets?.[0];
      if (!target) continue;
      aliases.push({
        prefix: from.replace(/\*$/, ""),
        target: posix.join(baseUrl === "." ? "" : baseUrl, target.replace(/\*$/, "")),
      });
    }
  }
  // Next.js convention that often has no tsconfig entry.
  if (!aliases.length && existsSync(join(root, "src"))) {
    aliases.push({ prefix: "@/", target: "src/" });
  }
  return aliases;
}

/**
 * Resolve one import specifier to a repo-relative path, or null when it is a
 * bare package or otherwise not ours.
 */
function resolveSpecifier(
  spec: string,
  fromFile: string,
  tracked: Set<string>,
  aliases: { prefix: string; target: string }[],
): string | null {
  let base: string | null = null;

  if (spec.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  } else {
    const alias = aliases.find((a) => a.prefix && spec.startsWith(a.prefix));
    if (alias) base = posix.normalize(posix.join(alias.target, spec.slice(alias.prefix.length)));
    else if (spec.startsWith("~/")) base = spec.slice(2);
    else if (/^[\w.]+$/.test(spec) && fromFile.endsWith(".py")) {
      // Python dotted module, relative to the repo root.
      base = spec.replace(/\./g, "/");
    }
  }
  if (base === null) return null;
  base = base.replace(/^\.\//, "");
  if (base.startsWith("..")) return null;

  for (const c of candidates(base)) {
    if (tracked.has(c)) return c;
  }
  return null;
}

/** Every import specifier appearing in a file's text. */
export function importsOf(text: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

/** File-ish tokens referenced from package.json (bin, main, exports, scripts). */
function packageJsonEntries(root: string, tracked: Set<string>): string[] {
  const raw = readSafe(join(root, "package.json"));
  if (!raw) return [];
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const cleaned = v.replace(/^\.\//, "");
    if (tracked.has(cleaned)) out.push(cleaned);
  };
  push(pkg.main);
  push(pkg.module);
  push(pkg.types);
  if (typeof pkg.bin === "string") push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object") Object.values(pkg.bin).forEach(push);
  const walkExports = (node: unknown) => {
    if (typeof node === "string") push(node);
    else if (node && typeof node === "object") Object.values(node).forEach(walkExports);
  };
  walkExports(pkg.exports);
  // Any tracked path named inside a script command counts as an entry point.
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    if (typeof cmd !== "string") continue;
    for (const token of cmd.split(/[\s'"=]+/)) {
      const cleaned = token.replace(/^\.\//, "");
      if (cleaned.includes(".") && tracked.has(cleaned)) out.push(cleaned);
    }
  }
  return out;
}

/**
 * Tracked source paths named inside a carrier that EXECUTES things: CI
 * workflows, Dockerfiles, shell scripts, Makefiles, hook configs. Prose that
 * merely names a file is not an entry point; the scanner tracks that separately
 * as a textual mention, which is a weaker signal and reported as such.
 */
function configEntries(root: string, tracked: string[]): string[] {
  const trackedSet = new Set(tracked);
  const carriers = tracked.filter(
    (p) =>
      p.startsWith(".github/workflows/") ||
      /(^|\/)Dockerfile/.test(p) ||
      p.endsWith(".sh") ||
      p === "Makefile" ||
      p === "lefthook.yml",
  );
  const out = new Set<string>();
  for (const carrier of carriers) {
    const text = readSafe(join(root, carrier));
    for (const token of text.split(/[\s'"`=(),;:]+/)) {
      // Docs point at scripts through a plugin-root variable
      // (`${CLAUDE_PLUGIN_ROOT}/workflows/x.js`); strip it to reach the
      // repo-relative path the carrier really names.
      const cleaned = token
        .replace(/^\$\{[^}]*\}\//, "")
        .replace(/^\.\//, "");
      if (cleaned.includes("/") && cleaned.includes(".") && trackedSet.has(cleaned)) {
        out.add(cleaned);
      }
    }
  }
  return [...out];
}

/** A shebang makes a file directly executable, so nothing needs to import it. */
function hasShebang(root: string, file: string): boolean {
  return readSafe(join(root, file)).startsWith("#!");
}

/** Build the import graph and walk it from every entry point. */
export function buildGraph(root: string, tracked: string[]): Graph {
  const trackedSet = new Set(tracked);
  const sources = tracked.filter(isSource);
  const aliases = readAliases(root);

  const edges = new Map<string, Set<string>>();
  const unresolved = new Map<string, Set<string>>();

  for (const file of sources) {
    const text = readSafe(join(root, file));
    const specs = importsOf(text);
    const targets = new Set<string>();
    const misses = new Set<string>();
    for (const spec of specs) {
      const hit = resolveSpecifier(spec, file, trackedSet, aliases);
      if (hit && hit !== file) targets.add(hit);
      else if (!hit) misses.add(spec);
    }
    edges.set(file, targets);
    if (misses.size) unresolved.set(file, misses);
  }

  const entries = new Set<string>();
  for (const file of sources) {
    if (ENTRY_PATTERNS.some((re) => re.test(file))) entries.add(file);
    else if (hasShebang(root, file)) entries.add(file);
  }
  for (const e of packageJsonEntries(root, trackedSet)) entries.add(e);
  for (const e of configEntries(root, tracked)) {
    if (isSource(e)) entries.add(e);
  }

  const reachable = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of edges.get(cur) ?? []) queue.push(next);
  }

  return { edges, reachable, entries: [...entries].sort(), unresolved };
}

/** Reverse edges: which files import `target`. */
export function importersOf(graph: Graph, target: string): string[] {
  const out: string[] = [];
  for (const [from, targets] of graph.edges) {
    if (targets.has(target)) out.push(from);
  }
  return out;
}

export { isSource };
