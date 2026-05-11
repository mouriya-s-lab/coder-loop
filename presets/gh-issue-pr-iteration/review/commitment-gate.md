# Fragment: review/commitment-gate

## Goal

For `kind:code` issues, verify that the PR actually delivers every commitment the issue body declared in `## 验收标准` and `## 继承验证义务` tables. Each row is a machine-checkable Command + Expect pair. Any row whose Expect does not match → `changes_requested`.

This gate replaces the prior reliance on review thinking to read the issue body and self-judge whether commitments are met. Review previously saw the constraints, rationalized them, and let work through anyway (`Mouriya-Emma/coder-loop#4` root cause). This fragment forces row-by-row execution.

## When this gate runs

- `ISSUE_KIND` is `code` AND the live issue body contains a `## 验收标准` table → run the gate.
- `ISSUE_KIND` is `comment` (spike / discussion) → skip via `commitment_skipped`. Commitments for spike issues are verified by `review/spike-followup-gate`, not here.
- `ISSUE_KIND` is empty (legacy unlabeled issue) → skip via `commitment_skipped`. Do not block the 50+ pre-`kind:*` issues.
- The live issue body has no `## 验收标准` heading → skip via `commitment_skipped` even on `kind:code`. Some `kind:code` issues are too small to carry a structured acceptance table; do not invent rows.

## Inputs

- Live issue body via `gh issue view {{ISSUE}} -R {{REPO}} --json body --jq .body` — always re-fetch; do not trust a snapshot from the iter trace.
- PR thread evidence packet (already read by `review/evidence-gate`).
- PR-bound branch/checkout when a row's Env is `local`.

## Procedure

1. Re-fetch the live issue body. Locate the `## 验收标准` heading. If absent, emit `commitment_skipped` with reason `no 验收标准 table in issue body`.

2. Parse the markdown pipe table under `## 验收标准`. Expected columns: `#`, `Dimension`, `Check`, `Command`, `Env`, `Expect`. Reject the gate if the column count or header names diverge — emit `commitment_failed` with reason `issue body 验收标准 table malformed` so iteration can fix the issue body first.

3. Locate `## 继承验证义务` heading if present. Parse the same table shape (columns: `From`, `Original #`, `Check`, `Command`, `Env`, `Expect`). Concatenate its rows after the `## 验收标准` rows. Missing `## 继承验证义务` is normal (most issues have no inherited obligations); only fail if the heading exists with a malformed table.

4. Enumerate every row from both tables. **Do not silently drop any row.** Name each Command verbatim in the verdict report so the operator can see all rows were considered.

5. For each row, branch on `Env`:
   - `local` — execute the `Command` in `{{TARGET_CWD}}`. Capture exit code and stdout/stderr. Compare to `Expect`.
   - `VM` / `container` / `CI` / `browser` / target-environment — review does not run these (review never starts servers, runs target tests, or opens browsers). Instead, locate the matching evidence artifact in the PR evidence packet that proves the row was executed in the target env and produced the `Expect` output. If no matching artifact exists, treat the row as failed and cite the missing artifact requirement.
   - `downstream` / `integration` — same as VM: require the row's artifact in the PR evidence packet.

6. Compose the verdict report. For each row, record:
   - row number + Check column;
   - Command executed (or artifact cited);
   - actual output / exit / artifact reference;
   - Expect column;
   - match / mismatch / 不匹配 verdict.

## Failure handling

If ANY row's Expect 不匹配 the actual result (whether from local execution or from PR evidence artifact), emit `commitment_failed`. Do not let review rationalize a single 不匹配 row through and accept the PR. The full set of mismatching rows must be cited in the retry feedback so iteration can address them all in one retry.

If a row's `Command` itself errors out for environmental reasons (gh auth, missing binary, network) and review cannot run it, emit `commitment_failed` with reason `row N command could not execute: <error>`. Do not paper over the gap.

## Output verdict

Choose exactly one:

- `commitment_passed` → read `review/spike-followup-gate`. All rows of both tables matched their Expect column.
- `commitment_skipped` → read `review/spike-followup-gate`. Gate did not apply (ISSUE_KIND ≠ code, or no `## 验收标准` table in body). Record the skip reason in the trace.
- `commitment_failed` → read `review/action-retry`. Cite every failing row's #, Check, Command, actual vs Expect. The retry feedback must enumerate all failing rows; iteration cannot fix them piecemeal.

Do not advance past this gate while any commitment row is in `不匹配 / changes_requested` state.
