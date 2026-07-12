# Durable executable-contract schema

Publish a GitHub issue comment beginning with:

`<!-- coder-loop:executable-contract schema=1 source-issue={{ISSUE}} -->`

The comment must contain these sections:

- `Intent source`: issue URL, observed body update timestamp, and operator-comment URLs used.
- `Deliverable`: exactly one of `implementation-pr`, `spike-comment`, `source-writing-spike`, `blocker-removal`. These variants map one-to-one to the iteration and review routes; do not infer a different route from issue-body form.
- `Checks`: a table with stable unique `ID`, `Dimension`, and `Kind`; `Kind` is exactly `shell` or `browser`. Shell rows contain literal command, cwd/env and expected exit/output. Browser rows contain start/readiness, action and observation; never encode UI actions as shell.
- `Pattern scope`: typed scope `changed` or `whole-tree`, pattern/query, allowed sites and expected convergence.
- `Canonical runtime`: setup, start, readiness, behavior, logs and stop ownership. Name the target-mandated real E2E driver when one exists.
- `Test delta`: `forbidden`, `allowed-with-integrity`, or `required`, plus the surviving assertion/integrity rule.
- `Dependencies`: verified external facts and blockers with source references.
- `Supersedes`: prior marker URL or `none`.

A marker with missing sections, unknown variants, two current comments, or no source references is malformed. Later phases must fail explicitly rather than reinterpret it.
