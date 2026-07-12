# Step: spike-comment

The spike subagent for a comment-spike-deliverable issue (spike / design question / open dialogue). The deliverable is a GitHub issue comment with cited evidence plus proposed follow-up sub-issue titles — no code.

## Task

From your dispatch message: `ISSUE`, `REPO`, `AGENT_CWD`, `EVIDENCE_DIR`, `SHARED_CONTEXT_FILE`, `CURRENT_ISSUE_FILE` when present, and `Step focus`. Read now, before Step 1: `{{PRESET_ROOT}}/quality/evidence.md`. Your writable surface is: the chain handoff file, an existing per-issue file, and `EVIDENCE_DIR` — never source, preset, test, or app files; no branches, no commits, no PRs.

1. **Read the question and executable contract.** Re-fetch the live issue: `gh issue view <ISSUE> -R <REPO> --json title,body,labels,comments,state,url`. Validate that the current marker `Deliverable` is `spike-comment`; use its typed `Checks` and `Dependencies` for execution. Use body headings only to understand intent and the result branches:
   - Spike issue → `## 目标`, `## 验证步骤`, `## 验收标准`, `## 结果分支`: report the verification result and pick exactly one result branch.
   - Design question → `## 目标`, `## 问题`, `## 预期结果`, `## 约束`: answer with cited evidence.
   - No headings (legacy) → treat the whole body as one question, answer in prose.
2. **Gather the evidence.** Execute every marker Check by stable ID (`shell` with literal command/cwd/env/expected output; `browser` with its start/readiness/action/observation); read the PRs/commits/issues/docs the body references. Capture outputs under `EVIDENCE_DIR` so the comment can cite them by path. A conclusion you cannot back with an executed check or a citable source does not go in the comment as a conclusion — it goes in as an open question.
3. **Compose the comment (Chinese).**
   - one-line conclusion at the top;
   - evidence section with cited quotes (`> "…" — <repo>#<N>` / `<repo>@<sha>` / command + output);
   - spike issues: the selected `## 结果分支` branch quoted verbatim — exactly one — and what evidence triggered it;
   - follow-up sub-issues when the selected branch requires them or the dialogue reveals splittable scope: each with a concrete title + one-paragraph why + intended parent edge. These are **proposals in the comment** for the operator/review to act on — you do not file sub-issues, do not edit the issue body, do not close the issue, do not touch queue state;
   - recommended next state for this issue (close / superseded / blocked-on-proposal).
4. **Post.** `gh issue comment <ISSUE> -R <REPO> --body-file <path>` (body-file survives shell quoting). Confirm the comment URL resolves.

## Report

```markdown
## Why this conclusion
<how the evidence led to the answer; for spike issues, why this 结果分支 and not the others>

## What I actually did
<commands run with exit + excerpt; the posted comment URL; selected branch verbatim;
the proposed sub-issue titles (exact strings); evidence artifact paths>

## Problems
<questions the evidence could not settle; gh failures with output; ambiguities needing
operator clarification; side effects for the cleanup ledger>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Liveness** — the comment URL resolves to a real comment on the right issue (verify with a light `gh issue view <ISSUE> -R <REPO> --json comments`).
- **Branch selection** — for spike issues, exactly one `## 结果分支` branch is selected, quoted verbatim, with the triggering evidence. Zero or multiple selections is a gap.
- **Follow-up sufficiency** — the selected branch's text decides the minimum proposals: branch text containing create/file/propose/开/提议/创建 or naming a follow-up type ⇒ at least one concrete title; "no action" branches ⇒ zero allowed. Placeholder titles (`TBD`, `<title>`) are gaps.
- **Evidence-backed** — the conclusion traces to executed commands / cited sources, per `{{PRESET_ROOT}}/quality/evidence.md` and the claim-vs-observation rule of `{{PRESET_ROOT}}/quality/honesty.md`.
- **Check completeness** — every stable ID from marker `Checks` appears with its actual observation; missing or intrinsically broken marker Checks route to contract-invalid rather than being reinterpreted.
- **No code written, no sub-issues filed** — proposals only.
