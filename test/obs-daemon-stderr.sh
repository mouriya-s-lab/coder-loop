#!/bin/bash
# #388 acceptance #3 (environment): a real isolated central daemon must have its stderr
# captured to a durable file and be non-empty (the daemon writes a startup banner to
# stderr, so any launch path that redirects stderr keeps a greppable record + a place the
# runtime stack lands on crash). Isolated loop-data root; never touches ~/.coder-loop.
set -u
ROOT=/tmp/cl-obs-stderr
ENGINE="$(cd "$(dirname "$0")/.." && pwd)/src/loop.ts"
export CODER_LOOP_DATA_DIR="$ROOT/data"
rm -rf "$ROOT"; mkdir -p "$ROOT/data"
ERRLOG="$ROOT/daemon-stderr.log"

( bun "$ENGINE" daemon up > "$ROOT/daemon-stdout.log" 2> "$ERRLOG" ) &
DPID=$!
sleep 3
bun "$ENGINE" daemon down >/dev/null 2>&1
sleep 1
kill "$DPID" 2>/dev/null

if [ -s "$ERRLOG" ]; then
	echo "ok: non-empty captured stderr at $ERRLOG"
	head -1 "$ERRLOG"
	exit 0
fi
echo "FAIL: captured stderr is empty ($ERRLOG)"
exit 1
