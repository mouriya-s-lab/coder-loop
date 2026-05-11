# Fragment: review/title-intent-gate

## Goal

For `kind:code` issues with an open PR, verify that the PR title's main subject aligns with the issue title's main subject. Catch noun-drift like `Shim CLI` (issue) vs `Shim SDK` (PR) where the iter agent silently re-scoped the deliverable.

This gate exists because such drift previously slipped through review on the assumption that the agent had a reason — it usually did not, and the wrong-scope PR was accepted (`Mouriya-Emma/moat-browser#75` documented in `Mouriya-Emma/coder-loop#4`).

## When this gate runs

- `ISSUE_KIND` is `code` AND a PR exists for the selected issue → run the gate.
- `ISSUE_KIND` is `comment` → skip via `title_gate_skipped`. Spike issues have no PR.
- `ISSUE_KIND` is empty (legacy unlabeled) AND a PR exists → run the gate. Legacy issues can still suffer scope drift.
- No PR exists for the selected issue (handoff-only / no-code path) → skip via `title_gate_skipped`.

## Inputs

- Issue title: `gh issue view {{ISSUE}} -R {{REPO}} --json title --jq .title` (re-fetch live).
- PR title: `gh pr view <PR_NUMBER> -R {{REPO}} --json title --jq .title` (re-fetch live; do not trust iter trace).
- Issue body summary: from `gh issue view --json body` if needed to disambiguate.

## Procedure

1. Extract the main subject from each title. The main subject is the principal noun phrase the title is acting on (the object of the verb, or the topic clause). Ignore conventional commit prefixes (`feat:`, `fix:`, `refactor(...):`, `chore:`), retroactive prefixes (`RFC:`), issue / PR number references, and language tags. Both Chinese and English titles use the same rule: strip conventional prefixes, identify the object noun phrase.

   Examples (Chinese / English):
   - issue `Shim CLI 客户端补丁` vs PR `feat: shim CLI client patch` → both subject = `CLI`. Aligned.
   - issue `Shim CLI 客户端补丁` vs PR `feat: shim SDK runtime` → subjects `CLI` vs `SDK runtime`. Drift.
   - issue `加 net0 channel 健康探测` vs PR `feat(net0): add channel health probe` → both subject = `net0 channel health probe`. Aligned.
   - issue `Bootstrap skill 自动 dispatch 当前 mission` vs PR `chore: clean up supervisor templates` → subjects diverge. Drift.

2. Compare subjects:
   - Exact noun match → aligned.
   - Substring / synonym alignment with obvious mapping → aligned (e.g. `登录流程` vs `login flow`).
   - One subject is a strict subset/specialization of the other AND the PR body's `Closes #N` matches the issue → aligned-narrowed (treat as aligned but record in trace).
   - Subjects refer to different concrete artifacts (different module names, different commands, different protocols, different surfaces) → drift, regardless of how similar they look.

3. When ambiguous (e.g. abbreviation vs full name where mapping isn't obvious), read the PR body's `## Summary` and the issue's `## 目标` / `## 问题` sections to disambiguate. Do not guess.

## Failure handling

Title drift is a structural mismatch, not a writing-style complaint. Even if the PR appears to implement something useful, accepting drift means the issue's actual problem is unsolved. Always emit `title_drift` on confirmed mismatch; retry feedback must:

- quote both titles verbatim;
- identify each subject;
- state which artifact the issue meant and which the PR delivered;
- instruct iteration to either (a) rename the PR + adjust scope to match the issue, or (b) close the PR and open a separate issue for the divergent scope.

Do not tell iteration to retitle the issue to fit the PR. The issue is the contract.

## Output verdict

Choose exactly one:

- `title_aligned` → read `review/evidence-gate`.
- `title_drift` → read `review/action-retry`. Retry feedback must cite both titles + subjects.
- `title_gate_skipped` → read `review/evidence-gate`. Gate did not apply (no PR / `kind:comment`). Record the skip reason in the trace.

Do not proceed past this gate while PR title and issue title subjects are confirmed to diverge.
