# Fragment: plan/intake

## Goal

Read the planning input. Confirm there is enough material to produce atomic issues. Bail out early if source is ambiguous or contradicts itself — don't invent scope.

## Inputs

The slash command (`/dev-plan <input>`) passes one of:

- a design document path;
- a GitHub issue / PR / RFC link;
- a user-described large task;
- a repository path plus goal;
- a cross-repo initiative.

Plus implicit context:

- target repository at `{{TARGET_CWD}}`;
- target's `.coder-loop/workflow.md` (project-specific commands, PR / evidence conventions, CI parity);
- existing GitHub issues / PRs in the target repo that may overlap.

## Procedure

1. Read the slash command argument and any referenced design source verbatim. Quote the section(s) the planning will key on.

2. Read `{{TARGET_CWD}}/.coder-loop/workflow.md` end-to-end. Extract:
   - project test / build / lint commands (e.g. `mise run test`, `bun test`, `pnpm build`);
   - PR title / body conventions;
   - evidence layer expectations beyond the four-layer baseline;
   - CI parity command (or "no CI" note).
   These become the `Command` column source for `## 验收标准` rows. Without reading workflow.md, checkpoints will drift from target reality.

3. Survey existing GitHub state. Run:
   ```bash
   gh issue list -R <repo> --state all --limit 50 --json number,title,state,labels
   gh pr list -R <repo> --state all --limit 30 --json number,title,state
   ```
   to detect overlap. If the user's task is already covered by an existing open / closed issue, surface that — don't duplicate.

4. Confirm source sufficiency:
   - source unambiguously specifies the user-visible problem;
   - source specifies the expected outcome (not the implementation);
   - source distinguishes hard external constraints from soft preferences;
   - source either gives concrete environment hints (target OS / runtime / dependencies) or the project's `workflow.md` does.

5. If source is insufficient, ambiguous, or contradicts itself:
   - quote the missing / conflicting passage;
   - identify the smallest set of questions needed to proceed;
   - do not guess; do not invent scope.

## Failure handling

If source is insufficient, emit `intake_needs_clarification`. The handoff fragment will record the questions; the slash command shell shows them to the operator and stops the planning run. Operator answers → re-invoke `/dev-plan` with augmented input.

If `workflow.md` is missing or empty, emit `intake_needs_clarification` with feedback "target repo needs `.coder-loop/workflow.md` describing project commands and conventions before planning can produce realistic checkpoints" — do not proceed by guessing project commands.

## Output verdict

Choose exactly one:

- `intake_clear` → read `plan/classify`. Source is sufficient to start classification.
- `intake_needs_clarification` → read `plan/handoff` with the unanswered questions. Planning stops, operator clarifies, re-invoke.
- `intake_blocked` → read `plan/handoff` with the exact infrastructure failure (target repo not accessible, `workflow.md` unreadable, `gh` auth failure).

Do not classify or decompose under `intake_needs_clarification` / `intake_blocked`.
