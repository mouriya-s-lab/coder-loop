# Action: moot (skip)

Adjudicate an issue as requiring no implementation. Only for verified invalid, duplicate, out-of-scope, no-code, or truly moot outcomes. Parent/umbrella issues are never mooted merely for being parents. This action publishes the durable ReviewVerdict and ends in a clean exit — closure closes the issue and writes the local terminal status after you.

## Procedure

1. Comment on the issue with the verified reason no implementation PR should be merged.
2. If a live PR must be explicitly abandoned as invalid, also comment on the PR (closure will not merge it; your verdict is what tells closure this route is moot).
3. In the issue comment, publish the machine-readable verdict per `{{PRESET_ROOT}}/common/packets.md` — a fenced json block labeled `coder-loop:review-verdict`:

```json
{
  "kind": "moot",
  "reason": "<the verified skip reason, one sentence>",
  "proofUrl": "<URL of the evidence backing the reason — duplicate issue, satisfied-on-base diff, invalidating comment>"
}
```

4. Verify the verdict comment resolves live. Record the URL in the handoff.

## Failure routing

Publication blocked or failed before the verdict is durable → record exact command + output in handoff and take the stop action; do not exit clean without a durable verdict.

On full success: no status write. Continue the entry's wrap-up and exit 0 — the scheduler advances to closure, which closes the issue with the moot reason and writes the terminal status.
