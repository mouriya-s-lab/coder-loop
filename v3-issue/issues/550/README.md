# #550 doc 渲染声明驱动化：非法化引擎按变量名分支

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:01Z  | updated: 2026-07-26T16:15:16Z
- closed: 2026-07-26T16:15:16Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/550
- comments: 4  | timeline events: 17

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其裁决 F，逐字快照：

> "非法化引擎按变量名分支；doc 渲染完全声明驱动（现有 `label/suffix/style/blankBefore` 扩 `prefix`）" / 理由："#539 一类问题根除于机制而非逐个修" — #547 裁决记录 F

## 目标

runtime-inputs doc 渲染完全由 `[phases.variables]` 的 doc 声明驱动，引擎渲染路径不存在任何按变量 key 字面量的分支。

## 使用场景

- preset 作者要某个变量在 runtime-inputs doc 里带前置说明行，声明 `doc.prefix` 即得——不需要该变量名恰好叫 `ISSUE` 才享受特殊排版。
- 引擎侧再也不可能出现「某知名变量名有隐藏行为」——非 bundled preset 与 bundled preset 在 doc 渲染上完全同权。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- 特判现场：`renderRuntimeInputsDoc`（`src/loop.ts:5166`）内 `if (variable.key === "ISSUE")`（`src/loop.ts:5173`）——引擎按变量名字面量分支，违反「引擎不知道已知 KEY 含义」分层契约（CLAUDE.md L1 职责表）。
- 既有声明面：`[phases.variables]` 的 doc 表已有 `label/suffix/style/blankBefore` 四字段（类型 `src/loop.ts:553`，parse `src/loop.ts:4382-4384`）——扩 `prefix` 是同构追加。
- #539 已在 #534 audit 树登记该特判的 v2 行为修复；本 child 是机制级根除（v3），与其为先后两刀。

## 问题

> "doc 渲染存在按变量名分支的特判（`renderRuntimeInputsDoc` 的 `"ISSUE"` 特例，#539 已在 #534 树登记 v2 修复）" — #547 定位事实

机制上引擎只要允许一处按变量名分支，就为任意「知名变量名特权」开了口子——每个后续特判都会引用这个先例。

## 预期结果

性质表述：

1. **完全声明驱动**：runtime-inputs doc 的每一行输出都可追溯到某绑定的 doc 声明字段；引擎渲染函数的输入是声明结构，不读变量 key 的字面量值做分支。
2. **声明面扩 `prefix`**：覆盖原特判所表达的排版需求；bundled preset 迁移为显式声明，渲染语义与 #539 修复后的正确行为等价。
3. **编译器守护**：doc 声明是 typed 结构（arktype parse），新增 doc 字段必须过 parse + 渲染两端类型链，不能以「渲染函数里认变量名」旁路。

## 不应残留

- 本 child 范围内：`=== "ISSUE"` 分支及任何等价的按 key 字面量分支（含换个字面量重生的形态）。
- 范围之外不动：绑定类型流（type/required/default 归类型流 child）、`[[tools]]`、#539 的 v2 行为修复本身（归 #534 树，本 child 在其后 rebase）。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 引擎层禁止 `gh-issue-pr-iteration` 字面量（含 `{{KEY}}` 已知 KEY，CLAUDE.md Conventions）——本 child 正是该红线在 doc 渲染面的执行。
- 排序：#539（#534 树）先合，本 child 在其后 rebase 并做机制非法化；偏离此序需在 PR 里写明理由。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 变量名特判死亡（RFC 关闭验证行 2 之本 child 份额） | `grep -rnE '=== "ISSUE"' src/` | local | 无输出 |
| function | 不以别的字面量重生 | 单元测试：两个仅 key 名不同、doc 声明相同的绑定 → 渲染输出逐字节相同（除 key 名本身） | local | 测试绿 |
| function | prefix 声明生效 | fixture preset 绑定声明 `doc.prefix`，渲染 runtime-inputs doc | local | 输出含 prefix 行，位置符合声明 |
| integration | bundled preset 语义等价 | 迁移前后对 gh-issue-pr-iteration 渲染 runtime-inputs doc 做 diff | local | 语义等价（与 #539 修复后的正确行为一致），diff 列入 PR evidence |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 无树内硬上游（doc 声明面独立于编译产物导出）。
- 排序边: #539（#534 audit 树）先合。


---

## Comments (4)

### comment #4865081695 by `RiriAgent` — 2026-07-02T11:14:35Z

## 架构切片

1. **系统定位**：L1 引擎 render 期 doc builder 级（`renderRuntimeInputsDoc`，与 `phaseExitsDoc` 等 7 个动态 doc 同层）。
2. **全局坐标**：preset 声明域（`[phases.variables].doc` typed 结构）→ prompt 文本域。parse 点在 preset 装载；render 只消费声明结构。
3. **类型↔值不漂移**：防类型泄露——`ISSUE` 特判是 L2 preset 私有 KEY 语义被编码进 L1 引擎代码（域词表倒灌）；声明驱动后引擎对 KEY 名保持无知。
4. **消除的错误类别**：「知名变量名享受隐藏行为」不可表达——渲染输出只能是声明字段的函数。

## log/观测义务

- 无新事件义务：本 child 不触 daemon/scheduler 事件面，渲染失败沿既有 render throw 语义。



### comment #4953814373 by `RiriAgent` — 2026-07-13T02:12:02Z

<!-- coder-loop:executable-contract schema=1 source-issue=550 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/550
- Observed body revision: created `2026-07-02T11:12:01Z`; GitHub reports `lastEditedAt: null` (the body has no edit revision). Complete issue/timeline fetch was performed against the open issue on `2026-07-13`.
- Operator comment used: https://github.com/mouriya-s-lab/coder-loop/issues/550#issuecomment-4865081695 (L1 render-time placement, declaration-to-prompt flow, and no new event/log surface).
- Parent decision source: https://github.com/mouriya-s-lab/coder-loop/issues/547 (decision F and the type-system constraints quoted by the child).
- Historical implementation evidence only: https://github.com/mouriya-s-lab/coder-loop/pull/652. It is CLOSED/unmerged; its closing comment explicitly requires a fresh implementation from current `main`, so its commits are not a migration or cherry-pick source.

## Deliverable

`implementation-pr`

Implement from current `origin/main` and open one PR that closes only #550. The remaining current-tree work is: (a) replace `PresetPhaseBoundary.variables = "object"` with named, precise ArkType boundaries for the string-or-product binding wire ADT and its string-keyed variables record; (b) make `parseVariableBinding` consume the inferred precise union without `any`, anonymous product shapes, unchecked casts, or duplicated runtime type checks; (c) remove the bundled-preset test's `candidate.key === "ISSUE"` lookup and add the key-renaming byte-invariance guard. Preserve the already-landed schema-driven `prefix` renderer from #611.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | forbidden exact key literal | shell | `rg -n "===\\s*['\\\"]ISSUE['\\\"]" src` from repo root; local | exit 1 and no output |
| C2 | no equivalent variable-key literal branch | shell | `rg -n "(variable|candidate)\\.key\\s*===\\s*['\\\"][A-Z_]+['\\\"]" src` from repo root; local | exit 1 and no output |
| C3 | precise boundary chain | shell | `bun test src/preset.test.ts -t "runtime input doc"` from repo root; local | exit 0; malformed variable-doc products are rejected at the ArkType preset boundary, valid bindings reach `parseVariableBinding` as the inferred string-or-product union, and no broad `BoundaryValue` re-parse is used for that binding |
| C4 | key-renaming invariance | shell | `bun test src/preset.test.ts -t "runtime input doc rendering is invariant under variable key renaming"` from repo root; local | exit 0; two bindings differing only in key render byte-for-byte equal output |
| C5 | prefix declaration behavior | shell | `bun test src/preset.test.ts -t "runtime input doc decoration is schema driven"` from repo root; local | exit 0; declared `prefix`, `suffix`, `style`, and `blankBefore` render at their declared positions |
| C6 | bundled preset migration/semantic lookup | shell | `bun test src/preset.test.ts -t "bundled preset declares issue doc prefix"` from repo root; local | exit 0; bundled bindings are found by declared source/doc semantics rather than a known variable key, and their `#` prefix remains explicit in preset TOML |
| C7 | full static and test gate | shell | `bun run typecheck && bun test` from repo root; local, non-contending host | exit 0; full runner summary reports 0 fail and no existing test is removed, skipped, renamed, or weakened to obtain green |
| C8 | canonical real runtime | shell | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repo root; local with RiriAgent `gh` auth and preset runner CLIs on PATH | exit 0; stdout reports isolated daemon socket readiness, a real fixture issue CLOSED, its closing PR MERGED, successful content assertion, and teardown of the run-owned fixture/socket/processes |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| P1 | `whole-tree` | `rg -n "===\\s*['\\\"]ISSUE['\\\"]" src` | none | zero matches across production code and tests |
| P2 | `whole-tree` | `rg -n "(variable|candidate)\\.key\\s*===\\s*['\\\"][A-Z_]+['\\\"]" src` | none | zero variable-name/candidate-name equality branches against uppercase preset-key literals; semantic source-field comparisons and generic map lookup by caller-supplied key are outside this pattern |
| P3 | `changed` | ArkType wire products introduced for phase variable bindings | `src/loop.ts` boundary declarations and the parser signature that consumes their inferred union; tests in `src/preset.test.ts` | every new object alternative is a separately named boundary; the variables record composes that named union; no anonymous product alternative, `any`, new unchecked cast, or loose object/optional-field bag is introduced |

## Canonical runtime

- Setup: from this checkout, use Bun `1.3.14`; run `bun install --frozen-lockfile` if dependencies are not already installed. Verify `gh auth status` has active account `RiriAgent`, `codex` and `claude` resolve on PATH, `/Users/mouriya/Ext/code/coder-loop-e2e-fixture` is a git checkout whose origin is `mouriya-s-lab/coder-loop-e2e-fixture`, and `gh repo view mouriya-s-lab/coder-loop-e2e-fixture --json nameWithOwner,visibility` succeeds.
- Start/behavior owner: `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` is the target-mandated real E2E driver (`CLAUDE.md`; `docs/real-e2e-fixture.md`). It allocates a run UUID, creates a run-owned fixture file and seed issue, starts the real daemon with an isolated loop-data root, creates the chain/item, and drives real iteration/review agents.
- Readiness: require the harness line `daemon: socket 就绪 <isolated .../daemon.sock>` before treating the runtime as started.
- Observation: require harness exit 0 plus the emitted `seed issue ... (CLOSED)`, `PR ... (MERGED, <sha>)`, and run-owned fixture assertion. Independently re-read the emitted issue and PR URLs with `gh issue view` / `gh pr view` if preparing PR evidence.
- Logs: preserve the complete command transcript under the run's evidence directory; on failure preserve the printed isolated loop-data root, daemon stdout/stderr paths, and last status snapshot.
- Stop ownership: the harness owns `daemon down`, residual phase-process cleanup, run-owned GitHub cleanup, fixture deletion, and mutex release. Do not touch production `~/.coder-loop`; after exit verify no harness-owned process/socket remains.

## Test delta

`required`

Add the key-renaming byte-invariance test and precise-boundary rejection/acceptance coverage needed by C3/C4. Retarget the existing bundled-prefix test away from literal key identity to declared source/doc semantics. Surviving integrity rule: retain all pre-existing prefix/suffix/style/blankBefore assertions and malformed-input rejection coverage; do not delete, skip, rename, relax, or replace exact byte/output assertions merely to pass. Report base/head test inventory and explain every changed test.

## Dependencies

- The ordering edge is satisfied: #539 is CLOSED by merged PR https://github.com/mouriya-s-lab/coder-loop/pull/611. Current `main` contains `PresetVariableDoc.prefix`, parser support, declaration-driven rendering, and explicit bundled `prefix = "#"`; those landed semantics must be preserved.
- #547 remains the open parent and is the source of the quoted ADT/type redlines; #550 has no sub-issues.
- PR #652 is CLOSED/unmerged at head `81a445347d201972a85c2aa642ecd8d04c7730ba`; its final comment says to restart from current `main`. Continue neither that PR nor its branch, and do not cherry-pick it.
- Current investigated base is `origin/main@f01560d5d0b324e791db7f599e502f09fc78a652`. At this revision `src/loop.ts` still declares phase `variables` as broad `"object"`, `parseVariableBinding` still accepts `BoundaryValue`, and `src/preset.test.ts` still contains `candidate.key === "ISSUE"`; these are the verified remaining implementation sites, not authorization to copy the old PR diff.
- External runtime dependencies are currently reachable: active `gh` account is `RiriAgent`; private fixture repo `mouriya-s-lab/coder-loop-e2e-fixture` and its local checkout are available; Bun, Codex, and Claude binaries resolve. Real E2E consumes GitHub/runner capacity and must use the harness mutex rather than bypassing it.

## Supersedes

none



### comment #4995017104 by `RiriAgent` — 2026-07-16T17:57:06Z

<!-- coder-loop:executable-contract schema=1 source-issue=550 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/550
- Observed body update timestamp: `2026-07-15T12:57:47Z` (`updated_at` from the complete REST issue object; the latest issue comment predates it). The current body adds the implementation-level verification boundary that excludes `scripts/real-e2e.ts` from this child.
- Operator comment used: https://github.com/mouriya-s-lab/coder-loop/issues/550#issuecomment-4865081695 (L1 render-time placement, declaration-to-prompt flow, and no new event/log surface).
- Parent decision source: https://github.com/mouriya-s-lab/coder-loop/issues/547 (decision F and the quoted ADT/type constraints).
- Historical implementation/review sources only: https://github.com/mouriya-s-lab/coder-loop/pull/652 and https://github.com/mouriya-s-lab/coder-loop/pull/670. Both are CLOSED/unmerged; #652's final comment explicitly requires a fresh implementation from current `main`, and #670 was later closed by the operator without a replacement PR.

## Deliverable

`implementation-pr`

Implement from current `origin/main` and open one PR that closes only #550. Preserve the schema-driven renderer and bundled `prefix = "#"` declarations already merged by #611. The remaining current-tree work is to replace the broad phase-variable wire boundary with named exact ArkType boundaries, carry the inferred string-or-product binding type into `parseVariableBinding`, remove duplicated loose-object/type checks made redundant by that boundary, remove the bundled test's `candidate.key === "ISSUE"` selector, and add boundary plus key-renaming regressions. Do not continue either closed PR or transport its commit; investigate and implement against the current tree.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | forbidden exact key literal | shell | `rg -n "===\\s*[\\\"']ISSUE[\\\"']" src` from repo root; local | exit 1 and no output |
| C2 | no equivalent uppercase variable-key branch | shell | `rg -n "(?:variable|candidate)\\.key\\s*(?:===|!==)\\s*[\\\"'][A-Z_][A-Z0-9_]*[\\\"']" src` from repo root; local | exit 1 and no output |
| C3 | exact boundary round-trip | shell | `bun test src/preset.test.ts --test-name-pattern "preset variable binding boundary accepts both variants and rejects malformed products"` from repo root after frozen install; local | exit 0; string and full product bindings cross the ArkType boundary and reach the parser, while a non-string doc field and an unknown product field are rejected at the preset boundary with field-qualified errors |
| C4 | key-renaming invariance | shell | `bun test src/preset.test.ts --test-name-pattern "runtime input doc rendering is invariant under variable key renaming"` from repo root after frozen install; local | exit 0; two bindings that differ only in key render byte-for-byte equal output |
| C5 | prefix declaration behavior | shell | `bun test src/preset.test.ts --test-name-pattern "runtime input doc decoration is schema driven"` from repo root after frozen install; local | exit 0; declared `prefix`, `suffix`, `style`, and `blankBefore` render in their declared positions and exact output remains stable |
| C6 | bundled declaration lookup | shell | `bun test src/preset.test.ts --test-name-pattern "bundled preset declares issue doc prefix"` from repo root after frozen install; local | exit 0; bundled bindings are selected by declared item source/doc semantics rather than a known variable key, and the explicit `#` prefix still renders |
| C7 | full static and unit/contract gate | shell | `bun run typecheck && bun test` from repo root after `bun install --frozen-lockfile`; local, non-contending host | exit 0; typecheck has no diagnostics, full suite reports 0 fail, and no existing test is removed, skipped, renamed, or weakened to obtain green |
| C8 | process-level engine regression gate | shell | `bun scripts/engine-integration.ts` from repo root after frozen install; local, no GitHub or real runner credentials | exit 0; socket readiness is observed, the deterministic iteration/review run reaches `done`, SQLite admission and marker commit assertions pass, worktrees are recycled, and no orphan remains |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| P1 | `whole-tree` | `rg -n "===\\s*[\\\"']ISSUE[\\\"']" src` | none | zero matches in production code and tests |
| P2 | `whole-tree` | `rg -n "(?:variable|candidate)\\.key\\s*(?:===|!==)\\s*[\\\"'][A-Z_][A-Z0-9_]*[\\\"']" src` | none | zero branches granting behavior from an uppercase preset-variable key literal; generic caller-supplied lookup and comparisons on declared semantic source fields are outside this pattern |
| P3 | `whole-tree` | `rg -n '"variables\\?":\\s*"object"|parseVariableBinding\\(value:\\s*BoundaryValue' src/loop.ts` | none after the change | zero broad phase-variable boundary/parser signatures; phase variables are parsed once into the exact declared union before internal use |
| P4 | `changed` | named ArkType boundary chain for preset phase variable bindings | boundary declarations and `parseVariableBinding` in `src/loop.ts`; focused regressions and the bundled selector in `src/preset.test.ts` | every object alternative is a separately named product boundary, the string-or-product union and string-keyed record compose named boundaries, the parser consumes the inferred union, and changed code introduces no `any`, anonymous product, boundary-internal `unknown`, unchecked cast, loose optional-field bag, or private fallback |

## Canonical runtime

- Setup: use Bun `1.3.14`; run `bun install --frozen-lockfile` in the issue checkout. This worktree initially lacked installed dependencies and the focused test correctly failed to load `cmd-ts`; after frozen install, the two existing focused renderer tests passed (2 pass, 0 fail) and `bun run typecheck` completed without diagnostics.
- Semantic behavior driver: the focused C3-C6 Bun tests are the canonical checks for preset-boundary rejection/acceptance and exact runtime-input doc output. They exercise `parsePreset`/`loadPreset` through the real ArkType boundary and `renderRuntimeInputsDoc` without inventing a separate fixture program.
- Process start: `bun scripts/engine-integration.ts` is the repository's mandated process-level daily gate. It creates a UUID-scoped local git fixture and loop-data root, starts `bun src/loop.ts daemon up`, and uses the declared `engine-integration` preset with a deterministic PATH runner shim.
- Readiness: require the emitted `daemon: socket 就绪 <isolated .../daemon.sock>` line before chain/item creation.
- Behavior/observation: require command exit 0 and the final evidence block showing item `done`, `iteration -> review`, at least one `item.status.write_admission` event, a real marker commit, recycled slot worktree, and no orphan process. A current-base investigation run passed in 4.8 seconds.
- Logs: capture the complete command transcript. On failure the harness preserves and prints its UUID work directory, loop-data root, daemon stdout/stderr paths, and a status snapshot; phase logs are under the printed run path.
- Stop ownership: the harness owns `daemon down`, bounded SIGTERM/SIGKILL fallback, run-owned worktree cleanup, orphan detection, and removal of the successful UUID work directory. It does not touch production `~/.coder-loop` state or GitHub.
- Repository real E2E exists at `bun scripts/real-e2e.ts`, but this issue's current body explicitly forbids running it here. Cross-child v3 integration is owned by https://github.com/mouriya-s-lab/coder-loop/issues/684 and bundled GitHub compatibility real E2E by https://github.com/mouriya-s-lab/coder-loop/issues/685.

## Test delta

`required`

Add C3 and C4 coverage. Retarget the existing bundled-prefix test's selection logic from literal key identity to declared item-source/doc semantics; retaining the test name and its prefix/render assertions is required. Surviving integrity rule: retain all existing prefix/suffix/style/blankBefore exact assertions, malformed/unknown-field rejection, default-only binding behavior, and bundled declaration counts; do not delete, skip, rename, relax, or replace exact output assertions merely to pass. Report base/head test inventory and explain each changed test.

## Dependencies

- Investigated base: `origin/main@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. At this revision `src/loop.ts` still has `PresetPhaseBoundary.variables = "object"` and `parseVariableBinding(value: BoundaryValue, ...)`; `src/preset.test.ts` still has `candidate.key === "ISSUE"`. These are current-tree facts, not authorization to copy an old PR diff.
- Ordering edge satisfied: #539 is CLOSED by merged PR https://github.com/mouriya-s-lab/coder-loop/pull/611. Current `main` contains `PresetVariableDoc.prefix`, parser normalization, declaration-driven rendering, explicit bundled `prefix = "#"`, authoring docs, and rejection of unknown binding fields; preserve those semantics.
- Parent https://github.com/mouriya-s-lab/coder-loop/issues/547 remains OPEN and supplies the quoted ADT/type redlines. Issue #550 has no sub-issues.
- PR https://github.com/mouriya-s-lab/coder-loop/pull/652 is CLOSED/unmerged; its final comment says its old head and review history are investigation evidence only and not a migration/cherry-pick source. PR https://github.com/mouriya-s-lab/coder-loop/pull/670 is also CLOSED/unmerged, has no reviews or remote checks, and was closed by `Mouriya-Emma` on `2026-07-16T17:35:31Z`; no open replacement PR is linked.
- External dependencies for this child are local only: Bun and the frozen lockfile for C3-C8. C8 supplies its own local fixture and stub runner and needs no GitHub/API credentials. GitHub/real-runner capacity is deliberately deferred to #685, not a blocker for this implementation PR.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/550#issuecomment-4953814373



### comment #5084308723 by `RiriAgent` — 2026-07-26T16:15:15Z

重新拆分后由 #735 承接 doc 渲染声明驱动化。关联 PR #652 / #670 / #691 均已 closed unmerged，本 issue 无 open PR，按 #547 重拆结果关闭。


---

## Timeline (17)

- 2026-07-02T11:12:02Z `assigned` @RiriAgent
- 2026-07-02T11:13:05Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:35Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-11T22:48:52Z `cross-referenced` @RiriAgentsrc=652
- 2026-07-12T03:02:00Z `referenced` @RiriAgentcommit=81a445347d201972a85c2aa642ecd8d04c7730ba
- 2026-07-12T14:00:42Z `cross-referenced` @RiriAgentsrc=666
- 2026-07-12T14:34:45Z `cross-referenced` @RiriAgentsrc=667
- 2026-07-13T00:03:34Z `cross-referenced` @RiriAgentsrc=661
- 2026-07-13T02:12:02Z `commented` @RiriAgent
- 2026-07-13T02:48:40Z `cross-referenced` @RiriAgentsrc=670
- 2026-07-16T17:57:06Z `commented` @RiriAgent
- 2026-07-16T18:12:38Z `cross-referenced` @RiriAgentsrc=691
- 2026-07-17T20:37:13Z `cross-referenced` @RiriAgentsrc=735
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-26T16:15:15Z `commented` @RiriAgent
- 2026-07-26T16:15:17Z `closed` @RiriAgentcommit=None