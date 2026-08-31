# Tidy artifact templates

Everything a tidy run produces lives in `.keepwright/tidy/<date>/` and is
committed to the tidy branch. They are written for a reviewer who was not in the
conversation, so each one has to stand on its own.

The quarantine directory `.attic/<date>/` is committed too. That is the point:
the reviewer sees the moved files in the diff and can restore any of them with a
single `git mv`.

## INVENTORY.md

```markdown
# Tidy inventory — <repo> — <date>

## Verdict in three sentences
<what this repo is, what shape it is in, what the single biggest source of
clutter is>

## Size
| | Count | Bytes |
|---|---|---|
| Tracked files | | |
| Source files | | |
| Entry points found | | |
| Findings | | |
| Bytes flagged | | |

## Findings by class
| Class | Count | Highest confidence | What it means here |
|---|---|---|---|
| junk | | high | build output or machine-local files tracked in git |
| gitignore-gap | | high | git and .gitignore disagree about the same path |
| duplicate | | high | byte-identical copies |
| empty | | high | zero-byte tracked files |
| scratch | | medium | backup and one-off filenames |
| orphan | | medium | no entry point, no importer, no mention |
| unreferenced-code | | low | no importer, but the docs name it |
| heavy | | medium | large blobs every clone pays for |
| root-clutter | | low | loose files at the repo root |
| dead-script | | high | package.json scripts pointing at missing files |

## High-confidence findings (named individually)
| Path | Class | Evidence |
|---|---|---|

## The long tail
<counted and grouped, never pasted in full>

## Scan health
<"complete", or the degraded sources and what that makes unknowable>
```

## TIDY-CHARTER.md

The authority for the run. Anything not written here is not agreed.

```markdown
# Tidy charter — <date>

## Scope
<whole repo, or the subtree; and how much churn is welcome this round>

## Sacred ground (never moved, whatever the evidence says)
- <path or glob> — <why>

## Proof command
`<command>` — must pass before the run starts and after it finishes.
<or: "this repo has no proof command. The run is limited to provably inert
files and proposes nothing about code.">

## Confirmed kill list
<the high-confidence quarantine candidates the user explicitly blessed>

## Explicitly out of scope
<what the user asked to leave alone this round>

## Open decisions
[NEEDS DECISION: <question>]

<!-- The plan phase cannot start while a NEEDS DECISION marker is still here. -->
```

## plan.json

What the engine actually runs. It rejects the whole plan if any operation is
malformed, untracked, protected, duplicated, sacred, or missing a reason, and it
writes nothing when it rejects.

```json
{
  "label": "tidy 2026-08-31",
  "sacred": ["src/generated/", "vendor/"],
  "operations": [
    {
      "op": "quarantine",
      "path": "src/lib/old-widget.ts",
      "reason": "no entry point reaches it, zero files import it, no tracked file mentions it; last commit 412d ago"
    },
    {
      "op": "untrack",
      "path": ".DS_Store",
      "reason": "macOS metadata; machine-local and regenerable, stays on disk"
    },
    {
      "op": "move",
      "path": "notes-migration.md",
      "to": "docs/notes-migration.md",
      "reason": "loose doc at the repo root; docs/ is where this repo keeps prose"
    }
  ]
}
```

`reason` is what the reviewer reads in the PR. Write the evidence, not a
restatement of the action: "backup artifact, superseded by src/lib/widget.ts"
beats "moving this to the attic".

## TIDY-PLAN.md

```markdown
# Tidy plan — <date>

## What this run does
<one paragraph, in the order the operations run>

## Operations
| # | Op | Path | Lands at | Why |
|---|----|------|----------|-----|

## Deliberately NOT acted on
| Path | Class | Why it stays |
|---|---|---|
<the honest half. Every `review` finding belongs here or in a question.>

## Reversal
`bun scripts/tidy-apply.ts --undo .keepwright/tidy/<date>/MANIFEST.json --apply`
```

## BASELINE.md

```markdown
# Baseline — <date>

Command: `<proof command>`
Result: PASS | FAIL
Exit code: <n>

<the real output, trimmed to what proves the verdict>
```

A FAIL here stops the run. Cleanup cannot be proven harmless against a repo that
was already broken.

## MANIFEST.json

Written by the engine, never by hand. It holds every operation actually
performed with its exact inverse, and `undoAll` is the single command that
replays all of them in reverse order.

## REPORT.md

```markdown
# Tidy report — <date>

**Nothing was deleted.** Quarantined files live in `.attic/<date>/` with their
original paths preserved, and are restored with a single `git mv`.

## Before and after
| | Before | After |
|---|---|---|
| Tracked files | | |
| Tracked bytes | | |

## What moved
| Path | Now at | Why |
|---|---|---|

## What was untracked (still on disk)
| Path | Why |
|---|---|

## What was left alone
| Path | Why |
|---|---|

## Proof
Baseline: `<command>` PASS
After: `<command>` PASS

## Undo
`bun scripts/tidy-apply.ts --undo .keepwright/tidy/<date>/MANIFEST.json --apply`

## Catalyzed
<the .gitignore lines, rules or validators added so this clutter does not
come back, or "none, and why">
```
