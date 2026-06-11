# Acceptance: spike-comment

## Required report fields

The report must contain: `Why this conclusion`; `What I actually did` with commands run (exit + excerpt), the posted comment URL, the selected branch verbatim, the proposed sub-issue titles as exact strings, and evidence artifact paths; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

Judge the spike report against:

- **Liveness** — the comment URL resolves to a real comment on the right issue (verify with a light `gh issue view <ISSUE> -R <REPO> --json comments` yourself).
- **Branch selection** — for spike issues, exactly one `## 结果分支` branch is selected, quoted verbatim, with the triggering evidence. Zero or multiple selections is a gap.
- **Follow-up sufficiency** — the selected branch's text decides the minimum proposals: branch text containing create/file/propose/开/提议/创建 or naming a follow-up type ⇒ at least one concrete title; "no action" branches ⇒ zero allowed. Placeholder titles (`TBD`, `<title>`) are gaps.
- **Evidence-backed** — the conclusion traces to executed commands / cited sources, per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-judge.md` and the claim-vs-observation rule of `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`.
- **No code written, no sub-issues filed** — proposals only.
