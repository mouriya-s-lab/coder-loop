# State contract

Item status is routing only. GitHub packets, committed run evidence, `run-state.md`, and live infrastructure are the durable facts. A routed exit is valid only after its exact reason and next action are durable. Only review writes business-terminal statuses. `exhausted` is engine-owned. `blocked` is operator-unblockable and resumes at contract enrichment. Never edit SQLite or runtime files directly.
