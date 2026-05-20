# Fragment: plan/checkpoint-author

## Goal

For each draft body, fill in the `## 验收标准` table (and `## 结果分支` for spikes). Tables must satisfy `contract.md` §1.4 / §1.6 — column names, order, content quality — so `commitment-gate` / `spike-followup-gate` can parse them.

## Inputs

- Draft bodies from `plan/decompose`.
- `contract.md` §1.4 (table column spec) + §1.6 (`## 结果分支` spec).
- `workflow.md` extracts (concrete project commands to use in `Command` column).

## Procedure

### For each `kind:code` or `kind:blocked` issue

1. Write the `## 验收标准` table with column header exactly:
   ```
   | # | Dimension | Check | Command | Env | Expect |
   |---|-----------|-------|---------|-----|--------|
   ```
   Column count, order, names — all match. Any deviation → `commitment-gate` will refuse to parse.

2. For every row:
   - `#` — sequential, starting at 1.
   - `Dimension` — exactly one of `function` / `environment` / `integration` / `assumption`. No other values.
   - `Check` — Chinese short sentence describing what this row verifies. Outcome-focused, not implementation-choice-focused. "调用 `foo()` 函数" ❌; "无效输入返回 4xx" ✅.
   - `Command` — backtick-wrapped executable command. Must really run in `Env`. Use `\|` to escape pipe characters inside the table cell. Source commands from `workflow.md` extracts where possible: `` `mise run test` `` / `` `bun test` `` / `` `pnpm build` `` / `` `gh pr view <N> --json mergeable --jq .mergeable` ``.
   - `Env` — exactly one of `local` / `VM` / `container` / `CI` / `browser` / `downstream` / `integration`.
   - `Expect` — concrete actual: exit code (`exit 0`), grep count (`≥ 1`), boolean string, file existence, etc.

3. **Dimension coverage**:
   - Pure code logic → at least one `function` row.
   - Docker / VM / deployment / OS-specific behavior → at least one `environment` row.
   - Downstream consumer / cross-service E2E → at least one `integration` row.
   - Third-party undocumented behavior / "should work" claim → at least one `assumption` row.
   Missing a dimension that the work actually touches → review will discover the gap during evidence-gate; pre-empt it here.

4. **Adversarial inference**. For each row, ask: "what's the smallest change to source code that satisfies `Expect` without solving the user-visible problem?" If you can construct such a shortcut, the row's `Check` or `Expect` is too lax — sharpen it. (Full adversarial validation is `plan/adversarial-validate`'s job; this is the per-row first pass.)

5. **Smoke-check `local` rows now**. For every `Env == local` row, try running `Command` in `{{TARGET_CWD}}` — or, if the issue will queue with `agentCwd` pointing at a cross-repo checkout, in that checkout directory (the iter agent's future `cwd`). Best-effort dry-run if the command is destructive. Confirm:
   - command syntax parses (no obvious typo);
   - command exists in `PATH` or relative to repo root;
   - exit code is consistent with the spec (passing `Expect` shape is fine; if the work hasn't landed yet the command may still error meaningfully).
   If a row's `Command` doesn't even parse, the issue is unrunnable — revise before posting.

6. **Skip the table only when trivially small**. Per `contract.md` §6, allowed to omit `## 验收标准` for truly trivial `kind:code` work (rename, format-only). `kind:blocked` issues must not omit the table because review needs the blocked-path proof. When omitting for `kind:code`, write inline:
   > 本 issue trivial，无 `## 验收标准` 表；依赖 PR 四层证据。
   Without that explicit note, omission looks like a write error.

7. For `kind:blocked`, include at least one `integration` or target-environment row whose command/artifact replays the blocked path after the fix and proves it no longer reproduces. The issue body must also include the `Unblocks:` back-link or explicitly say why no back-link exists.

8. **`## 继承验证义务` table** (if applicable). Same column shape as `## 验收标准` except first columns:
   ```
   | From | Original # | Check | Command | Env | Expect |
   ```
   Inherited rows cannot be deferred a second time. If you'd write a row that the current environment also can't run, that's a sign the row belongs on a different downstream issue — re-route, don't defer twice.

### For each `kind:comment` or `kind:code-spike` spike issue

1. Write the `## 验收标准` table (same column spec as above). Even spikes need executable verification — typically `assumption` Dimension rows. "What command, in what env, proves the assumption holds / fails?"

2. Write the `## 结果分支` section per `contract.md` §1.6:
   ```
   ## 结果分支

   - **If passed**: <动作>。<对应 sub-issue 提议要求>。
   - **If failed**: <动作>。<对应 sub-issue 提议要求>。
   - **If <其他条件>**: <动作>。<...>
   ```
   - Each branch starts with `**If <condition>**:`.
   - For each branch, decide whether `spike-followup-gate`'s verb table is triggered:
     - branch text contains `create` / `file` / `propose` / `开` / `提议` / `创建` or names a specific follow-up type → spike comment must propose ≥ 1 concrete sub-issue title;
     - branch text says "no follow-up needed" / "no action" → 0 proposals OK.
   - Don't write `If passed: TBD` or vague placeholders; the gate will reject `vague proposals do not satisfy the minimum`.

3. Spike issue's `## 依赖关系` must include `Blocks: #<impl>` where `#<impl>` is the implementation issue that depends on the spike outcome.

4. For `kind:code-spike`, include at least one row whose command or artifact proves the source-writing/runtime PoC. Also include the no-merge expectation in `## 约束`; review will reject a PR-backed result on this route.

## Failure handling

If a row's `Command` can't be expressed concretely (no command exists yet, environment not bootstrap-able from planning), the row belongs as `assumption` Dimension referencing an external smoke test or as inherited verification on a different issue. Don't write fake commands.

If `## 结果分支` for a spike genuinely has no actionable follow-up regardless of outcome, the spike is a `design-question` instead — bounce back to `plan/classify`.

## Output verdict

Choose exactly one:

- `checkpoints_authored` → read `plan/adversarial-validate`. Every issue has its tables filled and smoke-checked.
- `cannot_author_blocked` → read `plan/handoff` with the specific issue whose table can't be authored and why.
- `not_atomic_resplit` → return to `plan/decompose` if filling the table revealed the issue is actually multiple problems wearing one title.

Do not advance to validation with empty `## 验收标准` placeholders.
