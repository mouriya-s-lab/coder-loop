#!/usr/bin/env bash
# #508 acceptance row #1: daemon recovery preserves items.status / phase / sessionIds.
# Real isolated daemon (`bun src/loop.ts daemon up --loop-data-root <tmp>`), real
# in_progress item seed (non-empty sessionIds), real SIGKILL, real restart, real
# snapshot diff. No mocks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "${SCRIPT_DIR}/_runner.ts" preserve-item-fields
