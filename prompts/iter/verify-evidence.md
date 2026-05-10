# Fragment: iter/verify-evidence

## Goal

Run the required verification and collect reviewer-visible evidence.

## General verification

Follow the workflow file exactly. Before treating a PR as reviewable, detect project CI configuration and record the result.

For GitHub Actions jobs that can be reproduced locally, run the relevant job with `act`, deriving workflow path, event, job, and runner architecture from the project. Prefer native/local architecture first. Use an explicit amd64 runner only when the workflow, dependency, or image demonstrably requires it, and record the caveat.

If local CI-parity cannot run because of Docker, act installation, image pull, network, runner tooling, or third-party service limitations, record the exact command, failure mode, exit status, and log excerpt as an infrastructure blocker. Do not silently skip CI-parity and do not use remote PR CI as a substitute.

If local CI-parity reaches product tests and fails or hangs, fix locally and rerun before handoff unless the failure is a proven infrastructure blocker.

## Target workflow verification

Follow the target workflow file for project-specific verification:

- run the workflow-defined build, test, lint, typecheck, migration, browser, or deployment-preview commands that apply to the selected issue;
- obey workflow-defined prohibitions and required wrappers for commands;
- collect workflow-defined evidence artifacts, screenshots, logs, and PR-body excerpts;
- after each screenshot capture, verify the image file exists under a tracked `screenshots/` path and can be read/opened as image data before using it as evidence;
- record both the local file path and the repository-relative `screenshots/...` path for every screenshot so the PR body can embed the exact committed artifact;
- capture positive and negative/error/disabled paths when the workflow or issue scope requires them;
- if a workflow-required command or evidence path cannot run, record the exact command, failure mode, exit status, and log excerpt as a blocker or retry input.

If a workflow command starts a long-running server or service, use an explicit background/PID/log pattern and stop the PID before exiting.

## Output verdict

Choose exactly one:

- `verification_passed` → read `iter/commit-pr`.
- `verification_failed_fixable` → return to `iter/implement`.
- `verification_blocked` → read `iter/handoff` with exact command, exit status, and log excerpt.

Unit tests alone are never sufficient evidence for UI/runtime/integration changes.