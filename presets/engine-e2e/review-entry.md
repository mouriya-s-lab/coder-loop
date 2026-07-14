engine-e2e deterministic stub protocol (no LLM; parsed line-wise by scripts/engine-e2e-stub-runner.ts).

PHASE=review
CHAIN={{CHAIN_NAME}}
ITEM={{ITEM_KEY}}
RUN={{RUN_ID}}

Task: verify `engine-e2e-marker.txt` is committed in the worktree, then write the terminal
status through `coder-loop item update` (credentialed admission; #397 gate).
