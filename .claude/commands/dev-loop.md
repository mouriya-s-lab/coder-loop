# /dev-loop — Start coder-loop

Launch coder-loop after `/dev-plan` has created or refreshed the GitHub issue queue and `.coder-loop/runtime/state.json`. This command does not decompose large work; it only runs the existing queue.

Before launch, if you have any doubt about the target's bootstrap state (first time on this machine, after a `git pull` of coder-loop itself, after a long pause), run `coder-loop doctor <target>` once — read-only check across runtime layout, `gh` auth, `claude` CLI, and skill version. If it reports anything not OK, run `coder-loop install <target>` (idempotent) before continuing.

Launch the orchestrator as a detached background process that survives this shell session.

```bash
LOGFILE="/tmp/coder-loop-$$.$(date +%Y%m%d-%H%M%S).log"
nohup coder-loop $ARGUMENTS > "$LOGFILE" 2>&1 &
echo "coder-loop started (pid=$!, log=$LOGFILE)"
```

If `coder-loop` is not in PATH, use the full path:

```bash
LOGFILE="/tmp/coder-loop-$$.$(date +%Y%m%d-%H%M%S).log"
nohup bun /path/to/coder-loop/src/loop.ts $ARGUMENTS > "$LOGFILE" 2>&1 &
echo "coder-loop started (pid=$!, log=$LOGFILE)"
```

- No argument: run indefinitely until a preset phase signals stop.
- Pass a number to limit iterations, e.g. `/dev-loop 10`.
- Recovery/resume is preset-driven: if `.coder-loop/runtime/state.json` `current` is set, the engine resumes that phase via session id instead of starting a fresh phase. The set of phases and their stop semantics are owned by the active preset (`presets/<name>/preset.toml`).

Monitor:

- Human stdout tail: `tail -f $LOGFILE`
- Structured per-run event stream (agent-consumable, non-polling): `tail -F .coder-loop/runtime/events/<runId>.jsonl`. Each line is one JSONL event (`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.close` / `watchdog.fire` / `queue.terminal`). `runId` of the active run lives in `state.json` `current.runId`. Use this channel for any external watcher (supervisor, downstream agent) instead of scraping stdout.

Stop: `rm .dev-loop`
