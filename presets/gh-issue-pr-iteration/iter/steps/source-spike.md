# Step: source-spike

The source-writing spike subagent for a source-writing-spike-deliverable issue: proof-of-concept branches, temporary source files, runtime commands, and reviewer-visible evidence, where the result must never become a production PR merge. The deliverable is a GitHub issue comment plus evidence artifacts and, when useful, a pushed spike branch.

## Task

From your dispatch message: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there), `TARGET_CWD`, `EVIDENCE_DIR`, and `Step focus`. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` for project commands; plus `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/cleanup.md`.

1. **Read the spike contract.** Fetch the live issue body and comments (`gh issue view <ISSUE> -R <REPO> --json body,comments`). Use the marker `Deliverable`, typed `Checks`, and Dependencies; read the issue `## 结果分支` only as intent, and identify the `## 结果分支` branches **before** running anything — the spike exists to pick one of those branches with evidence.
2. **Take the spike branch.** Fresh spike:

   ```bash
   git switch <BASE_BRANCH>
   git pull --ff-only
   git switch -c "spike/issue-<ISSUE>-<RUN_ID>"
   ```

   Retry/resume: continue the existing spike branch when one exists; do not replace a usable branch to rename it.
3. **Build the smallest PoC.** Create/edit/delete only the PoC source files needed to answer the spike question. PoC code answers the question — it never masquerades as production implementation, never grows beyond what the question needs, and never gets cleaned up into "merge-ready" shape.
4. **Run the spike checks.** Run the strongest feasible runtime checks per `quality/evidence.md` (real path, text logs). When browser evidence is required and the spike has browser-observable behavior, capture it; otherwise record why it is not applicable. Capture each command's exit status as you go.
5. **Land the evidence.** Save concise logs/screenshots/artifacts under `EVIDENCE_DIR`. When the durable source state is itself useful evidence, commit and push the spike branch and record its head SHA; a local-only branch is acceptable when you record why pushing adds nothing.
6. **Post the issue comment.** Post (via `gh issue comment <ISSUE> -R <REPO> --body-file <path>`) a comment containing: `Run: <RUN_ID>`; the spike branch + head SHA when pushed (or the local-only justification); the commands run with exit status and artifact paths; the selected `## 结果分支` branch quoted verbatim with the evidence that triggered it; follow-up issue title proposals the selected branch requires; and an explicit statement that this is no-merge spike evidence, not production implementation. **No PR on this route** — if you are about to open one, the spike has drifted into implementation; stop and report instead. Also out: merging anything, closing the issue, writing queue state, staging loop-data runtime artifacts.

## Report

```markdown
## Why this PoC shape
<how the spike question constrained the PoC; what was deliberately left unbuilt>

## What I actually did
<spike branch + head SHA (or local-only justification); commands run with exit + excerpt;
the posted comment URL; selected 结果分支 verbatim; proposed follow-up titles;
artifact paths and what each proves>

## Problems
<checks that could not run and why; ambiguities in the spike question; side effects
(processes/PIDs, scattered files) for the cleanup ledger>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Liveness** — the issue comment exists (verify yourself, light `gh` read), carries `Run: <RUN_ID>`, and explicitly states no-merge spike semantics.
- **Branch evidence** — source changes come with branch + head SHA, or an explicit local-only justification. Missing both is a gap.
- **Command coverage** — every command promised by `## 验收标准` / `## 验证步骤` has an exit status and output/artifact reference; browser evidence present or explicitly not-applicable with a scope-based reason.
- **Branch selection & follow-ups** — exactly one `## 结果分支` selected; required follow-up titles concrete (same minimums as spike-comment acceptance).
- **No PR** — if a PR was opened on this route, that is a hard gap: have it closed and the evidence re-routed to the comment.
- Apply `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/honesty.md` to the packet.
