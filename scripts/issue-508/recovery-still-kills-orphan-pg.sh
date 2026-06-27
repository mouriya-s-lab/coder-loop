#!/usr/bin/env bash
# #508 acceptance row #5: #217 Bug 1 path preserved — daemon recovery still
# terminates the stale process group of the pre-crash agent. Driver records the
# child pid, SIGKILLs the daemon, restarts, and waits for the pid to disappear.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "${SCRIPT_DIR}/_runner.ts" kill-orphan-pg
