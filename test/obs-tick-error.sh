#!/bin/bash
# #388 acceptance #4 (integration): a scheduler tick error must be durably recorded to the
# global daemon.log (consumable by downstream status/doctor readers), not only emitted via
# console.warn to an uncaptured stderr. Trigger: an item whose repo-cwd is not a git repo
# makes worktree creation fail inside the tick. Isolated root; never touches ~/.coder-loop.
set -u
ROOT=/tmp/cl-obs-tick
ENGINE="$(cd "$(dirname "$0")/.." && pwd)/src/loop.ts"
export CODER_LOOP_DATA_DIR="$ROOT/data"
rm -rf "$ROOT"; mkdir -p "$ROOT/data" "$ROOT/not-a-git-repo"

( bun "$ENGINE" daemon up > "$ROOT/daemon.out" 2>&1 ) &
DPID=$!
sleep 2
bun "$ENGINE" chain create obstick --repo mouriya-s-lab/coder-loop --preset gh-issue-pr-iteration --base-branch main --json >/dev/null 2>&1
bun "$ENGINE" item add obstick --issue 379 --repo-cwd "$ROOT/not-a-git-repo" --json >/dev/null 2>&1
sleep 4
bun "$ENGINE" daemon down >/dev/null 2>&1
sleep 1
kill "$DPID" 2>/dev/null

echo "=== durable scheduler.tick_failed records in global daemon.log ==="
grep -h "scheduler.tick_failed" "$ROOT"/data/daemon/*/daemon.log 2>/dev/null | head -2
