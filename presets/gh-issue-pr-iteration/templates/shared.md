# coder-loop shared context for <PROJECT>

> **Note on what this file is.** `coder-loop` is a stateless loop — every
> iteration and review agent spawn starts fresh with no in-process memory.
> This file is the project's only durable cross-issue scratchpad. Keep it
> short, source-cited, and policy-bounded so it doesn't drift into a
> dumping ground.

Canonical task state remains in GitHub issues/PRs and `central SQLite state DB`. This file is for *cross-issue* facts that don't belong to any single issue.

## Memory policy

Allowed:

- stable cross-issue facts
- source-cited spike findings
- environment access notes
- non-obvious repo conventions
- recurring failure modes

Forbidden:

- raw logs
- full traces
- full issue bodies
- full PR diffs
- secrets/tokens
- screenshot blobs
- transient TODO state
- unverified assumptions

Keep this file short. Review agent may promote at most three durable facts per review, each with a source reference (issue/PR/comment id, doc path, or commit sha).

## Facts

<!--
Append facts as bullet lines. Each fact must include a `Source:` reference.
Example:

- The project test suite must run via `mise run test`, never direct `bun test`,
  because mise sets `HOME` and `FULCRUM_DIR` before Bun starts. Source: `CLAUDE.md` Testing section.
- Mattermost v10.12.4 upstream defines `POST /api/v4/posts/{post_id}/actions/{action_id}`;
  route-level 404 indicates a deployment issue, not a missing handler. Source: issue #72 handoff run-2026-05-03-18-26-21.
-->

(seed with the first real fact when one exists; do not pre-populate placeholders)
