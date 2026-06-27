#!/usr/bin/env bash
# #508 acceptance row #2: daemon recovery emits zero `item.status` events with
# reason=`stale_current_run_recovery`. The fixture runs an isolated daemon
# subprocess and greps its stderr observability log for any offending line.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "${SCRIPT_DIR}/_runner.ts" no-item-status-event
