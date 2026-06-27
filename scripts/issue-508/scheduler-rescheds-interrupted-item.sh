#!/usr/bin/env bash
# #508 acceptance row #3: after daemon restart, the scheduler re-spawns the
# interrupted item even though daemon recovery did NOT rewrite items.status.
# Driver verifies (a) a new run row appears with the original itemRowId, and
# (b) items.status remains "in_progress" throughout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "${SCRIPT_DIR}/_runner.ts" scheduler-rescheds
