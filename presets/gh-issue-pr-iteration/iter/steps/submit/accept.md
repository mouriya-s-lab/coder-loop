# Acceptance: submit

## Required report fields

The report must contain: `Why I organized it this way`; `What I actually did` with commit SHA(s) + branch + push ref, the deliverable PR number/URL or PR-comment URL, the `Result (run …)` pointer with delta verdict, the packet section list, and the test-delta line; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Liveness** — the PR / PR comment actually exists: verify with a light `gh pr view <N> -R <REPO> --json url,body` / comment listing yourself. A reported URL that does not resolve is a hard gap (claim-vs-observation, `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`).
- **Protocol** — fresh PR: body first line exactly `Closes #<ISSUE>`; retry: a **new** PR-thread comment exists for this run (a body edit alone is a gap). Routing per `common/github-routing.md`.
- **Packet completeness** — the evidence packet carries the layered sections the target workflow demands, with commands/exits/excerpts, embedded screenshots, the E2E direct-run evidence, the runtime manifest, and the test-inventory delta line; every claim in the packet traces back to this run's verification report, not to new unverified claims. A secret value pasted into the PR body/comment is a hard gap — auth appears by resolution location only.
- **Delta honesty** — the `Result (run …)` block exists and discloses drift; check it against the intent-action mismatch trigger (quality/honesty-judge.md).
- **Hygiene** — no runtime artifacts staged; no merge/close performed.

Gaps go back to the same subagent with precise instructions (e.g. "comment posted to issue instead of PR thread — repost per routing"). After acceptance, the iteration deliverable is review-ready.
