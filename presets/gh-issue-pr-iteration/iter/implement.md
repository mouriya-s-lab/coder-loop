# Fragment: iter/implement

## Goal

Implement one complete deliverable for the selected issue.

## Branch and PR continuity

If this spawn is a retry (`ISSUE_STATUS` is `changes_requested` and `ISSUE_LAST_RUN_ID` is non-empty) or a resumed iteration (`RUN_ID_GENERATION` is `resumed` and `RESUMED_FROM_PHASE` is the iteration phase), continue the existing branch/PR/worktree state when present. Inspect the existing branch, PR, latest PR review/comment, handoff, trace, evidence directory, and dirty files. Do not restart from the base branch unless the existing branch/PR is unrelated to the selected issue.

For a fresh issue when code changes are needed, use the configured base branch and create a run-specific branch:

```bash
git switch <BASE_BRANCH>
git pull --ff-only
git switch -c "issue-<ISSUE>-<RUN_ID>"
```

## Read commitments before implementing

For `kind:code`, `kind:blocked`, and legacy unlabeled issues, the issue body may carry machine-checkable commitments that review will enforce row-by-row. Before writing code, read the issue body's `## 验收标准` 与 `## 继承验证义务` 表全部 Command 列 from the live GitHub state (use the `gh issue view --json body` output from `iter/read-context`). Each row's Command column is a concrete check; each row's Expect column is the result review will compare against.

Implement the change so that every Command row will pass. If a row's Command cannot be made to pass within the current environment (e.g. it requires VM, browser, or external service), capture the evidence that the row's intent is satisfied via an alternative observable proof and record the deviation in handoff — but do not silently drop the row.

If the issue body has no `## 验收标准` table (legacy issue without structured body), this section does not apply; proceed under the implementation constraints below.

## Think before implementing

The issue body alone is not enough context to implement a non-trivial change correctly. Before writing code, walk through this thinking procedure. It is not a checklist to mechanically tick — it is a thinking framework. The output is your own understanding, not a form to fill.

1. **Read the live issue body in full**, including any sections beyond `## 验收标准`. Issue authors may write sections like "完成态描述", "不应残留", "PR body 应包含...", "Review 必须验证...", or any other custom section to encode constraints specific to this issue. Identify all of them. Treat each as a real constraint, even if it does not appear in the gate-enforced tables.

2. **Classify the kind of change this issue demands.** Ask yourself: is it
   - additive — introducing new behavior alongside what exists;
   - substitutive — replacing an existing behavior or system with a new one;
   - corrective — fixing a defect in existing behavior;
   - removal — taking out behavior that should no longer exist;
   - investigative — research / spike / understanding-building, may produce no code;
   - mixed — combinations of the above.

   The classification changes what "complete" looks like. Substitutive and removal work especially are scope traps: it is easy to add the new thing while leaving the old thing standing.

3. **For substitutive or removal work, find the full footprint of the thing being replaced/removed.** Do not work from memory. Run grep / read / explore as you judge useful. List every site in the current code where the old thing still lives. Decide for each site whether (a) this PR owns it, (b) it belongs to another open issue you can name, or (c) it's annotation/test fixture/clearly inert. Sites you can't classify mean the issue decomposition has a gap — surface that gap; do not assume the absence of a row in the acceptance table means the site is someone else's problem.

4. **Decide whether writing code is the right move this iteration.** Writing code is not the only valid iteration output. If after step 1-3 you are not yet sure what the right change is, the right move may be to do focused research this iteration — read more code, run exploratory commands, compare scenarios — and write up your findings rather than committing speculative code. This option is always available; it is not a fallback path, not a special category, and not gated by review feedback. Choose it when it produces more useful signal than a half-considered code change.

5. **Write down your intent before you start coding** (see the Intent statement section below). The act of writing the intent is part of the thinking, not paperwork.

## Intent statement

Before making code changes (or deciding this iteration is research-only), write down for review what you are about to do. The intent statement is the durable surface that lets review later compare what you said you would do against what you actually did.

Content the statement must convey, in whatever form (prose / list / table) you judge clearest for this issue:

- your understanding of what the issue is asking for, in your own words, citing the specific sections of the issue body you are responding to;
- what kind of change you classified this as (per step 2 above) and why;
- the full footprint you identified (per step 3) when applicable, and your plan for which sites this PR will touch versus which sites are out of scope and why;
- what you plan to do in this iteration — code change scope, evidence you intend to produce, or research-only direction;
- known uncertainties: things you cannot decide without doing the work itself, and how you will surface them if they turn out to matter.

Where to write the intent statement:

- Always append it to the current issue handoff file (`{{CURRENT_ISSUE_FILE}}`) under a clearly labeled `Intent (run {{RUN_ID}})` heading. This is the durable surface review reads regardless of PR state.
- If no PR exists yet and you will create one this iteration, the intent statement also belongs in the PR body as its opening section — review reads this as the cover letter.
- If a PR already exists (retry / resumed), the intent statement for this iteration belongs in a new PR thread comment. Do not rewrite the original PR body to update intent; PR body is immutable once posted.

If you are doing research-only this iteration (no code), the intent statement still belongs in handoff + PR comment (or as a fresh issue comment when no PR exists). It is what tells review "this iteration's deliverable is research, here is what I learned, here is what informs the next iteration." Without the statement, review cannot distinguish research-only from drift.

## Implementation constraints

- Make a small direct change that closes exactly the selected issue.
- Do not batch multiple issues.
- Do not weaken tests.
- Do not stage `loop-data runtime artifacts`, central daemon scheduling state, or run stdout log.
- Do not create child issues, link sub-issues, merge PRs, close issues, or write final local state.
- Preserve unrelated dirty files.

## Output verdict

Choose exactly one:

- `implementation_ready_for_verification` → read `iter/verify-evidence`.
- `implementation_blocked` → read `iter/handoff` with the exact blocker and attempted command/query.

Do not proceed to commit/PR before required verification evidence exists.
