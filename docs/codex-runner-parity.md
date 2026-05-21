# Codex Runner Parity Audit

Issue: `mouriya-s-lab/coder-loop#138`
Audit date: 2026-05-21

This document records the current Codex-vs-Claude runner contract for the
`gh-issue-pr-iteration` preset. It is a regression checklist: when either CLI
changes its stream format or flags, update this file and the matching tests in
`src/loop.test.ts` / `src/smoke.test.ts`.

## Parity Matrix

| Dimension | Claude path | Codex path | Current status |
|---|---|---|---|
| Issue kind routing | `runtime.issueKind` is injected into iteration and review prompts. | Same runtime binding is runner-independent. | Aligned. `parseKindFromLabels` covers `code`, `comment`, `code-spike`, and `blocked`; `iterationRouteForIssueKind` routes all four. |
| Fresh spawn stream | `claude -p` runs with `--output-format stream-json --verbose`. | `codex exec` runs with `--json`. | Aligned at JSONL level. Codex has no separate `--verbose` requirement for JSONL event streaming. |
| Workspace and adjacent runtime access | Claude receives one `--add-dir` containing the preset dir, loop-data root, and cross-repo target cwd when needed. | Fresh Codex receives repeated `--add-dir` entries for the same generated dirs, unless the caller supplies `codex.extraArgs --add-dir`. | Aligned for fresh spawns. This keeps `workspace-write` Codex configs able to read/write loop-data artifacts without relying on the default full sandbox. |
| Sandbox / approval defaults | Claude uses its own CLI policy plus configured extra args. | Fresh Codex uses top-level `--ask-for-approval never`, `exec --json --cd <agentCwd>`, and default `--sandbox danger-full-access` unless overridden. | Intentional difference. Codex needs noninteractive approval and real workspace writes for iteration agents. |
| Resume flags | Claude uses `--resume <session_id> -p <continue prompt>`. | Codex uses `exec resume <thread_id> --json --ignore-rules <continue prompt>`. | Aligned where the CLIs overlap. `codex exec resume --help` currently exposes no `--cd`, `--add-dir`, or `--sandbox`; resume relies on the stored thread context. |
| Session identity | `session_id` is parsed from Claude stream-json. | `thread_id` is parsed from Codex `thread.started`. | Aligned. `sessions.jsonl` records runner and model, and cross-run resume refuses incompatible runner/model pairs. |
| Summary watchdog | Raw Claude assistant text can arm `ITERATION SUMMARY` / `REVIEW SUMMARY`. | Codex JSONL only arms from agent-message events. | Aligned. Command-output JSON that merely quotes a summary marker is ignored for Codex. |
| Review verdict parsing | Raw or Claude assistant JSON text must end with a valid `REVIEW SUMMARY` verdict. | Codex agent-message JSON text follows the same final-summary rule. | Aligned. Stale quoted summaries are ignored. |
| Rate-limit extraction | Claude result events with `api_error_status=429`, synthetic rate-limit errors, and `rate_limit_event` reset metadata are parsed. | Codex-compatible JSONL `rate_limit_event` and rate-limit text/error markers flow through the same parser. | Aligned for structured events and common text markers; add a fixture if Codex changes its exact 429 payload. |
| Daemon cooldown | Runner attempts emit `CODER_LOOP_RATE_LIMIT` when a parsed reset is present. | Same. | Aligned. Daemon pauses until reset and resumes one item at a time after the stagger window. |
| Review runner default | Review defaults to Claude with `claude-opus-4-7` unless `reviewRunner` is configured. | Codex iteration does not change review default. | Intentional difference. Review runner selection is phase-level policy, not host inheritance. |
| Parent expansion queue order | Review creates child issues, initializes local artifacts, then updates state. | Same prompt/state contract regardless of runner. | Aligned by prompt contract. `action-expand-parent` now carries a front-insertion batch, and `update-state` requires children before the parent retry item and older queued siblings. |

## Known Non-Equivalences

- Codex fresh and resume command surfaces are not identical. Fresh `codex exec`
  supports `--cd`, `--add-dir`, and `--sandbox`; `codex exec resume` currently
  does not. Do not synthesize unsupported resume flags.
- Claude accepts one `--add-dir` followed by multiple directories. Codex accepts
  repeated `--add-dir <dir>` flags in the invocation builder.
- Codex does not need a `--verbose` flag to produce JSONL; the runner contract
  depends on `--json` events instead.

## Runtime Checks

The audit maps to these checks:

- `bun test src/loop.test.ts` covers issue-kind routing, runner invocation
  arguments, session ID parsing, watchdog parsing, resume policy, and prompt
  front-insertion wording.
- `bun test src/smoke.test.ts` covers the default Codex iteration / Claude
  review phase path with fake runner binaries.
- `bun run typecheck && bun test` is the full repository gate required by
  issue `#138`.
