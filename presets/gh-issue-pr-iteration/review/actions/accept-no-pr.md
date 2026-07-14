# Action: accept without a PR

Use only when the completeness judgment proves current scope and children are complete without a new implementation PR: already satisfied on base, complete no-code closure, or a complete source-writing-spike-deliverable spike (which becomes the success terminal, not moot). This action publishes the durable ReviewVerdict and ends in a clean exit — closure posts the closing comment and closes the issue after you.

## Procedure

1. Comment on the issue with the already-satisfied/spike-complete evidence and the child closure table when applicable — the same fixed report shape as `{{PRESET_ROOT}}/review/actions/accept-pr.md`, with the no-PR route's skipped checks named.
2. In the same comment, publish the machine-readable verdict per `{{PRESET_ROOT}}/common/packets.md` — a fenced json block labeled `coder-loop:review-verdict`:

```json
{
  "kind": "accepted-no-pr",
  "candidate": { "kind": "no-change", "baseSha": "…", "proofCommentUrl": "…" },
  "verificationPacketUrl": "<the audited packet comment URL, when the route produced one>"
}
```

Populate `candidate` verbatim from the latest CandidateRef (`no-change` / `source-writing` / `comment-delivery` variant as the route produced). A no-PR route that never produced a CandidateRef (e.g. pre-split history) → cite the proof evidence URLs directly in the verdict's `candidate.proofCommentUrl`.

3. Verify the verdict comment resolves live. Record the URL in the handoff.

## Failure routing

Publication blocked by an approval boundary / failed before the verdict is durable → record exact command + output in handoff and take the stop action; do not exit clean without a durable verdict.

On full success: no status write. Continue the entry's wrap-up and exit 0 — the scheduler advances to closure, which performs any unblock side effect, closes the issue, and writes the terminal status.
