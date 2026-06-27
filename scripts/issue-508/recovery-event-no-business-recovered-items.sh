#!/usr/bin/env bash
# #508 acceptance row #4: `scheduler.recovery` event payload no longer carries
# `recoveredItems` (or carries it only as an empty array). Driver scrapes the
# daemon stderr observability log and asserts no recovery line contains the
# `recoveredItems` token.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "${SCRIPT_DIR}/_runner.ts" no-recovered-items-payload
