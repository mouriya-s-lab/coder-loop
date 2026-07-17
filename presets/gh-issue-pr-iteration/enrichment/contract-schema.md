# Durable executable-contract schema

Publish a GitHub issue comment beginning with:

`<!-- coder-loop:executable-contract schema=1 source-issue={{ISSUE}} -->`

The comment must contain these sections:

- `Intent source`: issue URL, observed body update timestamp, and operator-comment URLs used.
- `Deliverable`: exactly one of `implementation-pr`, `spike-comment`, `source-writing-spike`, `blocker-removal`. These variants map one-to-one to the iteration and review routes; do not infer a different route from issue-body form.
- `Checks`: a table with stable unique `ID`, `Dimension`, and `Kind`; `Kind` is exactly `shell` or `browser`. Shell rows contain literal command, cwd/env and expected exit/output. Browser rows contain start/readiness, action and observation; never encode UI actions as shell.
- `Pattern scope`: a table with columns `Pattern | Scope | Criterion`, exactly one row per executable pattern. `Pattern` is the verbatim pattern/query; `Scope` is exactly `changed` or `whole-tree`; `Criterion` is the literal command/criterion that counts remaining unconverted sites — convergence means that count reaches zero after the change (a site that legitimately stays is enumerated inside `Criterion` as excluded, so the count still converges to zero). When the issue names no pattern target, declare that with the single literal row `| none | - | - |`. The diff-audit phase consumes exactly this table; a pattern stated in prose without a matching row, prose in place of the table, or a convergence criterion that expects a nonzero remaining count is a contract error.
- `Canonical runtime`: setup, start, readiness, behavior, logs and stop ownership. Name the target-mandated real E2E driver when one exists.
- `Test delta`: `forbidden`, `allowed-with-integrity`, or `required`, plus the surviving assertion/integrity rule.
- `Dependencies`: verified external facts and blockers with source references.
- `Supersedes`: prior marker URL or `none`.

A marker with missing sections, unknown variants, two current comments, or no source references is malformed. Later phases must fail explicitly rather than reinterpret it.
