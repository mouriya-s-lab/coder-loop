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
- if a workflow-required command or evidence path cannot run, record the exact command, failure mode, exit status, and log excerpt as a blocker or retry input;
- **screenshot target must be the real system**: screenshot the actual running dev server, actual CI/CD page, actual service UI, or actual deployed endpoint. Never create a local HTML file that renders log output, test results, or data and screenshot that — such synthetic screenshots prove nothing that a text log excerpt doesn't already prove, and they hide whether the real system was actually running;
- **log evidence is text, not screenshots**: paste log output directly as text in the evidence packet (command, exit status, concise excerpt or path to full log). Two forms: (a) change-verification logs (typecheck, test, lint, build output) proving correctness of the diff, (b) runtime-execution logs (server startup, daemon output, CLI smoke, integration probe) proving the behavior works. Both belong as text. Screenshot a log only when the log is displayed inside a real UI that is itself part of the evidence (e.g. a CI dashboard page, a monitoring panel).

If a workflow command starts a long-running server or service, use an explicit background/PID/log pattern and stop the PID before exiting.

## Output verdict

Choose exactly one:

- `verification_passed` → read `iter/commit-pr`.
- `verification_failed_fixable` → return to `iter/implement`.
- `verification_blocked` → read `iter/handoff` with exact command, exit status, and log excerpt.

Unit tests alone are never sufficient evidence for UI/runtime/integration changes.