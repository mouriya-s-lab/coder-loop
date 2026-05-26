---
name: coder-loop
description: Operate coder-loop through its current centralized daemon, chain, item, status, and queue APIs. Use when installing a target, checking loop health, shaping queue work, starting/stopping daemon execution, or recovering a blocked item.
---

# coder-loop

Use stable CLI/API surfaces first. Do not scrape runtime files until `doctor`, `status`, or `daemon status` points to a concrete artifact.

## Command order

1. Bootstrap and verify:

```bash
coder-loop install <target> --repo <owner>/<repo>
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop status <target> --json
```

2. Manage daemon lifecycle:

```bash
coder-loop daemon up --json
coder-loop daemon status <target> --json
coder-loop daemon start <target>
coder-loop daemon stop <target>
coder-loop daemon restart <target>
coder-loop daemon down --json
```

3. Manage chains and items:

```bash
coder-loop chain create --help
coder-loop chain list --help
coder-loop chain status --help
coder-loop chain delete --help
coder-loop item add --help
coder-loop item list --help
coder-loop item update --help
coder-loop queue unblock <target> --issue <id> --start-daemon --require-browser-evidence
```

## Status truth

Read `coder-loop status <target> --json` for:

- `target.runner.default` and `target.runner.reviewDefault`;
- `queue.selected.runner` and `queue.selected.reviewRunner`;
- `current.runner`;
- `events.path`;
- `current.phaseStatus.value.outputPath` and `statusPath`;
- `processes.live`.

Runner selection is explicit runtime policy. Do not infer runner/model from the host app or old flat logs.

## Patrol checklist

Use this read-only order:

```bash
coder-loop daemon status <target> --json
coder-loop status <target> --json
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop chain status <chain-name> --json
coder-loop item list <chain-name> --json
gh issue view <issue> -R <owner>/<repo> --json state,labels,comments,closedByPullRequestsReferences
gh pr view <pr> -R <owner>/<repo> --json state,mergedAt,reviewDecision,statusCheckRollup,closingIssuesReferences
gh pr checks <pr> -R <owner>/<repo>
```

Classify observations as OK / WARN / ERROR before taking recovery action.

## Diagnostics

Level 1: stable API (`daemon status`, `status`, `doctor`, `chain status`, `item list`).

Level 2: paths returned by status (`events.path`, outputPath, statusPath). Current event names include `queue.select`, `phase.start`, `phase.end`, `attempt.start`, `attempt.close`, `watchdog.fire`, `queue.terminal`, and `attempt.timeout`.

Level 3: process/storage checks only after Level 1/2 identify a daemon, socket, DB, worktree, rate-limit, or child-process problem.

## When to use coder-loop

Use it for complex coding tasks: multi issue, multi PR, multi repo, longer than one session, explicit user request, block/unblock flows, or work needing durable patrol/recovery.

Do not force it for simple single-file fixes, low-risk docs edits, small bugfixes, read-only investigation, or when the user asks for direct manual implementation.
