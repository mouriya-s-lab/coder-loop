# #601 feat(engine): 收敛引擎递出授权面——runner --add-dir 剥离 loopDataRoot 整根授权

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-10T05:26:57Z  | updated: 2026-07-15T22:47:36Z
- closed: 2026-07-15T22:47:14Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/601
- comments: 5  | timeline events: 35

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）「引擎递出面定理」节与 `v3/task-closure-decision.md`（2026-07-10 边界 2 裁决报告）。定理逐字引用：

> **引擎递给任务的每个面，必须穷尽归入三类之一：任务私有面、声明通道、repo 级共享 Git 协调面。前两类承载业务状态；第三类只承载 Git 对象存储、远端视图分发、引擎 pin 与 linked-worktree 管理，不得成为未声明的业务状态通道。**

成立时，越出声明通道的跨任务状态流可把 blame 指派给 agent（escape），系统不背锅、不预防。本 child 修复该定理当前最重的系统侧反例。

## 上下文

- **git 面凭据不在 #406 覆盖内**（#546 body「引擎递出面定理」节 2026-07-10 修订 + 权威记录 `v3/closure-lifecycle-decision.md` §5 对抗检验消化项）：#406 是 run-scoped credential（`coder-loop` CLI 主体识别与准入门），git 面（origin push/fetch 等）使用的是 **ambient git 凭据**（操作员环境的 git config / credential helper / SSH agent），不在 #406 覆盖清单内——**这是登记事实，本 child 不为其立机制**。
- **escape 清单「用 ambient 凭据」已收窄为「凭据滥用」**（同上出处）：agent 在引擎创建的闭包分支上合法 push 本就使用 ambient git 凭据（供给条款 2：agent 契约 = 在闭包分支上 commit、解决冲突、push、开 PR），使用本身不是 escape；escape 的是拿凭据越出声明通道（写他人分支、动引擎外 refs），不是使用本身。本 child 的授权收敛不需要触碰 git 面凭据，只收敛引擎自己的目录授权递出。

## 问题

`runnerAdditionalDirs = distinctPaths([presetDir, loopDataRoot, agentCwd])`（`src/loop.ts:6457-6459`）把**整个 loop-data root** 授权给每个任务（claude 经 `--add-dir`，codex 经 additionalDirs 同源消费）：其中含其他 chain 的目录、全部 run 的 evidence/logs、以及中央 SQLite 状态库本体。这与引擎自己的两条既有设计直接矛盾：

- prompt 侧刻意隐藏 DB 路径——`stateFile` 绑定值是描述字符串 `"the central state DB"` 而非路径（`src/scheduler.ts:2219`）；
- 状态写必须走 #397 default-deny 准入门 + #406 run-scoped credential。

权限授予侧把整根目录递出，等于引擎自己发的通行证旁路自己的准入门；agent 经该授权直写他 chain 目录或 SQLite 时，blame 落在系统而非 agent，递出面定理不成立。

## 预期结果

- 授权集合中不含 loopDataRoot 整根；集合中每个路径可逐项追溯到一个声明的递出面：agentCwd（任务私有）、presetDir（只读共享通道）、任务实际需要的 loop-data 子路径（本 item 的 evidence dir 等）逐项授权，不整根兜底。
- claude / codex / opencode 三 runner 同型处理（各自的目录授权机制应用同一收敛清单）。
- agent 经声明通道的能力零回归：仍能写 evidence、读 preset fragment、经 `coder-loop` CLI 写状态。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：全链路 ADT，禁 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse；禁真 `as`（`as const` 除外）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | loopDataRoot 整根授权消失 | 真跑一条链，从 events/ps 取 runner 进程命令行，检查 `--add-dir` 集合 | local | 无 loopDataRoot 根路径；出现的每个路径可对应到 #546 递出面清单中的一个声明面 |
| function | 声明通道能力零回归 | 同一真跑中 agent 写 evidence、读 presetDir fragment、CLI 写状态 | local | 全部成功 |
| assumption | 递出集合构成对齐 | `grep -n "runnerAdditionalDirs" src/` 人工核对集合构成 | local | 与 #546「引擎递出面定理」节登记一致 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: 无硬上游（可与 #560 并行；若 #560 先落地，授权路径按任务闭包粒度重核）。
- Relates to: #397 / #406（同一准入完整性面）；#545（`shared.md` 保留现有创建与 prompt 注入行为，并显式归类为 chain 级自由 prompt 注入面；不属于本 child 的授权收敛缺口）；#567（evidenceDir 的 phase 级 par 作用域化 = 缺口③）。


---

## Comments (5)

### comment #4953812292 by `RiriAgent` — 2026-07-13T02:11:34Z

<!-- coder-loop:executable-contract schema=1 source-issue=601 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/601
- Observed body update timestamp: `2026-07-11T07:25:28Z`
- Operator-comment URLs used: none (the issue has no comments as observed on 2026-07-13; intent comes from the live body and its linked authority #546).

## Deliverable

`implementation-pr`

Implement the directory/filesystem authorization boundary on current `main`: remove the whole `loopDataRoot` grant, derive every runner-visible filesystem surface from one typed declared-surface model, and project the same read/write semantics into Claude, Codex, and OpenCode on both fresh and resumed runs. Preserve `agentCwd`, read-only preset access, the item/chain channels actually bound into the prompt (including evidence, optional current-issue, shared context, and the daemon CLI socket as applicable), and credentialed `coder-loop` state writes. Ambient Git credentials and #567's task-lifetime re-scoping are out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | authorization construction | shell | `rg -n 'runnerAdditionalDirs|RunnerInvocationPaths|loopDataRoot|--add-dir|dangerously-skip-permissions|danger-full-access' src/loop.ts src/scheduler.ts` from repository root; local env | exit `0`; every engine-added or metadata-derived filesystem/permission argument is traceable to the typed declared-surface projection; no projection grants the whole `loopDataRoot`, and no alternate/equal/short spelling can restore a broader cwd, directory, sandbox, or permission mode |
| C2 | focused regression | shell | `bun test src/loop.test.ts src/scheduler.test.ts -t 'runner filesystem grants|runner projections|runner authorization metadata'` from repository root; local env | exit `0`; tests cover Claude/Codex/OpenCode, fresh/resume, scheduler and chain-complete invocation paths, alternate CLI spellings, read-only preset denial, writable declared channels, and exact root-grant absence |
| C3 | type integrity | shell | `bun run typecheck` from repository root; local env | exit `0`; no type errors and the implementation obeys the repository ADT / no-`any` / no-real-`as` contract |
| C4 | canonical suite | shell | `bun test` from repository root; local env | exit `0`; all tests pass with no removed, renamed, skipped, or weakened pre-existing assertions |
| C5 | direct runner boundary | shell | `bun scripts/runner-filesystem-grants-e2e.ts` from repository root; local configured Claude/Codex/OpenCode sessions, isolated loop-data root created by the driver | exit `0`; one real chain run per runner reads the preset fragment, cannot write the preset tree, writes evidence, reads the declared shared/current-issue channels, performs credentialed `item exits` + `item update`, and reaches terminal state; captured process invocations contain no whole-root grant or metadata bypass spelling |
| C6 | engine E2E | shell | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repository root; configured GitHub and runner auth | exit `0`; fixture PR is `MERGED`, fixture issue is `CLOSED`, teardown/tripwire succeeds |

## Pattern scope

| Type | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| `whole-tree` | `rg -n 'runnerAdditionalDirs|RunnerInvocationPaths|buildRunnerInvocation|agentClaudeArgs|agentCodexArgs|agentOpencodeArgs|--add-dir|dangerously-skip-permissions|danger-full-access|workspace-write|read-only' src scripts` | typed grant/surface model and its boundary parser; the three runner projections; scheduler and chain-complete call sites; focused tests; the direct E2E driver | all runner filesystem authority is built from one exhaustive ADT and projected without raw-root fallback; every fresh/resume and scheduler/chain-complete path converges on that model; metadata cannot widen it through aliases or equal/short forms; tests/scripts may mention forbidden forms only as negative fixtures/assertions |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; use the already configured GitHub plus Claude/Codex/OpenCode authentication. The driver must create an isolated local loop-data root and fixture target; it must not touch production `~/.coder-loop` state.
- Start: C5 starts the isolated daemon and three real runner chains; C6 is the repository-mandated full engine driver from `CLAUDE.md`.
- Readiness: `bun src/loop.ts daemon status <fixture-target> --loop-data-root <isolated-root> --json` reports a live socket before items are added.
- Behavior: C5 exercises declared reads/writes, denied preset mutation, exact spawned argv, and credentialed state transition for each runner. C6 exercises the complete GitHub loop.
- Logs: preserve daemon stdout/stderr, structured events, each run's `status.json`/`stdout.jsonl`, captured argv, and the final chain status under the issue evidence directory.
- Stop ownership: each driver owns and must stop its isolated daemon in teardown, confirm the PID/socket are gone, and preserve only reviewer-consumable evidence.

## Test delta

`required`

Add focused negative and positive coverage plus the direct real-runner E2E driver required by C2/C5. Surviving integrity rule: no pre-existing test may be removed, renamed, skipped, or weakened; new tests must prove denial of every supported authorization-widening spelling and prove legitimate declared channels still work. Passing unit/type checks cannot substitute for C5 or C6.

## Dependencies

- Current `main` at investigation time is `f01560d`; `src/loop.ts:6533-6558` still derives Claude/Codex additional directories from `[presetDir, loopDataRoot, agentCwd]`, while `src/loop.ts:6574-6618` shows OpenCode/Codex permissive invocation defaults. `src/scheduler.ts:2438-2449` identifies the actual prompt-bound paths, and intentionally renders `stateFile` as `the central state DB`.
- PR https://github.com/mouriya-s-lab/coder-loop/pull/653 is `CLOSED`, not merged, and cannot be continued as an open retry PR. Its review records concrete bypass classes and the missing cross-runner read-only guarantee: https://github.com/mouriya-s-lab/coder-loop/pull/653#issuecomment-4949275683 and https://github.com/mouriya-s-lab/coder-loop/pull/653#issuecomment-4949549539 . Reimplement against current `main`; do not treat that rejected head as accepted evidence.
- Installed CLI facts observed during enrichment: Claude Code `2.1.201` exposes `--add-dir` and permission modes; Codex CLI `0.144.1` exposes `--sandbox`, `--cd`, and writable `--add-dir`; OpenCode `1.17.10` exposes `--dir` and `--dangerously-skip-permissions` but no native additional-directory read-only flag. Therefore read-only preset semantics must be engine-enforced and runtime-proven, not inferred from a flag name.
- #560 is open and may land in parallel; if it changes task-closure paths first, recompute the same declared-surface model at closure granularity. #567 is open and owns later task/phase lifetime re-scoping of evidence/current-issue paths; this issue narrows authorization without absorbing that lifecycle work.
- No browser check is required: this is a CLI/engine boundary. C5 and C6 are the required Layer 4 runtime evidence.

## Supersedes

`none`



### comment #4958183363 by `RiriAgent` — 2026-07-13T12:57:31Z

<!-- coder-loop:executable-contract schema=1 source-issue=601 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/601
- Observed body update timestamp: `2026-07-11T07:25:28Z`
- Later workflow/review source used: https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4958149470
- Operator-comment URLs used: none; no later operator comment changes the live issue intent.

## Deliverable

`implementation-pr`

Continue the existing open PR https://github.com/mouriya-s-lab/coder-loop/pull/678. On its current branch, complete the directory/filesystem authorization boundary so every runner-visible loop-data surface is derived from one exhaustive typed model and sliced by the active phase's actual declared bindings. Apply the same effective read/write policy to Claude, Codex, and OpenCode on fresh/resume and scheduler/chain-complete paths. Preserve task-private `agentCwd`, read-only preset access, only the item/chain channels the active phase actually receives, runner runtime files required for startup/session resume, and credentialed `coder-loop` state writes. Ambient Git credentials and #567's later task-lifetime re-scoping remain out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | authorization construction | shell | `rg -n 'RunnerFilesystemSurface|buildRunnerFilesystemAuthorization|runnerSandboxProfile|file-read|file-write|loopDataRoot|--add-dir|dangerously-skip-permissions|danger-full-access' src/loop.ts src/scheduler.ts` from repository root; local env | exit `0`; the whole `loopDataRoot` has no blanket read or write grant; each loop-data rule maps to an active-phase declared binding; runner metadata aliases/equal/short forms cannot widen cwd, directory, sandbox, or permission policy |
| C2 | focused regression | shell | `bun test src/loop.test.ts src/scheduler.test.ts -t 'runner filesystem grants|runner projections|runner authorization metadata|phase-scoped runner surfaces'` from repository root; local env | exit `0`; tests cover three runners, fresh/resume, scheduler/chain-complete, active-phase binding slices, preset read/write distinction, undeclared loop-data read/write denial, declared-channel success, outer sandbox profile contents, metadata bypass spellings, and exact root-grant absence |
| C3 | type integrity | shell | `bun run typecheck` from repository root; local env | exit `0`; no type errors and no violation of the repository ADT / no-`any` / no-real-`as` contract |
| C4 | canonical suite | shell | `bun test` from repository root in a clean checkout with an isolated test runtime | exit `0`; all tests pass, with no removed, renamed, skipped, or weakened pre-existing assertions |
| C5 | direct effective-authority E2E | shell | `bun scripts/runner-filesystem-grants-e2e.ts` from repository root; configured Claude/Codex/OpenCode sessions; driver-owned isolated loop-data root | exit `0`; for each runner, capture and assert the complete outer `sandbox-exec` invocation/profile plus native argv; preset and declared channels behave per policy; credentialed `item exits` + `item update` reaches terminal state; read and write attempts against driver-created undeclared same-chain, other-chain, and root-level loop-data sentinels fail; neither whole-root authority nor metadata bypass appears |
| C6 | engine E2E | shell | `env -u CODER_LOOP_RUN_CRED bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repository root; configured GitHub and runner auth | exit `0`; fixture PR is `MERGED`, fixture issue is `CLOSED`, and teardown/tripwire succeeds |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `RunnerFilesystemSurface|buildRunnerFilesystemAuthorization|runnerSandboxProfile|invocationAuthorization` | `whole-tree` | Every construction and projection site in `src/` must converge on one exhaustive ADT; loop-data surfaces are admitted only when the active phase declares the corresponding runtime binding; global loop-data read/write fallbacks and unconditional chain-wide channel grants are forbidden. Tests and the E2E driver may construct forbidden surfaces only as negative fixtures. |
| `buildRunnerInvocation|agentClaudeArgs|agentCodexArgs|agentOpencodeArgs|sandbox-exec` | `whole-tree` | Every fresh/resume and scheduler/chain-complete invocation must consume the same effective authorization object; no runner-specific path may bypass the outer policy or silently broaden it. |
| `--add-dir|--sandbox|-s|--cd|-C|--dir|--permission-mode|dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox` | `whole-tree` | Engine-owned projections may emit only the reviewed form required by the outer sandbox; metadata-supplied authorization controls, including equal and short spellings, must fail explicitly. Occurrences in tests/scripts are allowed only for positive engine projection or negative bypass assertions. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; use configured GitHub and Claude/Codex/OpenCode authentication. Run from a clean checkout of the PR head. Drivers create isolated local loop-data roots and must not touch production `~/.coder-loop` state.
- Start: C5 starts isolated daemon/chain fixtures for all three runners; C6 is the repository-mandated real GitHub driver from `CLAUDE.md`.
- Readiness: each driver waits until `bun src/loop.ts daemon status <fixture-target> --loop-data-root <isolated-root> --json` reports the intended live socket before adding work.
- Behavior: C5 proves effective outer sandbox authority, phase-sliced declared channels, negative undeclared loop-data reads/writes, read-only preset behavior, runner startup/resume, and credentialed status transition. C6 proves the complete GitHub lifecycle.
- Logs: preserve complete outer invocation/profile, native argv, positive and negative operation results, daemon stdout/stderr, structured events, run `status.json`/`stdout.jsonl`, final chain status, and C6 terminal GitHub audit under the issue evidence directory.
- Stop ownership: each driver owns its isolated daemon and must call daemon down in teardown, confirm PID/socket removal, and leave no standing runner/copier process.

## Test delta

`required`

Extend the existing PR tests and C5 driver to cover phase-binding slicing, undeclared loop-data read denial, undeclared loop-data write denial, and the complete outer sandbox profile. Surviving integrity rule: no pre-existing test may be removed, renamed, skipped, or weakened; C4 must be green in a clean isolated run. Unit/type success cannot substitute for C5 or C6.

## Dependencies

- Current implementation PR: https://github.com/mouriya-s-lab/coder-loop/pull/678, open at investigated head `b5b9af9410e2a7419f11d169b0be253cf7affcaf`; current `origin/main` is `d381d06c0a55385fb211283adcfb05ffade94f88`. Continue this PR rather than opening another one.
- The review source https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4958149470 independently replayed C1/C2/C3 and found C4 green at head `510/510` and current base `524/524`; the older stale-worktree failures in the PR body are not a current blocker.
- That review also identifies the required implementation corrections: `src/loop.ts:6635` globally allows reads, `src/loop.ts:6562` builds unconditional chain-wide writable surfaces rather than a phase binding slice, and `scripts/runner-filesystem-grants-e2e.ts:25` captures only native argv and omits effective outer-profile/undeclared-root assertions.
- The live #546 theorem classifies engine-provided surfaces as task-private, declared channels, or repo-level shared Git coordination. #560 remains open and may change closure paths; if it lands first, recompute the same binding-sliced authorization at closure granularity. #567 remains open and owns later evidence/current-issue lifetime re-scoping, not this authorization fix.
- Installed runner facts remain Claude Code `2.1.201`, Codex CLI `0.144.1`, and OpenCode `1.17.10`; read-only and phase-sliced behavior must be proven at the engine-owned outer policy because the native CLIs do not share one equivalent directory-permission grammar.
- This is a CLI/engine task; browser evidence is not required. C5 and C6 are the required Layer 4 evidence.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/601#issuecomment-4953812292



### comment #4977279702 by `RiriAgent` — 2026-07-15T05:45:05Z

<!-- coder-loop:executable-contract schema=1 source-issue=601 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/601
- Observed body update timestamp (`lastEditedAt`): `2026-07-11T07:25:28Z`
- Later workflow/review source used: https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4958149470
- Operator-comment URLs used: none; the two existing issue comments are prior executable-contract markers and do not change operator intent.

## Deliverable

`implementation-pr`

Continue the existing open PR https://github.com/mouriya-s-lab/coder-loop/pull/678 and its existing issue branch. Preserve the already committed local retry work, then finish the directory/filesystem authorization boundary: every runner-visible path must come from one exhaustive typed surface model, and loop-data channels must be sliced to the active phase's actual declared runtime bindings. Apply the same effective read/write policy to Claude, Codex, and OpenCode across fresh/resume plus scheduler/chain-complete paths. Preserve task-private `agentCwd` and runner scratch, read-only preset access, the daemon socket needed for credentialed CLI state writes, runner runtime files needed for startup/resume, and the repo-level shared Git coordination surface needed for normal commit/push. Ambient Git credentials and #567's later task/phase lifetime re-scoping remain out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | authorization construction | shell | `rg -n 'RunnerFilesystemSurface|RuntimeBindingPaths|buildCentralRuntimeBindingPaths|buildRunnerFilesystemAuthorization|runnerGitMetadataSurfaces|runnerSandboxProfile|invocationAuthorization|file-read|file-write|loopDataRoot|--add-dir|dangerously-skip-permissions|danger-full-access' src/loop.ts src/scheduler.ts` from repository root; local env | exit `0`; no whole-`loopDataRoot` read or write grant exists; each emitted path is classified as task-private, an active-phase declared channel, required runner runtime, exact device/socket, or repo-level shared Git coordination; construction is exhaustive and contains no unconditional chain-wide fallback |
| C2 | focused regression | shell | `bun test src/loop.test.ts src/scheduler.test.ts -t 'runner filesystem grants|runner projections|runner authorization metadata|phase-scoped runner surfaces|runner git metadata'` from repository root; local env | exit `0`; tests cover all three runners, fresh/resume, scheduler/chain-complete, active-phase binding slices, preset read/write distinction, declared-channel success, undeclared same-chain/other-chain/root-level loop-data read and write denial, linked-worktree Git behavior, outer sandbox contents, metadata bypass spellings, and exact root-grant absence |
| C3 | type integrity | shell | `bun run typecheck` from repository root; local env | exit `0`; no type errors and no violation of the repository ADT / no-`any` / no-real-`as` contract |
| C4 | canonical suite | shell | `bun test` from repository root in a clean checkout with an isolated test runtime | exit `0`; all tests pass with no removed, renamed, skipped, or weakened pre-existing assertion |
| C5 | process integration gate | shell | `bun scripts/engine-integration.ts` from repository root; local env; harness-owned UUID fixture and isolated loop-data root | exit `0`; real daemon/socket/spawn/worktree/credential-admission/SQLite path completes both phases, worktree is reclaimed, and teardown reports no orphan; this is integration evidence, not real-agent E2E |
| C6 | direct effective-authority E2E | shell | `bun scripts/runner-filesystem-grants-e2e.ts` from repository root; configured Claude/Codex/OpenCode local sessions; driver-owned isolated loop-data root | exit `0`; each real runner reads only required declared/runtime/Git surfaces, cannot mutate preset or read/write driver-created undeclared same-chain, other-chain, or root-level loop-data sentinels, can commit in the linked worktree, writes declared evidence, and reaches terminal state through credentialed `item exits` + `item update`; captured complete outer `sandbox-exec` profile plus native argv contains no whole-root or metadata bypass |
| C7 | engine real E2E | shell | `env -u CODER_LOOP_RUN_CRED bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repository root; configured GitHub and runner sessions | exit `0`; fixture PR is `MERGED`, fixture issue is `CLOSED`, default-branch behavior assertion passes, and tripwire/teardown succeeds |

## Pattern scope

| Pattern | Scope | Criterion |
|---|---|---|
| `RunnerFilesystemSurface|RuntimeBindingPaths|buildCentralRuntimeBindingPaths|buildRunnerFilesystemAuthorization|invocationAuthorization|runnerGitMetadataSurfaces` | `whole-tree` | Every authorization construction site in `src/` converges on one exhaustive ADT. Loop-data surfaces are admitted only when the active phase declares the corresponding runtime binding; runner runtime and repo-level Git coordination surfaces are explicit variants. Global loop-data read/write fallbacks and unconditional chain-wide channel grants are forbidden. Tests/scripts may construct forbidden paths only as negative fixtures. |
| `buildRunnerInvocation|agentClaudeArgs|agentCodexArgs|agentOpencodeArgs|runnerSandboxProfile|sandbox-exec` | `whole-tree` | Every fresh/resume and scheduler/chain-complete invocation consumes the same effective authorization object; the outer profile is the enforcement source and no runner-specific projection silently broadens it. |
| `--add-dir|--sandbox|-s|--cd|-C|--dir|--permission-mode|dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|danger-full-access` | `whole-tree` | Engine-owned projections emit only forms required under the reviewed outer policy; metadata-supplied authorization controls, including equal and short spellings, fail explicitly. Occurrences in tests/scripts are allowed only for positive engine projection or negative bypass assertions. |
| `runner-filesystem-grants-e2e|engine-integration|real-e2e` | `changed` | The issue-specific driver proves effective read and write authority with real runners; the canonical integration and real-E2E drivers remain intact and are run as separate gates with their distinct evidence claims. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; use configured GitHub and Claude/Codex/OpenCode sessions resolved from their existing local stores. Run from a clean checkout of the final pushed PR head. C5-C7 create isolated local runtime roots and must not touch production `~/.coder-loop` state.
- Start: C5 starts the deterministic process-integration fixture; C6 starts isolated daemon/chains for all three real runners; C7 is the repository-mandated real GitHub lifecycle driver.
- Readiness: each driver waits for its own isolated daemon socket through `bun src/loop.ts daemon status --loop-data-root <isolated-root> --json` before adding work.
- Behavior: C5 proves the real engine process path with a deterministic runner; C6 proves effective phase-sliced filesystem authority, linked-worktree Git, runner startup/resume, and credentialed transition for Claude/Codex/OpenCode; C7 proves the complete GitHub PR/merge/issue-closure lifecycle.
- Logs: preserve C5 evidence summary; C6 complete outer profile, native argv, positive/negative operation results, daemon stdout/stderr, events, run status/stdout, and final chain status; C7 issue/PR URLs, merge SHA, terminal status, daemon logs, and teardown audit under the issue evidence directory.
- Stop ownership: each driver owns and must stop its isolated daemon, confirm PID/socket removal, and leave no standing runner/copier process. A failed driver must retain its diagnostic directory and report it rather than claiming completion.

## Test delta

`required`

Extend the existing focused tests and C6 driver for active-phase binding slicing, undeclared loop-data read denial, undeclared loop-data write denial, linked-worktree Git operation, and complete outer-profile capture. Surviving integrity rule: no pre-existing test may be removed, renamed, skipped, or weakened; C3-C5 must be green in a clean isolated run. Unit/type/integration success cannot substitute for C6 or C7.

## Dependencies

- Current remote implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/678 is open and non-draft at remote head `b5b9af9410e2a7419f11d169b0be253cf7affcaf`, with no review threads, reviews, or check runs in the complete 2026-07-15 fetch. Continue this PR; do not open a replacement.
- The clean local issue branch is at `3783b4d02f5fef0dfe3c6b8c46f334176cd11f22`, based on current `origin/main` `07dad882ded934766f51e53a5e0a04605a18c697`, and contains two issue commits not present in the remote PR head: `a922c78` (agent-context sandbox test correction) and `d7ee782` (linked-worktree Git metadata authorization), plus main-merge commits. Later iteration must preserve, validate, and push this same branch history before presenting new PR evidence.
- The review source https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4958149470 established the remaining semantic gaps. They remain visible in the current checkout: `src/loop.ts:6733` grants global file reads; `src/loop.ts:6632-6647` unconditionally includes chain-wide channels; scheduler authorization at `src/scheduler.ts:2385-2398` does not receive the active phase/binding set; and `scripts/runner-filesystem-grants-e2e.ts:25-31` captures only native runner argv rather than the effective outer profile.
- Current `main` now mandates `bun run typecheck` + `bun test` + `bun scripts/engine-integration.ts` as the default gate. Because this issue changes runner spawn/filesystem authorization and scheduler/chain-complete invocation semantics, the stage-closing real E2E C7 is also mandatory.
- Parent https://github.com/mouriya-s-lab/coder-loop/issues/546 is open. Related https://github.com/mouriya-s-lab/coder-loop/issues/560 and https://github.com/mouriya-s-lab/coder-loop/issues/567 remain open; #560 may later require closure-granularity re-audit, while #567 owns later evidence/current-issue lifetime re-scoping and is not absorbed here.
- Installed runtime facts observed during this enrichment: Bun `1.3.14`, Claude Code `2.1.201`, Codex CLI `0.144.3`, OpenCode `1.17.10`, and gh `2.96.0`. Native directory permission grammars are not equivalent, so effective read/write behavior must be proved at the engine-owned outer sandbox.
- This is a CLI/engine task. Browser evidence is not required; C6 and C7 are the Layer 4 evidence.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/601#issuecomment-4958183363



### comment #4983609637 by `RiriAgent` — 2026-07-15T17:42:26Z

<!-- coder-loop:executable-contract schema=1 source-issue=601 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/601
- Observed body update timestamp (`lastEditedAt`): `2026-07-15T12:58:43Z`
- Operator-comment URLs used: none. The current intent comes from the live issue body; the issue's three existing comments are supersession-linked executable-contract markers, not operator intent changes.

## Deliverable

`implementation-pr`

Continue the existing open PR https://github.com/mouriya-s-lab/coder-loop/pull/678 and its existing issue branch. Preserve the committed authorization work, then align its proof path with the current issue body: every runner-visible path comes from one exhaustive typed surface model, loop-data channels are sliced to the active phase's declared runtime bindings, and Claude/Codex/OpenCode consume the same effective read/write policy across fresh/resume and scheduler/chain-complete invocation paths. Preserve task-private `agentCwd` and runner scratch, read-only preset access, declared item/chain channels, the exact daemon socket needed for credentialed CLI writes, runner runtime files required for startup/resume, and repo-level Git coordination needed for normal linked-worktree commits. Ambient Git credentials and #567's later lifetime re-scoping remain out of scope.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | authorization construction | shell | `rg -n 'RunnerFilesystemSurface|RuntimeBindingPaths|buildCentralRuntimeBindingPaths|buildRunnerFilesystemAuthorization|runnerGitMetadataSurfaces|runnerSandboxProfile|invocationAuthorization|file-read|file-write|loopDataRoot|--add-dir|dangerously-skip-permissions|danger-full-access' src/loop.ts src/scheduler.ts` from repository root; local env | exit `0`; no whole-`loopDataRoot` read or write grant exists; every emitted path is classified as task-private, an active-phase declared channel, required runner runtime, exact device/socket, or repo-level shared Git coordination; construction is exhaustive and has no unconditional chain-wide fallback |
| C2 | focused regression | shell | `bun test src/loop.test.ts src/scheduler.test.ts scripts/runner-filesystem-grants-integration.test.ts -t 'runner filesystem grants|runner projections|runner authorization metadata|phase-scoped runner surfaces|runner git metadata|deterministic runner filesystem integration'` from repository root; local env | exit `0`; tests cover all three runner projections, fresh/resume, scheduler/chain-complete, active-phase binding slices, preset read/write distinction, declared-channel success, undeclared same-chain/other-chain/root-level loop-data denial, linked-worktree Git metadata, outer sandbox contents, metadata bypass spellings, and exact root-grant absence |
| C3 | type integrity | shell | `bun run typecheck` from repository root; local env | exit `0`; no type errors and no violation of the repository ADT / no-`any` / no-real-`as` contract |
| C4 | canonical suite | shell | `bun test` from repository root in a clean checkout with an isolated test runtime | exit `0`; all tests pass with no removed, renamed, skipped, or weakened pre-existing assertion |
| C5 | repository process gate | shell | `bun scripts/engine-integration.ts` from repository root; local env; harness-owned UUID fixture and isolated loop-data root | exit `0`; the repository's canonical deterministic process gate completes daemon/socket/spawn/worktree/credential-admission/SQLite, reclaims its worktree, and reports no orphan; this is the daily repository gate, not the issue-specific authorization proof |
| C6 | issue-specific authorization integration | shell | `bun scripts/runner-filesystem-grants-integration.ts` from repository root; local macOS env with `/usr/bin/sandbox-exec`; driver-owned isolated loop-data root; no Claude/Codex/OpenCode network session and no GitHub fixture | exit `0`; a real daemon spawns deterministic shims through each Claude/Codex/OpenCode projection for fresh and resumed attempts; each shim reads the declared preset/shared/current-issue inputs, cannot mutate preset or read/write driver-created undeclared same-chain, other-chain, or root-level loop-data sentinels, writes declared evidence, commits in the linked worktree, and advances through credentialed `item exits` + `item update`; captured native argv and engine-produced outer profiles contain no whole-root or metadata bypass; SQLite/status/events/process/resource before/after assertions prove the dedicated path ran and teardown leaves no daemon, socket, runner, or worktree orphan |

## Pattern scope

| Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|
| `whole-tree` | `RunnerFilesystemSurface|RuntimeBindingPaths|buildCentralRuntimeBindingPaths|buildRunnerFilesystemAuthorization|invocationAuthorization|runnerGitMetadataSurfaces` | typed authorization construction in `src/`; focused tests and deterministic integration fixtures may construct forbidden paths only as negative cases | every authorization construction site converges on one exhaustive ADT; loop-data surfaces are admitted only for active-phase runtime bindings; runner-runtime and repo-level Git coordination are explicit variants; no global loop-data fallback or unconditional chain-wide grant remains |
| `whole-tree` | `buildRunnerInvocation|agentClaudeArgs|agentCodexArgs|agentOpencodeArgs|runnerSandboxProfile|sandbox-exec|--add-dir|--sandbox|-s|--cd|-C|--dir|--permission-mode|dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|danger-full-access` | the three runner projections, scheduler and chain-complete call sites, metadata validation, focused tests, and the deterministic integration driver | fresh/resume and scheduler/chain-complete consume the same effective authorization object; engine-owned projection forms do not silently broaden it; metadata-supplied authorization controls, including equal and short spellings, fail explicitly |
| `changed` | `runner-filesystem-grants-(e2e|integration)|engine-integration|real-e2e` | rename/replace the PR-local real-runner driver and its tests with the deterministic issue-specific integration; preserve the canonical `engine-integration` driver; no change to `scripts/real-e2e.ts` is required | issue proof ends at the dedicated deterministic process integration; it does not require configured real-runner sessions or GitHub lifecycle execution, and it does not absorb #684 or #685 |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; run from a clean checkout of the final pushed PR head. C5 and C6 create driver-owned isolated local runtime roots and must not touch production `~/.coder-loop`. C6 requires the verified local `/usr/bin/sandbox-exec`, but no external runner or GitHub authentication.
- Start: C5 starts the repository's canonical deterministic engine fixture. C6 starts an isolated real daemon and creates one fixture chain per runner kind, with PATH-resolved deterministic shims standing in for the three native CLIs while the engine's real runner projection and outer sandbox remain in the executed path.
- Readiness: each driver waits for its own Unix daemon socket via `bun src/loop.ts daemon status --loop-data-root <isolated-root> --json` before adding work.
- Behavior: C6 directly exercises the new typed authorization state and fresh-to-resume transition for all three projections; it performs declared positive operations, undeclared negative operations, linked-worktree Git, and credentialed state writes, then asserts SQLite/status/events/process/resource before and after values. C5 alone is not accepted as proof of C6.
- Logs: preserve C5's evidence summary and C6's complete outer profile, native argv, positive/negative probe results, daemon stdout/stderr, structured events, run `status.json`/`stdout.jsonl`, SQLite/status snapshots, final chain status, and teardown audit under the issue evidence directory.
- Stop ownership: each driver owns and must stop its isolated daemon, confirm PID/socket removal, reclaim run-owned worktrees/processes, and retain a diagnostic directory on failure instead of claiming completion.
- Browser / GitHub E2E: none for this issue. Cross-issue v3 integration belongs to https://github.com/mouriya-s-lab/coder-loop/issues/684; bundled-preset real runner + GitHub compatibility belongs exclusively to https://github.com/mouriya-s-lab/coder-loop/issues/685 on a frozen release-candidate SHA.

## Test delta

`required`

Keep and extend the focused authorization tests, and replace the PR-local real-runner-session driver/test with the deterministic C6 process-integration driver/test. Surviving integrity rule: no test present on `origin/main` may be removed, renamed, skipped, or weakened merely to pass; renaming the PR-local unmerged driver/test is allowed only to make its new deterministic integration semantics accurate. C3-C5 remain green in a clean isolated run; C6 must prove the issue-specific positive and negative runtime behavior rather than relying on source inspection, a generic linear preset, or previously captured real-runner/GitHub evidence.

## Dependencies

- The live issue body revision is `2026-07-15T12:58:43Z` and explicitly sets this issue's verification level to a real daemon, isolated loop-data, and deterministic runner in a dedicated process integration. It explicitly excludes `bun scripts/real-e2e.ts`, assigns cross-issue scenarios to https://github.com/mouriya-s-lab/coder-loop/issues/684, and assigns existing GitHub compatibility real E2E to https://github.com/mouriya-s-lab/coder-loop/issues/685. This supersedes the old marker's real-runner C6 and GitHub-lifecycle C7 requirements; see the drift report https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4983548229.
- The existing implementation PR https://github.com/mouriya-s-lab/coder-loop/pull/678 is open, non-draft, mergeable, and closes only #601. Its branch is `issue-601-run-1783909035253-16-iteration-item-8` at `2bbfaa3ca8681d1f1418169170e5461b000c7878`; it has no submitted reviews, inline review threads, commit statuses, or check runs in the complete fetch. Continue this PR and branch; do not open a replacement.
- The current PR checkout already centralizes the surface model and active-phase projection in `src/loop.ts:1293-1310`, `src/loop.ts:6553-6565`, `src/loop.ts:6992-7050`, `src/loop.ts:7093-7124`, and `src/scheduler.ts:2392-2403`. Its current `scripts/runner-filesystem-grants-e2e.ts` resolves and invokes real Claude/Codex/OpenCode binaries, so iteration must replace that external-session dependency with deterministic shims while retaining the real daemon/spawn/outer-sandbox/CLI-state path and the same positive/negative authority observations.
- Parent https://github.com/mouriya-s-lab/coder-loop/issues/546 is open. Related https://github.com/mouriya-s-lab/coder-loop/issues/560 and https://github.com/mouriya-s-lab/coder-loop/issues/567 remain open; #560 may later require closure-granularity re-audit, while #567 owns later evidence/current-issue lifetime re-scoping. Neither is a hard blocker for this authorization narrowing.
- Verified local runtime facts: Bun `1.3.14`, Git `2.55.0`, and `/usr/bin/sandbox-exec` are available. Browser evidence is not required because this is a CLI/engine authorization task; C6 is the strongest in-scope Layer 4 evidence.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/601#issuecomment-4977279702



### comment #4986014427 by `RiriAgent` — 2026-07-15T22:47:36Z

## Coder-loop closure (run-1784155528348-20-closure-item-8)

Accepted: merged PR https://github.com/mouriya-s-lab/coder-loop/pull/678 at merge commit `9844e998639fbb4c19e32b4c037ba80ce7229630`; consumed verdict https://github.com/mouriya-s-lab/coder-loop/pull/678#issuecomment-4985991758.


---

## Timeline (35)

- 2026-07-10T05:26:58Z `assigned` @RiriAgent
- 2026-07-10T05:27:28Z `parent_issue_added` @RiriAgent
- 2026-07-10T05:29:50Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-10T05:32:20Z `referenced` @RiriAgentcommit=49d84106d5a3a23d8420278a739d6d4f992758ce
- 2026-07-10T11:54:10Z `cross-referenced` @RiriAgentsrc=607
- 2026-07-11T00:50:28Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-11T08:33:36Z `referenced` @RiriAgentcommit=6bad6fcea488533dd230d4a26548957ddf0eec69
- 2026-07-11T23:23:22Z `cross-referenced` @RiriAgentsrc=653
- 2026-07-12T14:00:42Z `cross-referenced` @RiriAgentsrc=666
- 2026-07-12T14:34:45Z `cross-referenced` @RiriAgentsrc=667
- 2026-07-13T00:03:34Z `cross-referenced` @RiriAgentsrc=661
- 2026-07-13T02:11:34Z `commented` @RiriAgent
- 2026-07-13T12:29:39Z `cross-referenced` @RiriAgentsrc=678
- 2026-07-13T12:57:31Z `commented` @RiriAgent
- 2026-07-15T05:45:05Z `commented` @RiriAgent
- 2026-07-15T13:49:16Z `referenced` @RiriAgentcommit=0c8aeb7d07c32f957ea465fc07f61643d3c82544
- 2026-07-15T13:49:16Z `referenced` @RiriAgentcommit=b75d8c123f890128046f1062f309f4ae122251e7
- 2026-07-15T13:49:16Z `referenced` @RiriAgentcommit=8ea674c922170b1ef6cccaff8733bc7ce79e27b0
- 2026-07-15T13:49:17Z `referenced` @RiriAgentcommit=c856458c5081c4e1bbce70d56ef1f613fe8080d2
- 2026-07-15T13:49:17Z `referenced` @RiriAgentcommit=7ed2145f60b662aa00aa39bb167c1f604de2d174
- 2026-07-15T13:49:17Z `referenced` @RiriAgentcommit=8bc1efff6ff8d454bb23b65a36b6e17db5d11fae
- 2026-07-15T13:49:17Z `referenced` @RiriAgentcommit=1445afa587b283999e070a4902153c6486af962a
- 2026-07-15T16:52:40Z `referenced` @RiriAgentcommit=6db150479c822a6cf388b528ee124663d0a6457e
- 2026-07-15T16:52:41Z `referenced` @RiriAgentcommit=2bbfaa3ca8681d1f1418169170e5461b000c7878
- 2026-07-15T17:42:26Z `commented` @RiriAgent
- 2026-07-15T19:17:42Z `referenced` @RiriAgentcommit=8348895a1ae36e965d05e1b693607e2b61ac5996
- 2026-07-15T19:17:42Z `referenced` @RiriAgentcommit=9d65d26d36ec6322064346796d9b5eebaa36d23d
- 2026-07-15T22:10:17Z `referenced` @RiriAgentcommit=53eeb73b2f8b87d036e57a86a01c3d8d2e258bb7
- 2026-07-15T22:47:14Z `closed` @RiriAgentcommit=None
- 2026-07-15T22:47:14Z `referenced` @RiriAgentcommit=9844e998639fbb4c19e32b4c037ba80ce7229630
- 2026-07-15T22:47:36Z `commented` @RiriAgent
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:27:43Z `cross-referenced` @RiriAgentsrc=560