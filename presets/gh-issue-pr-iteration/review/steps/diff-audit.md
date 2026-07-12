# Step: diff-audit (review)

A diff-audit subagent for one coder-loop review. You audit what the PR **actually changes** against what the issue **authorizes it to change**, review the changed code against the issue's stated design, and audit the diff's test changes for hidden weakening. The anchor is absolute: you judge whether this code correctly and cleanly does what the issue specified, never whether a different design would be better, and never anything outside the change.

## Task

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `AGENT_CWD` (work there), `EVIDENCE_DIR`, and `Step focus`. Read now, before Step 1: `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/cleanup.md` — they bind your own command logs and side effects.

1. **Read the authorization source.** Fetch the issue intent plus the unique current executable-contract marker. Map changed files against intent, marker Deliverable, Pattern scope, Test delta, and constraints — read it before looking at the diff, so the diff cannot anchor your reading of the scope.
2. **Materialize the diff.** In `AGENT_CWD`: `gh pr view <ISSUE_PR> -R <REPO> --json headRefName,baseRefName,headRefOid`, then `git fetch origin <base> <head>`. Work from `git diff <base>...<head>` (three-dot, merge-base) plus `--name-status`; record both SHAs. Throughout you modify nothing: no commits, no checkouts that disturb worktree state, no GitHub writes.
3. **Map the scope, file by file.** For **every** changed file, classify: `in-scope` (name the issue requirement/acceptance row that demands it), `support` (test/doc/config change directly entailed by an in-scope change — name the entailing change), or `unmapped` (you cannot tie it to the issue). Do not stretch — a file justifiable only as "related cleanup" or "while at it" is `unmapped`, and every `unmapped` file is a finding.
4. **Hygiene scan.** Flag staged runtime artifacts anywhere in the diff: loop-data files, scheduling state, run stdout logs, evidence files, target-side runtime config/state directories, editor/OS droppings, lockfile churn with no dependency change.
5. **Test-integrity check (in the diff).** From `git diff <base>...<head>`, enumerate every test **removed** (test/it block or test file deleted), **renamed**, **skipped** (`.skip`, `.todo`, commented out, condition wrapped), or **weakened** (assertion deleted/loosened, expected value broadened, error-path assertion removed) in the diff. Also flag test-collection changes that would broaden or narrow the runnable set without touching a specific test (config edits, glob changes, skip-marker introductions, CI-config changes to the test invocation). Quote each: file, test name, what happened. The empty case is written explicitly — "none" — only after enumeration, never assumed. The head-side suite count and canonical test command belong to the replay step's canonical run (see `review/steps/replay.md`); a static `rg` / `grep` declaration count published as the inventory integer is a protocol violation for that report — you flag it in the diff, but the count itself is not your responsibility.
6. **Code review against the issue's design.** Two reading windows and one verdict; both must run.

   ### 6a. Issue-named pattern coverage (explicit scope, single pass)

   Every executable pattern MUST be declared in the marker packet `Pattern scope` section. `Scope` is the closed union `changed | whole-tree`. A pattern sentence elsewhere without exactly one matching table row, an unknown scope, duplicate rows, or conflicting scopes is a **contract error**; do not guess from prose or language.

   For each named pattern:

   1. Quote `Pattern`, `Scope`, and `Criterion` verbatim. Record base and head SHAs used for comparison.
   2. For `changed`, derive the candidate site set only from base→head added or modified lines (`git diff --unified=0 <base>...<head>`); run the criterion against those complete changed-line ranges. Pre-existing untouched matches are excluded from verdict.
   3. For `whole-tree`, run the criterion against the PR head's complete declared tree and enumerate every remaining site.
   4. List every matching site in the coverage table. `Sites > 0` means retry for either scope; the difference is the candidate set, not the severity. Zero sites is `converged` only with the command, scope, and base/head recorded.

   ### 6b. Diff-anchored code findings

   Read the changed code (and the unchanged code its correctness directly depends on — callers/callees of changed symbols). Report findings in four categories, each anchored:

   1. **Logic errors** — a concrete defect in the changed code: name the failure scenario (input/state → wrong behavior) with `file:line`. "Looks suspicious" without a traceable failure path is not a finding.
   2. **Design deviation** — the implementation diverges from the design intent and marker packet state (mechanism, placement, data flow it named). Quote the issue sentence it deviates from.
   3. **Convention violations** — the changed code breaks the target project's written conventions (target `CLAUDE.md`, workflow file) or is inconsistent with the immediately surrounding code (naming, error handling, typing idiom). Cite the convention source or the neighboring counter-example.
   4. **Structural defects in the change** — dead code the change introduces, duplicated logic within the diff, an abstraction the diff adds but uses once. Within the diff only.

   The no-divergence rule binds every 6b finding: nothing about code the diff does not touch *beyond what 6a's issue-named patterns already authorize* (a pre-existing bug you trip over goes as one line in Problems marked `out-of-scope observation`, never as a finding); no alternative-design proposals; no improvement ideas beyond the issue's design; no new requirements the issue and project conventions do not state. A finding that cannot cite its anchor does not go in the report.
7. **Summarize the footprint.** Describe the change footprint factually: surfaces touched, nature of the change per surface, 3–8 lines. The orchestrator compares this against the iteration's declared intent — you describe; you do not judge whether any mismatch matters, and no severity labels ("minor", "cosmetic") appear anywhere in the report: raw findings only.

## Report

```markdown
## Refs audited
base=<branch>@<sha> head=<branch>@<sha> (PR #<n>)

## Scope mapping
| File | Class | Mapped to |
|---|---|---|
| <path> | in-scope / support / unmapped | <issue requirement or row #, or entailing change, or `-`> |

Unmapped files: <list or `none`>

## Hygiene findings
<staged runtime artifacts / scheduling state / logs / droppings, with paths — or `none`>

## Test changes in the diff
| Test | File | What happened |
|---|---|---|
| <name> | <path> | removed / renamed to X / skipped via Y / weakened: <how> |

Test-collection changes (config/glob/skip-marker/CI): <list or `none`>

(or a single row `none | - | -` after actual enumeration)

## Issue-named pattern coverage
| Pattern (verbatim) | Scope | Base→head | Criterion / command | Sites | Verdict |
|---|---|---|---|---|---|
| <quote> | changed / whole-tree | <base sha>→<head sha> | <verbatim Criterion> | <count or `0`> | converged / <n> remaining: <one file:line per remaining site> |

(or a single row `none | - | - | - | - | -` only after confirming the marker declares no pattern target)

## Code findings (anchored to the issue's design)
| # | Category | Location | Finding | Anchor |
|---|---|---|---|---|
| <n> | logic / design-deviation / convention / structure | <file:line> | <concrete defect> | <failure path / issue sentence quote / convention source / diff evidence> |

(or a single row `none | - | - | - | -` after actually reading the changed code)

## Change footprint (factual)
<surfaces touched and the nature of each change, 3-8 lines, no quality judgments>

## Problems
<commands that failed, parts of the diff you could not audit and why,
processes started / files written (for the cleanup ledger)>
```

## Acceptance

Reject the report (send back the gap list) unless it contains all of: `Refs audited` with both SHAs; `Scope mapping` table covering **every** changed file; `Hygiene findings`; `Test changes in the diff`; `Issue-named pattern coverage` table with one row per declared pattern carrying verbatim pattern, explicit scope, base/head, criterion, complete in-scope site count and sites; `Code findings`; `Change footprint`; `Problems`. A report that paraphrases the PR description instead of auditing the diff is not a diff audit — send it back.

- **Unmapped files** → scope violation finding. An unmapped file is excusable only when the task intent or marker deliverable explicitly covers it.
- **Hygiene findings** → any staged runtime artifact / scheduling state / run log is a hard retry finding.
- **Test changes** → non-empty enumeration not authorized by the marker Test delta → test-weakening trigger of `{{PRESET_ROOT}}/quality/honesty.md`. Test-collection changes that widen or narrow the runnable set without marker Test delta authorization are the same trigger — flag them in the retry. Apply the same file's stale-baseline exception to pure count drift explained by base movement.
- **Issue-named pattern coverage** → missing/unknown/conflicting scope is a contract error. For `changed`, only complete base→head changed-line sites participate; for `whole-tree`, every head-tree site participates. Every in-scope row whose Sites > 0 is a retry finding and must cite all sites in one shot.
- **Code findings** → verdict inputs only when properly anchored: a logic finding must carry a traceable failure path; a design-deviation finding must quote the issue sentence; a convention finding must cite the source. Anchored findings route to retry with the anchor quoted. Discard alternative-design taste, improvement ideas beyond issue design, or code the diff does not touch and no 6a pattern covers.
- **Change footprint** feeds your caveat-honesty judgment: compare it against the iteration's declared `Intent (run …)` blocks for intent-action mismatch.
- Severity-downgrading language ("minor", "cosmetic") anywhere in the report → step defect, send back.
