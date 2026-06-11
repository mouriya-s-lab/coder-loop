# Quality: cleanup — executor constraints

Site-cleanliness rules binding every executor subagent. The orchestrator's final sweep lives in a separate judge file; you do not read it, you make it possible by reporting accurately.

- Every process you start (dev server, daemon, watcher, tunnel, container) is started with an explicit background + PID + log pattern, and reported: command, PID, log path.
- Every file you create outside the deliverable (temp scripts, scratch dirs, downloaded artifacts, extra worktrees/branches beyond the issue branch) is reported with its path.
- Stop what you started when your step no longer needs it; whatever you intentionally leave running for a later step, say so explicitly in your report.
- Never stage runtime artifacts, scheduling state, run logs, or local-only evidence into feature commits. Preserve unrelated dirty files you found in the worktree — pre-existing mess is not yours to clean or to commit.
