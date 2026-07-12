# Step: implement

An implementation subagent for one coder-loop iteration. The deliverable is working code on the issue branch — not a commit, not a PR; later steps own those.

## Task

From your dispatch message: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there), `SHARED_CONTEXT_FILE`, `ISSUE_STATUS`, `RUN_ID_GENERATION`, `ISSUE_BRANCH`/`ISSUE_PR` when set, and `Step focus` (current scope, retry feedback to address, or the orchestrator's gap list). Read now, before Step 1: `{{PRESET_ROOT}}/quality/honesty.md` and `{{PRESET_ROOT}}/quality/cleanup.md` — they bind every claim and side effect below.

**Process discipline** (binds the implementing in Step 5; the delivery-form rules in this file — row coverage, intent block, test integrity — bind on top):

- **Test-first for feature/bugfix code.** Write the failing test before the production code, run it, and watch it fail for the expected reason — a test that passes immediately tests nothing; fix the test, not the code. Then write the minimal code to green and watch it pass alongside the rest of the suite. Checks that are pure config/docs carry no test-first obligation — the executable contract decides, and a borderline call goes in Problems.
- **Root cause before any fix.** When a test or build fails unexpectedly: read the full error, reproduce it, check what changed, form one hypothesis, and test it with the smallest possible change — never stack speculative fixes. Three failed fixes mean the approach is wrong, not that a fourth is due: stop and record the situation in Problems for the orchestrator's call.
- **Retry feedback is claims to verify, not orders.** When `Step focus` folds in review feedback, check each finding against the actual code before changing anything; implement confirmed items one at a time, testing each. A finding that is technically wrong for this codebase is answered with reasoning in your report, never silently obeyed — and never with performative agreement either way.

1. **Read the contract.** Fetch the complete issue intent and the unique current executable-contract marker. Read every typed `Checks`, `Pattern scope`, `Canonical runtime`, `Test delta`, `Deliverable`, and `Dependencies` entry; implement so each applicable entry can pass. Never silently drop a stable Check ID. An intrinsically broken Check makes the marker contract-invalid; do not reinterpret it as implementation intent.
2. **Take the branch.**
   - Retry / resumed run (`ISSUE_STATUS` is the preset's retry continuable status, or `RUN_ID_GENERATION` = `resumed`): continue the existing branch (`ISSUE_BRANCH`). Before changing anything, inspect and record: `git log --oneline <BASE_BRANCH>..HEAD` (what previous runs already committed), `git status --short` (which dirty files are previous-run work in progress vs unrelated — unrelated dirty files are preserved untouched), and the latest PR review/comments (the demands your `Step focus` answers). Restart from base only when the branch's commits are unrelated to this issue — record why.
   - Fresh run:
     ```bash
     git switch <BASE_BRANCH>
     git pull --ff-only
     git switch -c "issue-<ISSUE>-<RUN_ID>"
     ```
3. **Decide the change before writing it.**
   - Classify: additive / substitutive / corrective / removal / investigative / mixed. Classification changes what "complete" means — substitutive and removal work are scope traps (adding the new thing while the old thing still stands).
   - For substitutive/removal work: grep/read the actual code to find the full footprint of the old thing, list **every** live site, and decide per site — this change owns it / another named issue owns it / it is inert. A site you cannot classify is a decomposition gap: record it in Problems.
   - If you cannot see the right change, stop here and report that instead of writing speculative code — the orchestrator dispatches research. Committing a guess wastes a review cycle.
4. **Declare intent.** Append to the chain handoff file (`SHARED_CONTEXT_FILE`) under a heading `Intent (run <RUN_ID>)`: your understanding of the issue in your own words, citing the body sections you are responding to; the change classification and footprint plan (sites touched vs out of scope, and why); what this dispatch will do; known uncertainties. This is your working log — the submit step writes a matching `Result (run <RUN_ID>)` block with the delta. Do not retro-edit the intent; write the delta.
5. **Implement.** Make the smallest direct change that closes exactly this issue. No batching, no drive-by refactors, no style cleanups beyond the contract. Within that scope the code must hold up to review: follow the issue's stated design exactly (mechanism, placement, data flow it names), match the target project's written conventions (`CLAUDE.md`, workflow file) and the idiom of the immediately surrounding code, introduce no dead code or one-use abstractions. Review independently reads the diff against the issue design and rejects on these.

   Touching a test file: never remove, skip, rename-away, or loosen an existing test unless the marker packet Test delta explicitly authorizes that exact change. A test that must change because it pins the very behavior this issue changes: record old test name → new assertion for your report. Review independently diffs the test inventory against base — an undeclared delta is treated as hidden weakening.

   Every process you start and every file you create outside the deliverable: write it down as you go — the Problems section is the orchestrator's cleanup ledger input.
6. **Stop and report.** Do not commit, push, open a PR, comment on GitHub, close issues, or write queue state — later steps own those. Confirm the uncommitted state on the branch matches what you are about to claim, then report per the Report section below.

## Report

```markdown
## Why I did it this way
<your reading of the issue contract; change classification and why; footprint decision
(sites touched vs left, with owners); path chosen over which alternatives>

## What I actually did
Branch: <name> @ <head sha (uncommitted: say so)>
Files changed: <bulleted list, every file, with one clause each on what changed>
Intent appended: <handoff path + heading written>

Check coverage:
| Check ID / intent constraint | Addressed by | Status |
|---|---|---|
| <stable Check ID or intent constraint> | <which change> | addressed / deviated: <how> / deferred: <why> |

Test changes: <every test added/modified/removed/renamed/skipped with old→new — or `none`>

## Problems
<uncertainties; discoveries outside the issue scope; deviations from intent;
unclassifiable footprint sites; processes started / files scattered (for the cleanup ledger)
— or `none` per item>
```

## Acceptance

Report structurally missing branch+head, files-changed list, intent pointer, Check-coverage table, test-changes enumeration, or Problems → send back before judging substance.

- **Contract coverage** — every applicable executable-contract entry and intent constraint is either addressed or flagged with a concrete deviation reason in the Check-coverage table. Silent drops are gaps. (Cross-check against the current marker and source issue revision; re-fetch if stale.)
- **Classification sanity** — the declared change classification matches what the issue demands; for substitutive/removal work the footprint list exists and each site has an owner. "Added the new thing" with the old thing unaccounted for is the classic trap — a gap.
- **Test integrity** — a non-empty test-changes enumeration must be justified by the issue contract; removal/skip/loosening the marker Test delta does not explicitly authorize is a gap to send back now (cheaper than at review's diff-audit).
- **Intent landed** — the handoff file contains an `Intent (run …)` block for this run. Missing intent on a substantive change is a gap.
- **Boundary compliance** — no batching, no commits/PRs/GitHub writes.
- Apply `{{PRESET_ROOT}}/quality/honesty.md` — especially intent-action mismatch, cross-issue deferral, and test weakening triggers in the report itself.

The gate is the contract and the report's coherence — review's diff-audit independently reads code against issue design, so do not duplicate a line-by-line code review here; but a report that itself reveals a design deviation is a gap to send back now. Send back precise gap lists; do not fix code yourself.
