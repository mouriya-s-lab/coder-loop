#!/bin/bash
# #388 acceptance #5 (integration): after a real `daemon up` process hits an uncaught
# rejection, the durable global daemon.log must contain a `daemon.fatal` record carrying
# the stack, so the death cause is recoverable post-mortem (the gap that made #387
# undiagnosable). The crash is injected via a Bun --preload that schedules an unhandled
# rejection once the daemon is up; the production fatal handler in runDaemonUpCommand is
# what catches it. Isolated root; never touches ~/.coder-loop.
set -u
ROOT=/tmp/cl-obs-crash
ENGINE="$(cd "$(dirname "$0")/.." && pwd)/src/loop.ts"
export CODER_LOOP_DATA_DIR="$ROOT/data"
rm -rf "$ROOT"; mkdir -p "$ROOT/data"

cat > "$ROOT/inject.ts" <<'EOF'
// Fire an unhandled rejection after the daemon has come up and installed its handlers.
setTimeout(() => { void Promise.reject(new Error("OBS_CRASH_INJECT")) }, 1500)
EOF

( bun --preload "$ROOT/inject.ts" "$ENGINE" daemon up > "$ROOT/daemon.out" 2>&1 ) &
DPID=$!
sleep 4
kill "$DPID" 2>/dev/null

echo "=== daemon process exit (should be gone after fatal handler exit) ==="
kill -0 "$DPID" 2>/dev/null && echo "still alive" || echo "exited"
echo "=== durable daemon.fatal record with stack ==="
grep -h "daemon.fatal" "$ROOT"/data/daemon/*/daemon.log 2>/dev/null | head -1
