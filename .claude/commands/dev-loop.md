# /dev-loop — Start coder-loop via daemon API

Launch coder-loop after `/dev-plan` has created or refreshed the GitHub issue queue in the centralized chain runtime. This command does not decompose large work; it only runs the existing queue.

Treat the current working directory as the target. Before launch, run the read-only checks through coder-loop itself:

```bash
TARGET="$PWD"
coder-loop doctor "$TARGET"
coder-loop status "$TARGET" --json
```

If `coder-loop` is missing or does not recognize `daemon`, stop and run `coder-loop install "$TARGET"` after upgrading/linking the coder-loop repo. Do not recreate the old `nohup` launch path in this command.

Launch the orchestrator through the daemon API. No argument runs indefinitely; a numeric argument preserves `/dev-loop [N]` by passing `--max-iterations N` to `coder-loop daemon start`.

```bash
TARGET="$PWD"

if [ -n "$ARGUMENTS" ]; then
  case "$ARGUMENTS" in
    *[!0-9]*)
      echo "/dev-loop accepts either no argument or a positive integer iteration limit, got: $ARGUMENTS" >&2
      exit 2
      ;;
    *)
      coder-loop daemon start "$TARGET" --max-iterations "$ARGUMENTS"
      ;;
  esac
else
  coder-loop daemon start "$TARGET"
fi
```

The start command is idempotent for an already-live target: it returns `alreadyRunning: true` instead of starting a duplicate loop. Use daemon/status commands for monitoring:

```bash
coder-loop daemon status "$PWD" --json
coder-loop status "$PWD" --json | jq '.events.path, .current.phaseStatus.value.outputPath, .current.phaseStatus.value.statusPath'
```

- No argument: run indefinitely until a preset phase signals stop.
- Pass a number to limit iterations, e.g. `/dev-loop 10`.
- Recovery/resume is preset-driven: if the centralized chain state has `current` set, the engine resumes that phase via session id instead of starting a fresh phase. Read it through `coder-loop status "$PWD" --json`; the set of phases and their stop semantics are owned by the active preset (`presets/<name>/preset.toml`).

Structured per-run event stream (agent-consumable, non-polling): get the path from `coder-loop status "$PWD" --json | jq -r '.events.path // empty'` and then `tail -F` that file. Each line is one JSONL event (`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.close` / `watchdog.fire` / `queue.terminal`). Use this channel for any external watcher (supervisor, downstream agent) instead of scraping stdout.

Stop: `coder-loop daemon stop "$PWD"`.
