# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/).

## [2.3.0] — 2026-08-31

### Added

- **New command `/keepwright:tidy` and its `tidy` skill** — non-destructive
  cleanup for repos that have accumulated junk, scratch files, duplicates, dead
  modules and misplaced folders. The contract is that nothing is ever deleted:
  a file that leaves its place is moved into `.attic/<date>/` with its original
  path preserved, a file that should not be in git is untracked and stays on
  disk, and every run is reversible from a manifest.
- **`scripts/tidy-scan.ts`** — a read-only scanner that produces evidence rather
  than opinions. It classifies findings as junk, gitignore-gap, secret-risk,
  scratch, empty, duplicate, orphan, unreferenced-code, heavy, root-clutter and
  dead-script, and attaches a confidence plus the concrete evidence to each one.
  `high` means a mechanical proof (identical SHA-256, git itself reporting a
  tracked path as ignored, a zero-byte file, a `package.json` script pointing at
  a missing file, a source file that no entry point reaches and nothing mentions).
- **`scripts/lib/graph.ts`** — module reachability over the repo's own sources.
  It resolves relative imports, `tsconfig`/`jsconfig` path aliases and Python
  dotted modules, then walks from the real entry points: Next.js `app/` and
  `pages/` routes with or without the `src/` layout, `middleware`,
  `instrumentation`, config and test files, `conftest.py`, Supabase edge
  functions, anything carrying a shebang, anything named in `package.json`
  (`main`, `module`, `bin`, `exports`, or inside a script command), and anything
  a CI workflow, Dockerfile, Makefile, lefthook config or shell script executes
  by path. Anything it cannot resolve is treated as reachable, so the graph errs
  toward calling files used.
- **`scripts/lib/gitx.ts`** — time-boxed, read-only git helpers. A history walk
  that fails or times out degrades into a declared partial result instead of
  silently reporting "never touched".
- **`scripts/tidy-apply.ts`** — the only part of tidy that writes, and it has no
  delete path at all. It knows `git mv`, `git rm --cached` and a `.gitignore`
  append; it refuses a dirty tree, the default branch, path traversal, protected
  and sacred paths, duplicated operands, unknown operation kinds and operations
  with no stated reason, rejecting the whole plan and writing nothing when any
  of those fire. Dry run is the default. `--undo <manifest> --apply` replays the
  inverse of every operation, down to removing the `.gitignore` line the run
  appended.
- **Artifact flow inspired by spec-driven development** — five phases, each
  ending in a committed file under `.keepwright/tidy/<date>/`: `INVENTORY.md`,
  `TIDY-CHARTER.md` (with `[NEEDS DECISION: ...]` markers that gate the next
  phase), `plan.json` plus `TIDY-PLAN.md`, `BASELINE.md`, `MANIFEST.json` and
  `REPORT.md`. Templates live in `skills/tidy/references/artifacts.md`.
- **CI enforces the non-destructive contract** — the pipeline greps
  `tidy-apply.ts` for any filesystem delete or a `git rm` without `--cached`,
  asserts unknown flags exit 2, asserts a plan naming an untracked path is
  rejected, and asserts none of it dirties the working tree.

- **CI now installs the plugin for real and asserts the outcome.** A new
  `install` job applies the engine into a scratch greenfield repo and a scratch
  brownfield repo that already has its own `CLAUDE.md`, then fails if any
  executable installed file still carries a literal placeholder, if a hook
  references a file that was never installed, if `run-all.sh` is not valid bash,
  if the brownfield repo does not pass the equalization validator immediately,
  or if applying a second time creates a file, modifies `CLAUDE.md`, or appends
  the rules index twice.

### Security

- **Shell injection in `claude-mention.yml.template` (critical).** The guard step
  interpolated `${{ github.event.comment.body }}` and the issue body and title
  directly into a `run:` script inside single quotes. GitHub Actions substitutes
  an expression into the script TEXT before bash parses it, so a comment
  containing a quote closed the quoting and the rest of the comment ran as
  commands. The step fires on every `issue_comment.created`, before the
  `@claude` filter, which lives inside the same already-substituted script and
  therefore offered no protection. With `contents: write`, `id-token: write` and
  the schema's `self-hosted` runner default, that was arbitrary command
  execution on the maintainer's own machine, triggerable by any GitHub user who
  can comment on an issue. Every untrusted field now travels through the step's
  `env:` block and is referenced as `"$VAR"`, the way `issue-triage.yml` already
  did.
- **Same class, lower reach, also fixed.** `pr-auto-merge.yml.template`
  interpolated `workflow_run.head_branch` (git allows `;`, `$` and quotes in a
  ref), `deploy/supabase-functions.yml.template` interpolated the
  `workflow_dispatch` input (now passed by env and validated against
  `[a-zA-Z0-9_-]`), and `pr-auto-review.yml.template` interpolated
  `pull_request.base.ref`. Numeric fields such as `pull_request.number` were
  left as they are: GitHub types them as integers and they cannot carry a
  payload.
- **The lesson is now a mechanical gate.** CI fails if any known free-text
  GitHub context field appears inside a `run:` block in any workflow or
  template. The check is verified by a positive control: reintroducing the
  original vulnerable line makes it fail, and a `pull_request.number`
  interpolation does not trip it.

- **`claude-mention.yml` held write access to the code it never writes.** The
  workflow declares no Edit or Write tool, and its own prompt says it proposes a
  diff through a comment instead of pushing, yet it requested `contents: write`
  on a job any GitHub user can trigger. Now `contents: read`. `id-token: write`
  stays: the action's token exchange needs it, and it is not what widens the
  blast radius.

### Fixed

- **Every commit broke right after `/keepwright:setup`.** The installed
  `lefthook.yml` called `scripts/validators/run-all.sh`, which no template ever
  generated (it was referenced in three places and shipped in none), and it
  carried `{{SOURCE_GLOB}}` and `{{CMD_TYPECHECK}}` as literal text, because
  neither token was in the substitution map. Leaving an unknown token intact is
  the right default for prose a human fills in later, but `lefthook.yml` is
  executed, so the pre-commit type-check tried to run the string
  `{{CMD_TYPECHECK}}` as a command. `run-all.sh` now ships (it runs every
  `validate-*.ts` in the directory and aggregates the exit codes, so local hooks
  and CI share one list), and the stack matrix in `scripts/lib/stacks.ts` gained
  a `typecheck` and a `sourceGlob` per stack, with a runnable fallback for an
  unrecognized stack.
- **A brownfield repo got a red pipeline on day one.** `apply.ts` correctly
  refuses to clobber an existing `CLAUDE.md`, but the same run installs the nine
  rules AND the validator that fails when a rule has no pointer, so any repo that
  already had a constitution failed `validate-claude-md-sync` on its first push:
  exactly the "works on any existing repo" case the plugin advertises. Apply now
  APPENDS a rules index with the missing pointers, never rewriting a line the
  maintainer wrote, and reports them as `equalized` in its summary. It is a no-op
  on a second run.
- **`{{INVARIANT_REFS}}` was posted verbatim into pull requests.** The auto-review
  comment for a change to a critical file embedded a token that was not in the
  substitution map, so every such PR received "confirm invariants
  {{INVARIANT_REFS}}". It now resolves from the configured layers.

- **Five diverging copies of the secret pattern list became one.** The engine,
  the installed validator, the PR auto-review grep, the auto-merge gate and this
  repo's own CI each carried a hand-maintained list, and they had already
  drifted: `ghp_` required 30, 36 or exactly 36 characters depending on which
  copy you read, the Meta prefix wanted 60 or 80, and only the engine anchored
  the authorship trailer, which is what produced the banned-terms false
  positive. They now all read `secret-patterns.ere`, a data file consumed by
  `grep -E -f` from shell and `new RegExp` from TypeScript with no code
  generation and no build step. Where two copies disagreed the more permissive
  bound won: this is a blocker against committing a credential, so a near-miss
  costs a human glance while a miss costs a rotation. The union also armed the
  shell greps with the OpenAI, Slack and AWS shapes that only the validator had.
  `grep -f` reads every line of a pattern file as a pattern, including blank
  lines that match everything, so each shell consumer strips comments and blanks
  first, portably, before grepping. CI now plants a fake credential in a freshly
  installed repo and fails if the validator passes it, and fails if an emptied
  pattern list is accepted rather than refused.

- **Derived patterns reached nothing.** The `derive-patterns` workflow mined the
  repo's design and writing-voice conventions and the config schema declared
  them, but no placeholder consumed them, so every PR was still reviewed against
  a generic ideal. That was the gap between the README's central claim, that the
  standard a repo is held to is its own, and what setup actually delivered.
  `REVIEW.md` gained a §3.4 fed by `{{DERIVED_DESIGN}}` and `{{DERIVED_VOICE}}`,
  the `pr-review` skill reads that section by name, and when nothing has been
  derived yet the section says so instead of leaving a blank the reviewer has to
  interpret. CI fails if the placeholder survives into an installed `REVIEW.md`.
- **The review skill skipped two of the nine rules.** It globbed
  `.claude/rules/0[1-7]-*.md`, so `08-empirical-proof` and `09-issue-triage`
  were never consulted, and any derived rule would have been missed too. It now
  reads the whole directory: a numbered glob goes stale the moment a rule is
  added.
- **The wizard silently defaulted the output language.** Detection reads
  `language` from `~/.claude/settings.json`, a field Claude Code does not
  populate by default, so it almost always came back empty and the generated
  constitution landed in English regardless of the repo. The wizard now asks
  when detection finds nothing.
- **Issue triage looked identical whether it worked or not.** Without GitHub
  Models access the classify step returns empty and the workflow soft-lands on
  `needs:human-triage`, which is correct but indistinguishable from a model with
  nothing to say. The template now says so at the top.

- **The engine now refuses to ship a placeholder into a file that gets
  executed.** `apply.ts` resolves every template in memory first and aborts the
  whole run, writing nothing, if a `{{TOKEN}}` would survive into a workflow, a
  hook config or a script. Leaving an unknown token intact is still the right
  default for prose a human fills in later, so `.md` docs stay tolerant, and the
  two genuinely human-filled values are listed explicitly and guarded at runtime.
  This is the generalization of four separate bugs fixed in this release, and it
  found a fifth on its first run: with no `criticalFiles` configured, the PR
  auto-review workflow was grepping the changed-file list for the literal string
  `{{CRITICAL_FILE_1}}`, so the critical-file warning never fired and the repo
  looked watched while nothing watched it. Unset critical files now resolve to an
  explicit sentinel that matches no path, making the step visibly inert instead
  of invisibly broken.
- **`audit.ts` counted a repo's own files as keepwright coverage.** A project
  that already had `.github/workflows/ci.yml` scored that path as present, so
  the audit reported coverage for a pipeline running none of these checks. The
  generated workflows and `lefthook.yml` now carry a `keepwright:managed`
  marker, and the audit reports a same-named file that lacks it as
  "exists, but is not the keepwright one".
- **`/keepwright:setup` no longer installs into a directory that is not a git
  repo.** `detect.ts` reports `isGitRepo`, and the wizard stops on false. The
  worker agent ships with `isolation: worktree` and cannot spawn without a
  repository, so the old behavior produced a setup that looked complete and
  worked nowhere.
- **Layer detection was blind to monorepos.** `detectLayers` only read `src/`
  or `app/` at the root, so a repo with `packages/*/src` fell back to the
  generic defaults while claiming the layers came from the real structure. It
  now walks `packages/*` and `apps/*` as well.

- **The repo blocked itself from editing its own review doc.** The banned-terms
  grep in `pr-auto-review.yml` matched `Co-Authored-By: Claude` anywhere in an
  added line, and `REVIEW.md` documents that exact string as an example of what
  gets detected. Any PR touching that line got "Banned terms detected" and a
  hard `exit 1`. The authorship patterns are now anchored to the start of an
  added line, where a real git trailer lives, and `REVIEW.md` joined the
  pathspec exclusions next to the workflows and rules that were already exempt
  for the same reason. The engine's own scan had this anchoring from the start;
  the workflow had drifted from it.
- **The auto-merge author allowlist matched almost nobody.** It listed
  `app/github-actions`, but the bot's login is `github-actions[bot]`, so that
  alternative never matched; and an unquoted `[bot]` in a `case` pattern is a
  bracket expression matching one of `b`, `o`, `t`, not a literal. The owner
  placeholder is also the org name in an org repo, never a human's login. The
  allowlist now quotes its patterns and includes the maintainer login. It always
  failed toward the human flow, so nothing unsafe merged; the feature was simply
  dead in most repos.
- **The documented merge bypass could not work.** `{{PROJECT_UPPER}}` was a raw
  `toUpperCase()`, so a project named `my-app` produced
  `${MY-APP_MERGE_UNSAFE:-}`, which bash parses as the default-value form
  `${VAR-word}`: it expands to the literal word and never reads the variable.
  The placeholder is now sanitized to `[A-Z0-9_]`.
- **The auto-merge approve was documented as a gate it cannot be.** GitHub
  refuses `--approve` on a self-authored PR, and a `GITHUB_TOKEN` review does
  not satisfy a required-approvals rule. The step no longer dies when the
  approve is refused, and says plainly that the real gates are the Tier S
  allowlist, the author allowlist, the secret grep and a green CI.
- **The OAuth secret was interpolated into a shell script to test it.**
  `pr-auto-review.yml` did `[ -n "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}" ]`,
  putting the secret in the script text. It now tests the boolean
  `secrets.X != ''` through `env`, the same way `claude-mention.yml` does.
- **`REVIEW.md` claimed the plugin ships 7 rules; it ships 9.** The count went
  stale when issue triage was added. The prose no longer repeats a number, and
  points at `validate-claude-md-sync` as the authority on the set.

- **Deploy templates failed late and opaquely on an unfilled placeholder.**
  `static-pages` (`{{BUILD_DIR}}`) and `supabase-functions`
  (`{{SUPABASE_PROJECT_REF}}`) are filled in by hand after install and are not
  in the substitution map by design, but nothing checked them: the workflow ran
  to the upload or deploy step and failed there, minutes later and far from the
  cause. Both now fail on their first step with the name of the value and where
  to set it.

### Removed

- **The orchestration workflows are no longer copied into the target repo.**
  `apply.ts` wrote `workflows/*.js` into `.claude/workflows/`, where nothing
  invoked them and where they could not run anyway: they depend on globals the
  Workflow tool injects (`agent`, `parallel`, `phase`), so `node
  .claude/workflows/derive-patterns.js` fails with `phase is not defined`. The
  copy used the never-overwrite path, so it silently aged while the plugin
  evolved, and it read like live code to anyone browsing the repo. The commands
  load them from the plugin root, which is the only path that ever worked.
- **`customValidators` and `mode` are gone from the config schema.** Neither was
  read by any script. A project-specific validator needs no declaration: drop a
  `validate-*.ts` into `scripts/validators/` and `run-all.sh` picks it up in both
  the hook and CI, so the array only promised scaffolding that did not exist.
  `--mode` remains a flag on `/keepwright:setup`, where it belongs: it selects a
  conversation path, and a versioned config should describe the repo, not the
  action being performed on it.

### Documentation

- README states the supported hosts. The engine is portable, but the scaffolded
  hooks and helper scripts are bash and `setup-oauth-secret.sh` reads the macOS
  Keychain, so macOS and Linux are supported and Windows needs WSL. The
  generated Actions run on `ubuntu-latest` and do not depend on the host.

## [2.2.0] — 2026-07-02

### Added

- **New skill: `overhaul`** — a full-repo overhaul orchestrator for deep
  refactoring, architecture improvement, dead-code removal, dependency updates,
  and cleanup on any existing project. It splits the work by model tier: cheap
  models fan out read-only reconnaissance, a frontier model grills the user and
  writes the plan plus per-workstream specs, and cheaper executor models carry
  the specs out — each phase emits an artifact under `.overhaul/`, so work
  survives the session and resumes across models.
- The skill integrates with what keepwright already ships instead of
  duplicating it: recon prefers the `map-brownfield` workflow
  (`${CLAUDE_PLUGIN_ROOT}/workflows/map-brownfield.js`), findings are ranked on
  the P1–P5 epistemic hierarchy, no workstream merges without empirical proof,
  and execution lessons are catalyzed into rules/validators where the
  keepwright structure exists.
- Reference files under `skills/overhaul/references/`: `artifacts.md` (the
  RECON / OVERHAUL-PLAN / workstream-spec / LOG templates) and
  `grilling-fallback.md` (a self-contained interview used when the external
  `grilling` skill from mattpocock/skills is not installed).
- CI now validates the `overhaul` skill's frontmatter and reference files,
  same as the existing skill checks.

## [2.1.0] — 2026-06-05

### Added

- **Automatic issue triage over free GitHub Models.** New workflow
  `issue-triage.yml`: when an issue is opened/edited/reopened, a classify job
  asks GitHub Models (free in Actions over the `GITHUB_TOKEN`, no secret) for
  strict JSON — suggested labels, possible duplicate, missing info, severity,
  summary — and a deterministic apply job acts on it. Triage is **advisory**: it
  never closes, assigns, or merges; a human stays in the merge path.
- **Safe by construction.** The workflow holds `issues: write` + `models: read` +
  `contents: read` and nothing else — no pull-requests, no id-token, no
  contents: write. A prompt injection in an issue body cannot reach code, a
  secret, or a merge. The issue body is passed as untrusted data in a separate
  `user` message wrapped in `<issue_body>`; the model's label suggestions are
  intersected with the repo's **live** label set (`gh label list`) so a
  hallucinated label is dropped — the workflow never creates labels.
- **Graceful degradation + idempotency.** No GitHub Models access, a rate limit,
  or malformed output falls back to a `needs:human-triage` label and stops. The
  advisory comment is keyed by an HTML marker and updated in place, so re-triggers
  never spam the issue.
- **Issue templates + label seeding.** `bug_report`, `feature_request`, and a
  `config.yml` (with `needs-triage`), plus `scripts/seed-labels.sh` to create the
  keepwright-specific labels once at setup — deterministic and human-run, kept out
  of the triage workflow's blast radius.
- New rule `09-issue-triage.md` (advisory; untrusted-data contract; P5 never
  overrides P1; documents coexistence with the `@claude` mention workflow), wired
  into the `CLAUDE.md` equalization table.
- Config gains an optional `issues` block: `{ "triage": "off" | "github-models",
  "model": "openai/gpt-4o-mini" }` (default: on, gpt-4o-mini).

## [2.0.2] — 2026-06-05

### Fixed

- Workflow templates are now fully generic, so they fit any repo. The PR
  auto-review and `@claude` mention workflows no longer hardcode
  `runs-on: [self-hosted, ...]` — they use `{{RUNNER}}` from the config
  (default `ubuntu-latest`; self-hosted only when chosen). The critical-file
  detection greps now come from the config's `criticalFiles[]` instead of
  example project paths.

### Removed

- Client project names dropped from `AUTHORS.md` and the 1.0.0 changelog entry.

## [2.0.1] — 2026-06-05

### Fixed

- Clean workflow names — `map-brownfield`, `derive-patterns`, `verify-setup`
  (were prefixed `keepwright-`, which surfaced as the redundant
  `/keepwright:keepwright-*`). No behavior change — the commands trigger them by path.

### Removed

- **The orchestration workflows are no longer copied into the target repo.**
  `apply.ts` wrote `workflows/*.js` into `.claude/workflows/`, where nothing
  invoked them and where they could not run anyway: they depend on globals the
  Workflow tool injects (`agent`, `parallel`, `phase`), so `node
  .claude/workflows/derive-patterns.js` fails with `phase is not defined`. The
  copy used the never-overwrite path, so it silently aged while the plugin
  evolved, and it read like live code to anyone browsing the repo. The commands
  load them from the plugin root, which is the only path that ever worked.
- **`customValidators` and `mode` are gone from the config schema.** Neither was
  read by any script. A project-specific validator needs no declaration: drop a
  `validate-*.ts` into `scripts/validators/` and `run-all.sh` picks it up in both
  the hook and CI, so the array only promised scaffolding that did not exist.
  `--mode` remains a flag on `/keepwright:setup`, where it belongs: it selects a
  conversation path, and a versioned config should describe the repo, not the
  action being performed on it.

### Documentation

- README now documents the workflows and the skills/agents the plugin exposes,
  not just the three top-level commands.
- Install split into numbered steps plus `/reload-plugins` to activate after install.

## [2.0.0] — 2026-06-05

Rebrand to **keepwright** and full plugin redesign. The old
`setup-projeto-qualidade` skill becomes a Claude Code plugin with three layers:
an interactive wizard command, a deterministic engine, and orchestration
workflows.

### Changed

- **Rebrand: `setup-projeto-qualidade` → keepwright.** Install via
  `/plugin marketplace add leonardocandiani/keepwright` then
  `/plugin install keepwright`.
- **Single skill → plugin with three commands.** `/keepwright:setup` (the wizard,
  formerly the whole skill), `/keepwright:audit` (integration coverage of an
  existing repo), `/keepwright:review` (repo state vs. derived patterns).
- **Deterministic engine split out.** Validators and git hooks run identically on
  every machine and in CI, with no model in the loop.

### Added

- **Orchestration workflows.** Multi-agent flows that audit an existing repo,
  derive its design and writing-voice patterns, and write them back as rules and
  validators.
- **OAuth via `/install-github-app`.** Recommended primary auth path for the AI
  workflows; it wires `CLAUDE_CODE_OAUTH_TOKEN` for you. Added
  `scripts/setup-oauth-secret.sh` as a deterministic fallback: reads the token
  from the macOS Keychain or `CLAUDE_CODE_OAUTH_TOKEN`, validates its shape, and
  sets the secret without mangling.
- **Empirical Proof Before Merge (EPP)** — 3rd leg of the empirical tripod
  (analysis → hierarchy → proof). New rule `08-empirical-proof.md` +
  validator `validate-empirical-proof.ts`: a functional change merges only with
  evidence that it **runs** against a real environment (command output, log,
  query, reproduced bug scenario), pasted into the PR under
  `## EMPIRICAL VALIDATION`. HARD in CI (with a PR body), REMINDER on pre-push.
  Exempts docs/refactor/style/config/workflow. Bypass via
  `# empirical-proof: ignore <reason>`. Equalized across CLAUDE.md (pointer +
  summary), REVIEW.md (§3.1 critical criterion + §3.5 canonical section + §5
  validators), PULL_REQUEST_TEMPLATE (EMPIRICAL VALIDATION section + checklist),
  `pr-auto-review.yml` (hard gate), and lefthook pre-push (reminder).
- **Explicit model + 1M context in Claude review and mention.**
  `pr-auto-review.yml` and `claude-mention.yml` now run with
  `--model {{REVIEW_MODEL}}` (recommended default `claude-opus-4-8[1m]`) instead
  of the account default. Placeholder `{{REVIEW_MODEL}}` + a per-plan decision
  table (Max/Team/Enterprise → Opus 4.8 1M; Pro → Opus 4.8; cost-sensitive →
  Sonnet 4.6).

### Fixed

- **Opus 4.8 fell back silently.** `claude-code-action@v1` auto-installs a stale
  CLI (~2.1.150, pre-Opus 4.8), so `--model claude-opus-4-8` ran on the account
  default without erroring. Both workflows now have an `Install Claude Code` step
  that **pins** a version >= 2.1.154, **verifies** it (fail-fast gate), and points
  `path_to_claude_code_executable` at it (the action skips its own install).
  `rm -rf` of the native install before the install fixes the launcher resolving
  an old version on a reused/self-hosted runner; `allowed_bots: "claude"` lets a
  bot trigger the `@claude` mention. Validated live: review and mention reporting
  Opus 4.8 1M over CLI 2.1.160.

### Planned

- Monorepo Turbo/Nx support with per-workspace layers
- Cloudflare Pages/Workers deploy template
- Railway deploy template
- Python variant with Ruff + Mypy + Hatch
- Rust variant with Cargo + Clippy
- UI-specific validator (forbidden terms in user-facing strings)
- Interactive wizard to customize the `01-invariants.md` invariants

## [1.0.0] — 2026-05-15

First public release. Skill consolidated around a 10-phase flow.

**Co-authorship**: Leonardo Candiani ([@leonardocandiani](https://github.com/leonardocandiani))
and SixQuasar ([@sixquasar](https://github.com/sixquasar)) — a tech company
founded by Leonardo Candiani, Ricardo, and Rodrigo. Refined in production on
real-world projects.

### Added

#### `.claude/` structure
- 7 structured rules: invariants, pipeline equalization, P1–P5 epistemic
  hierarchy, PR flow, lesson catalysis, parallel work streams, safe merge
- `worker.md` agent with `isolation: worktree` for isolated parallelism
- `settings.json` with `includeCoAuthoredBy: false` + empty attribution + Bash
  allowlist

#### Constitution
- `CLAUDE.md.template` as an equalized index of the rules + always-loaded
  invariants
- `AGENTS.md` (append-only living journal) + `build-log.md` (chronology)
- `docs/{reference-cases,lessons,deploys,api,architecture}/` structure

#### GitHub Actions
- `ci.yml` — type-check, lint, validators (PR + push main)
- `pr-auto-review.yml` — 3 jobs: heuristic + check-key + Claude review over OAuth
- `claude-mention.yml` — `@claude` on demand in a PR/issue/review
- `pr-auto-merge.yml` — auto-approve+merge **only** inert changes (`docs/`,
  `build-log.md`, `.planning/workstreams/`)
- Deploy adapted to stack: 5 templates (Vercel, Supabase Functions, Docker GHCR,
  npm publish, Static Pages)

#### Portable validators
- `validate-no-secrets.ts` — aggressive secret grep over staged files (`pk_live_`,
  `sk_live_`, `sbp_`, `ghp_`, `sk-ant-`, etc.)
- `validate-claude-md-sync.ts` — fails CI if a rule has no pointer in CLAUDE.md,
  or a dead pointer

#### Hooks
- `lefthook.yml` — pre-commit (validators + type-check), commit-msg (conventional
  + blocks AI mentions), pre-push (blocks force-push to main)
- Portable generators: `gen-project-structure.ts`, `gen-todos-report.ts`

#### Scripts
- `gh-pr-merge-safe.sh` — gate `mergeStateStatus = CLEAN` before merge

#### Helper templates
- `PULL_REQUEST_TEMPLATE.md` with an equalization/smoke/catalysis checklist

### Consolidated principles
- Analysis before execution (Phase 0 never skipped)
- Wave-based approval (Phase 1 is destructive, needs explicit ok)
- Double validation (smoke test after each phase)
- History preserved (sub-repos with their own `.git` not absorbed without
  confirmation)
- Secrets blocked via aggressive pre-commit grep
- CLAUDE.md equalization as a hard CI gate
- OAuth preferred over API key for the AI workflows

### Supported stacks (Phase 0 detects automatically)
- Next.js + serverless backend
- Plain Next.js
- Node CLI
- Python FastAPI
- React SPA + separate API
- Containerized service
- Monorepo (installs multiple deploy variants)

[2.3.0]: https://github.com/leonardocandiani/keepwright/compare/v2.2.0...v2.3.0
[2.1.0]: https://github.com/leonardocandiani/keepwright/compare/v2.0.2...v2.1.0
[2.0.0]: https://github.com/leonardocandiani/keepwright/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/leonardocandiani/keepwright/releases/tag/v1.0.0
