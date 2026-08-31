---
description: Clean up a cluttered repo without destroying anything — evidence-backed, reversible, and fully documented
argument-hint: '[--scan-only] [--stale-days N] [path scope]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(bun:*), Bash(git:*), Bash(gh:*), AskUserQuestion
---

# keepwright tidy

Take a repo that has accumulated junk, scratch files, dead code, duplicates and
misplaced folders, and leave it genuinely cleaner, with every change reversible
and every decision written down.

Raw arguments: `$ARGUMENTS`

## The contract you are bound by

1. **Nothing is deleted. Ever.** Not by you, not by the engine. A file that
   leaves its place is MOVED into `.attic/<date>/<original path>`; a file that
   should not be in git is UNTRACKED and stays on disk. `rm` is never the answer
   and is not an operation the engine accepts.
2. **No claim without evidence.** Every operation you propose cites a finding
   from `tidy-scan.ts` and the evidence string that finding carries. "Looks
   unused" is not evidence. If you believe a file is dead but the scan does not
   back you, say so as an open question instead of acting on it.
3. **Every phase writes a file.** A phase whose result lives only in this
   conversation did not happen. Artifacts go in `.keepwright/tidy/<date>/`.
4. **The repo must end smarter, not just tidier.** Phase 5 turns whatever made
   the mess into a rule, a `.gitignore` line, or a validator. Skipping it means
   the same clutter returns next quarter.

## Scan (already run)

!`bun "${CLAUDE_PLUGIN_ROOT}/scripts/tidy-scan.ts" 2>/dev/null || echo '{"_error":"scanner failed — is bun installed, and is this a git repo?"}'`

Read the JSON above before writing anything. `totals.findings` is the size of
the job; `byClass` is its shape; each finding carries `confidence`
(high/medium/low), `action` (quarantine/untrack/review) and `evidence`.

If the scanner returned `_error` or a `degraded` block, say so plainly and stop
before proposing operations. A partial scan cannot justify moving files.

With `--scan-only`, stop after Phase 0: write the inventory, report it, do not
interview and do not plan.

## Phase 0 — Inventory

Write `.keepwright/tidy/<date>/INVENTORY.md` from the scan: totals, the finding
table grouped by class, and a three-sentence verdict on what shape this repo is
in and what the single biggest source of clutter is.

Group the findings; never paste 200 raw rows at the user. High-confidence
findings get named individually, the long tail gets counted.

## Phase 1 — Charter (interview, this is a gate)

Write `.keepwright/tidy/<date>/TIDY-CHARTER.md`. Use **AskUserQuestion** and ask
only what the scan genuinely cannot answer. Four things must end up resolved:

- **Sacred ground** — paths that must not move whatever the evidence says
  (vendored code, generated files someone depends on, a folder mid-migration).
- **Proof command** — what proves the repo still works: `npm test`, `bun run
  build`, `tsc --noEmit`, a curl against a dev server. If the repo has no proof
  at all, say so in the charter; the run then stops at quarantine of provably
  inert files (junk, empty, backup artifacts) and proposes nothing about code.
- **Kill list confirmation** — show the high-confidence quarantine candidates
  and get an explicit yes. Medium and low confidence stay as proposals.
- **Scope** — the whole repo or one subtree, and roughly how much churn is
  welcome this round.

Mark anything still open as `[NEEDS DECISION: <question>]`. **Do not enter Phase
2 while a single `[NEEDS DECISION]` marker remains in the charter.** Ask again,
or narrow the scope so the undecided part falls outside it.

## Phase 2 — Plan

Write two files:

- `.keepwright/tidy/<date>/plan.json` — the machine-checkable plan the engine
  runs. Shape: `{ "label", "sacred": [...], "operations": [ { "op":
  "quarantine" | "untrack" | "move", "path", "to"?, "reason" } ] }`. The
  `reason` is what a reviewer reads in the PR, so make it the evidence, not a
  restatement of the action.
- `.keepwright/tidy/<date>/TIDY-PLAN.md` — the same plan for humans, ordered,
  grouped by class, with a section listing every finding you deliberately did
  **not** act on and why. That section is the honest half of the report.

Ordering rules: provably inert files first (junk, empty, backup artifacts), then
duplicates and misplaced files, then orphaned code last. Never mix a risky
operation into the first batch.

A finding whose `action` is `review` never becomes an operation on your own
authority. It becomes a line in the plan's open-questions section, or a question
to the user.

## Phase 3 — Baseline, apply, prove

1. Run the charter's proof command and record the result in
   `.keepwright/tidy/<date>/BASELINE.md`. **A red baseline stops the run**: you
   cannot prove your cleanup is harmless against a repo that was already broken.
2. Branch: `git checkout -b tidy/<date>`. The engine refuses to run on `main`
   or `master`, and refuses to run on a dirty tree, on purpose.
3. Dry run first: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/tidy-apply.ts"
   .keepwright/tidy/<date>/plan.json`. Read what it says it will do. A rejected
   plan comes back with a `problems` list; fix the plan, never bypass the check.
4. Apply: same command with `--apply`. It writes
   `.keepwright/tidy/<date>/MANIFEST.json`, which holds the exact inverse of
   every operation performed.
5. Run the proof command again. **If it goes red, undo immediately**: `bun
   "${CLAUDE_PLUGIN_ROOT}/scripts/tidy-apply.ts" --undo
   .keepwright/tidy/<date>/MANIFEST.json --apply`, then report which operation
   broke it and stop. Do not attempt a repair edit inside a tidy run: fixing
   code is a different job with a different review.
6. Commit with the operations summarized in the body, and the proof output.

## Phase 4 — Report

Write `.keepwright/tidy/<date>/REPORT.md`: tracked files and bytes before and
after, a table of what moved where, what was untracked and why, the findings
left untouched with the reason, and the one-line undo command. Then open the PR
with that report as the body.

The PR description must state, in plain words, that nothing was deleted and
where the quarantined files live, so a reviewer can restore any of them with a
single `git mv`.

## Phase 5 — Catalysis (do not skip)

Clutter comes back unless the repo learns. For each recurring class in the scan:

- Build output or machine-local files tracked in git → fix `.gitignore`.
- Backup and scratch files that keep landing in `src/` → a line in `CLAUDE.md`
  or a rule under `.claude/rules/` saying where scratch work goes.
- The same dead module type appearing again → a validator, if it is mechanically
  checkable.

Where the keepwright structure already exists in the repo, add the rule there and
re-equalize `CLAUDE.md` (every rule needs a pointer). Where it does not, append a
short section to `CLAUDE.md` and offer `/keepwright:setup`.

## Rules of engagement

- English for keepwright's own output; generated artifacts follow the repo's
  configured `language`.
- Be decisive about mechanics, never about someone else's code. When the
  evidence is thin, the honest move is a question, not a quarantine.
- Report the count you can prove. "12 files quarantined, 41 findings left as
  open questions" beats "cleaned up the repo".
