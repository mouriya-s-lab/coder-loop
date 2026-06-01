# coder-loop workflow for <PROJECT>

> **Note on what coder-loop is.** `coder-loop` itself is just a stateless loop: it
> alternates iteration/review agent spawns, captures their output, and writes
> trace/log/status files. It does **not** judge issue completion, evidence
> sufficiency, PR correctness, or parent closure. All of those judgments come
> from this `workflow.md` (project policy) plus live GitHub state. If you delete
> a rule from this file, the loop stops enforcing it. Keep this file project-
> owned and committed; the agents read it every spawn.

This template is a generic starting point distilled from the Fulcrum
implementation, which is a known-good default. Adapt every section to your
project — language, evidence layers, CI-parity expectations, browser-evidence
requirements may all differ.

## Goal

<One paragraph: what should the loop optimize for in this repo? Examples: "resolve all actionable open issues in priority order", "track upstream X latest while preserving fork direction", "land design-doc spike issues before implementation children". Make the priority/scope policy explicit so review and iteration agents agree.>

## Source of truth

- Queue/order/state: `central SQLite state DB`
- Chain handoff/shared context: `loop-data/chains/<chain>/shared.md`
- Optional per-issue handoff attachments: `loop-data/chains/<chain>/issues/<issue>.md`
- Runtime evidence/logs: `loop-data/chains/<chain>/evidence/` and `loop-data/chains/<chain>/runs/`
- Live GitHub issue/PR state verifies reality.
- `CLAUDE.md` is project reference only. It is not the loop workflow.

If this workflow conflicts with target `CLAUDE.md` about loop process, queue state, PR evidence, or browser evidence, follow this workflow. If this workflow conflicts with `CLAUDE.md` about project commands, tests, migrations, or codebase conventions, follow `CLAUDE.md`.

## Non-negotiable PR rules

- One PR closes exactly one issue.
- PR body first line must be `Closes #N`.
- <PR title/body language requirement, e.g. "PR title and body must be Chinese." or remove>
- PR body must include all required evidence layers (see skeleton below) plus an `Analysis` section.
- <Browser/E2E evidence requirement if any — keep, weaken, or remove>
- PR body is the immutable opening cover letter and initial evidence packet; do not rewrite it as a per-iteration test log. After an implementation PR exists, every iteration/retry must post a new PR-thread comment with addressed review feedback, what changed, and the full current evidence packet. Preserving every iteration comment is required evidence history.
- Do not mark an issue done without credible evidence.
- Review agent is the final gate: accepted PR-backed work is merged by review; retry/blocked/skipped/no-code decisions are classified by review.
- Iteration agent must never merge PRs or close issues.
- Do not stage `.coder-loop/`, central daemon scheduling state, run stdout log, `.claude/scheduled_tasks.json`, runtime logs, or untracked runtime evidence into feature PRs.

## Required PR body skeleton

```markdown
Closes #N

## Summary

<1-3 sentences.>

## Layer 1 — Change preview

<dry-run / diff / migration preview / not applicable reason + analysis.>

## Layer 2 — Landing checks

<files, code paths, tests, config, migration checks + analysis.>

## Layer 3 — Startup / runtime ordering

<dev server / service / startup / CI / deploy ordering evidence or not applicable reason + analysis.>

## Layer 4 — End-to-end behavior

<E2E evidence. If browser-based: include committed screenshot paths and what each proves, positive and negative/error cases where applicable. If non-UI: equivalent integration evidence.>

## Analysis

<2-4 sentences on whether evidence is sufficient and what risk remains.>
```

Drop layers your project genuinely doesn't need. Adding layers later is cheaper than starting with too many and silently waiving them.

## Verification commands

<Project build/test commands. Reference your `CLAUDE.md` rather than duplicating, e.g.:

- Build/type validation: `<command>`
- Full tests: `<command>`
- Focused tests: `<command>`

Note any test-isolation gotchas (env vars, sandboxes, mise/uv/poetry wrappers) so agents don't bypass them.>

## CI-parity evidence

Every PR must state:

- whether GitHub Actions / project CI was detected;
- the local CI-parity command or why exact parity cannot run locally;
- the workflow/job or equivalent CI target being mirrored;
- runner architecture and caveats;
- exit status;
- concise log excerpt or log path.

Remote GitHub checks are mergeability signals. They do not replace iteration-stage local CI-parity evidence when local CI can be reproduced.

## Browser / E2E evidence

<Keep this section only if your project has UI. Otherwise replace with whatever end-to-end signal is meaningful (CLI smoke run, integration test transcript, deployed-endpoint probe).>

For UI projects, minimum expectation:

- Start the dev server when UI/browser behavior is involved.
- Use local agent-browser (or equivalent) to exercise the golden path.
- Exercise at least one negative/error/disabled path when applicable.
- Commit screenshots under tracked `screenshots/coder-loop/issue-N/<runId>/` or similar.
- Reference screenshot paths in Layer 4 and explain what each screenshot proves.

For backend/config/CLI-only issues in projects that have a UI, still use agent-browser to open the closest relevant UI/status/settings page and capture a no-regression screenshot. For projects that have no UI at all (pure CLI / library / backend), CLI smoke run transcripts (command + exit status + output) are the Layer 4 evidence — do not fabricate a screenshot by creating an HTML page.

**What is NOT a valid screenshot:**

- A locally-created HTML file that renders log output, test results, JSON, or any text data. This is a synthetic screenshot — it proves nothing beyond what pasting the text directly would prove, and it hides whether the real system was actually exercised.
- A terminal screenshot when the same log content could be pasted as text.
- A screenshot of CI logs rendered locally instead of a screenshot of the actual CI dashboard page.

**When to use text instead of screenshots:**

- Change-verification evidence (typecheck, test, lint, build): paste as text (command + exit status + concise excerpt or log path).
- Runtime-execution evidence (server startup, daemon output, CLI smoke): paste as text.
- Only screenshot when the evidence is inherently visual: rendered UI state, layout, interactive behavior, real CI/CD dashboard pages, real monitoring panels.

## Issue queue policy

Preserve the concrete recommendation order from `central SQLite state DB`.

Skip parent/umbrella/moot issues as implementation targets unless their children are complete and the action is only documentation/comment/closure. For ambiguous external/upstream conflicts, prefer no-code spike issues to classify before implementation.

## Implementation behavior

- Work only on the selected issue for the current invocation.
- On retry, continue the existing branch/PR from runtime state unless that PR is explicitly invalid or unusable.
- Prefer small, direct changes over abstractions.
- Follow existing project patterns.
- Validate only at system boundaries; do not add defensive checks for impossible internal states.
- If a task is too large, implement the smallest complete slice that closes the selected issue or mark blocked with a concrete reason.
- If external services are unavailable, record the blocker and continue to other actionable issues when possible.

## Review behavior

Review rejects PRs that lack:

- `Closes #N` as first line
- <body language requirement if any>
- all required evidence layers
- CI-parity evidence
- build evidence
- test evidence (full or focused with rationale)
- <browser/E2E evidence requirement if applicable>
- credible positive and negative-path evidence where applicable

Review may merge accepted PR-backed work according to coder-loop review prompts. Review must not bypass evidence gates, must not accept stale local evidence from the wrong branch, and must not set local `done` until GitHub merge/issue closure actions succeed.
