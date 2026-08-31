---
name: keepwright
description: Set up and continuously keep engineering quality and architecture true in any git repo. Implants a constitution (CLAUDE.md), structured rules, GitHub Actions with AI PR review wired to OAuth, portable validators, and git hooks; then audits and enforces them over time. Detects the stack and adapts. Use when a repo needs a solid quality architecture, a PR flow with AI review, living rules, or an audit of how integrated it already is.
---

# keepwright

keepwright sets up **and continuously keeps** a high-quality engineering
architecture in any git repo — new or existing, any stack. It is both a
**scaffolder** (installs the architecture) and a **maintainer** (audits it and
keeps it enforced). The craft of building the standard, and the keep that guards it.

## How it works — three layers

1. **Wizard command** (`commands/`) — you drive it; it asks the user the genuine
   choices via `AskUserQuestion` and orchestrates the rest. This is the
   "type it and configure" surface.
2. **Deterministic engine** (`scripts/`, run with `bun`) — does the mechanical
   work: `detect.ts` proposes a config from the repo, `apply.ts` copies templates
   and substitutes placeholders idempotently (anti-secret scan first), `audit.ts`
   reports integration coverage. No LLM guesswork in the mechanical path.
3. **Orchestration workflows** (`workflows/*.js`, the Workflow tool) — parallel
   multi-agent analysis, used *situationally* because it costs tokens:
   `map-brownfield` (enrich the config from a large repo), `derive-patterns`
   (mine the repo's design + writing voice → rules + validators), `verify-setup`
   (adversarial parallel verification).

The split is deliberate: **mechanical → script, judgment → LLM/workflow.**

## Commands

- **`/keepwright:setup`** — interactive wizard: detect → (optional brownfield map)
  → configure via questions → apply → auth → (optional derive + verify) → smoke.
  Accepts `--mode setup|audit|maintain`.
- **`/keepwright:audit`** — reports whether the repo is fully integrated
  (CLAUDE.md, `.claude/rules`, workflows, validators, hooks) with a coverage
  verdict. `--deep` escalates to the adversarial verify workflow.
- **`/keepwright:review`** — reviews the current state against the repo's own
  derived patterns + the keepwright invariants; escalates to `/code-review ultra`
  / `/security-review` for depth.
- **`/keepwright:tidy`** — non-destructive cleanup of a cluttered repo: scan →
  charter → plan → apply → report → catalysis. It proves what is junk,
  duplicated, orphaned or misplaced from an import graph plus git history, then
  quarantines it into `.attic/` instead of deleting it. Every operation is
  reversible from a manifest. See the `tidy` skill.

## Config — `keepwright.config.json`

Produced by detection + the wizard, consumed by `apply.ts`. Conforms to
`schema/keepwright.config.schema.json`: `project`, `repo`, `maintainer`,
`language`, `stack`, `layers[]`, `deploy`, `runner`, `auth`, `criticalFiles[]`,
`issues{triage,model}`, `derivedPatterns{design[],voice[]}`. Versioned in the
repo, so the setup is reproducible and reviewable.

The config describes the REPO, never the action being performed on it. `--mode`
stays a flag on `/keepwright:setup` because it picks a conversation path; it is
not repo state and does not belong in a versioned file. A project-specific
validator needs no declaration either: drop a `validate-*.ts` in
`scripts/validators/` and `run-all.sh` picks it up in both the hook and CI.

## What gets installed (the architecture)

- **`CLAUDE.md`** — the constitution: an index pointing to every rule plus the
  load-bearing invariants inline. Rule with no pointer = invisible rule; a
  validator fails CI on desync (**equalization**).
- **`.claude/rules/`** — invariants, pipeline equalization, epistemic hierarchy
  (P1–P5), PR flow, lesson cataloging, parallel workstreams, safe merge, and any
  **derived rules** mined from the repo itself (design + voice).
- **GitHub Actions** — CI (typecheck/lint/validators), AI PR auto-review (calls
  the versioned `/pr-review` skill, advisory + deterministic publish + retry +
  fallback), `@claude` mention, safe auto-merge (Tier-S only), and a stack-picked
  deploy workflow. Self-hosted runner option keeps CI minutes at zero.
- **Validators** (`scripts/validators/`) — anti-secrets, CLAUDE.md equalization,
  epistemic hierarchy, webhook-active, empirical-proof, plus project-specific ones.
- **Hooks** (lefthook) + portable generators.

## Auth (Claude ↔ GitHub) — OAuth first

Run **`/install-github-app`** in the target repo and choose **subscription /
OAuth**: it installs the GitHub App *and* sets the `CLAUDE_CODE_OAUTH_TOKEN`
secret in one step. This replaces the old manual ritual and avoids the
malformed-secret class of bugs. OAuth keeps the AI review/mention on the
subscription (no metered API cost). Fallback for re-setting the secret by hand:
`bash scripts/setup-oauth-secret.sh <owner>/<repo>`. `ANTHROPIC_API_KEY` is a
documented, pay-per-use alternative — not the default.

## Derived patterns (the repo teaches itself)

`derive-patterns` reads how the repo *actually* writes code and prose, codifies
the strong/recurring conventions into rules, and — where mechanically checkable —
into validators. Those feed the AI review too, so the standard the repo is held
to is *its own*, not a generic ideal.

## Principles

- **Epistemic hierarchy P1–P5** — a reported symptom (P1) outranks prod logs (P2),
  DB state (P3), code (P4), abstract analysis (P5). P5 never refutes P1.
- **Equalization** — every rule has a CLAUDE.md pointer; a validator enforces it.
- **Safe merge** — double gate; Tier-S inert changes auto-merge, everything else
  is human. AI review is **advisory**, never a hard gate (it can 401 on workflow-
  touching PRs by design); the real gates are validators + typecheck + CODEOWNERS.
- **Empirical proof before "done"** — runtime evidence, not inference.
- **No AI attribution** in commits; the maintainer is the author.

## i18n

The plugin itself is English. **Generated artifacts** (CLAUDE.md prose, rule docs,
messages) follow the user's `language` — read from `~/.claude` settings into
`config.language` — so the constitution lands in the maintainer's language while
the tooling stays universal. English when unset.

## How to operate this skill

Read this file, then drive `/keepwright:setup`. Be decisive on technical defaults;
only ask the user about genuine choices. The apply step is idempotent — safe to
re-run; it reports what it skipped. Never cross the apply step (it touches git)
without explicit confirmation.
