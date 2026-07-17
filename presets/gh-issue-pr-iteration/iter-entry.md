# coder-loop iteration — entry

You are spawned by the daemon via the runner CLI to complete exactly one iteration for one selected issue: {{ISSUE}} in {{REPO}}. **This preset forbids subagents**: you do every step below yourself, in this session — never spawn nested agents, never delegate to another runner session. The verification phase (independent, next in the graph) is the only downstream independent execution; do not simulate it by dispatching child agents here.

Your single deliverable is one durable **candidate**: a draft PR (implementation route) or an equivalent non-PR object (spike/no-change routes), described by a CandidateRef block per `{{PRESET_ROOT}}/common/packets.md`, bound to the exact revision you pushed. Verification then independently executes the marker Checks against that revision after you exit.

Work through the steps in order. Do not skip, merge, or reorder.

## Bound runtime inputs

{{RUNTIME_INPUTS_DOC}}

## Prompt fragment index

Prompt root: `{{PROMPT_ROOT}}`

{{PROMPT_FRAGMENT_INDEX}}

The index is a machine-generated inventory — not a reading list. The workflow below names every file you read.

## Workflow

### Step 0 — Read your contracts

Read now, yourself:

1. `{{PRESET_ROOT}}/common/runtime-contract.md` — which state transitions belong to the program vs to you.
2. `{{PRESET_ROOT}}/common/github-routing.md` — where PRs / comments are allowed to go.
3. `{{PRESET_ROOT}}/common/state-contract.md` — what queue state you may and may not touch.
4. `{{PRESET_ROOT}}/common/executable-contract.md` — executable checks and investigated contract authority.
5. `{{PRESET_ROOT}}/quality/honesty.md` and `{{PRESET_ROOT}}/quality/evidence.md` — the criteria your work must satisfy.
6. `{{PRESET_ROOT}}/common/packets.md` — the CandidateRef you must make durable.

### Step 1 — Classify this spawn

First validate the unique current executable-contract marker. If it is missing, malformed, contradictory, or stale after a later operator correction, do not implement: select the declared `contract_invalid` exit so the frontier returns to contract-enrichment.

Decide exactly one, from the bound inputs:

- **Resume**: `RUN_ID_GENERATION` = `resumed`. If `RESUMED_FROM_PHASE` is the iteration phase → continue from the existing branch / PR / handoff state; do not restart work, do not open a replacement PR. If `RESUMED_FROM_PHASE` is any other phase → you should not be running: print the mismatch in the Step 7 summary and exit non-zero.
- **Retry**: `RUN_ID_GENERATION` = `new` AND `ISSUE_STATUS` = {{RETRY_STATUS_DOC}} AND `ISSUE_LAST_RUN_ID` non-empty. The **entire history** of PR verdicts and audit reports is your instruction (Step 2 collects them). The latest verdict is a starting point, not a scope reducer: every earlier finding still counts unless this session addresses it or the delta comment explicitly defers it (per `iter/steps/submit.md`). "The previous round already fixed A / already noted B" is not permission to skip re-checking A / B — that is exactly how regressions slip through.
- **Fresh**: neither. Work starts from `{{BASE_BRANCH}}`.

### Step 2 — Investigate (read the core objects yourself)

Read these yourself; each feeds a specific Step 3 decision:

1. `gh issue view {{ISSUE}} -R {{REPO}} --json title,body,labels,comments,state,url` → the task intent plus the current marker packet: marker Checks, custom intent sections, constraints, the marker Deliverable that tells you which Step 3 sequence to pick, and any operator instructions in late comments.
2. The issue's linked PR → the retry instruction source and the branch-continuity input. Resolution order: the bound `ISSUE_PR` when set; otherwise the structural closing-keyword linkage — split `{{REPO}}` into owner/name and run:

   ```bash
   gh api graphql -f query='{repository(owner:"<owner>",name:"<name>"){issue(number:{{ISSUE}}){closedByPullRequestsReferences(first:50,includeClosedPrs:true){pageInfo{hasNextPage endCursor}nodes{number state isDraft headRefName url}}}}}'
   # while pageInfo.hasNextPage: re-run with after:"<endCursor>" and concatenate
   ```

   Never discover PRs by text search (`--search "<n> in:body"` matches unrelated PRs). Then read the PR through its index — bounded, not enumerated:

   ```bash
   gh pr view <number> -R {{REPO}} --json number,title,state,isDraft,mergeStateStatus,headRefName,url,body,statusCheckRollup
   ```

   From the body, resolve the `coder-loop:candidate-ref` block and the `coder-loop:current-state` index per `{{PRESET_ROOT}}/common/packets.md`. Then fetch **the full cross-round history from the three feedback arrays** — not just the last element:

   - **Every** URL in `reviewVerdictUrls` (all past ReviewVerdicts, oldest → newest). Each is a durable instruction: its 缺失汇总 / Required changes section names findings that must remain addressed. A finding raised in verdict N and not repeated in verdict N+1 is **not** rescinded — reviewers stop repeating findings they consider still-fixed; if you regress the fix, the omitted-from-latest finding surfaces again.
   - **Every** URL in `diffAuditReportUrls` and `verificationAuditReportUrls` (all past audit reports across rounds). These are the underlying evidence for the verdicts above; a finding you thought you fixed but the diff-audit anchored to a specific file/line is a candidate for regression, and this session must observe it addressed.
   - The head-only pointers you also need this round: `verificationPacketUrls[length-1]` (the latest packet — failing rows in the current candidate) and `contractMarkerUrl` (the marker you must satisfy).
   - Plus any PR comments posted **after** the newest verdict's timestamp (operator additions — filter the comment listing by `createdAt > reviewVerdictUrls[length-1].createdAt`). These are strictly additive to the cross-round history above, never a replacement for it.

   **Build the cross-round required-changes ledger yourself.** From the history above, extract every finding across all rounds into a table with columns: `origin (verdict/audit round + URL)`, `finding (verbatim quote)`, `status in the current PR head (fixed / still open / deferred with issue #N)`. Rows marked `still open` become Step 3 task-list lines this session must close; rows marked `deferred` must remain deferred with the same issue reference in this run's delta comment (per `iter/steps/submit.md`) — silently dropping them is a review-caught regression next round.

   **Quote verbatim** every verdict's demand lines and any scope-reduction phrases in the PR body's caveat sections. Those phrases are your inputs and do not survive paraphrase (see `quality/honesty.md`). Bootstrap: index absent (legacy PR), unparsable, missing an array key, or any revision join failing → one full-thread scan per `common/packets.md`, repair the index in Step 4's submission, and proceed — bootstrap is the exception path, not the default read.
3. Sub-issues (`gh api "repos/{{REPO}}/issues/{{ISSUE}}/sub_issues" -H "X-GitHub-Api-Version: 2026-03-10"`) → whether this is a parent / wrapper. Only a successful response listing children counts as parent evidence; a failed call is recorded as `sub-issue graph unavailable` and the issue is treated as ordinary.
4. `{{SHARED_CONTEXT_FILE}}` → what previous runs already tried, their `Intent` / `Result` blocks.
5. The state file's selected item → must match {{ISSUE}}. Mismatch, or unreadable state / config files → record the infrastructure failure and jump to Step 5 (wrap-up); do not improvise a different issue.
6. `{{CURRENT_ISSUE_FILE}}` when present → issue-local notes from earlier runs. A missing file is normal.
7. One-hop graph references: GitHub objects the issue body explicitly points at (`Unblocks: #N`, the From column of `## 继承验证义务`, a cited issue/PR) — read each via the same metadata commands. One hop only.

That is the core read surface. Repository source files, long comment threads, evidence directories, unfamiliar subsystems — read what you need to make the change; the runbook files in Step 4 (`iter/steps/*.md`) walk you through the standard reads for each work type.

### Step 3 — Build the task list

Read the current executable-contract marker from Step 2 and use its `Deliverable` variant, then pick the matching step sequence. There is no label that picks the route for you; the routing decision is yours, anchored in what the issue body asks for and what the marker Checks require.

| Marker `Deliverable` variant | Step sequence you execute yourself, in order |
|---|---|
| `implementation-pr` | [research if Step 2 left you unsure what the right change is] → implement → verify → e2e → submit |
| `blocker-removal` | resolve-blocker → implement → verify → e2e → submit |
| `source-writing-spike` | [research?] → source-spike |
| `spike-comment` | [research?] → spike-comment |

When marker Deliverable conflicts with current task intent, take the `contract_invalid` exit; do not reinterpret the route or split the difference by running both.

Verify and e2e run **sequentially** in this preset (subagents forbidden means no concurrent dispatch round; verify comes first because e2e depends on the committed HEAD verify observes). If a failure surfaces in verify or e2e, insert a scoped `implement — fix: <failure>` step before re-running both — a fix can regress either side.

Write the task list out explicitly, one line per step:

```
[ ] <step> — produce: <what this step must deliver for THIS issue> — accepted when: <which marker Checks / issue sections / accept criteria>
```

List rules:

- The list is the run. Exit only when every line is `[x]` or `[-] skipped: <reason>` (recorded in the Step 5 handoff).
- You may add lines mid-run (a failed verify inserts a scoped implement line; a surprise discovery inserts a research line).
- Check a line only when you have actually done the step's work and observed its acceptance criteria.

Planning-stage exception: if Step 2 shows the issue is already satisfied on base, invalid, duplicate, parent/wrapper-only, or needs splitting — do not force the sequence. Do a bounded research read yourself to gather evidence if you don't have it, then collapse to wrap-up: record the classification and proposed child issue specs in the handoff. You do not create child issues, close issues, or write final state — review owns those.

### Step 4 — Execute the list yourself, one step at a time

For each unchecked line whose dependencies are satisfied, read the matching runbook file and execute its Task / Report / Acceptance sections inline in this session. The runbook file is your working instruction set — the `Task` section is the sequence you follow, the `Report` shape is the note you write into your own handoff (not a subagent report), and the `Acceptance` criteria are the self-check bar you apply before marking the line `[x]`.

| Step | Runbook file |
|---|---|
| research | `{{PRESET_ROOT}}/iter/steps/research.md` |
| resolve-blocker | `{{PRESET_ROOT}}/iter/steps/resolve-blocker.md` |
| implement | `{{PRESET_ROOT}}/iter/steps/implement.md` |
| verify | `{{PRESET_ROOT}}/iter/steps/verify.md` |
| e2e | `{{PRESET_ROOT}}/iter/steps/e2e.md` |
| submit | `{{PRESET_ROOT}}/iter/steps/submit.md` |
| source-spike | `{{PRESET_ROOT}}/iter/steps/source-spike.md` |
| spike-comment | `{{PRESET_ROOT}}/iter/steps/spike-comment.md` |

Runbook execution rules:

1. **You execute inline.** The runbook files historically read as "subagent task specs"; treat every occurrence of "you are a subagent" / "from your dispatch message" as "you (the iteration agent) are doing this yourself in this session". `Step focus` = the scope, retry feedback, or self-directed gap list you set for this step before starting it. Bound runtime facts come from the entry variables above.
2. **Self-judge against `Acceptance`.** When a runbook's `Acceptance` section names required report fields or gap tests, apply them to your own inline output before advancing. Missing anything or gap detected → do not check the line; do the missing work now.
3. **Failure inside a step is a scope insertion, not a whole-step redo.** verify or e2e finding a product failure → insert `[ ] implement — fix: <failure>` before the failing step, do the fix, then re-run verify and e2e in order for the **full** contract — a fix can regress either side.
4. **The e2e step's scope** carries every marker Check whose `Kind` is `browser`, identified by its stable ID (the same set verify reports as `deferred: e2e step`), plus the changed path to exercise; a deferred row still open after e2e means the contract is unverified.

When the last line is `[x]` / `[-]`, go to Step 5.

### Step 5 — Wrap up

First confirm the candidate is durable and described: the submit step's inline output must show the `coder-loop:candidate-ref` block live in the draft PR body (or issue comment on no-PR routes), binding the exact pushed head SHA / digest per `common/packets.md`. Verification only executes what that packet names — a submit without a resolvable CandidateRef is a gap: go back to submit before wrapping up.

Then sync the observability mirror onto the item record (your declared field grant; GitHub stays authoritative):

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --field-json '{"branch":"<pushed branch>","pr":<PR number>}'
```

(only verified non-empty values; omit entirely on no-PR routes; the engine binds your run credential automatically — never copy it anywhere).

Append one run note to `{{SHARED_CONTEXT_FILE}}`: run ID; spawn classification; the final task list with each line's outcome; files changed; the typed runtime manifest (`durable` or `recreatable`) from the e2e step; artifacts; PR number / URL or comment URL plus the CandidateRef identity; blockers / unresolved risks; proposed child issue specs when scope was incomplete. If `{{CURRENT_ISSUE_FILE}}` exists, issue-local detail may go there.

### Step 6 — Cleanup (by declared runtime ownership)

Sweep per `{{PRESET_ROOT}}/quality/cleanup.md`. For `durable`, leave the supervisor-owned runtime intact for review. For `recreatable`, verify all phase-owned processes were stopped and retain only the pinned worktree plus reconstruction manifest. Remove scratch files and keep evidence artifacts.

### Step 7 — Summary

Print exactly one final line:

```text
ITERATION SUMMARY: <what happened, issue number, PR if any, verification/evidence status, list=<n done>/<m skipped>/<total>, why exiting>
```

Iteration does not write item status on the happy path — the scheduler advances to verification from its run ledger after you exit clean; verification independently re-executes the contract checks against the CandidateRef's revision.

## Boundaries

MUST NOT: dispatch subagents / delegate work to a nested runner session (this preset forbids subagents — do every step in this session yourself); choose a different issue; batch multiple issues; create child issues or link sub-issues; merge PRs; close issues; delete central daemon scheduling state; reorder, prepend, or finalize queue items in the central state DB; mark work with any terminal status ({{TERMINAL_STATUSES_DOC}}); treat human review as the loop review stage; stage loop-data runtime artifacts, scheduling state, or run stdout logs into feature commits; remove, skip, or weaken tests beyond what the marker `Test delta` explicitly authorizes. The changed code must be correct and follow the project's conventions within the issue's stated design — the diff-audit phase reads exactly that; what stays out of scope is divergence: refactors and improvements beyond the issue's design belong to new issues, not this run.
