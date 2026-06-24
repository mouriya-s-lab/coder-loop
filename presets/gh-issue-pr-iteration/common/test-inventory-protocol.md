# Fragment: common/test-inventory-protocol

## Purpose

This fragment binds the iteration `verify` step (Step 3) and the review `test-integrity` step (Step 4) to a single measurement protocol for the "test inventory delta". The review treats packet credibility as failed when the iteration-published delta disagrees with the review-measured delta. Without a shared protocol, the two sides pick different commands and different parses (one counts the runner's executed tests, the other greps `test(` / `it(` declarations from source; one uses default `rg`, the other `rg -a`; one is stopped by a NUL-warning, the other is not), produce different integers for the same head, and the review retries the packet indefinitely while the code is already correct. This fragment removes that failure mode by fixing what is counted, which command produces it, and how it is parsed.

## What gets counted

The integer in the test inventory delta is the **number of test cases the project's test runner actually executed on that side**, taken from the runner's own aggregated summary line. It is never a static count of `test(` / `it(` / `describe(` declarations grepped from source: such counts vary across hosts because of binary-detection / NUL-warning truncation in `rg` / `grep`, and they vary across runners because of dynamic generators (`test.each`, table-driven loops, conditional skips, runtime-generated describes) that the runner expands but a static scan does not see. The runner-emitted total covers passed + failed + skipped + todo, exactly as the runner aggregates them; if the runner reports those buckets separately, record the breakdown too, but the published integer is the runner's own total.

## Command shape (both sides)

1. The full-suite test command is the canonical command named in the target's `WORKFLOW_FILE`. Use it verbatim — no flag substitutions, no narrowing to a path, no `--bail`, no `--only-changed`. If the target's `WORKFLOW_FILE` does not name a canonical full-suite command, the target must add one before this protocol applies; the iteration / review step does not invent one.
2. Run it with both stdout and stderr captured to a log file: `<command> 2>&1 | tee <log-path>`. The log path goes under `EVIDENCE_DIR` for the iteration side and under the review step's own artifact directory for the review side. The log is the artifact; the integer is parsed from it.
3. Parse the integer from the runner's own anchored summary line:
   - `bun test` → the `Ran <N> tests across <M> files` line; the integer is `N`.
   - jest / vitest / pnpm test fronting jest-or-vitest → the `Tests:` summary line; the integer is `passed + failed + skipped + todo`.
   - `cargo test` → the `<N> passed; <M> failed; <K> ignored` line; the integer is `N + M + K`.
   - Other runners → quote the runner's aggregated summary line verbatim in the report and use its own total. If the runner emits no aggregated total, the target must extend `WORKFLOW_FILE` with the parse rule before this protocol applies.
4. Record the command, the parsed integer, and the relative log path in the report. Review re-parses from the log if the integer is in doubt; the log is the ground truth, the integer is the projection.

## Base-side measurement

Never switch the issue branch's checkout away to measure the base side. Use a detached scratch worktree of your own: `git worktree add --detach <SCRATCH>/<role>-base <base-sha>`, install dependencies there per the project's manifest/lockfile, run the same command, then `git worktree remove` it and record the path plus the removal. A "base count" produced by checking out base in the same working tree, or by measuring on a different commit than the merge-base of `BASE_BRANCH` and `HEAD`, is a setup defect, not a measurement.

## Forbidden

- Publishing a static-source count produced by `rg` / `grep` / `ag` / AST extraction / find-with-grep as the inventory integer, in any form. Such counts depend on host-specific binary detection and pattern choices and produce mismatches even when the head is identical on both sides.
- Using a non-anchored `rg` invocation anywhere on this measurement path; if a static count is wanted purely as supplemental diagnostic next to (not replacing) the runner-emitted integer, the only acceptable form is `rg -a -n -P` with an explicit anchored Perl pattern, labelled in the report as `(diagnostic, not inventory)`. The diagnostic count never replaces the protocol integer and is never the basis for any mismatch judgment.
- Iteration and review using different commands or different parses. The command and parse rule are protocol-fixed; if either side cannot run the canonical command in its environment, that is a setup defect to surface, not something to measure around with a substitute.

## Publish format

Both sides emit the delta as a single line, identical in structure:

```
Test inventory delta: base <N_base> tests (command: <runner cmd>; log: <relative log path>); head <N_head> tests (command: <runner cmd>; log: <relative log path>); removed/renamed/skipped/weakened: <enumeration, or `none` after explicit enumeration>.
```

When iteration and review both followed this protocol and the integers still disagree, the disagreement points to an evolving `HEAD` (a new push between iteration's measurement and review's measurement) or a setup drift (different dependency versions installed on the two hosts). Review investigates which it is from the logs and PR push history rather than rejecting the packet on integer mismatch alone.
