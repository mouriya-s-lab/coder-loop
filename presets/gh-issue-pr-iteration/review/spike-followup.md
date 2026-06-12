# Judgment guide: spike follow-up (`kind:comment`)

For `kind:comment` issues the deliverable is the iteration-posted issue comment; its value is the follow-up it unlocks. A comment that answers the question without delivering what `## 结果分支` requires has not delivered.

## Inputs (read yourself)

- Live issue body + comments: `gh issue view <ISSUE> -R <REPO> --json body,comments` — always re-fetch, never trust the trace snapshot.
- The iteration-posted comment for this run (match by `Run: <RUN_ID>` or the handoff's stated comment URL).

## Judge

1. **Comment liveness** — the comment stated in the handoff exists in the live thread on the right issue. Absent = trace-honesty failure (retry).
2. **Branch selection** — the issue's `## 结果分支` lines vs the comment: exactly one branch selected, identifiably quoted. Zero or multiple = retry.
3. **Follow-up minimum** — the selected branch's own text sets the minimum: contains create/file/propose/开/提议/创建 or names a follow-up issue type ⇒ ≥ 1 concrete proposed title; "no action needed" branch ⇒ 0 allowed. Placeholder titles (`TBD`, `<title>`, vague one-worders) do not count.
4. **Evidence-cited conclusion** — the conclusion traces to executed commands or cited sources (quality/evidence-judge.md applies).

## Retry feedback shape

Posted on the issue (no PR exists): quote the `## 结果分支` lines verbatim; quote the comment's selected branch (or note none); list the missing/vague proposal slots; instruct iteration to repost or amend the comment with the required titles.
