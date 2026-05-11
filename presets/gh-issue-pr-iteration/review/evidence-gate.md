# Fragment: review/evidence-gate

## Goal

Audit whether the PR body and PR thread contain enough reviewer-consumable evidence before code review.

## CI-parity evidence

Reject unless the evidence states:

- whether project CI was detected;
- local CI-parity command when reproducible CI exists;
- workflow/job or equivalent CI target;
- runner architecture choice and caveats;
- exit status;
- log path or concise log excerpt.

Remote PR checks are Phase C mergeability signals. They do not replace iteration-stage local CI-parity evidence when local CI can be reproduced.

If local CI-parity could not run because of Docker, act installation, image pull, network, runner tooling, or third-party limitations, choose retry or blocked depending on whether an immediate retry can help. Do not accept as if CI passed.

## Target workflow evidence

Use the latest complete evidence packet from the PR thread for the current iteration when present; use the PR body only as the immutable opening evidence packet. Do not accept evidence that was only created by overwriting the PR body after retry, because that loses review history.

Reject unless reviewer-consumable evidence satisfies the target workflow file:

- required build, test, lint, typecheck, migration, browser, deployment-preview, or runtime checks are present with command names, exit status, and concise log excerpts or paths;
- workflow-defined command wrappers/prohibitions were followed;
- workflow-required artifacts, screenshots, logs, or PR-body sections are present and reviewer-visible;
- workflow-required screenshots are embedded in the evidence packet as Markdown images (`![alt](path-or-url)`); plain links to screenshots are insufficient;
- every screenshot reference in the evidence packet is enumerated and resolved to the exact PR-branch/local-checkout file it claims to show;
- every resolved screenshot file exists, is reachable from the evidence packet URL/path, and is actually read/opened as image data before accepting the evidence;
- stale screenshots that only exist on `main`, deleted head branches, local-only runtime paths, broken raw/blob URLs, non-image files, or uninspectable image references are insufficient even when the Markdown image syntax is present;
- evidence maps each artifact or log excerpt to the behavior it proves;
- positive and negative/error/disabled paths are covered when required by workflow or issue scope.

Review does not create missing workflow evidence. If evidence is absent, stale, local-only, ambiguous, or impossible to inspect, reject before code review.

## Output verdict

Choose exactly one:

- `evidence_passed` → read `review/commitment-gate`.
- `retry` → read `review/action-retry`.
- `blocked` → read `review/action-blocked`.

If evidence is insufficient, stop before code review and make the feedback precise.