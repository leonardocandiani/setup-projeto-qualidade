---
name: tidy
description: 'Non-destructive repo cleanup: prove what is junk, scratch, duplicated, orphaned or misplaced, then quarantine it reversibly instead of deleting it. Use whenever a repo needs to be cleaned up, decluttered, organized or slimmed down; when someone asks to "remove dead code", "clean this repo", "what can we delete here", "organize the folders", "why is this repo so big"; or before handing a messy project to a new maintainer. Every claim is backed by an import-graph or git-history proof, every change is reversible from a manifest, and the whole run is documented. Works on any git repo, any stack.'
---

# Tidy

A cleanup nobody can verify is a cleanup nobody should merge. Tidy exists so
that the sentence "this file is not used" becomes a checkable claim instead of
a hunch, and so that acting on it is always reversible.

## The two halves

**Mechanical, and therefore a script.** Whether a file is byte-identical to
another, whether git's own ignore rules already match it, whether any entry
point reaches it through resolved imports, how long since a commit touched it,
how many bytes it costs every clone. `tidy-scan.ts` answers all of that and
emits evidence. No model judgment is involved, so the answer is the same on
every machine and in CI.

**Judgment, and therefore yours.** Whether the repo actually wants that file
gone. Whether a folder named `legacy/` is dead weight or a deliberate archive.
Whether a script with no importers is abandoned or is the deploy hook someone
runs by hand once a quarter. The scan gives you the facts and a confidence; the
decision, and the interview that informs it, are the model's job.

Keeping those halves apart is the whole design. When the model guesses at the
mechanical half, it hallucinates dead code. When the script decides the judgment
half, it quarantines the deploy hook.

## Why nothing is ever deleted

Deletion is a claim that the future will not need something, made by whoever
happens to be looking today. Tidy refuses to make that claim, and does not need
to: git history plus a quarantine directory make "gone from where it was" and
"gone forever" two different things, and only the first one is useful.

So the engine knows exactly three operations, and none of them destroys bytes:

| Operation | What actually happens | How it reverses |
|---|---|---|
| `quarantine` | `git mv <path> .attic/<date>/<path>` | `git mv` back |
| `untrack` | `git rm --cached <path>`, file stays on disk, pattern added to `.gitignore` | `git add -f`, ignore line dropped |
| `move` | `git mv <path> <to>` for reorganization | `git mv` back |

There is no delete path in `tidy-apply.ts`. It also refuses to run on the
default branch or on a dirty tree, so deleting the branch is always a complete
escape hatch, and it writes a `MANIFEST.json` carrying the exact inverse of
every operation it performed. `--undo <manifest> --apply` replays those
inverses.

## How a finding earns its confidence

`high` means a mechanical proof: two files with the same SHA-256, a path git
itself reports as ignored yet tracked, a zero-byte file, a `package.json` script
pointing at a file that does not exist, or a source file that no entry point
reaches, that nothing imports, that no tracked file mentions by name, and that
has not been committed to in more than the stale window.

`medium` means the proof holds but the file is recent enough that someone may be
mid-work on it. `low` means something is odd and a human should look: a source
file nothing imports but that the docs discuss, a loose file at the repo root, a
megabyte of binary in the tree.

The scanner is deliberately biased toward calling things used. An unresolvable
import marks its target reachable; a shebang makes a file an entry point; a
prose mention downgrades an orphan to a question. A false "still in use" costs a
line of output. A false "unused" costs someone their code.

## Reading the entry points right

Most false positives in dead-code detection come from a naive definition of
"entry point". Tidy treats all of these as roots of the reachability walk:
framework routes (`app/**/page.tsx`, `pages/**`, with or without `src/`),
`middleware`, `instrumentation`, config files, test files and `__tests__/`,
Python `conftest.py` and `test_*.py`, edge functions under `supabase/functions/`,
anything with a shebang, anything named in `package.json` (`main`, `module`,
`bin`, `exports`, or inside a script command), and anything a CI workflow,
Dockerfile, Makefile, lefthook config or shell script executes by path.

Prose that merely names a file is **not** an entry point. It is tracked as a
separate, weaker signal, which is what separates the `orphan` class from the
`unreferenced-code` class.

## The flow

Five phases, each ending in a file under `.keepwright/tidy/<date>/`. Templates
for every artifact are in `references/artifacts.md`.

0. **Inventory** — run the scan, write `INVENTORY.md`. Read-only.
1. **Charter** — interview the user, write `TIDY-CHARTER.md`: sacred ground,
   the proof command, the confirmed kill list, the scope. Open questions are
   marked `[NEEDS DECISION: ...]` and the phase is a gate: no planning while a
   marker remains.
2. **Plan** — write `plan.json` (machine-checkable) and `TIDY-PLAN.md` (for
   humans), including the findings you chose NOT to act on and why.
3. **Baseline, apply, prove** — green baseline, branch, dry run, apply, prove
   again. Red proof after apply means undo, then report which operation did it.
4. **Report** — `REPORT.md` and the PR: before and after, what moved where, and
   the undo command.
5. **Catalysis** — turn the recurring clutter into a `.gitignore` line, a rule,
   or a validator, so the same mess does not come back.

## Where this sits next to overhaul

`overhaul` is the aggressive sibling: it deletes on a branch, it rewrites
architecture, it needs a frontier model to grill the user and write specs, and
it changes how the code is shaped. `tidy` changes only where files live and what
git tracks. It never edits a line inside a file.

Reach for `tidy` when the repo is fundamentally fine and just dirty. Reach for
`overhaul` when the repo's structure itself is the problem. Running `tidy` first
is usually right: there is less to reason about after the noise is gone.

## Operating notes

- A `degraded` block in the scan output means an evidence source failed. Report
  it and stop; a partial scan cannot justify moving files.
- Never let a finding whose `action` is `review` become an operation on your own
  authority. It is a question for the user.
- Report provable counts. "12 quarantined, 41 left as open questions" is a
  result; "cleaned up the repo" is a vibe.
