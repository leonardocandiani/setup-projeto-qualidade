---
description: Set up (or re-apply) the keepwright quality architecture in this repo through an interactive wizard
argument-hint: '[--mode setup|audit|maintain]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(bun:*), Bash(git:*), Bash(gh:*), AskUserQuestion, Workflow
---

# keepwright setup

You are running the **keepwright** setup wizard in the user's CURRENT repository.
Drive it interactively but lean on the deterministic engine for the mechanical
work. You provide judgment and interaction; the scripts copy templates and
substitute placeholders; the workflows do the heavy parallel analysis.

Raw arguments: `$ARGUMENTS`

## Detected defaults (already run)

!`bun "${CLAUDE_PLUGIN_ROOT}/scripts/detect.ts" 2>/dev/null || echo '{"_error":"detector failed — bun missing? run setup manually"}'`

Treat the JSON above as **defaults**, not the final config.

**Stop here if `isGitRepo` is `false`.** Say so plainly and offer `git init`.
Everything below assumes git: the worker agent is installed with
`isolation: worktree` and cannot spawn without a repository, the hooks have
nothing to attach to, and the workflows have nothing to run on. Installing into
a directory that is not a repo produces a setup that looks complete and works
nowhere.

## Steps

1. **Map (large/existing repos only).** If the repo is non-trivial — lots of
   files, real code, unclear layers — enrich the defaults by running the
   brownfield mapping workflow (multi-agent, costs tokens; SKIP for small/empty
   repos): invoke the **Workflow** tool with
   `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/map-brownfield.js"` and merge its
   returned `stack`/`layers`/`deploy`/`criticalFiles`/`derivedPatterns` into the
   defaults.

2. **Wizard.** Use **AskUserQuestion** to let the user confirm/adjust, with the
   detected value pre-selected as the recommended option. Only ask about choices
   that detection left genuinely ambiguous:
   - **Stack** — confirm detected or correct it
   - **Deploy** — vercel | supabase-functions | docker-ghcr | npm-publish | static-pages | none
   - **Runner** — self-hosted (zero CI minutes) | github
   - **Auth** — oauth (subscription token, no metered cost) | apikey (pay per use)
   - **Critical files / custom validators** — optional, multi-select

3. **Write config.** Write the finalized config to `keepwright.config.json` at the
   repo root, conforming to `${CLAUDE_PLUGIN_ROOT}/schema/keepwright.config.schema.json`.
   Set `language` so GENERATED artifacts match the maintainer's language, while
   the plugin's own text stays English. Detection reads `language` from
   `~/.claude/settings.json`, a field Claude Code does not populate by default,
   so it usually comes back empty: when it does, ASK, rather than silently
   defaulting to English in a repo whose docs are written in another language.

4. **Apply (deterministic, creates files + git).** Confirm with the user first
   (this writes the constitution, rules, workflows, validators, hooks). Then run:
   `bun "${CLAUDE_PLUGIN_ROOT}/scripts/apply.ts" keepwright.config.json`
   The engine runs an anti-secret scan before writing. Report the
   created/skipped/updated summary it prints.

5. **Auth (Claude ↔ GitHub).** Tell the user to run **`/install-github-app`** in
   this repo and choose **subscription / OAuth** when prompted — that installs the
   GitHub App AND sets the `CLAUDE_CODE_OAUTH_TOKEN` secret in one step, replacing
   the old manual ritual. Fallback if the secret must be set by hand:
   `bash scripts/setup-oauth-secret.sh <owner>/<repo>`.
   Then, if issue triage is enabled (the default), seed its labels once:
   `bash scripts/seed-labels.sh <owner>/<repo>` (deterministic; the triage
   workflow itself never creates labels — see `.claude/rules/09-issue-triage.md`).

6. **Derive patterns (optional, repos with real code).** Run the derive-patterns
   workflow (`scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/derive-patterns.js"`) to
   mine the repo's design + writing voice and generate rules + validator specs.
   Write the returned rules into `.claude/rules/` and validator specs into
   `scripts/validators/`, then re-equalize CLAUDE.md (every rule needs a pointer).

7. **Verify.** Run the verify-setup workflow
   (`scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/verify-setup.js"`) for adversarial
   parallel verification. Fix any `critical` issue before finishing.

8. **Smoke + catalog.** Optionally open a trivial test PR to confirm CI + AI
   review + auto-merge end-to-end, then catalog the run as `docs/lessons/L-000`.

## Rules of engagement

- **git is a precondition, not a detail.** Never run the apply step in a
  directory where `isGitRepo` is false.
- **English** for everything keepwright outputs about itself. **Generated
  artifacts** (CLAUDE.md prose, rule docs, messages) follow the user's `language`.
- Be **decisive** on technical defaults; only ask the user about genuine choices.
- The apply step is **idempotent** — safe to re-run; it reports what it skipped.
- Never proceed past step 4 without explicit confirmation (it touches git).
