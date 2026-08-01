# #698 feat(scheduler): 从公开入口实例化并调度 seq/par drain

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:13Z  | updated: 2026-07-27T04:26:48Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/698
- comments: 36  | timeline events: 61

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 现行补充契约：类型化路径完成协议

继承 [#451](https://github.com/mouriya-s-lab/coder-loop/issues/451) 与 [#452](https://github.com/mouriya-s-lab/coder-loop/issues/452)：agent 查询合法出边并经 CLI 提交选择，提交即业务完成；runner exit 不是业务完成权威。v3 将其从裸 status 扩展为 committed transition。

preset 对每条后继路径声明目标、可选 prompt 模板及全部输入来源。agent 只填写声明为 `exit.*` 的类型化对象；固定或外部值由既有 `item.*` / `chain.*` / `runtime.*` / typed literal binding 按 `required | default` 与 projection 规则填充。缺字段、错类型、非法路径或不可满足的已知 required binding 均不得完成当前 leaf，也不得创建后继。

本 issue 的树调度只消费 committed transition：前驱裸 terminal 或 runner exit 不足以使 `seq` 后继 ready。一次提交必须原子留下 transition record、完成当前 leaf并构造目标 invocation；调度器不得从 status、stdout 或进程退出推断缺失的路径和输入。

补充验收：通过公开 CLI 运行 `seq(A,B)`；A 分别尝试缺少 required `exit.*` 字段、字段类型错误、非法路径与完整合法对象。前三者均非零退出，A 不完成且 B 不存在/不可调度；合法提交后恰有一条 transition record，A 完成且 B 成为唯一后继。

## 目标

通过公开 daemon/CLI 创建入口实例化最小 runtime tree 并执行 seq/par drain；禁止直接写 SQLite/createTaskTree 作为验收。

调度决策从「flat position 队列 + slot=(chainId, repoCwd) 串行」切换为任务树遍历：seq 依游标推进、par 打开期间成员真并发、任意深度嵌套、slot 语义退役、单活性执法键从「chain / slot」重立到「闭包」、par 展开时按供给条款 4 写入 pin。

## 预期结果

- 调度决策唯一来源是任务树结构：seq 按游标依序推进；par 打开期间全部未终结成员可并发 spawn；嵌套任意深度按代数语义推进（性质：对任何 well-formed 树，每个 tick 的可 spawn 集 = 树语义允许的就绪 leaf 集，与资源键无关）。
- **spawn 一个 leaf = 查闭包状态表决策动作**（对照 #558 shape）：
  - 无闭包记录 → 触发 #699 的 create 转移；
  - 闭包记录为 suspended → 触发 #699 的 reopen 转移；
  - 闭包记录为 active 且当前无活 run → 触发 #699 的 resume 路径（同 worktree、同 session，attempt 链内继续）；
  - 闭包记录为 active 且已有活 run → 违反单活性，本 tick 不 spawn（下一 tick 由 run-exit 事件驱动）；
  - 闭包记录为 consumed → 该 leaf 不再可 spawn（终态既落）。
  本 child 只做决策与派发，机制本体归 #699；调度侧不重复实现闭包转移。
- drain join 的**结构性放行**随树遍历落地：par 全部成员 terminal 即容器 terminal、外层 seq 推进（drain 是代数的退化 join，无判定通道即可放行）；validator/hold 判定通道归 #700（join 评估）——本 child 落地后未声明 validator 的 par 全链路可跑通。
- **slot 串行语义退役**：`schedulerSlotKey` 不再参与调度决策；同 chain 同 repoCwd 的 par 成员执行区间可重叠。退役 rationale 更新——「共享单份 worktree」的存在理由消失，v3 每闭包一份 worktree，资源键（chainId, repoCwd）与「谁能并行」解耦。
- **单活性执法（新执法键 = 闭包）**：v2 偶然保证的两根柱子（slot 串行、`current_runs` PK=chain_id）随 slot 退役与树调度落地同时消失，本 child 在调度路径按新键显式重立——每次 spawn 决策前查该 leaf 对应闭包是否已有活 run，命中即拒绝第二个 run 并留可审计事件；表征形态（`current_runs` PK 换 closure id 还是别的形态）跟随 #558 shape，本 child 消费；挂起态闭包对应 leaf 决策路径不 spawn（走 reopen 而非新 create）。
- **par 展开时 pin 写入**：调度器识别到某 par 节点进入「展开」状态（即将 spawn 其成员入口任务集）时，先 pin base 尖端 commit——存储位与字段归 #558 shape，本 child 在调度路径承接**写入动作**并保证「pin 先落库、成员闭包 create 后读同一 pin」的时序（避免调度时序引入副作用）；嵌套 par 内层 par 展开时同样重新 pin（内层 par 有自己的 pin，独立于外层）；运行中追加成员时**不**重 pin（凝固点语义，追加复用同 pin——由 #702（动态物化）在追加路径消费）；本 child 只负责首次展开路径的 pin 写入与内层重 pin 语义。
- 并发上限 = 纯限流参数：全局上限与 per-par 上限的值取自元数据声明；未声明全局上限 = 不限（现状语义延续）；引擎不驻留业务上限数值。
- dependsOn 与树正交：par 成员携带跨结构 dependsOn 照常被 gate、全依赖 success 后恢复；写入期查环行为不变。
- 子任务失败不自动向上传播：非 success 终态成员不使容器/祖先失败，容器处置归 join 评估（后续 child）；本 child 保证失败 leaf 的退避/attempts 语义在树下不回归。
- v2 线性链（退化 seq 树）调度行为零回归。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | par 真并发（#546 行 2） | 构造 par 内 2 item（同 chain 同 repoCwd）的树，daemon 调度后查 runs 表两 run 的 `started_at`/`ended_at` | local | 执行区间重叠（真并发，非串行） |
| function | 嵌套深度推进（#546 行 1 调度半边） | 构造 `seq(leaf, par(leaf, par(leaf, leaf)))` 树真跑 | local | 嵌套结构按代数语义推进到全树 terminal |
| function | spawn 派发按闭包状态决策 | 分别构造三态触发场景：新 leaf（无闭包记录）、已挂起 leaf 被重新调度（suspended）、活跃闭包中断后 tick（active/无活 run） | local | 三种场景分别触发 #699 的 create / reopen / resume 转移调用；调度决策不直接写闭包状态 |
| function | 单活性执法（执法键 = 闭包） | 对已有活 run 的闭包再次触发 spawn 决策；对同 leaf 挂起态触发调度 | local | 第二个活 run 被拒 + 审计事件；挂起态走 reopen 分支不走 create |
| function | par 展开 pin 写入（供给条款 4） | 首次展开含 ≥2 成员的 par；嵌套 par 内层展开 | local | 展开前 pin base 尖端 commit 落库（存储位随 #558）；成员闭包 create 后底座 commit = 该 pin；内层 par 独立重新 pin |
| function | per-par 上限限流 | par 内 3 成员 + 元数据声明 per-par 上限 2，观察活 run 数 | local | 任意时刻该容器活 run ≤ 2，全部成员最终完成 |
| function | 全局上限限流 | 元数据声明全局上限 1 + 两 chain 各一就绪 item | local | 任意时刻全 daemon 活 run ≤ 1；未声明时行为不限（现状延续） |
| function | dependsOn 正交（#546 行 8） | par 成员携带跨结构 dependsOn 真跑；另写入含环的 dependsOn | local | 约束边与并行结构独立生效（先 gate 后恢复 entry）；环在写入期被拒 |
| function | 失败不上溯 | par 内一成员耗尽 attempts 落 exhausted，其余成员正常 | local | 其余成员照常执行完成；容器与祖先不因此失败 |
| assumption | slot 退役（#546 行 10 切片） | `grep -n "schedulerSlotKey" src/scheduler.ts src/daemon.ts` | local | 无调度决策路径引用（符号删除或仅存于迁移/清理代码） |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #558、#601、#699；外部 #737、#739、#743。
- Blocks: #700、#702、#704、#705、#706、#708、#709、#715、#724、#731、#744。





---

## Comments (36)

### comment #5010453165 by `RiriAgent` — 2026-07-18T07:40:28Z
_(last edited 2026-07-19T05:49:42Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`, editor `RiriAgent`). The issue has zero comments and `comments.pageInfo.hasNextPage=false`, so there are no direct operator-comment URLs on #698.
- Inherited parent: https://github.com/mouriya-s-lab/coder-loop/issues/546, observed body `lastEditedAt` `2026-07-18T06:18:52Z`; the complete 13-comment set is exhausted (`hasNextPage=false`). Operator-decision records used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885, https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406, and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021.
- Scope-handoff source: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns the old unresolved post-terminal leaf-reactivation question to #701, not #698.
- Local source inspected: current `main` `9ac3b87d336a04a564a40fa3ce9163d361e86b40` and the assigned checkout at `0f6bb5794286e1f5d53ff5e5ea8b0ec37a5e8b6a`, which contains the open #560 candidate plus four local test-only commits beyond live PR #749.

## Deliverable

`implementation-pr`

Create exactly one draft implementation PR whose body begins with `Closes #698`. It must implement public daemon/CLI instantiation and scheduler consumption of the already-declared task/transition model: structural `seq`, true-concurrent `par`, `drain`, closure-keyed dispatch, limits, pins, dependency gating, and committed-transition advancement. It must not implement #737's binding/type system, #739's declaration/compiler surface, #743's immutable definition-ref producer, #560's closure resource mechanism, #700's validator/join judgment, #701's correction/reopen and post-terminal reactivation, runtime append/materialization, cancellation, bundled-preset migration, GUI, or deployment. If the source prerequisites below are not landed, report the blocker on #698 rather than publishing a mixed-issue PR.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean #698 candidate checkout based on then-current `main`, env is local macOS with Bun/Git on `PATH`, and all runtime roots, fixture repos, chain names, refs and runner shims are UUID-isolated from production `~/.coder-loop`.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated daemon/runtime; fixture preset uses the landed #739 public syntax | Exit 0; real `bun src/loop.ts daemon up`, `chain create`, and `item add` instantiate a minimal persisted runtime tree visible through `coder-loop status --json` before dispatch. No direct SQLite write or `createTaskTree` call seeds acceptance state. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same runtime; public completion CLI; fixture `seq(A,B)` with a structured required `exit.*` field | Exit 0; missing required field, wrong field type, illegal path, and missing known-required external binding each make the CLI exit nonzero; no transition is persisted, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked terminal/status write without a legal path object do not advance the cursor. One valid CLI submission atomically persists exactly one transition record, completes A, creates the declared successor invocation with authoritative external bindings, and makes B the only ready leaf; replay creates neither a second transition nor a second B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | `par` with at least two leaves in one chain and the same `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are simultaneously active and their persisted `started_at`/`ended_at` intervals overlap. No resource-key/slot serialization decides readiness. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | fixture `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; arbitrary-depth structural traversal exposes exactly the algebraically ready leaves, each inner/outer `drain` completes only after all direct members are terminal, the outer seq then advances, and the whole tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | public runtime scenarios for absent, suspended, active/no-live-run, active/live-run and consumed closures | Exit 0; the scheduler delegates respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior from the landed closure API. The active/live case emits an identity-bearing audit event and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | first-open par with at least two members plus nested par; origin-backed local Git fixture | Exit 0; the scheduler persists the outer base pin before member-closure creation, all outer members use that exact pin without member fetch, and the nested par independently pins its own expansion point before creating inner members. Runtime append/no-repin behavior is not implemented or claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | par of three leaves with declared per-par limit 2; two chains with declared global limit 1; separate no-global-limit fixture | Exit 0; observed active runs never exceed each declared limit, all leaves eventually run, and absence of the global declaration adds no engine-owned default cap. Limit values are consumed from metadata rather than stored as scheduler literals. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | par member with cross-structure `dependsOn`; separate public write that introduces a dependency cycle | Exit 0; the dependent leaf is gated until all dependencies reach a declared success terminal, then becomes ready without changing tree structure; the cycle write is rejected before persistence. This row does not reactivate an already-advanced leaf, which belongs to #701. |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | drain par where one member exhausts attempts and siblings succeed | Exit 0; siblings continue, the failed leaf retains existing attempts/backoff/exhaustion semantics, failure does not automatically propagate to the container/ancestors, and drain completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | existing linear preset normalized to a degenerate seq | Exit 0; the public chain follows the same phase order, status-admission, retry/session, attempts/backoff, chain-complete and cleanup outcomes as before the tree scheduler; no second flat scheduling model remains. |
| C12 | assumption | shell | `rg -n "schedulerSlotKey" src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches in scheduling/daemon paths; scheduling concurrency is keyed by ready leaves and closure active-run state, not `(chainId, repoCwd)`. |
| C13 | assumption | shell | `rg -n 'createTaskTree\(|\b(INSERT|UPDATE|DELETE|REPLACE)\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. The driver may perform read-only `SELECT` queries for interval/record-count evidence, but all creation, transition and mutation effects must cross the public daemon/CLI path. |
| C14 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics; ready/blocked/dispatch/transition/join outcomes are exhaustive ADTs with no open-string or cast escape. |
| C15 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures; report aggregate base/head test totals and explicitly enumerate every removed, renamed, skipped, `.only`-selected, timeout-relaxed, or weakened test (the list must be empty unless a row is replaced by an equal-or-stronger assertion for the explicitly retired slot/flat-order behavior). |
| C16 | integration | shell | `bun scripts/engine-integration.ts` | candidate root; script-owned isolated daemon/runtime | Exit 0; the standard real-process daemon/socket/spawn/admission/worktree/SQLite gate reaches terminal and tears down with no orphan. This does not substitute for C01-C11. |
| C17 | e2e | shell | `bun scripts/real-e2e.ts --preset real-e2e-minimal` | candidate root; existing fixture repo and locally resolved GitHub/runner credentials | Exit 0; a real runner completes the real GitHub issue -> branch -> PR -> review -> merge -> issue-closure path, proving the scheduler change preserves the target-mandated production entry. This is the strongest Layer 4 evidence for this non-UI project. |
| C18 | assumption | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated GitHub CLI; after submit | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, begins with `Closes #698`, and its live branch/SHA equal the current candidate. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `schedulerSlotKey` | whole-tree | `rg -n "schedulerSlotKey" src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. A historical data migration or offline cleanup outside scheduler/daemon is explicitly excluded; no runtime scheduling or concurrency decision is excluded. |
| `createTaskTree\(|\b(INSERT|UPDATE|DELETE|REPLACE)\b` | changed | `rg -n 'createTaskTree\(|\b(INSERT|UPDATE|DELETE|REPLACE)\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only to corroborate public-runtime observations is excluded. |
| `\bany\b| as (?!const)` | changed | `git diff --unified=0 origin/main...HEAD -- ':(glob)src/**/*.ts' ':(glob)scripts/**/*.ts' | rg --pcre2 '^\+.*(\bany\b| as (?!const))'` must exit 1 with zero added-line matches. |

## Canonical runtime

- Setup: use a clean #698 candidate based on all satisfied prerequisites and run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated local Git fixtures, a fixture preset using the landed recursive task/path schema, a loop-data root, deterministic runner shim and evidence directory; starts the real `bun src/loop.ts daemon up --loop-data-root <root>` process; then creates every chain/item through `bun src/loop.ts chain create` and `item add`. Store APIs and direct SQL writes are not setup paths.
- Readiness: observe the daemon PID alive and isolated Unix socket accepting `daemon status`; after public create, require `coder-loop status --json` to expose the expected runtime-tree identity before allowing the first runner to proceed.
- Behavior: execute C01-C11, driving every completion choice through the public typed completion CLI. Read-only DB inspection may corroborate transition counts and run intervals, but status/log/event/CLI results remain the authoritative action path.
- Logs: record the exact command, source SHA, fixture UUID, readiness, public create responses, exit-query schemas, rejected/accepted transition responses, ready-leaf sets, active-run intervals, pins, limits, status tree snapshots, observability events, cleanup and exit status beneath the issue evidence directory. Do not record secrets.
- Stop ownership: the driver owns and stops every daemon/runner, deletes only its registered chains/runtime root/worktrees/engine refs, and asserts no PID/socket/worktree/ref/runtime-root orphan remains. Verification separately runs `bun scripts/engine-integration.ts`; final E2E runs `bun scripts/real-e2e.ts --preset real-e2e-minimal`, whose own driver owns its GitHub fixture and teardown.

## Test delta

`required`

Focused unit/contract tests and `scripts/issue-698-integration.ts` are required for tree readiness, committed-transition atomicity/idempotency, closure-keyed single activity, par overlap, drain, pins, limits, dependency gating, failure containment and negative submissions. Existing assertions survive unless they encode the explicitly retired `(chainId, repoCwd)` serialization or runner-exit/flat-phase advancement; any replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, renamed, skipped, `.only`-selected, timeout-relaxed, or weakened merely to pass, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Satisfied prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed; PR https://github.com/mouriya-s-lab/coder-loop/pull/675 merged task-tree/closure persistence and per-closure active-run shape into current `main` `9ac3b87d336a04a564a40fa3ce9163d361e86b40`, and PR https://github.com/mouriya-s-lab/coder-loop/pull/678 merged the runner authorization boundary.
- **Unmet declaration/type prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open, have no closing PRs, and expose no paginated remainder. #739 explicitly depends on #737 and blocks #698. #698 must consume their public `exit.*` value flow and recursive task/path schema; it must not invent temporary scheduler-private schema, fallback parser, or untyped transition object.
- **Unmet immutable-definition prerequisite:** old source issue https://github.com/mouriya-s-lab/coder-loop/issues/605 was closed without a PR and superseded by https://github.com/mouriya-s-lab/coder-loop/issues/743 plus cross-consumer #744. #743 is open with no closing PR and its live body explicitly blocks #698. Instantiate runtime nodes from the landed immutable definition ref; do not implement #743 inside #698.
- **Retired old declaration issue:** https://github.com/mouriya-s-lab/coder-loop/issues/554 is closed without a PR; its closure comment says #739 owns the declaration/compiler surface and #744 owns production identity integration. Closing #554 does not satisfy open #739.
- **Closure mechanism integration fact:** https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open with draft PR https://github.com/mouriya-s-lab/coder-loop/pull/749. The live PR head is `46ed2b2c178a20eb5e6f5a1150a05c18086a5ea9` on base `9ac3b87d…`, mergeable/clean, with 24 comments, zero reviews, zero review threads, zero check runs and zero status contexts. The assigned checkout at `0f6bb57…` contains that candidate plus four local test-only commits. #698 consumes the landed create/reopen/resume/consume/resource API and must not duplicate it or publish #560's diff as part of the #698 PR.
- **Current source gap:** at assigned checkout `0f6bb57…`, `src/loop.ts:786-880` still compiles only a degenerate phase seq; `src/daemon.ts:2164-2219` and `src/daemon.ts:2884-2934` create chain/item rows without instantiating the declared runtime tree; `src/sqlite-state.ts:2135-2174` lazily appends a flat seq leaf from `recordRun`; `src/scheduler.ts:537-568,634-681,871-873,2744-2757` selects by repo slot and flat phase order; `src/daemon.ts:3290-3320` exposes status/action exits without the #737 path object. Existing `src/task-runtime.ts:3-58` is the persistence/status shape to consume, not a public setup shortcut.
- **Scope boundaries:** https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen execution and post-terminal leaf reactivation, so `queue.unblock`/satisfied-`dependsOn` against an already-advanced leaf are not resolved here. Validator/hold judgment, runtime par append/materialization and append-time no-repin are also later children; #698 implements only structural `drain` and first/nested expansion pins.
- **External runtime:** no browser, UI, deployment, IaC or new secret is required. C01-C16 are local; C17 uses the repository's existing real-E2E GitHub fixture and locally resolved runner/GitHub credentials. The repository has no checked-in CI workflow, so the local frozen-install/typecheck/test/engine-integration/real-E2E ladder is the target gate.

## Supersedes

none



### comment #5012140382 by `RiriAgent` — 2026-07-18T17:02:27Z
_(last edited 2026-07-19T06:28:58Z)_

**[iteration] contract invalid @ 7172d3e** — current marker cannot be executed against current `main`

Consumed marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5010453165

Blocking contract defects:

- The marker was written at `2026-07-18T07:40:28Z` against the earlier source state. Current `origin/main` is `7172d3e8af37fadab5624ef155dbc9e6ef19a40c` (`2026-07-18T12:37:07Z`). After that base change, literal C16 and C17 omit the now-required `--log-file <path>`; `scripts/engine-integration.ts:90` and `scripts/real-e2e.ts:72` reject those commands, so the marker's expected exit 0 is unattainable as written.
- C17 requires `bun scripts/real-e2e.ts --preset real-e2e-minimal`, while current `CLAUDE.md:60` requires every v3 issue except #685 to state and follow: “本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行”.
- The marker's implementation route is not currently open: [#737](https://github.com/mouriya-s-lab/coder-loop/issues/737), [#739](https://github.com/mouriya-s-lab/coder-loop/issues/739), and [#743](https://github.com/mouriya-s-lab/coder-loop/issues/743) remain open with no closing PR; [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) remains open and PR [#749](https://github.com/mouriya-s-lab/coder-loop/pull/749) is unmerged (`c0a325e` is not an ancestor of current `origin/main`). The marker itself says verbatim: “If the source prerequisites below are not landed, report the blocker on #698 rather than publishing a mixed-issue PR.”
- Independently, current `AGENTS.md:197-213` forbids adding v3 implementation to `src/`/`scripts/` in this checkout, while the marker requires exactly that surface.

No implementation branch or PR was created and no product file was changed. Please re-enrich the executable contract after reconciling the current repository rule, dependency landing state, and the post-#751 command/verification boundary.



### comment #5014604951 by `RiriAgent` — 2026-07-19T05:49:19Z
_(last edited 2026-07-19T06:21:39Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698. Observed GraphQL `Issue.lastEditedAt`: `2026-07-18T06:19:38Z` (editor `RiriAgent`). The complete direct comment set was exhausted at two comments (`comments.pageInfo.hasNextPage=false`); there is no later direct operator correction to the task intent.
- Inherited parent: https://github.com/mouriya-s-lab/coder-loop/issues/546, observed `lastEditedAt` `2026-07-18T06:18:52Z`; all 13 comments were fetched (`hasNextPage=false`). Operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (closure-grained single activity), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure/resource and par-pin rules), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (drain/validator and immutable definition/run-time boundary).
- Scope handoff: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns production entry plus `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to #701.
- Re-enrichment trigger: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5012140382 proves the prior marker stale against current commands, verification policy, dependency state, and repository rules. This is a workflow correction, not new task intent.
- Local source inspected: `origin/main` at `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; the assigned checkout at `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to live dependency PR #749's head. Source, tests, `package.json`, `bunfig.toml`, `docs/test-boundaries.md`, public CLI help, runtime drivers, and v3 decision records were read locally rather than through GitHub blobs.

## Deliverable

`implementation-pr`

After every prerequisite in `Dependencies` is landed on the candidate base and the repository rule blocker is authoritatively resolved, create exactly one draft implementation PR whose body begins with `Closes #698`. The implementation must instantiate the immutable compiled runtime tree through the public daemon/CLI create path, schedule algebraically ready leaves for recursive `seq`/`par`, complete structural `drain`, consume only committed typed transitions, retire repo-slot/flat-phase scheduling, and delegate closure create/reopen/resume/single-activity/consume to the landed #560 API. It also owns first/nested par pins, metadata-sourced global/per-par limits, dependency gating, and failure containment named by the issue.

It must not implement #737's value/binding system, #739's declaration/compiler surface, #743's immutable-definition producer, #560's closure resource mechanism, #700's validator/join judgment, #701's correction/reopen and post-terminal reactivation, runtime append/materialization, cancellation, bundled-preset migration, GUI, deployment, or #684/#685 release validation. While any prerequisite remains unmet, iteration must report the live blocker on #698 and must not publish a mixed-issue implementation PR.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless stated otherwise, cwd is a clean candidate checkout based on a `main` that already contains every prerequisite, and env is local macOS with Bun/Git on `PATH`. Runtime roots, repositories, chain names, definition refs, runner shims, sockets, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 deliberately share one literal canonical command: execute it once at the exact candidate SHA, and use its separately labeled observations for each row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 public schema | Exit 0; public `chain create` plus `item add` instantiate the minimal immutable runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No test setup calls `createTaskTree` or writes SQLite. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path, and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; par has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity does not decide readiness or serialize the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal, then the outer seq advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closures | Exit 0; scheduler decisions delegate to landed #560 create, reopen, resume, deny-second-live-run, and never-spawn behavior respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open par and nested par over an origin-backed local Git fixture | Exit 0; outer pin persists before member-closure creation, all outer entry closures use that exact commit without per-member fetch, and nested par independently pins before inner closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and separate public cycle write | Exit 0; dependency gating is orthogonal to tree structure, restores the leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and drain completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup while using the same transition/tree scheduler; no second flat scheduling model remains. Final stdout contains an `issue-698.pass` record naming C01-C11, the exact source SHA, runtime UUID, and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches. Closure identity and active-run state replace repo-slot scheduling state; no renamed slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches. Recursive tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches. `recordRun` no longer lazily invents runtime tree nodes; public create owns instantiation. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every mutation and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics; traversal, readiness, dispatch, transition, and drain outcomes remain exhaustive ADTs with no open-string/cast escape. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, renamed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; that integrity-loss list must be empty. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |
| `-e '\bany\b' -e ' as (?!const)'` | changed | `rg --pcre2 -e '^\+.*\bany\b' -e '^\+.* as (?!const)' <(git diff --unified=0 origin/main...HEAD -- ':(glob)src/**/*.ts' ':(glob)scripts/**/*.ts' ':(glob)tests/**/*.ts')` must exit 1 with zero added-line matches. |

## Canonical runtime

- Setup: only after the dependency and repository-policy gates below are satisfied, use a clean candidate based on the resulting `origin/main`; run `bun install --frozen-lockfile`.
- Start: the target-mandated #698 driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots, deterministic runner shims, and starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`. It creates chains/items only through the public CLI. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime tree identity, and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed transition submission, status, and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. The exact-SHA CLI transcript is Layer 4 evidence for this non-UI project; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit beneath the issue evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its registered runtime root/worktrees/engine refs, and asserts no owned PID/socket/worktree/ref/runtime-root orphan remains. On failure it retains a named diagnostic root and reports it instead of deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because the issue body does not name it and its existing two-phase linear fixture does not exercise the new recursive behavior. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/contract coverage in `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, par overlap, drain, pins, limits, dependency gating, failure containment, and degenerate-seq compatibility. Existing assertions survive unless they encode the explicitly retired repo-slot serialization, flat runner-exit phase advancement, or lazy run-time tree materialization; replacements must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, renamed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass, and the driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Satisfied on current main:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675 and #678. Their task-tree persistence/status shape and runner authorization boundary are ancestors of current `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- **Unlanded closure mechanism:** https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open. Its only closing PR, https://github.com/mouriya-s-lab/coder-loop/pull/749, is open/ready, mergeable `MERGEABLE`/`CLEAN`, targets `main`, and currently has head `40c72f9222890d44eb90db8dcea272923c820e2d`, zero status checks, zero submitted reviews, and one pending review request. #698 must consume this API only after the merged #560 head is an ancestor of its base; it may not copy #749's diff.
- **Unlanded typed declaration path:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739, and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open with no closing PRs. #739 explicitly depends on #737 and blocks #698; #743 explicitly blocks #698. #698 must consume their landed public `exit.*` type flow, recursive task/path compile product, and immutable definition ref, without scheduler-private fallback schema, duplicate parser, untyped transition object, or current-file fallback.
- **Retired source issues:** https://github.com/mouriya-s-lab/coder-loop/issues/554#issuecomment-5007304203 transfers declaration/compiler work to #739, and https://github.com/mouriya-s-lab/coder-loop/issues/605#issuecomment-5007305290 transfers core definition-ref work to #743; both old issues closed without a PR and do not satisfy those prerequisites.
- **Repository-policy blocker:** current `AGENTS.md:197-213` says `src/`, `presets/`, `docs/`, and `scripts/` are v2-owned and forbids v3 implementation there, while #698 necessarily changes `src/`/`scripts/`. No live issue/PR currently supplies an exception or replacement rule. Iteration may begin implementation only after an operator-authoritative change on the candidate base removes/replaces that prohibition or places the work in an explicitly authorized implementation repository/branch; enrichment does not infer permission from prior contradictory commits.
- **Verified current source gap:** `src/daemon.ts:2167-2210` and `src/daemon.ts:2907-2945` create chain/item rows without instantiating the declared runtime tree; `src/sqlite-state.ts:1844-1868,2158-2202` lazily materializes a flat seq/closure from `recordRun`; `src/scheduler.ts:520-574,629-706,866-868,2841-2862` selects by repo slot and flat phase order; `src/daemon.ts:3288-3331` exposes phase exits without the future typed path object. `src/task-runtime.ts` and the SQLite task-tree API are persistence/status shapes to consume, not acceptance setup shortcuts.
- **Scope boundary:** #701 owns correction/reopen execution and post-terminal leaf reactivation. #700 owns validator/join judgment. Runtime par append/materialization, append-time no-repin, cancellation, bundled-preset migration, GUI, and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific daemon/CLI driver is the strongest local runtime path. Existing GitHub compatibility E2E is reserved to #685 as stated above.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5010453165



### comment #5014624732 by `RiriAgent` — 2026-07-19T05:57:50Z
_(last edited 2026-07-19T06:28:59Z)_

**[iteration] contract invalid @ 7172d3e** — `implementation-pr` has no legal candidate while its declared gates remain open

- [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) is open and [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) is not merged; #737, #739, and #743 are open with no closing PR.
- Fetched `origin/main` is `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; PR #749 head `40c72f9222890d44eb90db8dcea272923c820e2d` is not its ancestor.
- `origin/main:AGENTS.md:197-213` still forbids the required v3 changes under `src/` and `scripts/`.
- The current marker says not to publish a mixed-issue PR while any gate is unmet, but `implementation-pr` supplies no blocker/wait CandidateRef; iteration must finish with exactly one CandidateRef, and only review owns terminal `blocked`.

<details><summary>Contract evidence</summary>

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014604951

Verbatim marker demand: “While any prerequisite remains unmet, iteration must report the live blocker on #698 and must not publish a mixed-issue implementation PR.”

Live joins performed in `run-1784440290777-65-iteration-item-32`:

- #698 comment pagination exhausted; the current marker supersedes the minimized old marker and has no later operator correction.
- Structural closing-PR linkage is empty for #737/#739/#743; #560 links to open PR #749 and an older closed/unmerged PR.
- #698 has no linked PR and no sub-issues; the queue-selected item is exactly 698.
- `common/packets.md:9-31` requires exactly one CandidateRef and has no blocker variant; `common/state-contract.md:41-52` routes iteration contract defects through `contract_invalid` and reserves `blocked` for review.

No implementation, test, runtime, verification, or E2E action was started because the marker makes their prerequisite state false.

</details>



### comment #5014686656 by `RiriAgent` — 2026-07-19T06:21:31Z
_(last edited 2026-07-19T06:45:21Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698. Observed GraphQL body `lastEditedAt`: `2026-07-18T06:19:38Z` (editor `RiriAgent`); the complete direct comment set through https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014624732 was fetched with no pagination remainder.
- Inherited parent: https://github.com/mouriya-s-lab/coder-loop/issues/546, observed body `lastEditedAt` `2026-07-18T06:18:52Z`; all 13 comments and all 116 timeline items were fetched. Operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (closure-grained single activity), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closures and par-pin supply), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (drain/validator and immutable-definition boundary).
- Scope handoff: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public instantiation plus `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to #701.
- Re-enrichment evidence: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5012140382 corrected stale commands and the real-E2E boundary; https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014624732 records that the current dependency/policy state cannot yield an implementation CandidateRef. These comments are workflow evidence, not new task intent.
- Local source inspected: `origin/main` at `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned checkout at `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to live dependency PR #749's head. Source, tests, project rules, CLI help, package scripts, test boundaries, runtime drivers, and local v3 decision records were read from the checkout, not through GitHub blobs.

## Deliverable

`implementation-pr`

After the prerequisite and repository-policy gates in `Dependencies` are satisfied on the candidate base, create exactly one draft implementation PR whose body begins with `Closes #698`. Through the public daemon/CLI creation and completion surfaces, it must instantiate the immutable compiled runtime tree, schedule recursively ready leaves for structural `seq`/`par`, complete `drain`, consume only committed typed transitions, retire repo-slot/flat-phase scheduling, and delegate closure create/reopen/resume/single-activity/consume to the landed #560 API. It also owns first/nested par pins, metadata-sourced global/per-par limits, dependency gating, and failure containment named by the issue.

It must not implement #737's value/binding system, #739's declaration/compiler surface, #743's immutable-definition producer, #560's closure resource mechanism, #700's validator/join judgment, #701's correction/reopen and post-terminal reactivation, runtime append/materialization, cancellation, bundled-preset migration, GUI, deployment, or #684/#685 release validation. No alternate deliverable route is inferred from the current external blockers; queue/dependency repair is outside #698's implementation scope.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless stated otherwise, cwd is a clean candidate checkout based on a `main` that contains every prerequisite, and env is local macOS with Bun/Git on `PATH`. Runtime roots, fixture repositories, chain names, definition refs, runner shims, sockets, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command; execute it once at the exact candidate SHA and retain separately labeled observations for every row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 public schema | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path, and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; par has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity does not decide readiness or serialize the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal, then the outer seq advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closures | Exit 0; scheduler decisions delegate to landed #560 create, reopen, resume, deny-second-live-run, and never-spawn behavior respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open par and nested par over an origin-backed local Git fixture | Exit 0; outer pin persists before member-closure creation, all outer entry closures use that exact commit without per-member fetch, and nested par independently pins before inner closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and separate public cycle write | Exit 0; dependency gating is orthogonal to tree structure, restores the leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and drain completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through the same transition/tree scheduler. Final stdout contains an `issue-698.pass` record naming C01-C11, the exact source SHA, runtime UUID, and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; no repo-slot scheduling state or renamed repo-slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; `recordRun` no longer lazily invents runtime tree nodes. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every mutation and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, renamed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; that integrity-loss list must be empty. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: only after the dependency and repository-policy gates below are satisfied, use a clean candidate based on the resulting `origin/main` and run `bun install --frozen-lockfile`.
- Start: the target-mandated #698 driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots, deterministic runner shims, and starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`. It creates chains/items only through the public CLI; store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime tree identity, and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed transition submission, status, and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. The exact-SHA CLI transcript is Layer 4 evidence for this non-UI project; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit under the driver-reported evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its registered runtime root/worktrees/engine refs, and asserts no owned PID/socket/worktree/ref/runtime-root orphan remains. On failure it retains a named diagnostic root and reports it instead of deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear fixture does not exercise #698's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/contract coverage in `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, par overlap, drain, pins, limits, dependency gating, failure containment, and degenerate-seq compatibility. Existing assertions survive unless they encode the explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; replacements must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, renamed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass, and the driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Satisfied on current main:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675 and #678. Merge commits `9ac3b87d336a04a564a40fa3ce9163d361e86b40` and `9844e998639fbb4c19e32b4c037ba80ce7229630` are ancestors of current `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- **Unlanded closure mechanism:** https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open. Its active closing PR, https://github.com/mouriya-s-lab/coder-loop/pull/749, is open/ready, mergeable `true`/`clean`, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`, 58 issue comments, zero submitted reviews/review threads/check runs/status contexts, and one pending review request. That head is not an ancestor of current `origin/main`. #698 consumes this API only after it lands and must not copy or extend PR #749's diff.
- **Unlanded declaration/definition prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739, and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open with no closing PRs. #739 explicitly depends on #737 and `Blocks: #698`; #743 explicitly `Blocks: #698`. #698 consumes their landed typed `exit.*` flow, recursive task/path compile product, and immutable definition ref; it must not add a scheduler-private fallback schema, duplicate parser, untyped transition object, or current-file fallback.
- **Retired source issues:** https://github.com/mouriya-s-lab/coder-loop/issues/554#issuecomment-5007304203 transfers declaration/compiler work to #739, and https://github.com/mouriya-s-lab/coder-loop/issues/605#issuecomment-5007305290 transfers immutable-definition work to #743. Both old issues closed without an implementation PR and do not satisfy the new prerequisites.
- **Repository-policy conflict:** current `AGENTS.md:197-213` forbids v3 implementation under `src/`, `presets/`, `docs/`, and `scripts/`, while #698 necessarily changes `src/`/`scripts/`. Before implementation, an operator-authoritative rule on the candidate base must remove/replace that prohibition or explicitly identify an authorized implementation repository/branch. This contract does not treat earlier contradictory commits as permission.
- **Verified current source gap:** `src/loop.ts:780-875` compiles only a degenerate phase seq; `src/daemon.ts:2167-2229` and `src/daemon.ts:2895-2945` create chain/item rows without instantiating the declared runtime tree; `src/sqlite-state.ts:1844-1868,2158-2202` lazily materializes a flat seq/closure from `recordRun`; `src/scheduler.ts:506-574,586-706,866-868,2841-2862` selects by repo slot and flat phase order; `src/daemon.ts:3288-3331` exposes phase exits without the future typed path object. `src/task-runtime.ts` and the SQLite task-tree API are persistence/status shapes to consume, not acceptance setup shortcuts. `scripts/issue-698-integration.ts` does not yet exist.
- **Queue fact:** the live `v3-546` item for #698 has no dependency-wait record even though the GitHub prerequisites above are open. Queue/dependency repair belongs to the operator/orchestrator; #698 implementation must not absorb prerequisite scope to compensate.
- **Scope boundary:** #701 owns correction/reopen execution and post-terminal leaf reactivation; #700 owns validator/join judgment. Runtime par append/materialization, append-time no-repin, cancellation, bundled-preset migration, GUI, and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific daemon/CLI driver is the strongest runtime path. Compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014604951



### comment #5014703971 by `RiriAgent` — 2026-07-19T06:28:33Z
_(last edited 2026-07-19T06:51:25Z)_

**[iteration] contract invalid @ 40c72f9** — `implementation-pr` still has no legal CandidateRef under the marker's own gates

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014686656

Blocking contract contradiction:

- Deliverable says verbatim: “After the prerequisite and repository-policy gates in `Dependencies` are satisfied on the candidate base, create exactly one draft implementation PR”.
- It also says: “No alternate deliverable route is inferred from the current external blockers”.
- Live graph recheck: #560 is open and PR #749 (`40c72f9222890d44eb90db8dcea272923c820e2d`) is not in `origin/main`; #737, #739, and #743 are open with zero structural closing PRs.
- Live policy recheck: `AGENTS.md:197-213` still forbids v3 implementation in `src/`/`scripts/`, while #698 necessarily changes both.

Therefore this phase cannot produce the required `implementation-pr` CandidateRef without absorbing explicitly excluded prerequisites or violating repository policy. Contract-enrichment must supply an executable route only after those gates land (and queue dependency/policy routing is repaired), or declare an authorized non-implementation route; iteration must not invent either.

<details><summary>Evidence</summary>

- `origin/main`: `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`
- #560 closing refs: closed draft PR #690 plus open ready PR #749; pagination exhausted.
- #737/#739/#743 closing refs: empty; pagination exhausted.
- #698 closing refs: empty; pagination exhausted.
- Base still contains `ensureRuntimeClosure`, flat phase-plan selectors, and `schedulerSlotKey`, so the prerequisites are substantive rather than stale labels.
- Full local evidence: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784442169523-67-iteration-item-32-research.md`

</details>



### comment #5014745693 by `RiriAgent` — 2026-07-19T06:45:05Z
_(last edited 2026-07-19T07:03:24Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). The complete six-comment set was fetched with pagination exhausted. No later operator-intent comment is used: all non-marker comments on #698 are phase-generated contract-invalid reports. The latest execution-fact report is https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014703971.
- Inherited contract: https://github.com/mouriya-s-lab/coder-loop/issues/546, observed body `lastEditedAt` `2026-07-18T06:18:52Z`; scope handoff https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public instantiation plus `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to #701.
- Local source inspected without GitHub blobs: current `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned checkout `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to live dependency PR #749's head; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` at local `main` `9ac3b87d336a04a564a40fa3ce9163d361e86b40` with its `origin/main` refreshed to `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`. Source, tests, package scripts, runtime drivers, target rules and the central state read surface were inspected locally.

## Deliverable

`implementation-pr`

Produce exactly one draft implementation PR targeting `main`, with body first line `Closes #698`, from the first candidate base that contains the prerequisite contracts and is authorized by the target repository policy recorded in `Dependencies`. The PR must make the public daemon/CLI create path instantiate the immutable compiled runtime tree, recursively schedule the ready leaves of structural `seq`/`par`, complete `drain`, consume only committed typed transitions, retire repo-slot/flat-phase scheduling, and delegate closure create/reopen/resume/single-activity/consume to the landed #560 API. It owns first/nested-par pin ordering, metadata-sourced global/per-par limits, dependency gating, failure containment and degenerate-seq compatibility named by the issue.

It must not implement #737's value/binding system, #739's declaration/compiler surface, #743's immutable-definition producer, #560's closure resource mechanism, #700's validator/join judgment, #701's correction/reopen or post-terminal reactivation, runtime append/materialization, cancellation, bundled-preset migration, GUI, deployment, or #684/#685 release validation. The currently open prerequisites and repository-policy prohibition are external blockers, not authorization to reinterpret this implementation issue as `blocker-removal`, `spike-comment`, or `source-writing-spike`, and not authorization to absorb prerequisite diffs into the #698 PR.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean candidate checkout at the exact PR head, based on a `main` that contains the prerequisites below, with Bun and Git on `PATH`. Runtime roots, Git fixtures, chain names, definition refs, runner shims, sockets, logs and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command; execute it once and retain separately labeled observations for every row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 public schema | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; par has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity does not decide readiness or serialize the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal, then the outer seq advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run and consumed closures | Exit 0; scheduler decisions delegate to landed #560 create, reopen, resume, deny-second-live-run and never-spawn behavior respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open par and nested par over an origin-backed local Git fixture | Exit 0; outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and nested par independently pins before inner closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and separate public cycle write | Exit 0; dependency gating is orthogonal to tree structure, restores the leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and drain completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability and cleanup through the same transition/tree scheduler. Final stdout contains an `issue-698.pass` record naming C01-C11, the exact source SHA, runtime UUID and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; no repo-slot scheduling state or renamed repo-slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; `recordRun` no longer lazily invents runtime tree nodes. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every mutation and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened tests, whose integrity-loss list must be empty; separately enumerate any marker-authorized old-name → equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use a clean candidate based on an authorized `main` containing all prerequisite implementations below, then run `bun install --frozen-lockfile`.
- Start: the issue-specific real-process driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through the public CLI. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed transition submission, status and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown and process exit under the driver-reported evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its registered runtime root/worktrees/engine refs, and asserts no owned PID/socket/worktree/ref/runtime-root orphan remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not exercise #698's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/contract coverage under `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, par overlap, drain, pins, limits, dependency gating, failure containment and degenerate-seq compatibility. Existing assertions survive unless they encode the explicitly retired repo-slot serialization, runner-exit/flat-phase advancement or lazy run-time tree materialization; replacements must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Satisfied completion-protocol foundation:** https://github.com/mouriya-s-lab/coder-loop/issues/451 and https://github.com/mouriya-s-lab/coder-loop/issues/452 are closed by merged PRs #491 and #500. They establish typed phase-exit query/write selection and make admitted state writing—not runner stdout/exit—the existing completion authority that #698 extends to committed transitions.
- **Satisfied persistence/authorization foundation:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675 and #678; their merged commits are ancestors of current `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- **Unlanded closure mechanism:** https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open. Its active closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, ready, mergeable `true`/`clean`, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`, which is not an ancestor of `origin/main`. Pagination found 58 PR comments, zero submitted reviews, zero review threads/check runs/status contexts and one pending review request. The latest report https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 requests changes for one lifecycle/consumption-evidence mechanism. #698 consumes the landed #560 API and must not copy its open diff.
- **Unlanded declaration/definition prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739 and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open with no closing PRs. #739 explicitly depends on #737 and `Blocks: #698`; #743 explicitly `Blocks: #698`. #698 consumes their typed `exit.*` flow, recursive task/path compile product and immutable definition ref; it must not add a scheduler-private fallback schema, duplicate parser, untyped transition object or current-file fallback.
- **Retired source issues:** https://github.com/mouriya-s-lab/coder-loop/issues/554#issuecomment-5007304203 transfers declaration/compiler work to #739, and https://github.com/mouriya-s-lab/coder-loop/issues/605#issuecomment-5007305290 transfers immutable-definition work to #743. Both old issues closed without an implementation PR and do not satisfy the new prerequisites.
- **Repository-policy blocker:** both the assigned checkout and target checkout carry `AGENTS.md:197-213`, which forbids v3 implementation under `src/`, `presets/`, `docs/` and `scripts/`, while #698 necessarily changes `src/` and `scripts/`. No later operator-authoritative override was found. Before implementation, the authorized candidate base must remove/replace that prohibition or identify a separate authorized implementation repository/branch. This marker does not treat PR #749's contradictory implementation history as permission.
- **Verified current source gap:** `src/loop.ts:780-875` compiles only a degenerate phase seq; `src/daemon.ts:2167-2229` and `src/daemon.ts:2895-2945` create chain/item rows without instantiating the declared runtime tree; `src/sqlite-state.ts:1844-1868,2158-2202` lazily materializes a flat seq/closure from `recordRun`; `src/scheduler.ts:506-574,586-706,866-868,2841-2862` selects by repo slot and flat phase order; `src/daemon.ts:3288-3331` exposes phase exits without the future typed path object. `src/task-runtime.ts` and the SQLite task-tree API are persistence/status shapes to consume, not acceptance setup shortcuts. `scripts/issue-698-integration.ts` does not exist.
- **Central-queue blocker:** `coder-loop item list v3-546 --json` shows #698 with no `dependsOn` record even though the GitHub prerequisites above are open; #560 is `exhausted`, not successful. `coder-loop status /Users/mouriya/Ext/work/coder-loop-v3/issue-546 --json` therefore selects #698 at `contract_invalid` instead of holding it for dependencies. Dependency-wait/queue repair is an operator/orchestrator action outside #698's implementation scope and cannot be replaced by contract route invention.
- **Scope boundary:** #701 owns correction/reopen execution and post-terminal leaf reactivation; #700 owns validator/join judgment. Runtime par append/materialization, append-time no-repin, cancellation, bundled-preset migration, GUI and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC or new secret is required. The issue-specific daemon/CLI driver is the strongest runtime path. Compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014686656



### comment #5014762698 by `RiriAgent` — 2026-07-19T06:51:24Z

**[iteration] contract invalid @ 40c72f9** — current `implementation-pr` route has no legal CandidateRef

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014745693

The marker is the unique current marker, but its route remains unexecutable:

- It declares only `implementation-pr` and forbids reinterpreting the blockers as `blocker-removal`, `spike-comment`, or `source-writing-spike`.
- #560 is still open; its open PR #749 is at `40c72f9222890d44eb90db8dcea272923c820e2d`, which is not an ancestor of current `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- #737, #739, and #743 are still open with zero structural closing PRs and exhausted pagination.
- The checked-in repository rule `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still prohibits this v3 implementation under `src/` and `scripts/`; no later operator-authoritative override exists in the complete seven-comment issue record.
- #698 has no structural closing PR, so there is no existing candidate to resume.

Producing a PR now would either absorb prerequisites the marker explicitly excludes or violate repository policy. Contract-enrichment must wait for/encode an authorized base containing the prerequisites and an authorized implementation location, or declare a different deliverable; iteration cannot invent either route.

<details><summary>Evidence</summary>

- `queue.selected.id=698`, item status `contract_invalid`, state read succeeded.
- #560 closing refs: closed draft PR #690 and open PR #749; pagination exhausted.
- #737/#739/#743 closing refs: empty; pagination exhausted.
- #698 closing refs: empty; pagination exhausted.
- Local evidence: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784443623214-70-iteration-item-32-research.md`

</details>



### comment #5014796514 by `RiriAgent` — 2026-07-19T07:03:23Z
_(last edited 2026-07-19T09:05:43Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). Pagination is exhausted for the complete eight-comment set and 25 timeline items. There are no later operator-intent comments on #698; the non-marker comments are phase-generated contract-invalid reports. The latest execution-fact report used is https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014762698.
- Inherited intent: https://github.com/mouriya-s-lab/coder-loop/issues/546, including operator-decision comments https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885, https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406, and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021. Scope handoff https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public instantiation plus `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to #701.
- Local source inspected without GitHub blobs: `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned checkout `40c72f9222890d44eb90db8dcea272923c820e2d` (live dependency PR #749 head); target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` at `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Target rules, package scripts, daemon/CLI entry points, scheduler/runtime persistence, tests, real-process drivers, central queue state, linked PR metadata, reviews, threads and checks were read locally or through complete metadata snapshots.

## Deliverable

`blocker-removal`

The named blocked path is the one stated by #698: the public daemon/CLI create path cannot yet instantiate a minimal immutable runtime tree, and the scheduler still cannot execute structural `seq`/true-concurrent `par`/`drain` from committed typed transitions. The issue body explicitly records `Blocks: #700, #702, #704, #705, #706`; the minimum success condition is that C01-C11 pass through the public runtime path, after which those consumers have the scheduler/runtime substrate they declare.

This is a PR-backed unblock route when its prerequisites are available: create exactly one draft PR targeting `main`, with body first line `Closes #698`, implementing only #698's public instantiation and scheduling slice. It must not absorb #560, #737, #739 or #743, invent a scheduler-private fallback schema, or weaken the checked-in repository policy. While the prerequisite implementations or an authorized v3 implementation location remain unavailable, `resolve-blocker` must record that concrete missing access and use its planning-stage exception; it must not fabricate a CandidateRef or publish a mixed-scope PR. Review owns the resulting blocked/retry classification.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless stated otherwise, cwd is a clean candidate checkout at the exact PR head, based on an authorized `main` containing the prerequisite implementations below, with Bun and Git on `PATH`. Runtime roots, Git fixtures, chain names, definition refs, runner shims, sockets, logs and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command; run it once and retain separately labeled observations for every row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | blocked-path | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 public schema | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. This is the mandatory replay proving the path blocking #700/#702/#704/#705/#706 is removed. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; par has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity does not decide readiness or serialize the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal, then the outer seq advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run and consumed closures | Exit 0; scheduler decisions delegate to the landed #560 create, reopen, resume, deny-second-live-run and never-spawn behavior respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open par and nested par over an origin-backed local Git fixture | Exit 0; outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and nested par independently pins before inner closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and separate public cycle write | Exit 0; dependency gating is orthogonal to tree structure, restores the leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and drain completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability and cleanup through the same transition/tree scheduler. Final stdout contains an `issue-698.pass` record naming C01-C11, exact source SHA, runtime UUID and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; no repo-slot scheduling state or renamed repo-slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; run recording no longer lazily invents runtime tree nodes. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every mutation and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened tests, whose integrity-loss list must be empty; separately enumerate any authorized old-name to equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use a clean candidate based on an authorized `main` containing all prerequisite implementations below, then run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through the public CLI. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed transition submission, status and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown and process exit under the driver-reported evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its registered runtime root/worktrees/engine refs, and asserts no owned PID/socket/worktree/ref/runtime-root orphan remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not exercise #698's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/contract coverage under `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, par overlap, drain, pins, limits, dependency gating, failure containment and degenerate-seq compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement or lazy run-time tree materialization; replacements must preserve the original safety property while proving stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Satisfied protocol/persistence foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/451, https://github.com/mouriya-s-lab/coder-loop/issues/452, https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #491, #500, #675 and #678. Their closing-reference pagination is exhausted.
- **Unlanded closure mechanism:** https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open. Its active closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, ready, mergeable `true`/`clean`, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`, which is not in `origin/main`. Complete PR metadata contains 58 issue comments, zero submitted reviews, zero review comments/threads, zero check runs/status contexts and one pending review request. Latest diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 requests one lifecycle/consumption-evidence correction. #698 consumes the landed #560 API and must not copy its open diff.
- **Unlanded declaration/definition prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739 and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open with zero structural closing PRs and exhausted pagination. #739 declares it blocks #698; #698 consumes their typed binding flow, recursive compiled task/path product and immutable definition ref.
- **Repository-policy blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored in `AGENTS.md`, prohibits v3 implementation under `src/`, `presets/`, `docs/` and `scripts/`. #698 necessarily changes `src/` and `scripts/`; no later operator-authoritative override was found. An authorized candidate base must remove/replace that prohibition or identify a separate authorized implementation repository/branch.
- **Verified current source gap:** `src/sqlite-state.ts` still contains `ensureRuntimeClosure`; `src/scheduler.ts` still contains `SchedulerSlot`, `SchedulerPhasePlan`, flat phase selection and repo-slot scheduling; `scripts/issue-698-integration.ts` does not exist. Public task-tree setup and committed typed-transition scheduling are therefore not already satisfied on base or on PR #749's head.
- **Central-queue fact:** `coder-loop item list v3-546 --json` shows #698 selected at `contract_invalid` with no `dependsOn` record while #560 is `exhausted`; #737/#739/#743 are not present in this chain. Queue repair is operator/orchestrator work outside #698 and this phase, not permission to absorb prerequisite scope.
- **Scope boundary:** #701 owns correction/reopen and post-terminal leaf reactivation; #700 owns validator/join judgment. Runtime par append/materialization, cancellation, bundled-preset migration, GUI and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC or new secret is required. The issue-specific daemon/CLI driver is the strongest runtime path. Compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014745693



### comment #5014811396 by `RiriAgent` — 2026-07-19T07:08:53Z

**[iteration] blocker remains @ 40c72f9** — planning-stage exception; no legal #698 candidate exists yet

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014796514 (`Deliverable=blocker-removal`).
- Live blockers: #560 is still unmerged at PR #749 head `40c72f9`; #737/#739/#743 remain open with zero structural closing PRs; checked-in policy still forbids the required v3 changes under `src/`/`scripts/`.
- Current-path proof: C12/C13/C14 searches still find repo-slot scheduling, flat phase selection, and `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent, so C01–C11 cannot be replayed on a legal candidate.
- Per the marker, this iteration used the planning-stage exception. It made no code/branch/PR/runtime change and did not fabricate CandidateRef; review owns the blocked/retry classification.

<details><summary>Scoping and future replay</summary>

The issue has no literal `Unblocks:` back-link; its body instead declares that it blocks #700/#702/#704/#705/#706. Once #560/#737/#739/#743 are landed and an authorized v3 implementation location exists, the smallest #698 change is the public daemon/CLI instantiation plus recursive transition/tree scheduler slice named by the marker, excluding all prerequisite implementations and later-child scope.

The required replay is `bun scripts/issue-698-integration.ts`, retaining separately labeled C01–C11 observations from the real daemon/socket and public CLI path. Landing checks then run C12–C18; this issue explicitly does not run `bun scripts/engine-integration.ts` or `bun scripts/real-e2e.ts`.

Local evidence: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784444660348-73-iteration-item-32-resolve-blocker.md`

</details>



### comment #5014873004 by `RiriAgent` — 2026-07-19T07:31:28Z

**[verification] changes requested @ no-candidate** — 0/0 checks executed; CandidateRef is missing

- `candidate-ref` — expected: one parseable `coder-loop:candidate-ref` bound to a structural closing PR or a no-PR issue comment; observed: the structural GraphQL join returned 0 PRs and all 10 issue comments contain no CandidateRef.
- Current contract marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014796514.
- Without an immutable SHA/digest, revision join and materialization are forbidden; no C01–C19 command was run against an unbound checkout.

<details><summary>Independent input observations</summary>

- Command: `gh issue view 698 -R mouriya-s-lab/coder-loop --json title,body,comments,state,url`
  - Exit: `0`
  - Observed: 10 complete issue comments; five executable-contract markers form a supersession chain ending at comment `5014796514`; no comment contains `coder-loop:candidate-ref`.
  - Artifact: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/step1-issue.json`
- Command: `gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100){nodes{number url state isDraft headRefName headRefOid body}}}}}' -F owner=mouriya-s-lab -F name=coder-loop -F number=698`
  - Exit: `0`
  - Observed: `closedByPullRequestsReferences.nodes = []`.
  - Artifact: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/step1-linked-prs.json`

No `coder-loop:verification-packet` block is emitted because its required `candidate` field must reproduce a consumed CandidateRef verbatim, and none exists. Iteration must publish a legal CandidateRef before verification can bind and execute the contract.

</details>



### comment #5014890134 by `RiriAgent` — 2026-07-19T07:37:50Z

**[iteration] contract invalid @ 40c72f9** — planning-stage exception cannot produce the CandidateRef required by the next phase

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014796514 (`Deliverable=blocker-removal`). It says that while prerequisites or an authorized v3 location remain unavailable, iteration “must not fabricate a CandidateRef or publish a mixed-scope PR.”
- Latest verification: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014873004 rejected that permitted planning-stage output because CandidateRef was absent and requires iteration to publish one before verification can execute.
- Live state still makes every truthful CandidateRef variant unavailable: #560/PR #749 is unmerged; #737/#739/#743 are open; checked-in policy still forbids the required `src/`/`scripts/` v3 implementation; current source still fails marker assumptions C12-C14 and has no `scripts/issue-698-integration.ts`.

Re-enrichment must choose an executable route: either hold iteration until the named prerequisites and authorized implementation location exist, or define a truthful no-PR candidate/verification packet for the planning-stage exception. Repeating the current route can only oscillate between “do not fabricate CandidateRef” and “CandidateRef required.”

<details><summary>Current-path evidence</summary>

- `origin/main`: `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- PR #749 head: `40c72f9222890d44eb90db8dcea272923c820e2d`; not an ancestor of `origin/main`.
- Issue states: #560/#737/#739/#743 all `OPEN`.
- C12/C13/C14 searches exit `0` with forbidden scheduler-slot, flat-phase and lazy-runtime symbols; canonical driver existence probe exits `1`.
- Local report: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784446423364-5-iteration-item-32-research/resolve-blocker-report.md`.

</details>



### comment #5014917034 by `RiriAgent` — 2026-07-19T07:47:14Z
_(last edited 2026-07-19T09:05:44Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). The complete current snapshot has 12 comments and 29 timeline items with `hasNextPage=false`; no attachment URLs are present. The body asks for one implementation outcome: instantiate a minimal runtime tree through the public daemon/CLI path and schedule committed-transition-driven `seq` / true-concurrent `par` / `drain`.
- Later execution corrections used: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014873004 proves verification cannot consume a planning note without a CandidateRef; https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014890134 requires re-enrichment to remove that contradiction. These comments correct the packet route, not the implementation intent.
- Inherited intent: https://github.com/mouriya-s-lab/coder-loop/issues/546 and the scope handoff at https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124. Public instantiation plus structural `seq` / `par` / `drain` scheduling belongs to #698; post-terminal leaf reactivation belongs to #701.
- Local source inspected without GitHub blobs: `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned checkout and live #560 PR head `40c72f9222890d44eb90db8dcea272923c820e2d`; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` at `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. `AGENTS.md`, `CLAUDE.md`, `package.json`, `docs/test-boundaries.md`, public CLI/daemon entry points, scheduler, task runtime, SQLite store, issue-specific drivers, tests, linked issue/PR metadata, reviews, threads and checks were inspected.

## Deliverable

`implementation-pr`

After every prerequisite in `Dependencies` is landed on an authorized `main`, create exactly one draft implementation PR targeting `main`, with body first line `Closes #698`. The PR implements only public daemon/CLI runtime-tree instantiation and scheduler consumption of the landed compiled task/path/closure contracts: structural `seq`, true-concurrent `par`, `drain`, committed-transition advancement, closure-keyed dispatch, pins, limits and dependency gating.

Do not absorb #560, #737, #739 or #743; do not introduce a scheduler-private fallback schema; do not implement #700 validator judgment, #701 correction/reopen, runtime append/materialization, cancellation, bundled-preset migration, GUI or release-wide compatibility. An unmet prerequisite is not a `no-change`, `comment-delivery`, or planning-stage CandidateRef. The chain must hold iteration until the prerequisite and repository-policy conditions are true; this marker does not authorize a mixed-scope stacked PR.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless stated otherwise, cwd is a clean candidate checkout at the exact PR head, based on an authorized `main` containing the prerequisite implementations, with Bun and Git on `PATH`. Runtime roots, fixture repositories, chain names, definition refs, runner shims, sockets, logs and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command; run it once and retain separately labeled observations for every row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 public declaration and binding surface | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal, then the outer seq advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run and consumed closures | Exit 0; scheduler decisions delegate to the landed #560 create, reopen, resume, deny-second-live-run and never-spawn behaviors respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open `par` and nested `par` over an origin-backed local Git fixture | Exit 0; the outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and the nested `par` independently pins before inner-closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; `par` of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating is orthogonal to tree structure, restores a not-yet-advanced leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain `par` with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate `seq` | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability and cleanup through the single transition/tree scheduler. Final stdout contains an `issue-698.pass` record naming C01-C11, exact source SHA, runtime UUID and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; no repo-slot scheduling state or renamed repo-slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive task-tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; run recording consumes an already-created closure identity and never materializes a runtime tree node lazily. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, mutation and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened tests, whose integrity-loss list must be empty; separately enumerate any authorized old-name to equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use a clean candidate based on an authorized `main` containing every prerequisite listed below, then run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through the public CLI. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed-transition submission, status and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown and process exit under the driver-reported evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its owned runtime root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref or runtime root remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not exercise this issue's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, `par` overlap, `drain`, pins, limits, dependency gating, failure containment and degenerate-`seq` compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement or lazy run-time tree materialization; replacements must preserve the original safety property while proving stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675 and #678 and are present on `origin/main`. The existing compiled product is still only the degenerate phase sequence (`src/loop.ts` on `origin/main`), so their presence does not satisfy #698.
- **Closure prerequisite not landed:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its only closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`, which is not in `origin/main`. Complete metadata has 58 issue comments, zero submitted reviews, zero review threads/comments, zero check runs/status contexts and one pending review request. #698 consumes the landed #560 closure API; it does not copy PR #749's 24-file diff.
- **Declaration/definition prerequisites not landed:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739 and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open, each with zero structural closing PRs and exhausted pagination. #698 consumes their typed binding flow, recursive compiled task/path product and immutable definition ref.
- **Repository-policy prerequisite:** `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently prohibits v3 implementation under `src/`, `presets/`, `docs/` and `scripts/`. #698 necessarily changes `src/` and `scripts/`. Before iteration, an operator-authoritative repository change must remove/replace that prohibition or identify a separate authorized implementation repository/branch; this marker does not override it.
- **Verified source gap:** on `origin/main`, `src/scheduler.ts` still contains repo-slot scheduling plus `SchedulerPhasePlan`/flat phase selection, `src/sqlite-state.ts` still invokes `ensureRuntimeClosure`, and `scripts/issue-698-integration.ts` does not exist. The issue is not already satisfied, and #698 has no linked closing PR.
- **Queue hold required:** `coder-loop item list v3-546 --json` currently shows #698 at `contract_invalid` with no `dependsOn` record; #560 is `exhausted`; #737/#739/#743 are absent from the chain. That queue state is why iteration ran before the source dependencies were available. Dependency/queue repair is orchestrator/operator work outside the #698 implementation diff. Until the preceding dependency and policy facts become true, iteration cannot truthfully publish any CandidateRef.
- **Scope boundary:** #701 owns correction/reopen and post-terminal leaf reactivation; #700 owns validator/join judgment. Runtime `par` append/materialization, cancellation, bundled-preset migration, GUI and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path; compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014796514



### comment #5014930231 by `RiriAgent` — 2026-07-19T07:52:11Z
_(last edited 2026-07-19T08:12:37Z)_

**[iteration] contract invalid @ 7172d3e** — marker requires queue hold, but #698 was spawned before its gates landed

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014917034

The marker's exact delivery precondition is “After every prerequisite in `Dependencies` is landed on an authorized `main`”, and it says “The chain must hold iteration until the prerequisite and repository-policy conditions are true.” Live state still contradicts both conditions:

- #560 is open; PR #749 is open/unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d` and is absent from `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`.
- #737, #739, and #743 are open with zero structural closing PRs and exhausted pagination.
- `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids the required v3 changes under `src/` and `scripts/`.
- `origin/main` still contains `SchedulerSlot`, `SchedulerPhasePlan`/flat selection, and `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` does not exist.
- The queue nevertheless selected #698 in `iteration`; item state has no dependency record, #560 is `exhausted`, and #737/#739/#743 are absent.

No CandidateRef can truthfully be published: the marker explicitly rejects no-change, comment-delivery, planning CandidateRef, and a mixed-scope stacked PR while these facts remain false. Required correction: keep #698 outside iteration until the named source and policy prerequisites are true, or enrich the runtime contract/queue dependency mechanism so a conditional `implementation-pr` marker is not scheduled prematurely. No product or test files were changed.



### comment #5014968058 by `RiriAgent` — 2026-07-19T08:06:06Z
_(last edited 2026-07-19T08:24:39Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). The exhausted snapshot has 14 comments (`comments.pageInfo.hasNextPage=false`), 31 timeline items (`timelineItems.pageInfo.hasNextPage=false`), zero structural closing PRs, and no body/comment attachment URLs.
- Later execution corrections used: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014890134 identifies the CandidateRef/conditional-gate contradiction; https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014930231 records the latest required correction: #698 must remain outside iteration until its source/policy gates land or the queue dependency mechanism is repaired. These comments change readiness/routing facts, not the requested implementation outcome.
- Inherited intent: https://github.com/mouriya-s-lab/coder-loop/issues/546 and the superseded scope source https://github.com/mouriya-s-lab/coder-loop/issues/559. Public instantiation plus committed-transition-driven structural `seq`, true-concurrent `par`, and `drain` belongs to #698; validator judgment belongs to https://github.com/mouriya-s-lab/coder-loop/issues/700 and correction/reopen including post-terminal reactivation belongs to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Local source inspected without GitHub blobs: fetched `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned checkout and live #560 PR head `40c72f9222890d44eb90db8dcea272923c820e2d`; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` at `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. `AGENTS.md`, `CLAUDE.md`, `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, relevant tests and drivers, the complete referenced issue snapshots, and PR #749 metadata/comments/reviews/threads/checks were read locally.

## Deliverable

`implementation-pr`

Create exactly one draft implementation PR targeting `main`, with body first line `Closes #698`. It implements public daemon/CLI runtime-tree instantiation and scheduler consumption of the landed compiled task/path/closure contracts: structural `seq`, true-concurrent `par`, `drain`, committed-transition advancement, closure-keyed dispatch, first-expansion pins, declared limits, and dependency gating.

This route is not presently ready: iteration must not create a CandidateRef, mutate PR #749, duplicate prerequisite diffs, or publish a mixed-scope stacked PR until every blocking fact in `Dependencies` is cleared and #698 is selected from an authorized base. The marker does not turn a pending dependency into `no-change`, `comment-delivery`, `spike-comment`, `source-writing-spike`, or `blocker-removal`; the issue body remains an implementation request. #560/#737/#739/#743 implementations, #700 validator judgment, #701 correction/reopen, runtime append/materialization, cancellation, bundled-preset migration, GUI, and release-wide compatibility remain out of scope.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless stated otherwise, cwd is a clean exact-head candidate based on an authorized `main` that already contains every prerequisite in `Dependencies`, with Bun and Git on `PATH`. Runtime roots, fixture repos, chain names, definition refs, runner shims, sockets, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command; run it once and retain separately labeled observations for every row.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; fixture uses the landed #737/#739/#743 declaration, binding, path and immutable-definition surface | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the expected definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path, and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal; the outer seq then advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closures | Exit 0; scheduler decisions delegate to the landed #560 create, reopen, resume, deny-second-live-run, and never-spawn behaviors respectively. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open `par` and nested `par` over an origin-backed local Git fixture | Exit 0; the outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and the nested `par` independently pins before inner-closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; `par` of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absent global declaration adds no engine default cap. Limit values come only from compiled metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating is orthogonal to tree structure, restores a not-yet-advanced leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain `par` with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate `seq` | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through the single transition/tree scheduler. Final stdout contains an `issue-698.pass` record naming C01-C11, exact source SHA, runtime UUID, and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; no repo-slot scheduling state or renamed repo-slot decision path remains. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive task-tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; run recording consumes an already-created closure identity and never lazily materializes a runtime node. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, mutation, and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests, whose integrity-loss list must be empty; separately enumerate any old-name to equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C19 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use a clean candidate based on an authorized `main` containing every prerequisite listed below, then run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled definition/task/path fixtures, loop-data/evidence roots, and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add`. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed-transition submission, status, and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: record source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit under the driver-reported evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its owned runtime root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not exercise this issue's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**` and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, `par` overlap, `drain`, pins, limits, dependency gating, failure containment, and degenerate-`seq` compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675 and #678 and are present on `origin/main`. Historical source issues #554 and #605 are closed; their current implementation successors are #739 and #743.
- **Closure prerequisite not landed:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its current closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`, which is not in `origin/main`. Exhausted metadata shows 58 issue comments, zero submitted reviews, zero review threads/comments, zero check runs/status contexts, and one pending review request. #698 consumes the landed #560 closure API; it does not modify PR #749 or copy its 36-commit/24-file implementation into a second PR.
- **Declaration/definition prerequisites not landed:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739, and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open, each with zero structural closing PRs and exhausted pagination. #698 consumes their typed binding flow, recursive compiled task/path product, and immutable definition ref.
- **Repository-policy prerequisite:** `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently prohibits v3 implementation under `src/`, `presets/`, `docs/`, and `scripts/`. #698 necessarily changes `src/` and `scripts/`. An operator-authoritative repository change must remove/replace that prohibition or identify a separate authorized implementation checkout before iteration; this marker cannot override it.
- **Verified source gap:** on `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`, `src/scheduler.ts` still contains repo-slot scheduling plus `SchedulerPhasePlan`/flat phase selection, `src/sqlite-state.ts` still invokes `ensureRuntimeClosure`, and `scripts/issue-698-integration.ts` does not exist. #698 is not already satisfied and has no linked closing PR.
- **Queue dependency gap:** `coder-loop item list v3-546 --json` shows #698 at `contract_invalid` with no `dependsOn` record; #560 is `exhausted`; #737/#739/#743 are absent from the chain. The latest correction at https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014930231 requires #698 to remain outside iteration until the source/policy gates are true or the queue dependency mechanism is repaired. Queue repair is operator/orchestrator work outside the #698 product diff; contract enrichment must not fabricate authority to perform it.
- **Scope boundary:** #700 owns validator/join judgment; #701 owns correction/reopen and post-terminal leaf reactivation. Runtime `par` append/materialization, cancellation, bundled-preset migration, GUI, and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path; compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014917034



### comment #5014985212 by `RiriAgent` — 2026-07-19T08:12:25Z

**[iteration] contract invalid @ 7172d3e** — #698 was selected before its declared source and policy gates cleared

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014968058
- Fresh source join: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`
- Blocking state: #560 remains open with unmerged PR #749; #737/#739/#743 remain open with no closing PRs; the repository policy still prohibits this v3 implementation under `src/` and `scripts/`.
- Queue mismatch: #698 is selected with no `dependsOn`; #560 is `exhausted`; #737/#739/#743 are absent.
- Required correction: keep #698 outside iteration until every marker dependency and the repository-policy gate are satisfied, or repair the runtime contract/queue dependency mechanism so the conditional `implementation-pr` route cannot be scheduled early.

<details><summary>Evidence and task outcome</summary>

The marker requires `implementation-pr` but says verbatim: “This route is not presently ready: iteration must not create a CandidateRef, mutate PR #749, duplicate prerequisite diffs, or publish a mixed-scope stacked PR until every blocking fact in `Dependencies` is cleared and #698 is selected from an authorized base.”

A fresh GitHub structural read found #560 open with PR #749 open at `40c72f9222890d44eb90db8dcea272923c820e2d`; #737, #739, and #743 are open with zero closing PRs. A fresh fetch left `origin/main` at `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; that base still contains `SchedulerSlot`, `SchedulerPhasePlan`, and `ensureRuntimeClosure`, and does not contain `scripts/issue-698-integration.ts`. `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids v3 implementation in the required paths.

No product or test files changed. No CandidateRef was created because every candidate variant other than the currently gated `implementation-pr` is explicitly forbidden by the marker.

</details>



### comment #5015019578 by `RiriAgent` — 2026-07-19T08:24:38Z
_(last edited 2026-07-19T08:40:17Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). The exhausted pre-publication snapshot has 16 comments (`comments.pageInfo.hasNextPage=false`), 33 timeline items, zero closing PRs, zero sub-issues, parent https://github.com/mouriya-s-lab/coder-loop/issues/546, and no body/comment attachment URLs.
- Operator comments used: none. The issue has no later operator comment changing its body intent; prior `contract invalid` and phase comments are execution records, not task-authority substitutions.
- Inherited intent sources: https://github.com/mouriya-s-lab/coder-loop/issues/546 and the incorporated historical scope source https://github.com/mouriya-s-lab/coder-loop/issues/559. #698 owns public runtime-tree instantiation plus committed-transition-driven structural `seq`, true-concurrent `par`, and `drain`; validator judgment remains with https://github.com/mouriya-s-lab/coder-loop/issues/700 and correction/reopen including post-terminal reactivation remains with https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Local source inspected without GitHub blobs: fetched `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Read surfaces include `AGENTS.md`, `CLAUDE.md`, `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, current unit/integration drivers, the complete #698 body/comments/timeline, and the metadata/comments/reviews/threads/checks of dependency PR https://github.com/mouriya-s-lab/coder-loop/pull/749.

## Deliverable

`implementation-pr`

Create exactly one draft implementation PR targeting `main` whose body begins with `Closes #698`. Implement public daemon/CLI runtime-tree instantiation and scheduler consumption of the declared task/transition/closure model: structural `seq`, true-concurrent `par`, `drain`, committed-transition advancement, closure-keyed dispatch, first-expansion pins, declared concurrency limits, and dependency gating. Do not implement #560/#737/#739/#743 prerequisite surfaces inside this issue, #700 validator judgment, #701 correction/reopen, runtime `par` append/materialization, cancellation, bundled-preset migration, GUI, deployment, or release-wide compatibility.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is the clean exact-head #698 candidate checkout; env is local macOS with Bun and Git on `PATH`; runtime roots, fixture repositories, chain names, definition refs, runner shims, sockets, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command: execute it once per candidate SHA and retain separately labeled observations for all eleven IDs.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | candidate root; isolated real daemon/socket; fixture uses the available typed declaration/path/definition interfaces | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path, and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal; the outer seq then advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closures | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; first-open `par` and nested `par` over an origin-backed local Git fixture | Exit 0; the outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and the nested `par` independently pins before inner-closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; `par` of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absent global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating is orthogonal to tree structure, restores a not-yet-advanced leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; drain `par` with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; existing linear declaration normalized to a degenerate `seq` | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through the single transition/tree scheduler. Final log contains an `issue-698.pass` record naming C01-C11, exact source SHA, runtime UUID, and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; repo-slot scheduling state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive task-tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; run recording consumes an already-created closure identity and never lazily materializes a runtime node. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, mutation, and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests, whose integrity-loss list must be empty; separately enumerate every old-name to equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; log ends with `FINAL exit=0`; all scheduler integration files run, including the tree/transition scenarios added or migrated for #698. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision and run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground`. It creates UUID-isolated Git fixtures, task/path/definition fixtures, loop-data/evidence roots, and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add`. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected definition identity, runtime-tree identity, and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed-transition submission, status, and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit in the named log/evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its owned runtime root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not execute this issue's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, `par` overlap, `drain`, pins, limits, dependency gating, failure containment, and degenerate-`seq` compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`. Historical sources #554 and #605 are closed; their current implementation successors are #739 and #743.
- **Closure prerequisite:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its current closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d` over base `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`. Exhausted metadata has 58 issue-thread comments, zero submitted reviews, zero review threads/inline comments, zero check runs/status contexts, and one requested reviewer. #698 consumes the closure API rather than duplicating PR #749's diff.
- **Declaration/definition prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739, and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open, each with zero structural closing PRs and exhausted closing-reference pagination. #698 consumes their typed binding flow, recursive compiled task/path product, and immutable definition ref rather than creating scheduler-private substitutes.
- **Repository policy:** `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently prohibits v3 implementation under `src/`, `presets/`, `docs/`, and `scripts/`; #698's requested implementation touches `src/` and `scripts/`. This checked-in rule is an external authorization constraint on the implementation location, not a scope grant from this marker.
- **Current source gap:** on `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`, `src/scheduler.ts` still contains `SchedulerSlot`, repo-slot selection and `SchedulerPhasePlan`/flat phase advancement; `src/sqlite-state.ts` still lazily calls `ensureRuntimeClosure`; and `scripts/issue-698-integration.ts` does not exist. #698 is not already satisfied and has no linked closing PR.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and post-terminal leaf reactivation. Runtime `par` append/materialization, cancellation, bundled-preset migration, GUI, and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path; compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5014968058



### comment #5015035252 by `RiriAgent` — 2026-07-19T08:30:20Z

**[iteration] contract invalid @ 7172d3e** — #698 was selected before its declared prerequisite and path-authorization gates cleared

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015019578 (`Deliverable = implementation-pr`, superseding `5014968058`; exhaustive comment pagination shows no later correction).
- Live prerequisites: #560 remains open with unmerged PR #749 at `40c72f9222890d44eb90db8dcea272923c820e2d`; #737, #739, and #743 remain open with no structural closing PRs.
- Current base: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still contains `SchedulerSlot`/`SchedulerPhasePlan`/`schedulerSlotKey` and lazy `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent.
- Repository authorization: `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids this v3 implementation under the marker-required `src/` and `scripts/` paths.
- Required enrichment: keep #698 outside iteration until #560/#737/#739/#743 are landed and the repository path policy authorizes this implementation, or encode those gates in queue dependencies; do not publish a mixed prerequisite/#698 PR.

<details><summary>Run evidence</summary>

Run `run-1784449538828-13-iteration-item-32` rejoined the complete marker supersession chain, the zero-node #698 closing-PR query, the successful zero-child sub-issue query, current dependency/PR metadata, `origin/main`, and the checked-in rule. Research artifact: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784449538828-13-iteration-item-32-research/research-report.md`.

No source/test/runtime change was made and no CandidateRef exists: every CandidateRef variant other than `implementation-pr` contradicts the marker, while the implementation route is not currently authorized.

</details>



### comment #5015061997 by `RiriAgent` — 2026-07-19T08:39:33Z
_(last edited 2026-07-19T09:05:46Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body `lastEditedAt`: `2026-07-18T06:19:38Z` (GraphQL `Issue.lastEditedAt`; editor `RiriAgent`). The exhausted pre-publication snapshot has 18 comments (`comments.pageInfo.hasNextPage=false`), 35 timeline items (`timelineItems.pageInfo.hasNextPage=false`), zero closing PRs, zero sub-issues, parent https://github.com/mouriya-s-lab/coder-loop/issues/546, and no body/comment attachment URLs.
- Operator comments used: none. The issue has no later operator comment changing its body intent; prior `contract invalid` and phase comments are execution records, not task-authority substitutions.
- Inherited intent sources: https://github.com/mouriya-s-lab/coder-loop/issues/546 and the incorporated historical scope source https://github.com/mouriya-s-lab/coder-loop/issues/559. #698 owns public runtime-tree instantiation plus committed-transition-driven structural `seq`, true-concurrent `par`, and `drain`; validator judgment remains with https://github.com/mouriya-s-lab/coder-loop/issues/700 and correction/reopen including post-terminal reactivation remains with https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Local source inspected without GitHub blobs: fetched `origin/main` `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546` `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Read surfaces include `AGENTS.md`, `CLAUDE.md`, `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, current unit/integration drivers, the complete #698 body/comments/timeline, and the metadata/comments/reviews/threads/checks of dependency PR https://github.com/mouriya-s-lab/coder-loop/pull/749.

## Deliverable

`implementation-pr`

Create exactly one draft implementation PR targeting `main` whose body begins with `Closes #698`. Implement public daemon/CLI runtime-tree instantiation and scheduler consumption of the declared task/transition/closure model: structural `seq`, true-concurrent `par`, `drain`, committed-transition advancement, closure-keyed dispatch, first-expansion pins, declared concurrency limits, and dependency gating. Do not implement #560/#737/#739/#743 prerequisite surfaces inside this issue, #700 validator judgment, #701 correction/reopen, runtime `par` append/materialization, cancellation, bundled-preset migration, GUI, deployment, or release-wide compatibility.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is the clean exact-head #698 candidate checkout; env is local macOS with Bun and Git on `PATH`; runtime roots, fixture repositories, chain names, definition refs, runner shims, sockets, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical command: execute it once per candidate SHA and retain separately labeled observations for all eleven IDs.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | candidate root; isolated real daemon/socket; fixture uses the available typed declaration/path/definition interfaces | Exit 0; public `chain create` plus `item add` instantiate the immutable minimal runtime tree before any runner starts. `coder-loop status --json` exposes the definition/runtime identities and initial ready leaf. No setup call writes SQLite or invokes `createTaskTree`. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong type, illegal path, and a missing known-required external binding each return nonzero. No transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; both runs are live concurrently and persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` become terminal only after all direct members are terminal; the outer seq then advances and the tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closures | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denied case emits an identity-bearing audit event and each closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; first-open `par` and nested `par` over an origin-backed local Git fixture | Exit 0; the outer pin persists before member-closure creation, every outer entry closure uses that exact commit without per-member fetch, and the nested `par` independently pins before inner-closure creation. Runtime append/no-repin is neither implemented nor claimed. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; `par` of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absent global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating is orthogonal to tree structure, restores a not-yet-advanced leaf only after every dependency reaches a declared success terminal, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; drain `par` with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground` | same run; existing linear declaration normalized to a degenerate `seq` | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through the single transition/tree scheduler. Final log contains an `issue-698.pass` record naming C01-C11, exact source SHA, runtime UUID, and evidence directory. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` | candidate root | Exit 1 with no matches; repo-slot scheduling state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` | candidate root | Exit 1 with no matches; recursive task-tree/transition traversal is the only scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src tests scripts` | candidate root | Exit 1 with no matches; run recording consumes an already-created closure identity and never lazily materializes a runtime node. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, mutation, and transition crosses the public daemon/CLI surface. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals; enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests, whose integrity-loss list must be empty; separately enumerate every old-name to equal-or-stronger assertion replacement for explicitly retired behavior. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; log ends with `FINAL exit=0`; all scheduler integration files run, including the tree/transition scenarios added or migrated for #698. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | authenticated GitHub CLI after draft submission | Exit 0; `hasNextPage=false`; exactly one PR is open and draft for #698, targets `main`, its body begins `Closes #698`, and its live branch/head equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src tests scripts` must exit 1 with zero matches. No runtime scheduling/concurrency site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src tests scripts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src tests scripts` must exit 1 with zero matches. Run recording may consume an existing closure identity but may not materialize one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used only for evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision and run `bun install --frozen-lockfile`.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/issue-698-integration.log --foreground`. It creates UUID-isolated Git fixtures, task/path/definition fixtures, loop-data/evidence roots, and deterministic runner shims; starts the real `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add`. Store APIs and direct SQL are not setup paths.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected definition identity, runtime-tree identity, and initial ready leaf before releasing any runner.
- Behavior: execute C01-C11 through public create, exit-query, typed-transition submission, status, and logs commands. Read-only SQLite queries may corroborate record counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, fixture/runtime UUID, readiness, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit in the named log/evidence directory. Do not record secrets.
- Stop ownership: the driver terminates every daemon/runner, removes only its owned runtime root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains a named diagnostic root and reports it rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub fixture does not execute this issue's recursive behavior and the issue does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and the real-process `scripts/issue-698-integration.ts` driver for public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, `par` overlap, `drain`, pins, limits, dependency gating, failure containment, and degenerate-`seq` compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Every renamed/replaced test must be enumerated old-name to new assertion, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`. Historical sources #554 and #605 are closed; their current implementation successors are #739 and #743.
- **Closure prerequisite:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its current closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d` over base `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`. Exhausted metadata has 58 issue-thread comments, zero submitted reviews, zero review threads/inline comments, zero check runs/status contexts, and one requested reviewer. #698 consumes the closure API rather than duplicating PR #749's diff.
- **Declaration/definition prerequisites:** https://github.com/mouriya-s-lab/coder-loop/issues/737, https://github.com/mouriya-s-lab/coder-loop/issues/739, and https://github.com/mouriya-s-lab/coder-loop/issues/743 are open, each with zero structural closing PRs and exhausted closing-reference pagination. #698 consumes their typed binding flow, recursive compiled task/path product, and immutable definition ref rather than creating scheduler-private substitutes.
- **Repository policy:** `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently prohibits v3 implementation under `src/`, `presets/`, `docs/`, and `scripts/`; #698's requested implementation touches `src/` and `scripts/`. This checked-in rule is an external authorization constraint on the implementation location, not a scope grant from this marker.
- **Current source gap:** on `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`, `src/scheduler.ts` still contains `SchedulerSlot`, repo-slot selection and `SchedulerPhasePlan`/flat phase advancement; `src/sqlite-state.ts` still lazily calls `ensureRuntimeClosure`; and `scripts/issue-698-integration.ts` does not exist. #698 is not already satisfied and has no linked closing PR.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and post-terminal leaf reactivation. Runtime `par` append/materialization, cancellation, bundled-preset migration, GUI, and release-level cross-issue validation remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path; compatibility real E2E remains reserved to #685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015019578



### comment #5015087257 by `RiriAgent` — 2026-07-19T08:48:05Z

**[iteration] contract invalid @ 7172d3e** — #698 is selected while its current marker still declares unlanded and unauthorized implementation gates

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015061997 (`implementation-pr`; no later operator correction).

- Live dependency join: [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) remains open with unmerged [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) at `40c72f9222890d44eb90db8dcea272923c820e2d`; [#737](https://github.com/mouriya-s-lab/coder-loop/issues/737), [#739](https://github.com/mouriya-s-lab/coder-loop/issues/739), and [#743](https://github.com/mouriya-s-lab/coder-loop/issues/743) remain open with no closing PRs.
- Live source join: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still contains `SchedulerSlot`/`schedulerSlotKey`, `SchedulerPhasePlan`, and `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent.
- Authorization join: `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids v3 work in the `src/` and `scripts/` paths the marker requires.
- Queue join: #698 has no dependency record in `coder-loop item list v3-546 --json` and was selected despite those live gates.

This contract cannot produce a legal CandidateRef: implementing would absorb #560/#737/#739/#743 or violate checked-in path policy, while a no-PR route contradicts `Deliverable = implementation-pr`. Contract enrichment must keep #698 outside iteration until these gates are true (or until an authoritative repository-policy change and queue dependency model make the route executable); it must not return the same gated implementation route as executable.




### comment #5015139044 by `RiriAgent` — 2026-07-19T09:05:31Z
_(last edited 2026-07-19T09:42:40Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`; the issue itself was still open when this contract was prepared. The complete pre-publication snapshot exhausted 20 comments, 37 timeline records, zero structural closing PRs, zero sub-issues, parent https://github.com/mouriya-s-lab/coder-loop/issues/546, and zero attachment URLs.
- Operator-comment URLs used: none. No later operator comment on #698 changes the body intent; existing contract/iteration/verification comments are workflow records, not replacement task authority.
- Inherited intent: https://github.com/mouriya-s-lab/coder-loop/issues/546 supplies the task algebra, closure/resource axioms, committed-transition completion rule, supply clauses, and total-close boundary. The incorporated historical scheduler scope is https://github.com/mouriya-s-lab/coder-loop/issues/559; its old numbering is source provenance, while #698's own final `依赖关系` section is the current dependency declaration.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` (the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749); and target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Inspected entry points include `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, unit/integration harnesses, acceptance drivers, the complete #698 issue/timeline, linked issues, and full linked-PR comments/reviews/threads/checks.

## Deliverable

`implementation-pr`

After the declared prerequisite interfaces are available on the candidate base and the repository authorizes the implementation location, create exactly one draft PR targeting `main` whose body begins with `Closes #698`. Through public daemon/CLI creation and completion surfaces, instantiate the compiled minimal runtime tree before dispatch and replace flat/slot scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment. Do not implement #737 or #739 inside #698; do not absorb adjacent closure PR #749; do not implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide compatibility.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean exact-head candidate checkout based on then-current `main`; env is local macOS with Bun and Git on `PATH`; all fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 use one canonical driver execution per candidate SHA; its transcript must expose separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; a minimal immutable runtime tree is persisted and visible through `coder-loop status --json` before a runner starts. Setup does not call `createTaskTree` or mutate SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and a missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` contains at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the whole tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all of that par's entry closures use the exact pin without member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to the tree, restores a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The final transcript names C01-C11, the exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run recording consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but all creation, transition, and mutation effects cross the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list must be empty. Separately enumerate any old-name to equal-or-stronger assertion replacement for explicitly retired flat/slot behavior. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated recursive tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. No scheduler/daemon concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Run persistence may require an existing identity but may not create one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain the exact source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit under the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure, retain and report a named diagnostic root instead of deleting the evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- **Landed declared foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- **Declared prerequisite blockers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with no structural closing PR. #737 owns typed `exit.*`/external binding validation; #739 owns recursive phase-tree/path declaration and compile guards. #698 consumes these surfaces and may not implement them privately. This prevents a legal #698 implementation candidate on the current base.
- **Adjacent closure state:** the current #698 body says old child numbers in incorporated prose are provenance rather than the current dependency graph. Nevertheless, the requested closure-state dispatch path depends on a usable closure API. https://github.com/mouriya-s-lab/coder-loop/issues/560 remains open; its adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`; it has 58 issue-thread comments, zero submitted reviews, zero review threads, and zero check runs/status contexts. #698 must not absorb that PR's implementation.
- **Repository authorization blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This contract records the checked-in constraint but does not grant authority to remove or bypass it.
- **Current source gap:** `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still compiles only degenerate linear tasks (`src/loop.ts`), schedules through `SchedulerSlot`/`SchedulerPhasePlan` (`src/scheduler.ts`), lazily calls `ensureRuntimeClosure` from run persistence (`src/sqlite-state.ts`), and has no `scripts/issue-698-integration.ts`. #698 is not already satisfied and has no closing PR.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015061997



### comment #5015156244 by `RiriAgent` — 2026-07-19T09:11:43Z

**[iteration] contract invalid @ 7172d3e** — #698 is selected before its current marker's prerequisite and repository-authorization gates are true

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015139044 (`implementation-pr`; supersedes https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015061997).
- Live prerequisites: [#737](https://github.com/mouriya-s-lab/coder-loop/issues/737) and [#739](https://github.com/mouriya-s-lab/coder-loop/issues/739) are open with no structural closing PR; [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) is open and [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) remains unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d`.
- Base/policy: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still contains slot/flat/lazy-closure scheduling sites, lacks `scripts/issue-698-integration.ts`, and `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` forbids the required v3 changes in `src/`/`scripts/`.
- Queue: `queue.selected.id=698`; the item has no `dependsOn`, while #560 is `exhausted` and #737/#739 are absent from the chain.

The marker says to create the PR only after those gates are available and forbids implementing #737/#739 inside #698 or absorbing PR #749. No legal CandidateRef exists in this spawn. Contract enrichment/operator-owned dependency routing must keep #698 out of iteration until the declared source and policy gates are executable; no source, PR, queue-order, or chain-lifecycle mutation was performed.



### comment #5015188496 by `RiriAgent` — 2026-07-19T09:23:08Z
_(last edited 2026-07-19T09:42:40Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. The complete pre-publication snapshot exhausted 22 comments and 39 timeline records, with zero structural closing PRs, zero sub-issues, parent https://github.com/mouriya-s-lab/coder-loop/issues/546, and no body/comment attachment URLs.
- Operator-comment URLs used from the inherited parent contract: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (join boundary). No operator comment on #698 changes the live body intent; the existing contract/iteration/verification comments are workflow records, not replacement task authority.
- Scope handoff: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns production-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` (the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749); and target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Inspected entry points include `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, current unit/integration/acceptance drivers, the complete #698 timeline, dependency issues, central queue state, and PR #749 comments/reviews/threads/checks.

## Deliverable

`implementation-pr`

After the declared prerequisite interfaces are available on the candidate base and the repository authorizes the implementation location, create exactly one draft PR targeting `main` whose body begins with `Closes #698`. Through public daemon/CLI creation and completion surfaces, instantiate the compiled minimal runtime tree before dispatch and replace flat/slot scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment. Do not implement #737/#739/#743 inside #698; do not absorb adjacent closure PR #749; do not implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide compatibility.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean exact-head candidate checkout based on then-current `main`; env is local macOS with Bun and Git on `PATH`; all fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 use one canonical driver execution per candidate SHA; its transcript must expose separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; a minimal immutable runtime tree is persisted and visible through `coder-loop status --json` before a runner starts. Setup does not call `createTaskTree` or mutate SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and a missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` contains at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the whole tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all of that par's entry closures use the exact pin without member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to the tree, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run recording consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but all creation, transition, and mutation effects cross the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list must be empty. Separately enumerate any old-name to equal-or-stronger assertion replacement for explicitly retired flat/slot behavior. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated recursive tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open draft closing PR exists for #698, targets `main`, begins with `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. No scheduler/daemon concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Run persistence may require an existing identity but may not create one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain the exact source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit under the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure, retain and report a named diagnostic root instead of deleting the evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- Landed declared foundations: https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- Declared prerequisite blockers: https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with no structural closing PR. #737 owns typed `exit.*`/external-binding validation; #739 owns recursive task/path declaration and compile guards and explicitly blocks #698. #698 consumes these surfaces and may not implement them privately.
- Immutable-definition blocker: https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with no structural closing PR; its live body explicitly blocks #698 and owns the definition-ref producer/resolution surface that public runtime instantiation must consume. The closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 has no closing PR and does not itself satisfy #743.
- Adjacent closure execution fact: the incorporated scheduler semantics require dispatch to #560's closure mechanism, while https://github.com/mouriya-s-lab/coder-loop/issues/560 is open and PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`. The complete PR payload has 58 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. #698's current dependency section treats old child numbers as provenance, so this records an execution-interface fact rather than rewriting the issue graph; #698 must not absorb PR #749's diff.
- Repository authorization blocker: `.claude/rules/v2-only-no-v3-divergence.rule.md`, mirrored in `AGENTS.md`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This contract records the checked-in constraint but does not grant authority to remove or bypass it.
- Current source gap: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still compiles only degenerate linear tasks in `src/loop.ts`, schedules through `SchedulerSlot`/`SchedulerPhasePlan` in `src/scheduler.ts`, lazily calls `ensureRuntimeClosure` from `src/sqlite-state.ts`, and has no `scripts/issue-698-integration.ts`. #698 is not already satisfied and has no closing PR.
- Central runtime ordering gap: `coder-loop item list v3-546 --json` shows item #698 at position 1 with status `contract_invalid` and no `dependsOn`; #560 is terminal `exhausted`, while #737/#739/#743 are absent from the chain. The contract comment cannot mutate queue ownership or convert these external prerequisites into item edges.
- Scope boundary: https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- External runtime: no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015139044



### comment #5015210187 by `RiriAgent` — 2026-07-19T09:30:53Z

**[iteration] contract invalid @ 7172d3e** — #698 is still selected before its current marker's prerequisite and repository-authorization gates are true

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015188496 (`implementation-pr`; supersedes https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015139044).
- Live prerequisites: [#737](https://github.com/mouriya-s-lab/coder-loop/issues/737), [#739](https://github.com/mouriya-s-lab/coder-loop/issues/739), and [#743](https://github.com/mouriya-s-lab/coder-loop/issues/743) are open with no structural closing PR; [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) is open and [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) remains unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d`.
- Base/policy: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still contains slot/flat/lazy-closure scheduling sites, lacks `scripts/issue-698-integration.ts`, and `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` forbids the required v3 changes in `src/`/`scripts/`.
- Queue: `queue.selected.id=698`; the item has no dependency record, while #560 is `exhausted` and #737/#739/#743 are absent from the chain.

The marker authorizes an implementation PR only after those gates are available and forbids implementing #737/#739/#743 inside #698 or absorbing PR #749. No legal CandidateRef exists in this spawn. Contract enrichment/operator-owned dependency routing must keep #698 outside iteration until the declared source and policy gates are executable; no source, PR, queue-order, chain-lifecycle, or runtime mutation was performed.



### comment #5015243255 by `RiriAgent` — 2026-07-19T09:42:07Z
_(last edited 2026-07-19T10:03:18Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. The complete pre-publication snapshot exhausted 24 comments and 41 timeline records; it has zero structural closing PRs, zero sub-issues, parent https://github.com/mouriya-s-lab/coder-loop/issues/546, and no body/comment attachment URLs.
- Operator-comment URLs used from the inherited parent contract: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (join boundary). No direct operator comment on #698 changes the live body intent.
- Scope handoff: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns production-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Re-enrichment input: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015210187 records that the prior marker had no legal CandidateRef while its prerequisite and repository-authorization gates remained false. This workflow record does not replace task intent.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` (the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749); and target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Inspected entry points include `package.json`, `docs/test-boundaries.md`, `src/loop.ts`, `src/daemon.ts`, `src/scheduler.ts`, `src/sqlite-state.ts`, `src/task-runtime.ts`, current unit/integration/acceptance drivers, the complete #698 timeline, dependency issues, central queue state, and PR #749 comments/reviews/threads/checks.

## Deliverable

`implementation-pr`

Create exactly one implementation PR targeting `main` whose body begins with `Closes #698`. Through public daemon/CLI creation and completion surfaces, instantiate the compiled minimal runtime tree before dispatch and replace flat/slot scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment. Do not implement #737/#739/#743 inside #698; do not absorb adjacent closure PR #749; do not implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide compatibility. This remains `implementation-pr` because the issue asks for the scheduler implementation itself; it is not an issue whose deliverable is removal of a named blocker for another issue.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean exact-head candidate checkout based on then-current `main`; env is local macOS with Bun and Git on `PATH`; all fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 use one canonical driver execution per candidate SHA; its transcript must expose separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; a minimal immutable runtime tree is persisted and visible through `coder-loop status --json` before a runner starts. Setup does not call `createTaskTree` or mutate SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and a missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and a naked status/terminal write do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates no duplicate transition or B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` contains at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; each tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the whole tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all of that par's entry closures use the exact pin without member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and an absent global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` and a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to the tree, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run recording consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but all creation, transition, and mutation effects cross the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list must be empty. Separately enumerate any old-name to equal-or-stronger assertion replacement for explicitly retired flat/slot behavior. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated recursive tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open closing PR exists for #698, targets `main`, begins with `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. No scheduler/daemon concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. No second flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Run persistence may require an existing identity but may not create one. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root> --json`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain the exact source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit under the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts no owned PID, socket, worktree, ref, or runtime root remains. On failure, retain and report a named diagnostic root instead of deleting the evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility. Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement must preserve the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass, and the canonical driver may not replace public setup with direct persistence seeding.

## Dependencies

- Landed declared foundations: https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- Declared prerequisite blockers: https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with `closedByPullRequestsReferences.nodes=[]` and exhausted pagination. #737 owns typed required/default binding validation consumed by the typed successor path; #739 owns recursive task/path declaration and compile guards and explicitly blocks #698. #698 consumes these surfaces and may not implement them privately.
- Immutable-definition blocker: https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with `closedByPullRequestsReferences.nodes=[]`; its live body explicitly blocks #698 and owns the definition-ref producer/resolution surface that public runtime instantiation must consume. The closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 does not itself satisfy #743.
- Adjacent closure execution fact: the scheduler semantics require dispatch to #560's closure mechanism, while https://github.com/mouriya-s-lab/coder-loop/issues/560 is open and PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`. The complete PR payload has 58 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. #698's current dependency section treats old child numbers as provenance, so this records an execution-interface fact rather than rewriting the issue graph; #698 must not absorb PR #749's diff.
- Repository authorization blocker: `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored at `AGENTS.md:203-206`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This contract records the checked-in constraint but does not grant authority to remove or bypass it.
- Current source gap: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` compiles only degenerate linear task trees (`src/loop.ts:780-782,864-873`), schedules through `SchedulerSlot`/`SchedulerPhasePlan` (`src/scheduler.ts:137-155,487-684`), lazily calls `ensureRuntimeClosure` (`src/sqlite-state.ts:1790,1843,2054`), and has no `scripts/issue-698-integration.ts`. #698 is not already satisfied and has no closing PR.
- Central runtime ordering gap: `coder-loop item list v3-546 --json` shows item #698 at position 1 with status `contract_invalid`, attempts 12, and no `dependsOn`; #560 is terminal `exhausted`, while #737/#739/#743 are absent from the chain. The contract comment cannot mutate queue ownership or convert external prerequisites into item edges.
- Scope boundary: https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- External runtime: no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015188496



### comment #5015263127 by `RiriAgent` — 2026-07-19T09:49:32Z

**[iteration] contract invalid @ 7172d3e** — #698 remains selected before its current marker's implementation gates are executable

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015243255 (`Deliverable = implementation-pr`).
- Live blockers: #737, #739, and #743 are open with exhausted structural closing-PR lists and zero nodes; #560 remains open with adjacent PR #749 unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d`.
- Source/policy anchors: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` still contains the marker-forbidden flat/slot/lazy-closure symbols; `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` forbids the required v3 `src/`/`scripts/` implementation.
- Queue anchor: #698 is selected with no dependency route; #560 is `exhausted`, and #737/#739/#743 are absent from chain `v3-546`.
- Required enrichment: keep #698 outside iteration until the declared producer interfaces and repository path authorization exist, or authoritatively repair the dependency/policy route. Do not create a no-PR, stacked, mixed-prerequisite, or #749-absorbing CandidateRef.

<details><summary>Evidence and route judgment</summary>

The current marker is the unique head of a 12-marker `Supersedes` chain and is the final issue comment before this report; there is no later operator correction. Structural linkage for #698 is `hasNextPage=false,nodes=[]`, and its sub-issue endpoint returns `[]`.

Live GraphQL state for #737/#739/#743 is `OPEN` with `closedByPullRequestsReferences.pageInfo.hasNextPage=false` and empty nodes. PR #749 is `OPEN`, non-draft, `CLEAN`, targets `main`, and is the exact detached checkout head; the marker explicitly forbids absorbing it. Local base inspection finds `SchedulerSlot`, `SchedulerPhasePlan`, `getOrCreateSlot`, `schedulerSlotKey`, `hasActiveSlotForChain`, flat phase selectors, and `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent.

Because the marker permits only `implementation-pr`, all no-PR CandidateRef variants are invalid. The implementation route cannot legally be executed while the marker's own prerequisites and checked-in placement rule remain false. This iteration therefore publishes contract evidence and returns to contract enrichment without source changes or a candidate.

</details>



### comment #5015298820 by `RiriAgent` — 2026-07-19T10:02:56Z
_(last edited 2026-07-19T10:27:16Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. The pre-publication snapshot exhausted all 26 comments and 43 timeline records (`hasNextPage=false`), found no attachments, no sub-issues, and no structural closing PR for #698.
- Inherited operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure lifecycle and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (`drain`/validator join boundary).
- Scope handoff used: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Direct operator-comment URLs on #698: none. All direct comments are phase-generated contract markers or workflow reports. The latest report consumed for current execution facts is https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015263127; it does not replace the issue body.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`, which equals the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`; repository instructions, package/test entry points, source, tests, central queue state, dependency issues, and the complete PR #749 comments/reviews/threads/check state were read locally.

## Deliverable

`implementation-pr`

Create exactly one implementation PR targeting `main`, with body first line `Closes #698`, from an authorized base containing the producer interfaces listed in `Dependencies`. Through the public daemon/CLI create and completion surfaces, instantiate the compiled immutable runtime tree before dispatch and replace repo-slot/flat-phase scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, structural `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment.

Do not implement #737/#739/#743 inside #698, absorb adjacent PR #749, or implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide #684/#685 validation. This remains `implementation-pr` because #698 requests the scheduler implementation itself; it is not a blocker-removal or writing-spike issue.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean checkout at the exact candidate SHA based on then-current `main`; env is local macOS with Bun and Git on `PATH`; fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical driver execution per candidate SHA, whose transcript exposes separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; before any runner starts, the public create path persists the immutable minimal runtime tree and `coder-loop status --json` exposes its definition/runtime identities plus the initial ready leaf. Setup neither calls `createTaskTree` nor mutates SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and naked status/terminal writes do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates neither a duplicate transition nor a duplicate B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the complete tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to landed closure create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event, and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all entry closures of that par use the exact pin without per-member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absence of a global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` plus a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to tree structure, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run persistence consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, transition, and mutation effect crosses the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list is empty. Separately map any retired flat/slot assertion to its equal-or-stronger replacement. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; the log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open closing PR exists for #698, targets `main`, its body begins `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. Historical prose and offline migration/cleanup code outside scheduler/daemon are excluded; no runtime scheduling or concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. Historical prose is excluded; no second runtime flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Migration code outside `src` is excluded; no run-persistence materialization path is excluded. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision based on the authorized, prerequisite-complete `main`; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root>`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit beneath the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains and reports a named diagnostic root rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility.

Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement preserves the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Component fixtures may continue using typed store setup where their own boundary requires it, but the canonical #698 driver may not replace public setup with `createTaskTree` or direct persistence mutation.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- **Typed path/declaration producers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with exhausted, empty structural closing-PR lists. #737 owns the typed `exit.*`/required/default binding flow; #739 depends on #737, owns recursive task/path declarations and compile guards, and explicitly blocks #698. #698 consumes those public products and must not add a scheduler-private fallback schema, duplicate parser, or untyped transition object.
- **Immutable definition producer:** https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with an exhausted, empty structural closing-PR list and explicitly blocks #698. Public runtime instantiation must consume its landed definition-ref creation/resolution surface; the closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 does not satisfy #743.
- **Adjacent closure execution fact:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is open, non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`. Exhaustive state shows 58 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. #698 delegates closure create/reopen/resume/consume/single-activity behavior to the landed interface and must not absorb or extend PR #749 in its own PR.
- **Repository authorization blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored at `AGENTS.md:203-206`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This marker records the checked-in rule but does not authorize removing or bypassing it. Implementation requires an operator-authoritative rule change on the candidate base or an explicitly authorized implementation repository/branch.
- **Current source gap:** `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` compiles only a degenerate phase seq (`src/loop.ts:780-782,864-874`), creates chains/items without a runtime tree (`src/daemon.ts:2167-2230,2895-2945`), selects through repo slots and a flat phase plan (`src/scheduler.ts:486-574,586-706,866-868`), and lazily materializes task identities from `recordRun` (`src/sqlite-state.ts:1844-1850,2158-2202`). Public exits expose status/action choices but not #737's future typed path object (`src/daemon.ts:3301-3331`). `src/task-runtime.ts:3-58` and the SQLite task-tree API are landed persistence/status shapes to consume, not acceptance setup shortcuts; `scripts/issue-698-integration.ts` does not exist.
- **Central runtime ordering gap:** `coder-loop item list v3-546 --json` shows #698 selected as `contract_invalid`, attempts 13, with no `dependsOn`; #560 is terminal `exhausted`, while #737/#739/#743 are absent from the chain. Contract enrichment cannot mutate operator-owned queue topology or turn external prerequisites into item edges.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015243255



### comment #5015320145 by `RiriAgent` — 2026-07-19T10:10:24Z
_(last edited 2026-07-19T10:34:44Z)_

**[iteration] contract invalid @ 7172d3e** — #698 is still selected before its marker-required producer and repository-authorization gates exist

- Current contract: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015298820 (`implementation-pr`, exact base and scope constraints).
- Live producer state: #737/#739/#743 are OPEN with exhausted empty structural closing-PR lists; #560 is OPEN and its [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) remains unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d`.
- Live base/policy: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids the `src/`/`scripts/` v3 implementation this issue requires.
- Required enrichment: keep #698 outside iteration until the declared producer interfaces and repository-path authorization land, or authoritatively change the dependency/policy route. Do not create a no-PR, stacked, mixed-prerequisite, or PR-#749-absorbing candidate.

<details><summary>Observed source and queue evidence</summary>

- `src/scheduler.ts` still contains repo-slot state and flat `SchedulerPhasePlan` selection; `src/sqlite-state.ts` still contains lazy `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent.
- #698 has no sub-issues and no structural closing PR. Central queue still selects #698 as `contract_invalid`; #560 is `exhausted`; #737/#739/#743 are absent from the chain.
- Run: `run-1784455476448-29-iteration-item-32`; local evidence: `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/run-1784455476448-29-iteration-item-32/`.

</details>



### comment #5015364490 by `RiriAgent` — 2026-07-19T10:26:59Z
_(last edited 2026-07-19T10:47:04Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. The live snapshot exhausted all 28 comments and 45 timeline records (`hasNextPage=false`), found no attachments, no sub-issues, no structural dependency edges, and no structural closing PR for #698.
- Inherited operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure lifecycle and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (`drain`/validator join boundary).
- Scope handoff used: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Direct operator-comment URLs on #698: none. All direct comments are phase-generated contract markers or workflow reports. The latest report consumed for current execution facts is https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015320145; it does not replace the issue body.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Repository instructions, package/test entry points, source, tests, central queue state, dependency issues, and complete PR #749 comments/reviews/threads/check/timeline state were read locally.

## Deliverable

`implementation-pr`

Create exactly one implementation PR targeting `main`, with body first line `Closes #698`, from an authorized base containing the producer interfaces listed in `Dependencies`. Through the public daemon/CLI create and completion surfaces, instantiate the compiled immutable runtime tree before dispatch and replace repo-slot/flat-phase scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, structural `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment.

Do not implement #737/#739/#743 inside #698, absorb adjacent PR #749, or implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide #684/#685 validation. This remains `implementation-pr` because #698 requests the scheduler implementation itself; it is not a blocker-removal or writing-spike issue.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean checkout at the exact candidate SHA based on then-current `main`; env is local macOS with Bun and Git on `PATH`; fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical driver execution per candidate SHA, whose transcript exposes separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; before any runner starts, the public create path persists the immutable minimal runtime tree and `coder-loop status --json` exposes its definition/runtime identities plus the initial ready leaf. Setup neither calls `createTaskTree` nor mutates SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and naked status/terminal writes do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates neither a duplicate transition nor a duplicate B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the complete tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to landed closure create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event, and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all entry closures of that par use the exact pin without per-member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absence of a global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` plus a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to tree structure, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run persistence consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, transition, and mutation effect crosses the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list is empty. Separately map any retired flat/slot assertion to its equal-or-stronger replacement. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; the log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open closing PR exists for #698, targets `main`, its body begins `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. Historical prose and offline migration/cleanup code outside scheduler/daemon are excluded; no runtime scheduling or concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. Historical prose is excluded; no second runtime flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Migration code outside `src` is excluded; no run-persistence materialization path is excluded. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision based on the authorized, prerequisite-complete `main`; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root>`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit beneath the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains and reports a named diagnostic root rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility.

Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement preserves the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Component fixtures may continue using typed store setup where their own boundary requires it, but the canonical #698 driver may not replace public setup with `createTaskTree` or direct persistence mutation.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- **Typed path/declaration producers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with exhausted, empty structural closing-PR lists. #737 owns the typed `exit.*`/required/default binding flow; #739 depends on #737, owns recursive task/path declarations and compile guards, and explicitly blocks #698. #698 consumes those public products and must not add a scheduler-private fallback schema, duplicate parser, or untyped transition object.
- **Immutable definition producer:** https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with an exhausted, empty structural closing-PR list and explicitly blocks #698. Public runtime instantiation must consume its landed definition-ref creation/resolution surface; the closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 does not satisfy #743.
- **Adjacent closure execution fact:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its sole open closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`; exhaustive state shows 58 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. Its latest durable diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 still records one blocking implementation mechanism, and central state marks #560 `exhausted`. #698 delegates closure create/reopen/resume/consume/single-activity behavior to the landed interface and must not absorb or extend PR #749.
- **Repository authorization blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored at `AGENTS.md:203-206`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This marker records the checked-in rule but does not authorize removing or bypassing it. Implementation requires an operator-authoritative rule change on the candidate base or an explicitly authorized implementation repository/branch.
- **Current source gap:** assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` compiles only a degenerate phase seq (`src/loop.ts:780-782,864-874`), creates chains/items without a runtime tree (`src/daemon.ts:2167-2230,2895-2945`), selects through repo slots and a flat phase plan (`src/scheduler.ts:149-167,519-706,866-868`), and lazily materializes task identities from `recordRun` (`src/sqlite-state.ts:1844-1850,2158-2202`). Public exits expose status/action choices but not #737's future typed path object (`src/daemon.ts:3290-3331`). `src/task-runtime.ts` and the SQLite task-tree API are landed persistence/status shapes to consume, not acceptance setup shortcuts; `scripts/issue-698-integration.ts` does not exist.
- **Central runtime ordering gap:** `coder-loop item list v3-546 --json` shows #698 selected as `contract_invalid`, attempts 14, with no dependency record; #560 is terminal `exhausted`, while #737/#739/#743 are absent from the chain. Contract enrichment cannot mutate operator-owned queue topology or turn external prerequisites into item edges.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015298820



### comment #5015385621 by `RiriAgent` — 2026-07-19T10:34:28Z

**[iteration] contract invalid @ 7172d3e** — #698 still has no legal implementation candidate under its current marker

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015364490
Live prerequisites: #737/#739/#743 remain open with no structural closing PR; #560 remains open with unmerged PR #749.
Base/policy: `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids the required `src/`/`scripts/` implementation.
Required correction: keep #698 outside iteration until those producer interfaces and path authorization land, or change the authoritative route; do not create a stacked, mixed-prerequisite, or #749-absorbing PR.

<details><summary>Evidence and routing</summary>

- Marker `Deliverable`: `implementation-pr` from “an authorized base containing the producer interfaces listed in Dependencies.”
- GraphQL structural state (all pages exhausted): [#737](https://github.com/mouriya-s-lab/coder-loop/issues/737), [#739](https://github.com/mouriya-s-lab/coder-loop/issues/739), and [#743](https://github.com/mouriya-s-lab/coder-loop/issues/743) are `OPEN` with empty closing-PR lists; [#560](https://github.com/mouriya-s-lab/coder-loop/issues/560) is `OPEN`; [PR #749](https://github.com/mouriya-s-lab/coder-loop/pull/749) is open and unmerged at `40c72f9222890d44eb90db8dcea272923c820e2d`.
- Exact-base source still contains `SchedulerSlot`, `SchedulerPhasePlan`, `schedulerSlotKey`, and `ensureRuntimeClosure`; `scripts/issue-698-integration.ts` is absent.
- #698 has no closing PR and no sub-issues. The 29-comment live snapshot contains exactly one unminimized executable marker and no later operator correction.
- No CandidateRef is emitted: every no-PR variant conflicts with the marker, while the implementation variant cannot satisfy its own source and authorization conditions.

</details>



### comment #5015419603 by `RiriAgent` — 2026-07-19T10:46:44Z
_(last edited 2026-07-19T11:06:27Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. The pre-publication snapshot for this contract exhausted all 30 comments and 47 timeline records, found no attachments, no sub-issues, and no structural closing PR for #698; its structural parent is https://github.com/mouriya-s-lab/coder-loop/issues/546.
- Inherited operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure lifecycle and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (`drain`/validator join boundary).
- Scope handoff used: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Direct operator-comment URLs on #698: none. All direct comments are phase-generated contract markers or workflow reports. The latest report consumed for current execution facts is https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015385621; it does not replace the issue body.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Repository instructions, package/test entry points, source, tests, central queue state, dependency issues, and complete PR #749 comments/reviews/threads/check/timeline state were read locally.

## Deliverable

`implementation-pr`

Create exactly one implementation PR targeting `main`, with body first line `Closes #698`, from an authorized base containing the producer interfaces listed in `Dependencies`. Through the public daemon/CLI create and completion surfaces, instantiate the compiled immutable runtime tree before dispatch and replace repo-slot/flat-phase scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, structural `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment.

Do not implement #737/#739/#743 inside #698, absorb adjacent PR #749, or implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide #684/#685 validation. This remains `implementation-pr` because #698 requests the scheduler implementation itself; it is not a blocker-removal or writing-spike issue.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean checkout at the exact candidate SHA based on then-current `main`; env is local macOS with Bun and Git on `PATH`; fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical driver execution per candidate SHA, whose transcript exposes separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; before any runner starts, the public create path persists the immutable minimal runtime tree and `coder-loop status --json` exposes its definition/runtime identities plus the initial ready leaf. Setup neither calls `createTaskTree` nor mutates SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and naked status/terminal writes do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates neither a duplicate transition nor a duplicate B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the complete tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to landed closure create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event, and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all entry closures of that par use the exact pin without per-member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absence of a global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` plus a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to tree structure, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run persistence consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, transition, and mutation effect crosses the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list is empty. Separately map any retired flat/slot assertion to its equal-or-stronger replacement. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; the log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open closing PR exists for #698, targets `main`, its body begins `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. Historical prose and offline migration/cleanup code outside scheduler/daemon are excluded; no runtime scheduling or concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. Historical prose is excluded; no second runtime flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Migration code outside `src` is excluded; no run-persistence materialization path is excluded. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision based on the authorized, prerequisite-complete `main`; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root>`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit beneath the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains and reports a named diagnostic root rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility.

Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement preserves the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Component fixtures may continue using typed store setup where their own boundary requires it, but the canonical #698 driver may not replace public setup with `createTaskTree` or direct persistence mutation.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- **Typed path/declaration producers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with exhausted, empty structural closing-PR lists. #737 owns the typed `exit.*`/required/default binding flow; #739 depends on #737, owns recursive task/path declarations and compile guards, and explicitly blocks #698. #698 consumes those public products and must not add a scheduler-private fallback schema, duplicate parser, or untyped transition object.
- **Immutable definition producer:** https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with an exhausted, empty structural closing-PR list and explicitly blocks #698. Public runtime instantiation must consume its landed definition-ref creation/resolution surface; the closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 does not satisfy #743.
- **Adjacent closure execution fact:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its sole open closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`; exhaustive state shows 58 PR-thread comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. Its latest durable diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 still records one blocking implementation mechanism, and central state marks #560 `exhausted`. #698 delegates closure create/reopen/resume/consume/single-activity behavior to the landed interface and must not absorb or extend PR #749.
- **Repository authorization blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored at `AGENTS.md:203-206`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This marker records the checked-in rule but does not authorize removing or bypassing it. Implementation requires an operator-authoritative rule change on the candidate base or an explicitly authorized implementation repository/branch.
- **Current source gap:** assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` compiles only a degenerate phase seq (`src/loop.ts:780-782,864-874`), creates chains/items without a runtime tree (`src/daemon.ts:2167-2230,2895-2945`), selects through repo slots and a flat phase plan (`src/scheduler.ts:149-167,519-706,866-868`), and lazily materializes task identities from `recordRun` (`src/sqlite-state.ts:1844-1850,2158-2202`). Public exits expose status/action choices but not #737's future typed path object (`src/daemon.ts:3290-3331`). `src/task-runtime.ts` and the SQLite task-tree API are landed persistence/status shapes to consume, not acceptance setup shortcuts; `scripts/issue-698-integration.ts` does not exist.
- **Central runtime ordering gap:** during `run-1784457404339-33-contract-enrichment-item-32`, `coder-loop item list v3-546 --json` showed #698 selected as `contract_invalid` with no dependency record; #560 was terminal `exhausted`, while #737/#739/#743 were absent from the chain. Contract enrichment cannot mutate operator-owned queue topology or turn external prerequisites into item edges.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015364490



### comment #5015444526 by `RiriAgent` — 2026-07-19T10:55:54Z
_(last edited 2026-07-19T11:16:49Z)_

**[iteration] contract invalid @ 7172d3e** — #698 仍不存在满足 current marker 的合法 implementation base

- Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015419603；其唯一 Deliverable 是 `implementation-pr`，并要求 producer interfaces、#560 closure API 与 repository authorization 先存在。
- #737、#739、#743 均仍为 open，且各自穷尽的 structural closing-PR 列表为空；#739 与 #743 的 live body 仍显式 `Blocks: #698`。
- #560 仍为 open；唯一 open closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 仍未合并，live head 为 `40c72f9222890d44eb90db8dcea272923c820e2d`，最新 durable diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 仍是 `changes-requested`。
- Fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` 仍含 slot/flat-phase scheduler 与 lazy `ensureRuntimeClosure`，且没有 `scripts/issue-698-integration.ts`；`.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` 在 checkout 与 `origin/main` 均仍禁止本 issue 所需的 v3 `src/`/`scripts/` 实现。
- #698 的 structural closing-PR 列表仍穷尽且为空；其 31 条 comments 中最后一条就是 current marker，没有后续 operator correction。

本轮不创建混入 #737/#739/#743/#560、stack 在 #749、或绕过 repository rule 的 PR，也不把 route 改写成 no-change/spike。需要先让 marker 声明的 producer/closure interfaces 与 repository authorization 落到候选 base，或由 operator-authoritative source 改变交付 route；在此之前应返回 contract enrichment，而不是继续 iteration。



### comment #5015470516 by `RiriAgent` — 2026-07-19T11:04:48Z
_(last edited 2026-07-23T07:35:35Z)_

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`. Complete issue-comment and timeline pagination was exhausted immediately before publication; no attachments, sub-issues, structural dependency edges, or structural closing PR were present.
- Inherited operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (task-closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure lifecycle and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (`drain`/validator join boundary).
- Scope handoff used: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Direct operator-comment URLs on #698: none. All direct comments are phase-generated contract markers or workflow reports; they are execution history, not intent sources.
- Local source inspected rather than GitHub blobs: fetched `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c`; assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d`, equal to the live head of adjacent PR https://github.com/mouriya-s-lab/coder-loop/pull/749; target checkout `/Users/mouriya/Ext/work/coder-loop-v3/issue-546@9ac3b87d336a04a564a40fa3ce9163d361e86b40`. Repository instructions, package/test entry points, source, tests, central queue state, dependency issues, and complete PR #749 comments/reviews/threads/check/timeline state were read locally.

## Deliverable

`implementation-pr`

Create exactly one implementation PR targeting `main`, with body first line `Closes #698`, from an authorized base containing the producer interfaces listed in `Dependencies`. Through the public daemon/CLI create and completion surfaces, instantiate the compiled immutable runtime tree before dispatch and replace repo-slot/flat-phase scheduling with committed-transition-driven recursive `seq`/`par` traversal, true same-repository parallelism, structural `drain`, closure-keyed single activity, first-expansion pins, declared global/per-par limits, dependency gating, and failure containment.

Do not implement #737/#739/#743 inside #698, absorb adjacent PR #749, or implement #700 validator judgment, #701 correction/reopen and post-terminal reactivation, #702 runtime materialization, #704 cancellation, #705 top-level join, #706 bundled phase-tree migration, GUI, deployment, or release-wide #684/#685 validation. This remains `implementation-pr` because #698 requests the scheduler implementation itself; it is not a blocker-removal or writing-spike issue.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean checkout at the exact candidate SHA based on then-current `main`; env is local macOS with Bun and Git on `PATH`; fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 share one canonical driver execution per candidate SHA, whose transcript exposes separately labeled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; before any runner starts, the public create path persists the immutable minimal runtime tree and `coder-loop status --json` exposes its definition/runtime identities plus the initial ready leaf. Setup neither calls `createTaskTree` nor mutates SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and missing known-required external binding each make the public completion CLI exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and naked status/terminal writes do not advance the cursor. One legal typed submission atomically writes exactly one transition, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates neither a duplicate transition nor a duplicate B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the complete tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to landed closure create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event, and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all entry closures of that par use the exact pin without per-member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absence of a global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` plus a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to tree structure, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run persistence consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, transition, and mutation effect crosses the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list is empty. Separately map any retired flat/slot assertion to its equal-or-stronger replacement. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; the log ends with `FINAL exit=0`; all scheduler integration files execute, including new/migrated tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/main...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){issue(number:698){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state isDraft headRefName headRefOid baseRefName mergedAt closedAt url body}}}}}'` | candidate root; authenticated `gh`; after submit | Exit 0; `hasNextPage=false`; exactly one open closing PR exists for #698, targets `main`, its body begins `Closes #698`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. Historical prose and offline migration/cleanup code outside scheduler/daemon are excluded; no runtime scheduling or concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. Historical prose is excluded; no second runtime flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Migration code outside `src` is excluded; no run-persistence materialization path is excluded. |
| `-e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\bINSERT\b' -e '\bUPDATE\b' -e '\bDELETE\b' -e '\bREPLACE\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision based on the authorized, prerequisite-complete `main`; run `bun install --frozen-lockfile` in the candidate root.
- Start: the target-mandated issue driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, compiled declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root>`; and creates chains/items only through public `chain create` and `item add` commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, and process exit beneath the issue evidence directory. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains and reports a named diagnostic root rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its current two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility.

Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement preserves the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Component fixtures may continue using typed store setup where their own boundary requires it, but the canonical #698 driver may not replace public setup with `createTaskTree` or direct persistence mutation.

## Dependencies

- **Landed foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs https://github.com/mouriya-s-lab/coder-loop/pull/675 and https://github.com/mouriya-s-lab/coder-loop/pull/678 and are present on `origin/main`.
- **Typed path/declaration producers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 are open with exhausted, empty structural closing-PR lists. #737 owns the typed `exit.*`/required/default binding flow; #739 depends on #737, owns recursive task/path declarations and compile guards, and explicitly blocks #698. #698 consumes those public products and must not add a scheduler-private fallback schema, duplicate parser, or untyped transition object.
- **Immutable definition producer:** https://github.com/mouriya-s-lab/coder-loop/issues/743 is open with an exhausted, empty structural closing-PR list and explicitly blocks #698. Public runtime instantiation must consume its landed definition-ref creation/resolution surface; the closed historical source https://github.com/mouriya-s-lab/coder-loop/issues/605 does not satisfy #743.
- **Adjacent closure execution fact:** https://github.com/mouriya-s-lab/coder-loop/issues/560 is open. Its sole open closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 is non-draft, mergeable/clean, targets `main`, and has head `40c72f9222890d44eb90db8dcea272923c820e2d`; exhaustive state shows 58 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. Its latest durable diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 still records one blocking implementation mechanism, and central state marks #560 `exhausted`. #698 delegates closure create/reopen/resume/consume/single-activity behavior to the landed interface and must not absorb or extend PR #749.
- **Repository authorization blocker:** `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10`, mirrored at `AGENTS.md:203-206`, currently forbids v3 implementation in `src/`, `scripts/`, `presets/`, and `docs/`; #698 necessarily changes `src/` and adds a script. This marker records the checked-in rule but does not authorize removing or bypassing it. Implementation requires an operator-authoritative rule change on the candidate base or an explicitly authorized implementation repository/branch.
- **Current source gap:** assigned worktree `40c72f9222890d44eb90db8dcea272923c820e2d` compiles only a degenerate phase seq (`src/loop.ts:780-782,864-874`), creates chains/items without a runtime tree (`src/daemon.ts:2167-2230,2895-2945`), selects through repo slots and a flat phase plan (`src/scheduler.ts:149-167,519-706,866-868`), and lazily materializes task identities from `recordRun` (`src/sqlite-state.ts:1844-1850,2158-2202`). Public exits expose status/action choices but not #737's future typed path object (`src/daemon.ts:3290-3331`). `src/task-runtime.ts` and the SQLite task-tree API are landed persistence/status shapes to consume, not acceptance setup shortcuts; `scripts/issue-698-integration.ts` does not exist.
- **Central runtime ordering gap:** live `coder-loop item list v3-546 --json` shows #698 selected as `contract_invalid` with no dependency record; #560 is terminal `exhausted`, while #737/#739/#743 are absent from the chain. Contract enrichment cannot mutate operator-owned queue topology or turn external prerequisites into item edges.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and release checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. The issue-specific real daemon/CLI driver is the strongest runtime path.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015419603




### comment #5015503292 by `RiriAgent` — 2026-07-19T11:16:29Z

**[iteration] contract invalid @ 7172d3e** — #698 still has no authorized, prerequisite-complete implementation base

Current marker: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015470516 (`Deliverable=implementation-pr`). Live rejoin shows #737/#739/#743 are open with exhausted empty structural closing-PR lists; #739 and #743 explicitly block #698. #560 is also open, and its only open closing PR https://github.com/mouriya-s-lab/coder-loop/pull/749 remains at `40c72f9222890d44eb90db8dcea272923c820e2d` with a blocking current diff audit: https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515.

Freshly fetched `origin/main` is `7172d3e8af37fadab5624ef155dbc9e6ef19a40c`. It still contains repo-slot/flat-phase scheduling and lazy runtime-closure materialization, lacks `scripts/issue-698-integration.ts`, and `.claude/rules/v2-only-no-v3-divergence.rule.md:7-10` still forbids the required v3 edits in `src/` and `scripts/`. The assigned checkout is PR #749's head, so using it would additionally absorb the open #560 diff.

No CandidateRef or PR was created: any current candidate would violate the marker by duplicating/absorbing #737/#739/#743/#560 and bypassing repository-path authorization. Re-enrichment must keep #698 outside iteration until those producers and the closure interface land and the required implementation path is authoritatively allowed, or must change the deliverable route explicitly.



### comment #5055602886 by `RiriAgent` — 2026-07-23T07:23:32Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#698 承接 #559 seq/par 树调度）相对 baseline 的进度

- **已落地**: 无。baseline 49 commit 集中在 #699 闭包生命周期，`src/scheduler.ts` +946 行改动全部围绕 closure lifecycle/reachability/cleanup，**没有树遍历、seq 游标、par 真并发或 slot 退役的引入**。
- **半成品**: 单活性执法键从 slot 切换到闭包的**底座**已在 `src/closure-lifecycle.ts` (+221)、`src/sqlite-state.ts` task-tree schema (+325) 上就绪，可作为 spawn 决策改造的基础；但决策路径本身未改（`schedulerSlotKey` 未退役）。
- **未开始**: 本 issue 验收清单全部 — seq 游标推进树遍历、par 真并发（含嵌套）、`schedulerSlotKey` 退役（grep 命中应为零）、单活性执法键 = 闭包重立、par 展开 pin 写入（含嵌套内层重 pin）、并发上限（全局 + per-par）纯限流参数、dependsOn 与树正交、失败不上溯、v2 线性零回归、类型化路径完成协议（`committed transition` 协议）。

### iteration agent

从 baseline checkout，只补上面「未开始」的差量。PR base = `coder-loop/v3-546-baseline`。



### comment #5055716832 by `RiriAgent` — 2026-07-23T07:35:26Z

<!-- coder-loop:executable-contract schema=1 source-issue=698 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/698
- Observed issue-body update: GraphQL `Issue.lastEditedAt=2026-07-18T06:19:38Z`, editor `RiriAgent`; `comments.pageInfo.hasNextPage=false`, `subIssues.pageInfo.hasNextPage=false`, and `closedByPullRequestsReferences.pageInfo.hasNextPage=false` were re-read for the current 35-comment issue before publication.
- Current chain/base directive: https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5055602886 fixes the implementation base at `coder-loop/v3-546-baseline@d67fec5bf245616e1a0bd67508a443e5842c2722`, says the old chain/PR are not to be modified, records that the closure-lifecycle foundation is present but every #698 scheduler/transition acceptance item is unimplemented, and directs the iteration agent to implement only that delta with a PR targeting `coder-loop/v3-546-baseline`.
- Inherited completion protocol: https://github.com/mouriya-s-lab/coder-loop/issues/451 and https://github.com/mouriya-s-lab/coder-loop/issues/452 establish typed exit discovery plus CLI state-write completion and make runner exit non-authoritative.
- Inherited operator decisions used: https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4932303885 (closure granularity and one-live-run invariant), https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4934666406 (persistent closure lifecycle and Git supply clauses), and https://github.com/mouriya-s-lab/coder-loop/issues/546#issuecomment-4937852021 (`drain` versus validator/join boundary).
- Scope handoff used: https://github.com/mouriya-s-lab/coder-loop/issues/559#issuecomment-5007117124 assigns public-entry `seq`/`par`/`drain` scheduling to #698 and post-terminal leaf reactivation to https://github.com/mouriya-s-lab/coder-loop/issues/701.
- Local source inspected instead of GitHub blobs: assigned checkout and `origin/coder-loop/v3-546-baseline` both equal `d67fec5bf245616e1a0bd67508a443e5842c2722`; `origin/main=7df84f630bf7081983ea0ac290278749b2bd59ba`. Repository rules, build/test drivers, public CLI help, scheduler/daemon/SQLite/task-runtime paths, live central chain state, and the complete metadata/comments/timeline/review-thread/check state of the explicitly retired PR https://github.com/mouriya-s-lab/coder-loop/pull/749 were inspected.

## Deliverable

`implementation-pr`

Create exactly one new implementation PR from a #698 branch based on `coder-loop/v3-546-baseline@d67fec5bf245616e1a0bd67508a443e5842c2722`, targeting `coder-loop/v3-546-baseline`, with body first line `Closes #698`. Do not reuse, update, rebase, or close old PR https://github.com/mouriya-s-lab/coder-loop/pull/749.

The implementation must instantiate the immutable runtime task tree through the public daemon/CLI create path before any runner dispatch; make recursive `seq`/`par` readiness and structural `drain` the scheduler authority; retire repo-slot and flat phase-plan scheduling; dispatch against closure lifecycle/single-activity state; persist first-expansion par pins; apply declared global/per-par limits; preserve orthogonal dependency gating, attempts/backoff, and failure containment; and extend typed exit discovery/submission so only one validated committed transition can atomically complete a leaf and construct its declared successor invocation. Runner exit, stdout, or a naked terminal/status write must not synthesize a transition or advance `seq`.

This issue does not implement validator judgment (#700), post-terminal reactivation/correction/reopen decisions (#701), runtime par materialization (#702), cancellation (#704), top-level chain join (#705), bundled phase-tree migration (#706), GUI, deployment, or release compatibility validation (#685). The general-purpose work tracked by #737/#739 remains independently open; #698 implements only the public-entry/typed-transition slice demanded by its body and the later chain-base directive and does not claim those issues complete.

## Checks

All rows are `shell`; #698 has no browser/UI surface. Unless a row says otherwise, cwd is a clean checkout at the exact candidate SHA based on `coder-loop/v3-546-baseline`; env is local macOS with Bun and Git on `PATH`; fixture repositories, loop-data roots, sockets, worktrees, refs, runner shims, chain names, logs, and evidence paths are UUID-isolated from production `~/.coder-loop`. C01-C11 are one canonical driver execution whose transcript exposes separately labelled observations for every ID.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | integration | shell | `bun scripts/issue-698-integration.ts` | candidate root; isolated real daemon/socket; public `chain create` and `item add` only | Exit 0; before any runner starts, public creation persists the immutable minimal runtime tree and `coder-loop status --json` exposes its definition/runtime identities plus the initial ready leaf. Setup neither calls `createTaskTree` nor mutates SQLite directly. |
| C02 | function | shell | `bun scripts/issue-698-integration.ts` | same run; public exit query/submission for `seq(A,B)` | Exit 0; missing required `exit.*`, wrong field type, illegal path, and missing known-required external binding each make the public completion command exit nonzero; no transition is written, A is not complete, and B does not exist or become ready. |
| C03 | function | shell | `bun scripts/issue-698-integration.ts` | same `seq(A,B)` fixture | Exit 0; runner exit, stdout text, and naked status/terminal writes do not advance the cursor. One legal typed submission atomically writes exactly one transition record, completes A, constructs the declared successor invocation from authoritative bindings, and makes B the only ready leaf; replay creates neither a duplicate transition nor a duplicate B. |
| C04 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; one `par` has at least two leaves in one chain and one `repoCwd`; deterministic runners hold overlap | Exit 0; two runs are simultaneously live and their persisted `started_at`/`ended_at` intervals overlap. Repo/slot identity neither decides readiness nor serializes the leaves. |
| C05 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; `seq(leaf, par(leaf, par(leaf, leaf), join=drain), leaf)` | Exit 0; every tick's spawn set equals the recursively ready leaf set. Inner and outer `drain` complete only after all direct members are terminal; the outer seq then advances and the complete tree reaches terminal. |
| C06 | function | shell | `bun scripts/issue-698-integration.ts` | same run; absent, suspended, active/no-live-run, active/live-run, and consumed closure records | Exit 0; scheduler decisions delegate respectively to create, reopen, resume, deny-second-live-run, and never-spawn behavior. The denial emits an identity-bearing audit event, and every closure has at most one live run. |
| C07 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; first-open outer `par` and nested `par` over an origin-backed local Git fixture | Exit 0; each par persists its base pin before member-closure creation, all entry closures of that par use the exact pin without per-member fetch, and the nested par independently pins before creating inner closures. Runtime append/no-repin is not claimed here. |
| C08 | function | shell | `bun scripts/issue-698-integration.ts` | same run; par of three with per-par limit 2; two chains with global limit 1; separate no-global-limit case | Exit 0; active counts never exceed declared limits, all leaves eventually run, and absence of a global declaration adds no engine default cap. Limit values come only from declared metadata. |
| C09 | integration | shell | `bun scripts/issue-698-integration.ts` | same run; cross-structure `dependsOn` plus a separate public write introducing a cycle | Exit 0; dependency gating stays orthogonal to tree structure, releases a not-yet-advanced leaf only after every dependency reaches declared success, and rejects the cycle before persistence. It does not reactivate an already-advanced leaf (#701). |
| C10 | function | shell | `bun scripts/issue-698-integration.ts` | same run; drain par with one attempts-exhausted member and successful siblings | Exit 0; siblings continue, attempts/backoff/exhaustion semantics survive, failure does not automatically propagate to the container/ancestors, and `drain` completes when every member is terminal. |
| C11 | regression | shell | `bun scripts/issue-698-integration.ts` | same run; existing linear declaration normalized to a degenerate seq | Exit 0; public execution preserves phase order, status admission, retry/session, attempts/backoff, chain completion, observability, and cleanup through one transition/tree scheduler. The transcript names C01-C11, exact source SHA, runtime UUID, and owned evidence paths. |
| C12 | assumption | shell | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` | candidate root | Exit 1 with no matches; repo-slot state no longer selects or serializes work. |
| C13 | assumption | shell | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` | candidate root | Exit 1 with no matches; recursive task/transition traversal is the sole scheduler model. |
| C14 | assumption | shell | `rg -n '\bensureRuntimeClosure\b' src` | candidate root | Exit 1 with no matches; run persistence consumes an already-created leaf/closure identity and never lazily materializes the runtime tree. |
| C15 | assumption | shell | `rg -n -e 'createTaskTree\(' -e '\b(INSERT|UPDATE|DELETE|REPLACE)\b' scripts/issue-698-integration.ts` | candidate root | Exit 1 with no matches. Read-only `SELECT` may corroborate interval/record counts, but every creation, transition, and mutation effect crosses the public daemon/CLI path. |
| C16 | type | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics across declaration consumption, traversal, readiness, dispatch, transition, and drain ADTs. |
| C17 | regression | shell | `bun test` | candidate root after frozen install | Exit 0 with no failures. Report base/head totals and enumerate removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened tests; the integrity-loss list is empty. Separately map every retired flat/slot assertion to an equal-or-stronger replacement. |
| C18 | integration | shell | `bun scripts/run-tests.ts --batch integration-scheduler --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546-v2/evidence/698/integration-scheduler.log --foreground` | candidate root after frozen install | Exit 0; the log ends with `FINAL exit=0`; every scheduler integration file executes, including new/migrated tree, transition, overlap, limit, dependency, and drain scenarios. |
| C19 | landing | shell | `git diff --check origin/coder-loop/v3-546-baseline...HEAD` | clean candidate root | Exit 0 with no output. |
| C20 | publication | shell | `gh pr list --repo mouriya-s-lab/coder-loop --state open --base coder-loop/v3-546-baseline --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,body --jq '[.[] \| select(.body \| startswith("Closes #698"))]'` | candidate root; authenticated GitHub CLI; after submit | Exit 0; the JSON array has length 1; that PR is open, targets `coder-loop/v3-546-baseline`, and its live head branch/SHA equal the current CandidateRef. |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `-e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots'` | whole-tree | `rg -n -e '\bSchedulerSlot\b' -e '\bschedulerSlotKey\b' -e '\bgetOrCreateSlot\b' -e '\bhasActiveSlotForChain\b' -e 'state\.slots' src/scheduler.ts src/daemon.ts` must exit 1 with zero matches. Historical prose and offline migration/cleanup outside scheduler/daemon are excluded; no runtime scheduling or concurrency-decision site is excluded. |
| `-e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b'` | whole-tree | `rg -n -e '\bSchedulerPhasePlan\b' -e '\bbuildPhasePlanFromPreset\b' -e '\bresolvePhasePlanForChainWithItems\b' -e '\bselectNextItemAndPhase\b' -e '\bnextNonTriggerPhaseForItem\b' src/scheduler.ts src/daemon.ts src/loop.ts` must exit 1 with zero matches. Historical prose is excluded; no second runtime flat phase-order selector is excluded. |
| `\bensureRuntimeClosure\b` | whole-tree | `rg -n '\bensureRuntimeClosure\b' src` must exit 1 with zero matches. Migration code outside `src` is excluded; no run-persistence materialization path is excluded. |
| `-e 'createTaskTree\(' -e '\b(INSERT|UPDATE|DELETE|REPLACE)\b'` | changed | `rg -n -e 'createTaskTree\(' -e '\b(INSERT|UPDATE|DELETE|REPLACE)\b' scripts/issue-698-integration.ts` must exit 1 with zero matches. Read-only `SELECT` used solely to corroborate public-runtime evidence is excluded. |

## Canonical runtime

- Setup: use the exact candidate revision based on `coder-loop/v3-546-baseline@d67fec5bf245616e1a0bd67508a443e5842c2722`; run `bun install --frozen-lockfile` in the candidate root.
- Start: the issue-specific driver is `bun scripts/issue-698-integration.ts`. It creates UUID-isolated Git fixtures, declaration/transition fixtures, loop-data roots, sockets, evidence paths, and deterministic runner shims; starts the real source entry `bun src/loop.ts daemon up --loop-data-root <root>`; and creates chains/items only through public CLI commands.
- Readiness: require the daemon PID alive, its isolated Unix socket accepting `daemon status`, and `coder-loop status --json` exposing the expected immutable definition identity, runtime-tree identity, and initial ready leaf before releasing a runner.
- Behavior: execute C01-C11 through public creation, exit-query, typed-transition submission, status, and log surfaces. Read-only SQLite queries may corroborate counts/intervals; they are never action paths. For this non-UI issue, the exact-SHA CLI transcript is the strongest Layer 4 evidence; screenshots are not applicable.
- Logs: retain source SHA, runtime UUID, readiness record, create responses, exit schemas, rejected/accepted submissions, ready sets, active intervals, transition records, pins, limits, status trees, observability events, teardown, command exit, and driver output beneath `/Users/mouriya/.coder-loop/loop-data/chains/v3-546-v2/evidence/698/`. Never record secrets.
- Stop ownership: the driver terminates every daemon/runner it starts, removes only its owned loop-data root/worktrees/engine refs, and asserts that no owned PID, socket, worktree, ref, or runtime root remains. On failure it retains and reports a named diagnostic root rather than deleting evidence.
- Verification boundary: `bun scripts/engine-integration.ts` is not a #698 gate because its two-phase linear stub path does not execute this issue's recursive behavior and #698 does not name it. 本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## Test delta

`required`

Add focused unit/component coverage under `tests/unit/**`, scheduler integration coverage under `tests/integration/scheduler/**`, and `scripts/issue-698-integration.ts` as the real-process public-entry driver. Required coverage includes public instantiation, transition validation/atomicity/idempotency, recursive readiness, closure-keyed single activity, same-repository par overlap, drain, pins, limits, dependency gating/cycle rejection, failure containment, and degenerate-seq compatibility.

Existing assertions survive unless they encode explicitly retired repo-slot serialization, runner-exit/flat-phase advancement, or lazy run-time tree materialization; every replacement preserves the original safety property while proving the stronger tree/transition behavior. Tests may not be removed, skipped, `.only`/`.todo`-selected, timeout-relaxed, or weakened merely to pass. Component fixtures may continue using typed store setup where their own boundary requires it, but the canonical #698 driver may not replace public setup with `createTaskTree` or direct persistence mutation.

## Dependencies

- **Current base and route:** live `coder-loop chain status v3-546-v2 --json` reports active chain `v3-546-v2`, base `coder-loop/v3-546-baseline`, and all 12 items queued; `coder-loop item list v3-546-v2 --json` reports #698 first with no `dependsOn`, while #699 depends on #698. The later operator comment https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5055602886 is therefore the current ordering/base authority.
- **Baseline foundation:** local `git fetch origin coder-loop/v3-546-baseline` resolves both the assigned checkout and remote base to `d67fec5bf245616e1a0bd67508a443e5842c2722`. It contains the closure lifecycle, per-closure worktree/session/reachability foundation, task-tree persistence/status shape, and closure-keyed `active_runs` storage that #698 consumes.
- **Retired old PR:** https://github.com/mouriya-s-lab/coder-loop/pull/749 remains open, non-draft, mergeable/clean, targets `main`, and has head `d67fec5bf245616e1a0bd67508a443e5842c2722`; complete pagination shows 97 issue comments, zero submitted reviews, zero review threads, zero check runs, and zero status contexts. It is baseline provenance only and must not be used as #698's implementation PR.
- **Landed inherited foundations:** https://github.com/mouriya-s-lab/coder-loop/issues/451 and https://github.com/mouriya-s-lab/coder-loop/issues/452 are closed by merged PRs #491/#500. https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/issues/601 are closed by merged PRs #675/#678 and are ancestors of the baseline. Historical declaration/definition sources https://github.com/mouriya-s-lab/coder-loop/issues/554 and https://github.com/mouriya-s-lab/coder-loop/issues/605 are closed.
- **Open general-purpose producers:** https://github.com/mouriya-s-lab/coder-loop/issues/737 and https://github.com/mouriya-s-lab/coder-loop/issues/739 remain open with exhausted empty structural closing-PR lists. The current #698 body names them as dependencies, while the later chain-start directive explicitly includes the typed committed-transition delta in #698. This contract permits only the minimal #698 acceptance slice needed for public instantiation/scheduling and does not authorize closing those issues or absorbing their unrelated general binding/compiler acceptance.
- **Current implementation gap:** `src/loop.ts:780-874` compiles only a degenerate phase seq; `src/daemon.ts:2166-2229` and `src/daemon.ts:2887-2937` create chains/items without a runtime tree; `src/scheduler.ts:492-712,872-874,2995-3030` selects through repo slots and a flat phase plan and advances on `latestRun.exitCode === 0`; `src/sqlite-state.ts:1643-1648,2292-2336` lazily creates the task tree/closure while recording a run; `src/daemon.ts:3293-3323` exposes status/action exits but no typed path payload or committed-transition record. `scripts/issue-698-integration.ts` does not exist.
- **Scope boundary:** https://github.com/mouriya-s-lab/coder-loop/issues/700 owns validator/join judgment; https://github.com/mouriya-s-lab/coder-loop/issues/701 owns correction/reopen and already-advanced leaf reactivation; #702/#704/#705/#706 and compatibility checkpoint #685 remain outside #698.
- **External runtime:** no browser, UI, deployment, IaC, or new secret is required. Local Git fixtures plus the issue-specific real daemon/CLI driver are the strongest runtime path; GitHub access is required only to publish/review the new PR.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/698#issuecomment-5015470516



---

## Timeline (61)

- 2026-07-17T20:13:13Z `assigned` @RiriAgent
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:07Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:26Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:14:52Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:38:45Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:38:54Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:39:05Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:39:10Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-18T07:40:28Z `commented` @RiriAgent
- 2026-07-18T17:02:27Z `commented` @RiriAgent
- 2026-07-19T05:49:19Z `commented` @RiriAgent
- 2026-07-19T05:57:50Z `commented` @RiriAgent
- 2026-07-19T06:21:31Z `commented` @RiriAgent
- 2026-07-19T06:28:33Z `commented` @RiriAgent
- 2026-07-19T06:45:05Z `commented` @RiriAgent
- 2026-07-19T06:51:24Z `commented` @RiriAgent
- 2026-07-19T07:03:23Z `commented` @RiriAgent
- 2026-07-19T07:08:53Z `commented` @RiriAgent
- 2026-07-19T07:31:28Z `commented` @RiriAgent
- 2026-07-19T07:37:50Z `commented` @RiriAgent
- 2026-07-19T07:47:14Z `commented` @RiriAgent
- 2026-07-19T07:52:11Z `commented` @RiriAgent
- 2026-07-19T08:06:06Z `commented` @RiriAgent
- 2026-07-19T08:12:25Z `commented` @RiriAgent
- 2026-07-19T08:24:38Z `commented` @RiriAgent
- 2026-07-19T08:30:20Z `commented` @RiriAgent
- 2026-07-19T08:39:33Z `commented` @RiriAgent
- 2026-07-19T08:48:05Z `commented` @RiriAgent
- 2026-07-19T09:05:31Z `commented` @RiriAgent
- 2026-07-19T09:11:43Z `commented` @RiriAgent
- 2026-07-19T09:23:08Z `commented` @RiriAgent
- 2026-07-19T09:30:53Z `commented` @RiriAgent
- 2026-07-19T09:42:07Z `commented` @RiriAgent
- 2026-07-19T09:49:32Z `commented` @RiriAgent
- 2026-07-19T10:02:56Z `commented` @RiriAgent
- 2026-07-19T10:10:24Z `commented` @RiriAgent
- 2026-07-19T10:26:59Z `commented` @RiriAgent
- 2026-07-19T10:34:28Z `commented` @RiriAgent
- 2026-07-19T10:46:44Z `commented` @RiriAgent
- 2026-07-19T10:55:54Z `commented` @RiriAgent
- 2026-07-19T11:04:48Z `commented` @RiriAgent
- 2026-07-19T11:16:29Z `commented` @RiriAgent
- 2026-07-23T07:23:32Z `commented` @RiriAgent
- 2026-07-23T07:35:26Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T03:58:31Z `referenced` @RiriAgentcommit=eb25dd6900c7e7b04ee8c14b8a28dc10ccbeb117
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-26T16:13:57Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T23:49:12Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-27T04:27:10Z `cross-referenced` @RiriAgentsrc=737