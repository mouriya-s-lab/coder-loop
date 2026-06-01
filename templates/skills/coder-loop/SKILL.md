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

- `target.runner.phases`;
- `target.runner.default` and `target.runner.reviewDefault`;
- `queue.selected.phaseRunners`;
- `queue.selected.runner` and `queue.selected.reviewRunner`;
- `current.runner`;
- `events.path`;
- `current.phaseStatus.value.outputPath` and `statusPath`;
- `processes.live`.

Runner selection is explicit role-md/runtime policy. Do not infer runner/model from the host app or old flat logs.

## Legacy boundaries

Do not treat `state.json`, `.dev-loop`, or `.dev-trace.txt` as current authoritative state. They may appear only as legacy/debug notes, ignore patterns, or examples of what not to use.
