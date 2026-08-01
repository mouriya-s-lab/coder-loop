# #699 feat(scheduler): 任务闭包资源生命周期与 Git supply

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:15Z  | updated: 2026-07-27T04:26:49Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/699
- comments: 2  | timeline events: 27

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

在线性公开生产路径交付 per-(item,phase) closure create/suspend/reopen/consume、worktree/branch/session、起点、对账及本 issue 钉死的可执行验收契约；不要求 par scheduler、reopen decision producer 或 preset 改写。

任务闭包（= 同一 (item, phase) 的 attempt 链）的 worktree 生命周期机制落地：

- **create**：首次打开时创建 worktree 与闭包分支。
- **suspend**：只把调度态从 active 写为 suspended；worktree、分支、index、未提交文件、session、scratch 全部原地保留，禁止任何 GC。
- **reopen**：同一闭包原地恢复 active；零重建、零还原。
- **consume**：只有控制流证明闭包不可能再被合法 resume/reopen 命中时才成立；此后才回收 worktree/分支、清 sessionIds、发消费证据。

外加：钉死可计算的消费谓词；git 操作不阻塞 daemon 主线程；daemon 启动状态对账替代扫尸。

## 范围边界

本 issue 在 v2 引擎上、基于已在 `main` 的 v3 task-closure shape 交付 per-`(item, phase)` 任务闭包资源生命周期；不实现 #698 树调度、#701 reopen 控制流、#702 运行中物化、#703 join binding 写入 API、#707 preset 改写，也不承担 #684 跨 issue 整链路 integration 与 #685 bundled preset compatibility E2E。

## 预期结果

- 性质：任意两个任务的 worktree 路径互不相同（含同 item 先后 phase、同 repo 并发分支）；每闭包一条引擎创建的工作分支；cwd/index/HEAD/WIP/session/scratch 是闭包私有现场。对象库、remote-tracking refs、refs 物理存储、repo config/hooks 与 linked-worktree metadata 仍是 repo 级共享 Git 协调面，不冒充任务私有状态；业务状态只经 origin/GitHub 声明通道流动。
- **create**：底座 = 创建时刻 base 快照（创建前 fetch，per-repo 串行化/去重，网络失败显式化为事件不静默降级）；par 成员从 pin 派生免 fetch；闭包分支由引擎创建，命名在引擎命名空间内 per-闭包唯一。保存的 base SHA/par pin 是稳定输入；共享 `origin/*` 只是会随合法 fetch 前移的当前远端观察。
- **suspend**：phase 推进离开触发；只写 suspended 状态并发事件，worktree/分支/index/未提交文件/session/scratch 原地不动。单次 run 中断不触发挂起。
- **reopen**：原闭包原地切回 active；不创建、不删除、不 checkout、不 stash、不 commit。
- **consume**：仅在消费谓词成立后触发；回收 worktree/闭包分支、清该 phase `sessionIds`、发消费证据 `{无工作, 已发布, 未发布即弃, 无法求值}` + origin 新鲜度戳。
- **启动状态对账**：枚举磁盘 worktree 目录 + 引擎命名空间分支，对照闭包状态表——active/suspended→目录与分支都该在；consumed→都不该在；每处不一致发可审计事件，修复动作限引擎自己命名空间；同时核对 repo config/hooks 的引擎合同，漂移显式暴露、不静默继承任务留下的修改。
- **共享 Git 协调协议**：引擎的 fetch/create/consume/worktree 管理 per-repo 串行化；active/suspended 存在时不做显式 `git gc`；引擎只改自身 branch/pin/worktree namespace。任务修改 repo config/hooks、他闭包 refs/pin，或执行破坏性 `gc/repack/prune/worktree remove|prune|repair` 不在合法合同内。
- worktree git 操作不阻塞 daemon 主线程：git 操作进行期间 socket 请求照常应答。

## 已钉死的决策项

- **消费谓词（C00）：** closure `C` is consumable iff it is `active|suspended`, has no active run, and is absent from the least fixed point of every legal present-or-future resume/reopen edge in the persisted runtime tree. Seeds include its resumable attempt chain, decided-but-unconsumed reopen targeting `C` or an ancestor scope containing it, reachable seq suffixes whose legal target scope includes it, open par containers that can enter another epoch, open runtime-append places that can materialize such a target scope, and materialized par next-epoch candidate bindings that can legally reopen it. A scope seals only when its relevant seq continuations cannot run/recede, relevant par containers are `completed|exhausted` with no next epoch, decided reopens are consumed, and no open append/mutation authority can introduce a target edge. Item terminal, budget exhaustion, cancellation, current `drain`, or missing disk resources alone are never proof. Reachability recheck, `active|suspended -> consumed`, session clearing intent and append/reopen/join-binding writes share one serialization boundary; the winner determines whether the closure is retained or later writes receive a typed conflict. `consumed` is irreversible. Sources: [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546), [`closure-lifecycle-decision.md` lines 38-58](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/v3/closure-lifecycle-decision.md#L38-L58), and current-main [`task-runtime.ts`](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/src/task-runtime.ts#L13-L58).
- **C00 runtime mutation relation:** runtime append adds new work and does not itself reactivate an old closure, but an open append place keeps that closure reachable when it can still materialize a legal reopen issuer whose structural target scope contains it. A decided `reopen(target, corrections)` is consumed atomically under its sampled binding; it activates the original target closure and append-only corrections survive later join evolution. Definition joins are immutable for the instance. Materialized join evolution appends binding versions, cannot alter an in-flight epoch, and affects only a next epoch; therefore every legally installable candidate counts while a next epoch remains possible, and no binding mutation can resurrect a closure after the par control domain seals. Sources: [`join-evolution-decision.md` lines 11-18 and 39-58](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/v3/join-evolution-decision.md#L11-L58) and #546.
- **C00 no-origin rule:** if `origin` exists, fetch and resolve only `origin/<baseBranch>`; fetch/resolve failure is typed and audited with no fallback. If `origin` is absent, do not reject target/chain load: `doctor` emits WARN, create resolves only verified local `refs/heads/<baseBranch>^{commit}`, persists that SHA as the stable base, and records freshness as `no-origin/unavailable`. If the local base branch is absent, creation fails with a typed error. `HEAD` is never a fallback. Source: [`closure-lifecycle-decision.md` line 68](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/v3/closure-lifecycle-decision.md#L68).

## 实现事实与边界

- **Satisfied hard dependency:** #558 is closed and its implementation [PR #675](https://github.com/mouriya-s-lab/coder-loop/pull/675) merged as `9ac3b87d336a04a564a40fa3ce9163d361e86b40`. The merged shape provides `task_closures`, `closure_sessions`, closure-keyed active runs, par pin/binding/evaluation records, and `setClosureLifecycle` / `setClosureResources`; it intentionally does not implement 本 issue scheduler lifecycle.
- **Current-main implementation facts:** [`src/scheduler.ts`](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/src/scheduler.ts#L843-L951) still creates one slot worktree/branch per `chain × repoCwd`, cleans/prunes at chain scope, and [`chooseWorktreeStartRef`](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/src/scheduler.ts#L2702-L2707) still falls through to `HEAD`; the Git helper is synchronous at lines 2743-2753. [`src/daemon.ts`](https://github.com/mouriya-s-lab/coder-loop/blob/9ac3b87d336a04a564a40fa3ce9163d361e86b40/src/daemon.ts#L2296-L2368) reconciles stale runs only, not closure resources/config/hooks. Compatibility provisioning currently assigns each materialized phase closure the same incoming slot resource identity, so changing only the visible scheduler cwd is insufficient.
- **Shape boundary:** current-main has no #701 reopen-decision writer or #702/#703 mutation API. This PR implements the pure reachability algebra, serialized consume/recheck boundary, current scheduler lifecycle calls and fixtures that seed those future-writer states; it must not invent the later producer APIs or add a fourth closure lifecycle state.
- **Deferred verification:** open #684 owns frozen-SHA cross-v3 integration and open #685 owns bundled GitHub real E2E. Their absence does not authorize replacing C01-C10 with the old linear preset or running `real-e2e.ts` here.
- No browser, external service, production credential, deployment, or IaC dependency exists for 本 issue's local deterministic runtime.

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | per-闭包隔离（#546 行 7） | 真跑一条两 phase 链，从 runs/events 取两 phase（两闭包）的 worktree 路径与分支比对 | local | 路径互不相同；分支互不相同且均为引擎命名空间 |
| function | 起点公理（#546 行 13） | 创建前在 origin 侧推进 base，观察新闭包底座 commit；断网/坏 remote 下创建 | local | 底座 = fetch 后的 origin base 尖端；网络失败显式化为事件，无 HEAD 兜底 |
| function | 闭包分支程序化（#546 行 13） | 检查闭包创建后的分支存在性与 agent run 结束后 PR 的 headRef | local | 分支由引擎建（run 开始前已存在）；PR headRef 即闭包分支 |
| function | 挂起/重开（#546 行 7） | 跑完一个 phase 触发推进（挂起），随后触发打回重入（重开）；比对挂起前后与重开后的路径、分支尖端、脏文件、session | local | 挂起前后目录、分支、index、tracked/untracked/ignored 文件与 session 均原地不变；重开只改变调度态，resume 成功 |
| function | 消费谓词与 GC（#546 行 7） | 先让 item terminal 但保持合法 reopen 可达，再让外层控制流完成使谓词成立；分别检查 worktree/分支/sessionIds | local | terminal 但未 consumed 时环境完整保留；谓词成立进入 consumed 后才回收目录/分支并清 sessionIds，消费证据可见 |
| function | par pin 派生（#546 行 14） | par 展开 ≥2 成员，比对各成员闭包底座 commit 与持久化 pin | local | 底座 commit 全部等于 pin；成员创建路径无独立 fetch |
| function | 启动状态对账（#546 行 15） | 人为构造磁盘/分支/DB 三方不一致（多目录、少分支、幽灵记录）后重启 daemon | local | 逐项核查、异常暴露为可审计事件、修复限引擎命名空间、不静默清理 |
| function | 主线程不阻塞 | 在多 chain 并发 spawn（worktree 操作密集）期间循环调 `coder-loop daemon status <target> --json` 计时 | local | 应答无 git 操作时长级别的停顿 |
| function | 同任务 resume 醒在原 worktree（#546 行 7） | 中断一次 run 触发同任务 resume（第二 attempt），查 resumed run 的 agentCwd 与 session 有效性 | local | agentCwd 等于上次 run 的 worktree 路径；session resume 成功；中断不触发挂起/回收 |
| integration | 共享 Git 协调面 | 建两个 active 闭包与一个 suspended 闭包；并发执行合同内 fetch/commit/push 后恢复 suspended 闭包，比对保存的 base SHA/par pin、分支、HEAD、index、tracked/untracked WIP；另修改 repo config/hooks 后重启对账 | local | `origin/*` 可前移且有新鲜度记录；三闭包稳定输入与私有现场不变；repo-wide 引擎操作串行且仅改自身 namespace；config/hooks 漂移发可审计事件 |
| assumption | 同步阻塞点消除 | `grep -n "spawnSync" src/scheduler.ts` | local | worktree 管理路径零命中 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 可执行验收（C01–C16）

All rows are `shell`; this issue has no browser/UI acceptance surface. Unless a row says otherwise, cwd is the issue-branch repository root, env is local macOS with Bun/Git on `PATH`, an isolated driver-owned `loop-data` root, a deterministic runner shim, and no production `~/.coder-loop` mutation.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | per-closure isolation | shell | `bun scripts/issue-560-integration.ts` | repo root; isolated runtime | Exit 0; a real two-phase chain exposes two different worktree paths and two different engine-namespace closure branches before runner spawn. |
| C02 | fresh base and fetch failure | shell | `bun scripts/issue-560-integration.ts` | repo root; fixture origin advanced before create, plus bad-remote and no-origin cases | Exit 0; origin-backed create starts at the post-fetch base SHA with serialized/deduplicated fetch; fetch failure is an auditable typed event with no fallback; a no-origin target uses only its verified local base branch and records unavailable freshness; no case falls back to `HEAD`. |
| C03 | engine-created closure branch | shell | `bun scripts/issue-560-integration.ts` | repo root; isolated runtime | Exit 0; the branch exists before runner spawn, is the run/PR head ref, is unique per closure, and remains the same through that closure's lifetime. |
| C04 | suspend and reopen continuity | shell | `bun scripts/issue-560-integration.ts` | repo root; deterministic runner creates tracked, untracked, ignored and index state | Exit 0; suspend changes only lifecycle/event state; reopen changes only `suspended -> active`; path, branch tip, HEAD, index, tracked/untracked/ignored WIP, scratch and closure session remain byte-identical and resume uses the same cwd/session. |
| C05 | consumption predicate and GC | shell | `bun scripts/issue-560-integration.ts` | repo root; fixtures exercise active runs, decided reopen, open/closed seq/par scopes, append places and join epochs | Exit 0; the fixed-point predicate registered below protects every still-reachable closure; terminal/budget/cancel alone do not consume; consume is serialized with competing writers, then removes only owned resources, clears closure sessions, and emits one of `{no-work, published, unpublished-discarded, unevaluable}` plus origin freshness. |
| C06 | par pin derivation | shell | `bun scripts/issue-560-integration.ts` | repo root; par fixture with at least two members | Exit 0; every member's first-open base equals the persisted par pin and the member path performs no independent fetch; nested par receives its own pin. |
| C07 | daemon startup reconciliation | shell | `bun scripts/issue-560-integration.ts` | repo root; separately seed missing directory, missing branch, orphan directory/branch, and repo config/hooks drift | Exit 0; startup compares SQLite closures, disk worktrees and engine refs; every mismatch yields an identity-bearing audit event; repair is limited to engine namespace; active/suspended state is never silently deleted; config/hooks drift is surfaced. |
| C08 | daemon responsiveness during Git churn | shell | `bun scripts/issue-560-integration.ts` | repo root; gate Git add/fetch/remove while polling daemon socket | Exit 0; repeated `coder-loop daemon status <target> --json` calls complete while Git is deliberately blocked and show no Git-duration-sized event-loop stall. |
| C09 | interrupted-attempt resume | shell | `bun scripts/issue-560-integration.ts` | repo root; interrupt one real runner attempt | Exit 0; the second attempt has the exact prior `agentCwd`, branch and session, and the interruption performs neither suspend nor consume/GC. |
| C10 | shared Git coordination | shell | `bun scripts/issue-560-integration.ts` | repo root; two active closures plus one suspended closure, concurrent legal fetch/commit/push, then config/hooks drift | Exit 0; remote-tracking refs may advance with freshness recorded while saved base SHA/pin and each closure's HEAD/index/WIP stay unchanged; engine operations are per-repo serialized and touch only its namespace; no explicit `git gc` occurs while active/suspended closures exist. |
| C11 | synchronous worktree path removed | shell | `rg -n "Bun\\.spawnSync" src/scheduler.ts` | repo root | Exit 1 with no matches; scheduler worktree/fetch/create/consume/reconcile Git execution is async and cannot block the daemon event loop. |
| C12 | type integrity | shell | `bun run typecheck` | repo root after `bun install --frozen-lockfile` | Exit 0; the closure lifecycle/resource/event/error path remains exhaustive and precisely typed. |
| C13 | repository suite | shell | `bun test` | repo root after frozen install | Exit 0; no failures. Report Bun's aggregated base/head test counts and enumerate removed/renamed/skipped/weakened tests. |
| C14 | standard process gate | shell | `bun scripts/engine-integration.ts` | repo root; script-owned isolated daemon/runtime | Exit 0; ordinary engine integration still completes and tears down without orphan process, socket, worktree or runtime root. This does not substitute for C01–C10. |
| C15 | diff hygiene | shell | `git diff --check origin/main...HEAD` | repo root | Exit 0. |
| C16 | CI detection and local parity | shell | `git ls-tree -r --name-only HEAD \| rg '(^\|/)(\.github/workflows/.*\.ya?ml\|\.circleci/config\.ya?ml\|\.gitlab-ci\.yml\|Jenkinsfile\|azure-pipelines\.ya?ml\|\.buildkite/\|\.woodpecker/\|woodpecker\.ya?ml\|\.drone\.ya?ml)$'`<br>`act -l --container-architecture linux/arm64` | repo root after frozen install; `act` 0.2.89; OrbStack/Docker arm64 available | First command exits 1 with no matches on both `origin/main` and `HEAD`; second exits 1 with `stat <repo>/.github/workflows: no such file or directory`, proving this repo has no configured CI job to reproduce. C12-C14 must each exit 0, and the VerificationPacket must state exactly: `CI parity: 本仓无 CI；本地 bun install --frozen-lockfile && bun run typecheck && bun test && bun scripts/engine-integration.ts 等价 CI gate，已 PASS。` Remote PR checks are not a substitute. |

本 issue 不运行 `bun scripts/real-e2e.ts`：冻结候选的跨 issue 整链路验证归 #684，bundled GitHub compatibility 归 #685。

## 收敛断言（P01–P06）

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| P01 | whole-tree | `rg -n "schedulerSlotWorktreePath|schedulerSlotBranchName|removeStaleSlotBranchWorktree" src` | None in production `src/`; tests may mention removed names only when explicitly asserting absence/migration. | Old per-slot path/branch/stale-repair machinery has zero production matches. The slot may remain only as #698-owned scheduling serialization, never resource identity. |
| P02 | whole-tree | `rg -n "origin/.*baseBranch|chooseWorktreeStartRef|\\bHEAD\\b" src/scheduler.ts` | Explicit current-HEAD observation after a closure worktree is already opened; no create-start fallback. | The create path resolves a fetched remote base SHA, a verified local base SHA for no-origin, or a persisted par pin; the `origin -> local base -> HEAD` fallback is absent. |
| P03 | whole-tree | `rg -n "Bun\\.spawnSync" src/scheduler.ts` | None. | Zero matches, matching C11. |
| P04 | changed | `git diff --unified=0 origin/main...HEAD -- ':(glob)src/**/*.ts' ':(glob)scripts/**/*.ts'` reviewed for `any`, non-`as const` assertions, anonymous cross-boundary object shapes and propagated `unknown` | `unknown` only at catch/external parse boundaries; `as const` only where literal preservation is required. | No type degradation; new lifecycle, Git operation/result, reconciliation mismatch, reachability proof, consumption evidence and error states are named exhaustive ADTs. |
| P05 | whole-tree | `rg -n "git (gc|repack|prune)|worktree (remove|prune|repair)|update-ref" src presets scripts` | Exact engine-owned create/consume/startup-reconcile operations and isolated fixture teardown only; existing preset-side structural Git remains owned by #707 and must not be expanded here. | Production lifecycle touches only registered engine-owned branch/pin/worktree namespace, never explicit GC while active/suspended exists; no new agent instruction grants structural Git operations. |
| P06 | changed | `git diff --name-only origin/main...HEAD` | Scheduler/daemon/store/task-runtime/observability and directly corresponding tests/docs plus `scripts/issue-560-integration.ts`. | No #698 slot-retirement scheduling rewrite, #701 reopen decision production, #702 materialization, #703 binding-write API, #707 preset rewrite, GUI, or unrelated refactor enters the diff. |

## 验收运行时

- Setup: `bun install --frozen-lockfile` in a clean issue-branch checkout.
- Target-mandated issue driver: `bun scripts/issue-560-integration.ts`.
- Start: the driver creates a UUID-isolated fixture repo + origin, a separate no-origin fixture, a UUID-isolated `loop-data` root and deterministic runner shim, then launches the real `src/loop.ts daemon up --loop-data-root <root>` process. It exercises production scheduler/daemon/store/Git paths rather than directly mutating SQLite for the behavior under test; direct seeding is allowed only to construct startup-reconciliation contradictions and future-writer reachability cases not yet produced by #701/#702/#703.
- Readiness: observe the daemon PID alive and its isolated Unix socket accepting `daemon status` before any lifecycle action.
- Behavior: execute C01-C10 in named positive and negative scenarios, including blocked Git concurrency, daemon restart, fixed-point reachability, competing consume/mutation serialization, and resource/freshness/event observations.
- Logs: capture command, source SHA, fixture IDs, every lifecycle/Git/event/status observation and exit status under this issue's run evidence directory; secrets are neither required nor recorded.
- Stop ownership: the driver owns and stops every daemon/runner, removes its isolated runtime root and only its registered fixture worktrees/refs, and independently asserts no PID/socket/worktree/ref/runtime-root orphan remains. Verification reruns `bun scripts/engine-integration.ts` separately.

## 测试要求

`required`

Focused tests plus `scripts/issue-560-integration.ts` are required for the new lifecycle, fixed-point reachability, serialization and failure variants; the preserved candidate already contains them, so a delivery-only retry must not churn source or tests. Existing assertions survive unchanged unless a current-main assertion encodes the explicitly retired per-slot resource behavior; every replacement must preserve the old safety property while asserting per-closure semantics. No test may be removed, renamed, skipped, `.only`-selected, timeout-relaxed, or weakened merely to pass. Report runner-aggregated base/head totals and an explicit integrity list.

## 依赖关系

- Depends on: #558、#601。
- Blocks: #698、#701、#704、#705、#707、#708、#731、#748。



---

## Comments (2)

### comment #5014861042 by `RiriAgent` — 2026-07-19T07:26:54Z

<!-- coder-loop:executable-contract schema=1 source-issue=699 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/699
- Observed issue-body `lastEditedAt`: `2026-07-17T20:14:00Z` (GraphQL `Issue.lastEditedAt`; the complete issue comment set is empty).
- Operator-comment URLs used: `none` — issue #699 has zero comments, so there is no later operator correction to the body.
- Parent/source decisions: https://github.com/mouriya-s-lab/coder-loop/issues/546, the currently effective #560 marker https://github.com/mouriya-s-lab/coder-loop/issues/560#issuecomment-5011991777, and the checked-in `v3/closure-lifecycle-decision.md`, `v3/task-closure-decision.md`, `v3/join-evolution-decision.md`, and `src/task-runtime.ts` on current `origin/main`.
- Execution facts used: open PR https://github.com/mouriya-s-lab/coder-loop/pull/749 at `40c72f9222890d44eb90db8dcea272923c820e2d`, its latest verified packet https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014402576, and the later blocking diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515.

## Deliverable

`implementation-pr`

Continue the single existing open implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/749 and its branch `coder-loop/v3-546-94cd3a68e245`; do not create another PR and do not revive closed/unmerged PR #690. PR #749 must be updated to close exactly #699 (first line `Closes #699`) rather than old source issue #560, while preserving historical comments as immutable records. Fix the current blocking consumption-evidence mechanism, rerun this contract at the exact pushed candidate, and refresh the PR evidence/CandidateRef against this #699 marker. Scope is per-`(item, phase)` closure create/suspend/reopen/consume, worktree/branch/session supply, base/fetch/par-pin behavior, reconciliation, and asynchronous Git only; #698 tree scheduling, #701 reopen-decision production, #702 dynamic par materialization, #703 join-binding evolution, #707 preset migration, GUI, and release-wide acceptance remain outside this PR.

## Checks

All rows are `shell`; #699 has no browser/UI acceptance surface. Unless a row says otherwise, cwd is a clean checkout of the exact current PR candidate, env is local macOS with Bun and Git on `PATH`, and all runtime roots/fixtures are UUID-isolated and driver-owned rather than production `~/.coder-loop`.

| ID | Dimension | Kind | Literal command | Cwd / env | Expected exit / output |
|---|---|---|---|---|---|
| C01 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; isolated runtime | Exit 0; a real two-phase chain exposes different worktree paths and different engine-namespace branches for its two phase closures before runner spawn. |
| C02 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; origin advanced before create, bad-remote and no-origin fixtures | Exit 0; origin-backed creation starts at the post-fetch base SHA; per-repo fetch is serialized/deduplicated; fetch failure emits a typed auditable event; no-origin resolves only the verified local base; no create path falls back to `HEAD`. |
| C03 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; isolated runtime | Exit 0; the engine-created closure branch exists before spawn, is unique per closure, is the runner/PR head ref, and remains stable for that closure lifetime. |
| C04 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; deterministic runner writes tracked, untracked, ignored, index and scratch state | Exit 0; suspend changes only lifecycle/event state; reopen changes only `suspended -> active`; path, branch tip, HEAD, index, WIP, scratch and session remain byte-identical and resume uses the same cwd/session. |
| C05 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; fixtures cover active runs, resumable attempts, decided reopen, seq/par scopes, append places, join epochs, and a first cleanup failure followed by restart/retry | Exit 0; the fixed-point predicate in Dependencies protects every reachable closure; terminal/budget/cancel alone do not consume; consume serializes against competing writers, removes only owned resources, clears closure sessions, and emits exactly one of `{no-work,published,unpublished-discarded,unevaluable}` with origin freshness. When Git cleanup fails after lifecycle mutation, durable pending evidence survives restart and the already-consumed retry emits that evidence exactly once before cleanup finalizes; the driver must assert this event rather than infer it from resource deletion. |
| C06 | function | shell | `bun scripts/issue-560-integration.ts` | candidate root; par fixture with at least two members and one nested par | Exit 0; first-open member bases equal the persisted par pin with no member fetch; nested par uses its own pin. |
| C07 | integration | shell | `bun scripts/issue-560-integration.ts` | candidate root; seed missing directory, missing branch, orphan directory/branch and config/hooks drift, then restart daemon | Exit 0; startup compares persisted closures, disk worktrees and engine refs; each mismatch emits an identity-bearing event; repair is restricted to engine namespace; active/suspended state and config/hooks drift are never silently erased. |
| C08 | environment | shell | `bun scripts/issue-560-integration.ts` | candidate root; deliberately gate Git add/fetch/remove while polling the daemon socket | Exit 0; repeated daemon-status calls complete while Git is blocked and have no Git-duration-sized event-loop stall. |
| C09 | integration | shell | `bun scripts/issue-560-integration.ts` | candidate root; interrupt one real deterministic-runner attempt | Exit 0; attempt two reuses exactly the prior `agentCwd`, branch and session; interruption causes neither suspend nor consume/GC. |
| C10 | integration | shell | `bun scripts/issue-560-integration.ts` | candidate root; two active plus one suspended closure, concurrent legal Git operations and config/hooks drift | Exit 0; remote-tracking refs may advance with freshness recorded while saved base/pin and closure-private HEAD/index/WIP remain unchanged; engine Git operations serialize per repo, touch only its namespace, and perform no explicit GC while active/suspended closures exist. |
| C11 | assumption | shell | `rg -n "Bun\\.spawnSync" src/scheduler.ts` | candidate root | Exit 1 with no matches; scheduler worktree/fetch/create/consume/reconcile Git execution is asynchronous. |
| C12 | function | shell | `bun run typecheck` | candidate root after `bun install --frozen-lockfile` | Exit 0 with no diagnostics; lifecycle/resource/event/error variants remain exhaustive and precisely typed. |
| C13U | function | shell | `bun run test:unit` | candidate root after frozen install | Exit 0 with no failures. This is the post-#751 unit/component collection under `tests/unit/**`; report base/head runner totals and enumerate every removed, renamed, skipped, timeout-relaxed, or weakened test, with an explicit empty list when none. |
| C13I | integration | shell | `bun run test:integration -- --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/699/contract-c13-integration.log --foreground` | candidate root after frozen install; isolated test-owned processes | Exit 0; `integration-cli`, `integration-scheduler`, and `integration-daemon` all pass, the log ends `FINAL exit=0`, and focused coverage proves C05 cleanup-failure/restart evidence persistence plus the existing closure lifecycle/reconciliation paths. |
| C14 | integration | shell | `bun scripts/engine-integration.ts --log-file /Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/699/contract-c14-engine-integration.log --foreground` | candidate root; script-owned isolated daemon/runtime | Exit 0; ordinary process-level engine integration reaches terminal state, the log ends `FINAL exit=0`, and teardown leaves no orphan process, socket, worktree, branch, or runtime root. This does not substitute for C01-C10. |
| C15 | assumption | shell | `git diff --check origin/main...HEAD` | candidate root | Exit 0 with no output. |
| C16 | environment | shell | `test -z "$(git ls-tree -r --name-only HEAD | rg '(^|/)(\.github/workflows/.*\.ya?ml|\.circleci/config\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.ya?ml|\.buildkite/|\.woodpecker/|woodpecker\.ya?ml|\.drone\.ya?ml)$' || true)" && act -l --container-architecture linux/arm64` | candidate root after frozen install; `act` 0.2.89; registered/shared OrbStack Docker per repository policy | The tree query is empty; `act` exits 1 only with `stat <repo>/.github/workflows: no such file or directory`. C12, C13U, C13I, and C14 each pass, and the packet states that frozen install + typecheck + post-#751 unit/integration batches + engine integration are the repository's local no-CI parity gate. |
| C17 | integration | shell | `gh api graphql -f query='{repository(owner:"mouriya-s-lab",name:"coder-loop"){pullRequest(number:749){state isDraft headRefName headRefOid baseRefName body closingIssuesReferences(first:100){pageInfo{hasNextPage}nodes{number state url}}}issue(number:699){closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}nodes{number state headRefName headRefOid baseRefName url}}}}}'` | candidate root; authenticated GitHub CLI; after submit | Exit 0; both page sets have `hasNextPage=false`; PR #749 is open, targets `main`, begins `Closes #699`, has exactly one closing issue (#699), and its live branch/SHA equal CandidateRef; issue #699 has #749 as its sole open closing PR. Draft/readiness state is workflow-owned and is not an acceptance condition. |

本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。The umbrella-wide frozen-SHA acceptance remains outside #699.

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `schedulerSlotWorktreePath|schedulerSlotBranchName|removeStaleSlotBranchWorktree` | whole-tree | `rg -n "schedulerSlotWorktreePath|schedulerSlotBranchName|removeStaleSlotBranchWorktree" src` must exit 1 with zero matches; slot scheduling may remain only as scheduler serialization, never as resource identity. |
| `chooseWorktreeStartRef` | whole-tree | `rg -n "chooseWorktreeStartRef" src/scheduler.ts` must exit 1 with zero matches. Legitimate `HEAD` observations after an already-open closure are excluded; create-start resolution must use fetched `refs/remotes/origin/<base>`, verified local `refs/heads/<base>`, or persisted par pin only. |
| `Bun\.spawnSync` | whole-tree | `rg -n "Bun\\.spawnSync" src/scheduler.ts` must exit 1 with zero matches. |
| `\bany\b| as (?!const)` | changed | `git diff --unified=0 origin/main...HEAD -- ':(glob)**/*.ts' | rg --pcre2 '^\+.*(\bany\b| as (?!const))'` must exit 1 with zero added-line matches; boundary parsing does not authorize a true `as` assertion. |
| `\bunknown\b` | changed | Inspect `git diff --unified=0 origin/main...HEAD -- ':(glob)**/*.ts'`; added type-level `unknown` is allowed only at the external JSON/runner parse boundary in `scripts/issue-560-integration.ts` (`assert`, `record`, `stringField`, `parseRunnerObservation`, and values immediately produced by `JSON.parse`). String literals/test titles are excluded. Every other added type-level site counts as remaining, and that count must be zero. |
| `^(src|scripts)/.*\.(test|integration)\.ts$` | whole-tree | `rg --files -g '*.test.ts' -g '*.integration.ts' | rg '^(src|scripts)/'` must exit 1 with zero matches. Unit tests live under `tests/unit/**`, collected integrations under `tests/integration/**`; explicit acceptance drivers such as `scripts/issue-560-integration.ts` and `scripts/engine-integration.ts` are excluded because they are not collection files. |
| `git diff --name-only origin/main...HEAD` | changed | `git diff --name-only origin/main...HEAD | rg -v '^(presets/engine-integration/(preset\.toml|review-entry\.md)|scripts/(engine-integration-stub-runner|engine-integration|issue-560-integration)\.ts|src/(closure-lifecycle|daemon|install-commands|observability|scheduler|sqlite-state)\.ts|tests/unit/(runtime/closure-lifecycle|cli/install-commands|observability/observability|sqlite-state/task-tree)\.test\.ts|tests/integration/(cli/central-cli|daemon/chain-crud|scheduler/(core|cross-runner|daemon-restart|phase-advancement|worktree))\.integration\.ts|tests/integration/(daemon|scheduler)/harness\.ts)$'` must exit 1 with zero matches. No #698/#701/#702/#703/#707 implementation, GUI, unrelated docs, or runtime/evidence artifact may enter the diff. |

## Canonical runtime

- Setup: use a clean checkout of the exact CandidateRef SHA and run `bun install --frozen-lockfile`.
- Start: the target-mandated real driver remains `bun scripts/issue-560-integration.ts`. It creates UUID-isolated local origin/target/no-origin/bad-remote repos, an isolated `loop-data` root, deterministic runner and Git shims, then starts the real `src/loop.ts daemon up --loop-data-root <root>` process. It exercises production scheduler/daemon/store/Git paths; direct persistence seeding is permitted only for reconciliation contradictions and future-writer reachability facts whose producers are outside #699.
- Readiness: before lifecycle actions, observe the daemon PID alive and the isolated Unix socket accepting `daemon status`.
- Behavior: execute C01-C10 as named positive/negative scenarios. The cleanup-failure scenario must prove that lifecycle/session mutation, durable evidence intent, Git cleanup, restart reconciliation, and retry converge to one auditable `closure.consumed` observation with origin freshness, not merely to absent resources.
- Logs: record command, source SHA, fixture UUIDs, readiness, lifecycle/Git/event/status observations, batch file lists, final exits, and cleanup probes beneath `/Users/mouriya/.coder-loop/loop-data/chains/v3-546/evidence/699/`; no production secret is required or recorded.
- Stop ownership: each driver stops every daemon/runner it creates, removes only its registered runtime root/worktrees/refs, and independently asserts that no PID/socket/worktree/ref/runtime-root orphan remains.

## Test delta

`required`

Production and focused test changes are required to fix the latest C05 defect: consumption evidence/freshness must survive a cleanup failure and be emitted exactly once by restart/retry, and `scripts/issue-560-integration.ts` plus the owning unit/integration tests must assert the event rather than infer success from resource disappearance. The post-#751 directory contract survives: deterministic unit/component tests remain under `tests/unit/**`, real daemon/socket/scheduler/worktree tests remain in exactly one `tests/integration/{cli,scheduler,daemon}/**` batch, and explicit acceptance drivers remain outside automatic collection. Existing assertions survive unless they encode the explicitly retired per-slot or terminal-immediate-cleanup semantics; replacements must preserve the original safety property while asserting per-closure behavior. No test may be removed, renamed, skipped, `.only`-selected, timeout-relaxed, split while dropping an assertion/real boundary, or weakened merely to pass. Verification reports base/head runner totals and a complete test-integrity delta.

## Dependencies

- **Consumption predicate:** closure `C` is consumable iff it is `active|suspended`, has no active run, and is absent from the least fixed point of every legal present-or-future resume/reopen edge in the persisted runtime tree. Seeds include resumable attempts, decided-but-unconsumed reopen, reachable seq suffixes, open par epochs, open append places, and next-epoch binding candidates. Item terminal, budget exhaustion, cancellation, current `drain`, or missing disk resources alone never prove consumption. Reachability recheck, irreversible `consumed`, session-clear intent, evidence intent, and competing append/reopen/join-binding writes share one serialization boundary. Sources: https://github.com/mouriya-s-lab/coder-loop/issues/546, `v3/closure-lifecycle-decision.md:38-58`, and current `src/task-runtime.ts`.
- **No-origin rule:** with `origin`, fetch and resolve only `origin/<baseBranch>`; failure is typed/audited with no fallback. Without `origin`, `doctor` warns and create resolves only verified local `refs/heads/<baseBranch>^{commit}`, persists that SHA, and records freshness as no-origin/unavailable. Missing local base fails typed. `HEAD` is never a create fallback. Source: `v3/closure-lifecycle-decision.md:68`.
- **Satisfied prerequisites:** live parent sub-issue state shows #558 and #601 closed. Current `origin/main@7172d3e8af37fadab5624ef155dbc9e6ef19a40c` supplies the typed closure/task-tree persistence and restricted runner filesystem surface; #699 consumes those shapes rather than redefining them.
- **Current-main gap:** local `git grep` at `origin/main@7172d3e` still finds `schedulerSlotWorktreePath`, `schedulerSlotBranchName`, `removeStaleSlotBranchWorktree`, `chooseWorktreeStartRef`, and synchronous scheduler Git at `src/scheduler.ts:2731`. The 36-commit PR candidate removes those sites and supplies the per-closure production path.
- **Live delivery state:** PR #749 is open, non-draft, mergeable/clean, based on `main@7172d3e`, with branch `coder-loop/v3-546-94cd3a68e245` at `40c72f9222890d44eb90db8dcea272923c820e2d`; there are zero reviews, review threads, check runs, or status contexts. Its current closing edge points only to old issue #560, while #699 has no closing PR, so C17 routing repair is required before acceptance.
- **Current blocking mechanism:** the later diff audit https://github.com/mouriya-s-lab/coder-loop/pull/749#issuecomment-5014552515 overrides the earlier all-pass packet as the current implementation verdict. `consumeClosureIfUnreachable` commits `consumed` and clears sessions before Git cleanup; on cleanup failure the transient sampled observation is lost, and the already-consumed retry path bypasses `closure.consumed`, permanently omitting C05 evidence/freshness. The canonical driver currently checks recovery cleanup but does not assert that event. This is the sole current blocking code mechanism; all declared Pattern rows were already converged at `40c72f9`.
- **Verification ownership:** this issue owns its C01-C10 local deterministic runtime plus type/unit/integration/engine gates. It does not own par scheduling, reopen production, bundled-preset migration, browser/UI, deployment, external service, production credential, IaC, umbrella-wide frozen-SHA integration, or the #685 GitHub compatibility real E2E.

## Supersedes

none



### comment #5055603070 by `RiriAgent` — 2026-07-23T07:23:33Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (本 issue 承接方, OPEN)。

### 本 issue（#699 承接 #560 闭包资源生命周期）相对 baseline 的进度

baseline 49 commit **绝大多数就是本 issue 的候选 SHA**（旧 PR #749 就是这条 branch 的 draft implementation PR，也就是 #560 C17 要求的 replacement delivery route，只不过仍挂在旧 #560 号上）。

- **已落地**（对照 #699 body 内嵌的 #560 C01-C17 executable contract）:
  - **C01** per-闭包隔离 — `src/closure-lifecycle.ts` (+221)、`scripts/issue-560-integration.ts` (+721)、`tests/integration/scheduler/worktree.integration.ts` (+847)；commits `feat: implement per-closure resource lifecycle` (92ba7c8) → `test: add canonical closure lifecycle runtime` (3049802)
  - **C02** 起点公理 fresh base + fetch failure — `fix: complete closure lifecycle runtime evidence` (48af423)、`fix: complete closure lifecycle contract coverage` (111df23)
  - **C03** 引擎创建闭包分支 — closure-lifecycle.ts 引擎命名空间 + `fix: preserve migrated closure resources on reopen` (ba4a421)
  - **C04** suspend/reopen 连续性 — `fix: preserve closure reopen and reconciliation invariants` (6babc2d)、`fix: preserve migrated closure resources on reopen` (ba4a421)、`test: restore lazy closure assertions` (5c46046)
  - **C05** 消费谓词与 GC — 十余 commit 迭代：`fix: derive closure reachability from persisted state` (64643d7) → `fix: tighten closure cleanup reachability` (b2d192f) → `fix: complete closure reachability and cleanup semantics` (4d25ac3) → `fix: retire legacy closure resources` (e2033da) / `fix: retire migrated closure resources safely` (9098ee0) → `fix: persist closure consumption evidence` (3b7ac4e) → `fix: migrate closure evidence structurally` (eb92962) → `fix: verify closure Git cleanup before resource release` (af78d69) → `fix: await closure consumption before marker inspection` (c44fee8) → `fix(scheduler): typed reachability-fact API, unpublished-orphan retention, async branch validation` (cbec3d7)
  - **C07** daemon 启动状态对账 — `fix: complete closure reconciliation semantics` (b2bc43b)、`fix: preserve closure recovery state on cleanup mismatch` (7f36f19)、`test: assert reconciliation failure details` (a8021ae)
  - **C08** responsiveness — `fix: await daemon status readiness` (4b483bb)、`fix: measure blocked Git responsiveness directly` (5a57c69)
  - **C09** 中断-attempt resume — `test: align session retry fixtures with lazy closures` (d7fcb25)、`fix: preserve closure resource recovery` (a51bf03)
  - **C10** shared Git 协调 — `fix: verify closure Git cleanup before resource release` (af78d69)、`test: align closure checks with test boundaries` (2105550)
  - **C11** spawnSync 移除（async 化）— `fix(scheduler): typed reachability-fact API, unpublished-orphan retention, async branch validation` (cbec3d7)
  - **C12** typecheck — `refactor(test): remove as unknown as ADT red-line casts in load-bundled and shutdown` (d67fec5)
  - **C14** engine-integration — `scripts/engine-integration.ts` (+52) 与 `scripts/engine-integration-stub-runner.ts` (+14) 已适配闭包生命周期

- **半成品 / 待验证**:
  - **C06 par pin 派生** — baseline 无 par 相关 commit（#699 body 明说本 issue does not implement #559 tree scheduling），par 展开与 pin 派生依赖 **#698** 落地才可真跑；本 issue 本轮承接 #560 时应保留 stub 或明确 defer 说明
  - **C13** 全套 `bun test` 未证明全绿 — 旧 PR #749 仍在 `changes_requested`，说明有 review 意见未消化
  - **C15** diff hygiene 需在本 chain 新 PR 上重跑
  - **C17** replacement delivery PR — 旧 PR #749 挂在 v3-546 iteration branch 上关闭 **#560**；本 issue 需要新 draft PR 关闭 **#699**（本 issue），base = `coder-loop/v3-546-baseline`

### iteration agent

从 baseline checkout。绝大部分 candidate 已在 tree，起手先跑 `bun scripts/issue-560-integration.ts` 复核 C01-C10 现绿状态，`bun run typecheck && bun test && bun scripts/engine-integration.ts` 复核 C12-C14；然后消化旧 PR #749 未处理的 review 意见（`gh api repos/mouriya-s-lab/coder-loop/pulls/749/reviews`），改交付方向为关闭 **#699**，交付新 draft PR。**不要动**旧 #560 / 旧 PR #749（事故现场保留）。



---

## Timeline (27)

- 2026-07-17T20:13:16Z `assigned` @RiriAgent
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:14:07Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:27Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:27:43Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-17T20:38:54Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:39:17Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-19T07:26:54Z `commented` @RiriAgent
- 2026-07-19T12:13:34Z `referenced` @RiriAgentcommit=19a88bc1f0bd95410f9793ccd28f749c1eec3637
- 2026-07-19T12:13:34Z `referenced` @RiriAgentcommit=7a23e3aa710adf1560700838a2590fd482280b87
- 2026-07-19T12:13:34Z `referenced` @RiriAgentcommit=56bcf4b8d75acda64c4a6efb0125fc54a13e50d4
- 2026-07-19T12:14:49Z `cross-referenced` @RiriAgentsrc=749
- 2026-07-19T15:37:05Z `referenced` @RiriAgentcommit=3b7ac4efd34e72a82dbf1ce0ca5cfc6f4e58d6e2
- 2026-07-19T15:37:05Z `referenced` @RiriAgentcommit=45971f5270f1538059fdbf6136f2283ad1cb6595
- 2026-07-19T15:37:06Z `referenced` @RiriAgentcommit=eb929621a7482b6c2bb45a73a78317b1428dc83c
- 2026-07-23T07:23:33Z `commented` @RiriAgent
- 2026-07-23T07:23:33Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-23T07:23:38Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-23T07:23:39Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-23T07:23:42Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-23T07:23:45Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-23T07:25:48Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-27T01:21:08Z `cross-referenced` @RiriAgentsrc=546