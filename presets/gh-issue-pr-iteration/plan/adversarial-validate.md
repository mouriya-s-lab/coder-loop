# Fragment: plan/adversarial-validate

## Goal

Before posting issues to GitHub, simulate the laziest iter agent's path to passing every checkpoint. If that shortcut can succeed while the user-visible problem remains unsolved, the issue is broken — sharpen it.

This fragment exists because issues that pass formatting check still produce wrong PRs when checkpoints don't actually enforce the desired outcome. `Mouriya-Emma/moat-browser#75` is the canonical case (Shim CLI → Shim SDK drift through a checkpoint that didn't bind the deliverable to the CLI subject).

## Inputs

- All draft issue bodies from `plan/checkpoint-author` (tables filled).
- `contract.md` §5 (planning invariants) for what counts as "wrong PR".

## Procedure

For each draft issue, run the adversarial simulation:

1. **Minimum-effort path simulation**.
   - Read every row of `## 验收标准` + `## 继承验证义务`.
   - For each row, ask: "what's the smallest change — to source code, test fixtures, the issue itself, or even just to PR evidence — that satisfies `Expect`?"
   - Compose those minimum changes into the laziest possible PR.
   - Ask: "does this PR actually solve the `## 问题` paragraph?"
   - If YES → checkpoints are tight enough.
   - If NO → checkpoints have a hole.

2. **Common holes to look for**:
   - **Mocked instead of real**: row says `Command: bun test` Expect `pass`, but unit tests can be made to pass while integration breaks. Add `integration` Dimension row that runs against real dependency.
   - **Surface-only check**: row checks `test -f foo.md` but doesn't check content. Add `wc -l` or `grep` for required tokens.
   - **Wrong subject binding**: row checks that a feature works but doesn't bind to the specific module / command / API name from `## 问题`. Add a row that greps for the specific subject.
   - **Free pass from CI**: row says "CI green" but CI doesn't run the failing scenario. Either add direct command row or sharpen what CI must check.
   - **Vague Expect**: `Expect: works correctly`. Replace with concrete: exit code, output substring, file count.
   - **Skipped environment**: function rows pass but the actual target environment (Docker / VM / browser) wasn't exercised. Add `environment` Dimension row.

3. **Terminology disambiguation**. For each ambiguous term (abbreviation, jargon, project-internal name), check whether the issue defines it inline at first use. If a future iter agent could read the body and reasonably guess wrong, define it inline. Examples:
   - "Shim CLI" — does the agent know whether this means CLI vs SDK vs runtime? If not, add inline note.
   - "auth flow" — define which auth (SSO / password / API key).
   - "the API" — name it explicitly with route or function.

4. **Implicit requirement check**. For each `## 约束` and `## 预期结果` bullet, ask: "if the iter agent missed this constraint while iterating, would the resulting PR still pass checkpoints?" If yes, the constraint needs a corresponding checkpoint row that catches violations. Implicit constraints invisible to checkpoints get violated.

5. **Title subject re-check**. Re-read the title with the laziest-PR simulation. Does the simulated PR title's subject match the issue title's subject? If the simulated PR could rename the subject and still pass, the title-intent-gate hole exists. Sharpen title or add subject-binding row.

6. **Spike-specific adversarial**:
   - For `kind:comment` issues, simulate the laziest spike comment. Does it select a `## 结果分支` line AND propose the minimum sub-issue titles?
   - For `kind:code-spike` issues, simulate the laziest source-writing spike. Does it write real PoC/runtime evidence, post a no-merge issue comment, and avoid PR creation/merge?
   - If the spike comment could say "assumption holds" without proposing the downstream implementation, `## 结果分支` isn't forcing sub-issue creation — fix the branch text.

## Failure handling

If any draft has a hole the simulation found, edit the body (sharpen checkpoint row, add new row, define terminology inline, tighten title). Mark which rows were added / changed.

If you find a hole you can't fix without re-classification (the issue is actually a `spike` not `implementation`, or vice versa), emit `sharpen_resplit` and bounce back to `plan/classify`.

If the body passes adversarial simulation as-is, mark it `validated` and move on.

## Output verdict

Choose exactly one:

- `validated` → read `plan/create-issues`. All draft bodies survived adversarial simulation.
- `sharpen_checkpoints` → return to `plan/checkpoint-author` with the specific holes to patch. The next pass through checkpoint-author should re-author only the affected rows, not rewrite the whole table.
- `sharpen_resplit` → return to `plan/classify` with candidates that need re-classification.
- `validation_blocked` → read `plan/handoff` if the simulation surfaced a contradiction the operator must resolve (e.g. the issue's `## 问题` and `## 预期结果` are inconsistent).

Do not post issues to GitHub while any draft is in `sharpen_*` state.
