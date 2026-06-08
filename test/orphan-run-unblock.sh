#!/bin/bash
# #391 acceptance #2/#3 (integration, scheduler ENABLED): a daemon started over a DB whose only
# unfinished run is an orphan (endedAt=null) on a TERMINAL, non-current item must (a) reconcile
# that orphan on startup and (b) resume scheduling the repoCwd's pending item. Pre-fix the
# single-flight gate (hasUnfinishedCurrentPhaseRun) treats the orphan as in-flight and
# selectNextItemAndPhase returns null for the whole repoCwd forever, so the pending item is never
# touched. Observing ANY scheduling activity for the pending item proves the gate unblocked.
# Isolated loop-data root; never touches ~/.coder-loop. GitHub-free: the pending item points at a
# non-existent issue so its spawn aborts fast after selection (we only assert it was SELECTED).
set -u
ROOT=/tmp/cl-orphan-unblock
ENGINE="$(cd "$(dirname "$0")/.." && pwd)/src/loop.ts"
export REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CODER_LOOP_DATA_DIR="$ROOT/data"
rm -rf "$ROOT"; mkdir -p "$ROOT/data"
export ENGINE_STORE="$REPO_ROOT/src/sqlite-state.ts"

# Seed the DB directly via the store, mirroring the daemon unit-test fixtures.
bun -e '
const { openSqliteStateStore } = await import(process.env.ENGINE_STORE);
const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR });
const chain = store.createChain({ name: "orphan-unblock", preset: "gh-issue-pr-iteration", repository: "mouriya-s-lab/coder-loop", baseBranch: "main", status: "active", metadata: {} });
const terminal = store.createItem({ chainId: chain.id, issueNumber: 307, repoCwd: process.env.REPO_ROOT, status: "done", attempts: 1, phase: "iteration", lastRunId: "run-orphan-307", title: "terminal", extra: {} });
store.recordRun({ runId: "run-orphan-307", chainId: chain.id, itemId: terminal.id, phase: "iteration", startedAt: 1700000000, extra: {} });
store.createItem({ chainId: chain.id, issueNumber: 999999, repoCwd: process.env.REPO_ROOT, status: "queued", attempts: 0, title: "pending gated item", extra: {} });
store.close();
console.log("seeded: orphan run-orphan-307 (endedAt=null) + queued #999999");
' 2>&1

( bun "$ENGINE" daemon up > "$ROOT/daemon.out" 2>&1 ) &
DPID=$!
sleep 6
bun "$ENGINE" daemon down >/dev/null 2>&1
sleep 1
kill "$DPID" 2>/dev/null

echo "=== orphan run reconciled? (endedAt + status) ==="
sqlite3 -json "$ROOT/data/db.sqlite" "select run_id,status,ended_at,exit_code from runs where run_id='run-orphan-307';" 2>&1
echo "=== unfinished runs remaining (expect only a fresh #999999 attempt, never the orphan) ==="
sqlite3 -json "$ROOT/data/db.sqlite" "select run_id,item_id,phase,status,ended_at from runs where chain_id=1 order by started_at;" 2>&1
echo "=== daemon.log recovery event ==="
grep -hoE '"reason":"[a-z_]+"' "$ROOT"/data/chains/*/daemon/*/daemon.log 2>/dev/null | sort | uniq -c

# Pass criterion: the previously-gated queued item #999999 was SELECTED and reached spawn (the
# kind-gate GitHub fetch). Pre-fix the gate returns null for the whole repoCwd and this item is
# never touched, so this line cannot appear. It fails only because #999999 is intentionally fake.
echo "=== selection-reached-spawn signal for the gated item ==="
if grep -q "issue=#999999" "$ROOT/daemon.out" 2>/dev/null; then
	grep "issue=#999999" "$ROOT/daemon.out"
	ORPHAN_STATUS=$(sqlite3 "$ROOT/data/db.sqlite" "select status from runs where run_id='run-orphan-307';" 2>/dev/null)
	if [ "$ORPHAN_STATUS" = "orphaned" ]; then
		echo "PASS: orphan reconciled (status=orphaned) AND gated item #999999 re-entered scheduling"
		exit 0
	fi
	echo "FAIL: gated item scheduled but orphan run not reconciled (status=$ORPHAN_STATUS)"
	exit 1
fi
echo "FAIL: gated item #999999 never selected — gate still blocking the repoCwd"
exit 1
