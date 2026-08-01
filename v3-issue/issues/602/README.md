# #602 外部执行终端 runner 的缺席语义与 daemon 显式警告路径

- state: **open**  | author: `RiriAgent`  | created: 2026-07-10T05:56:40Z  | updated: 2026-07-17T19:17:52Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/602
- comments: 0  | timeline events: 27

---

## Body

## 必须先读的关联 issue

- #548（RFC-6 umbrella，parent）。本 issue 继承以下已经裁定的边界：
  - HAPI 远端 HTTP 交互不进入 coder-loop；通用交互 CLI 归 `mouriya-s-lab/hapi-remote-session`。coder-loop 对 HAPI 通道的感知收敛为 runner binary、probe、退出码、`status.json` 与工作目录契约。
  - hapi 必须作为首个真实「外部执行终端」样板落地，用实现和真实运行验证抽象，不能先做无法被真实执行证伪的抽象。
  - 全链路使用精确 ADT：禁止新增 `any`、匿名形状、非边界 `unknown` 与真 `as` 断言（`as const` 除外）；外部输入在边界解析为精确类型后流转。
- #418 与 `mouriya-s-lab/hapi-remote-session#1`：HAPI 交互调查及 headless CLI 消费契约。
- `mouriya-s-lab/hapi-remote-session#2`：coder-loop 要实际 spawn 的 CLI 实现。

## 目标

把「外部执行终端随时可能不存在」与「真实 hapi runner 执行」作为一个不可拆分的闭环交付：`hapi` 进入 runner 词表；daemon 在创建、调度和运行中检测终端可用性；缺席时显式 warning + hold；恢复后自动执行；执行时通过 `hapi-remote-session` 完成真实远端 session；运行中通道消失时，以独立 loss 语义终止、恢复并重新调度。

本 issue 同时完成原 #602 与 #603 的全部范围。二者不能分阶段完成：没有真实 hapi invocation，就不存在可验证的 active external-terminal run，运行中 loss/latch/recovery 只是不可达代码；没有 availability/hold/loss 语义，真实 hapi invocation 又不具备“终端随时可能不存在”的正确运行模型。

## 使用场景

操作员在 preset phase 或 item 上声明 `runner = "hapi"` 后离开：

1. HAPI 通道当前缺席时，item 的 durable intent 被接受并进入 hold；daemon 不创建 worktree/run/credential，不增加 attempt，也不进入 `spawn_failed` backoff。操作员从 `status --json` 和 `logs --json` 直接看到缺席原因及受影响 item。
2. 通道恢复后，daemon 无需 `queue unblock` 或 item mutation，自动 spawn `hapi-remote-session`，在该任务的既有 worktree 中启动或恢复远端 session，并按退出码与 `status.json` 推进队列。
3. active HAPI run 期间通道消失时，daemon 对该 run 记录 durable loss、撤销 credential、受控终止 runner、恢复 run 前 item 状态与 attempt，并在通道恢复后以 fresh invocation 重新调度。
4. 操作员通过与本地 runner 一致的 `current.runner`、`phaseRunners`、run/status/log 读面观察完整生命周期，同时能明确区分 endpoint 缺席、probe 故障、runner 业务失败和运行中终端丢失。

## 上下文

- **Repo**：`mouriya-s-lab/coder-loop`（path：`/Users/mouriya/Ext/code/coder-loop`）。
- **当前实现 PR**：#676。继续使用其现有 branch/PR；最终可合并 revision 必须覆盖本 issue 的完整原子范围。
- **当前问题来源**：#676 已证明原拆分不可执行。若 `hapi` 被建模为 `probe-only / invocation-pending`，生产 scheduler 会在 worktree/run/attempt/credential 之前永久停止，因此 active-run loss 逻辑没有任何生产入口；用 fake runner、测试注入或直接构造 active state 只能验证内部函数，不能证明真实产品闭环。
- **runner 基线**：`claude | codex | opencode` 是本地进程 runner；`hapi` 是首个外部执行终端 runner。四者共享调度、attempt/result、status 和观察面；external-terminal availability/loss 是执行域差异，不是 hapi 名字特判。
- **headless 完成契约**：runner 在所属任务闭包的 worktree 内执行；完成由进程退出码和 `<logDir>/<runId>/<phase>/status.json` 表达；同一 `(item, phase)` attempt 链的 retry/resume 复用既有闭包，闭包 consumed 后才回收。

## 问题

现有引擎只把 runner 不可用视为 spawn failure，并进入盲指数 backoff。对外部执行终端而言，缺席是正常、可恢复的运行状态，不是瞬时 spawn 故障；该状态必须在调度前被发现并在 operator 读面显式呈现。

同时，外部终端抽象不能脱离真实 hapi invocation 单独完成。probe、hold、loss latch、credential revoke、TERM/KILL、status race、session invalidation 和 recovery 都依赖同一个真实 active run 身份。若 availability/loss 与 invocation/session/status 被拆到两个 issue：

- 前半部分只能制造一个永远停在 `invocation-pending` 的 runner，无法验证运行中消失；
- 后半部分又依赖前半部分定义 active-run gate、loss 和恢复语义；
- 两边互相依赖，任何一边都不能通过端到端 runtime 验收；
- 大量不可达的 speculative machinery 会先进入 main，直到后续 issue 才首次经真实输入运行。

因此完成单位必须是从 runner 选择、probe、真实 invocation、远端 session、status 写回，到缺席、恢复与运行中 loss 的一个生产闭环。

## 已裁定的完整运行语义

### Runner 领域与 HAPI 边界

- runner execution domain 是穷尽 ADT：`local-process` 与 `external-terminal`。
- `claude | codex | opencode` 属于 `local-process`；`hapi` 属于 `external-terminal`，且在本 issue 完成态必须可真实 invocation，不得保留 `probe-only / invocation-pending` 作为最终生产状态。
- scheduler/daemon 的 availability 决策只消费 execution-domain ADT，不出现 `runner.kind === "hapi"` 等名字特判。
- coder-loop 只知道 hapi runner binary、启动参数、probe 子命令、退出码、`status.json`、worktree 与进程生命周期；不得引入 HTTP client、HAPI URL/auth/remote response parsing 或服务端 session 生命周期实现。
- `hapi-remote-session` 负责远端 HTTP/session 交互；coder-loop 通过统一 runner invocation 与 headless 结果契约消费它。

### Probe 契约

- 调用已解析 runner binary 的字面量 `probe` 子命令。
- exit `0`：available。
- exit `69`（`EX_UNAVAILABLE`）：endpoint unavailable。
- binary 无法执行：binary missing。
- 其他非零退出、signal 或 deadline：probe failed，不能伪装成正常 endpoint 缺席。
- probe 不读取 stdout JSON，不创建 worktree/run/credential/artifact，不接触 HAPI HTTP 协议。
- probe 进程服从 daemon 的受控 TERM/grace/KILL 机制和显式 deadline。

### 创建与调度

- 创建期接受 durable item，不因终端缺席回滚 item 创建；创建后立即形成 engine-owned hold 与 warning。
- 每次候选调度在 worktree、run ID、run ledger/current-run、attempt、credential、session、prompt/artifact 和 runner process 之前执行 availability gate。
- unavailable/probe-failed item 释放 repo slot，scheduler 继续选择同 repo 其他 runnable item；不能造成队首饥饿。
- 缺席不改变 preset status，不增加 attempt，不写 scheduler backoff。
- available 后直接进入完整真实 hapi invocation，不经过永久 `invocation-pending` 中间态。
- 恢复后下一次 tick 自动清 hold、发一次 restoration event，并启动真实 runner；不需要人工解卡。

### 真实 HAPI invocation

- daemon 按统一 runner 管线 spawn `hapi-remote-session`，传入本次 phase 的完整 rendered prompt、任务 worktree、run/status 位置、resume decision 与所需授权。
- hapi run 的完成、失败、retry、resume、status admission 与 worktree 回收遵守其他 runner 的统一 attempt/result 边界；不得新增 hapi 专属队列推进路径。
- 同一 `(item, phase)` attempt 链可恢复同一远端 session；运行中终端 loss 后清除该 session identity，恢复时必须 fresh invocation，不能 resume 已失联 session。
- `status --json` 必须准确报告 hapi runner/model、当前 run、availability 和 loss；`status.json` 是业务结果事实源，普通 stdout 文本或 HAPI 私有响应不能旁路推进状态。

### 运行中终端消失

- 仅 active external-terminal run 周期 probe。
- 第一次从 available 进入 unavailable/probe-failed 时，以不可覆盖的 per-run durable latch 决定 loss 归因，并立即撤销该 run credential。
- loss latch 以 immutable `run_id` 为权威，不能使用 chain-singleton 投影承载；同一 chain 不同 repo slot 的并发 run 必须独立。
- latch 后按既有进程组语义 SIGTERM，grace 后仍存活则 SIGKILL。
- latch 前已成功提交的 terminal status 胜出；terminal commit 与 probe/warning 的 await race 不得被后来的 loss 覆盖。
- loss 先胜出时，后续 status write 或普通 child exit 不得把它改写成业务失败/成功。
- close 时清 current-run/slot/credential/session，恢复 run 前 item status、phase、status timestamp 与 attempts；不进入 `spawn_failed` backoff。
- daemon 重启后必须从 durable per-run facts 继续完成 loss recovery，不得丢失归因或留下 stale hold/current run。

### Warning、去重与读面

- availability 状态按解析后的 endpoint identity（runner kind + binary + probe argv）管理，而不是按 tick 或 item 管理。
- `unknown|available -> unavailable|probe-failed` 发一次 typed `daemon.warning`；同状态重复 probe 不刷屏；reason 改变是新跃迁。
- `unavailable|probe-failed -> available` 发一次 typed restoration diagnostic。
- warning payload 至少包含 code、runner、binary、probe argv、typed reason、exit/signal、checkedAt 及受影响 `{chainId,rowId,itemId,phase}`。
- `queue.holds[]` 列出全部当前受影响 item；runner 更新、本地 runner 切换、terminal completion 与恢复都必须清除失效 hold。
- `current.externalTerminal` 对 active external run 暴露当前 availability 与 loss；endpoint 缺席、probe failed、runner business failure、spawn failure 和 external-terminal loss 在 wire 上互不混淆。

## 预期结果

1. `runner=hapi` 从 item 创建到真实远端 session 完成形成一个可运行闭环，队列按 `status.json` 正确推进。
2. 创建期、调度期和运行中三档可用性语义均通过同一个真实 hapi runner 路径验证；不存在只在 fake/test seam 可达的 loss 逻辑。
3. 终端缺席时 item durable hold、无 spawn/attempt/backoff；恢复后自动真实执行。
4. active HAPI run 期间终端消失时，per-run loss、credential revoke、受控终止、状态恢复、session invalidation 与重新调度全部可观察。
5. terminal-first、loss-first、并发 repo-slot run 与 daemon restart 的竞态结果确定且 durable。
6. operator 从 `status --json` / `logs --json` 获取完整 typed availability/hold/restoration/loss 信息，不需要从 spawn-failure 日志推断。
7. coder-loop 不包含 HAPI HTTP/session 协议实现；触碰位置形成可核对的外部执行终端接入边界清单。
8. 本地 runner 的 invocation、missing-binary、spawn failure、attempt、resume 与 status 行为不变。

## 不应残留

- 不得保留 `hapi` 的最终 `probe-only / invocation-pending` 生产状态。
- 不得保留只能由 test fixture、隐藏 override、路径/名字/extraArgs 约定或直接构造内部 state 才能触达的 active-run loss 路径。
- 不得把 endpoint 缺席送入 `spawn_failed` 盲 backoff。
- 不得按 hapi kind 名在 scheduler/daemon 散落 availability 或推进特判。
- 不得在 coder-loop 中实现 HAPI HTTP、URL、auth、remote response 或服务端 session 管理。
- 不得绕过 `status.json` 以 stdout 文本或私有 HAPI 响应推进 item。
- 不得留下 terminal item stale hold、恢复后 stale warning、每 tick warning spam、held item 阻塞同 repo 后续 runnable item。
- 不得以 unit test、fake-only integration、`scripts/engine-integration.ts` 或现有 GitHub real E2E 代替真实 HAPI remote session E2E。
- 不得修改 `hapi-remote-session` CLI 本体；其实现归 `mouriya-s-lab/hapi-remote-session#2`。

## 验证边界

- **必须执行的业务 E2E**：真实 coder-loop daemon + 隔离 loop-data + 真实 `hapi-remote-session` + 真实 HAPI machine，覆盖正常完成、创建/调度缺席恢复、active-run loss、terminal-first、loss-first、restart 与并发 run。
- **可控故障注入**：可以控制 probe 返回 missing/69/nonzero/signal/deadline，也可以控制真实 runner 进程的 terminal/loss 竞态；但不能绕过生产 invocation capability、生产 scheduler/daemon/run ledger 或真实 HAPI session 来制造通过。
- **内部回归 gate**：typecheck、focused tests、完整 `bun test`、`scripts/engine-integration.ts` 只能补充证明 schema/类型/本地 runner 未回归，不替代业务 E2E。
- **不在本 issue 内执行**：`bun scripts/real-e2e.ts` 的 bundled preset / GitHub compatibility 由 #685 在冻结 release-candidate SHA 上执行；#684 负责冻结 SHA 的跨子系统组合验证。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | integration | 覆盖预期结果 1、7：真实 hapi 正常完成 | 用 repository-owned HAPI E2E driver 启动隔离 daemon，创建 `runner=hapi` item 并等待真实远端 session 完成 | local + 真实 HAPI machine + 已安装 `hapi-remote-session` | runner 收到完整 prompt/worktree/status 契约；真实 session 完成；`status.json` 被 admission；item/phase 正确推进；领域边界记录只包含 binary/headless 契约触点 |
| 2 | integration | 覆盖预期结果 2、3、6：创建/调度缺席与恢复 | 同一 E2E 生命周期依次使 binary missing、probe exit 69、其他非零、signal、deadline，再恢复 endpoint | 同上 | 每种 typed reason 正确；hold/warning 可见且去重；零 worktree/run/attempt/credential/backoff；恢复只发一次 restoration，并自动进入真实 HAPI invocation |
| 3 | integration | 覆盖预期结果 2、4：active-run loss-first | 真实 HAPI run 已 active 且 credential/status admission 已确认后使 endpoint 消失，再恢复 | 同上 | per-run loss latch、credential revoke、TERM/grace/KILL、session 清理、pre-run tuple/attempt 恢复可见；恢复后 fresh invocation 完成；无普通 spawn backoff |
| 4 | integration | 覆盖预期结果 4、5：terminal-first 与 await race | 在真实 active run 中让 terminal `status.json` admission 与 loss probe/warning 交错执行 | 同上 | 已持久化 terminal status 胜出；无 loss 覆盖、stale hold 或重复 warning；run 正常 close |
| 5 | integration | 覆盖预期结果 4、5：daemon restart recovery | loss latch 持久化后、进程关闭前重启隔离 daemon | 同上 | 新 daemon 从 durable run fact 完成 credential/session/current/slot/item 恢复，loss 归因不丢失，恢复后可重新调度 |
| 6 | integration | 覆盖预期结果 5：并发 repo-slot 隔离 | 同一 chain 在两个 repo slot 启动两个真实 external-terminal run，只使其中一个 endpoint/run 丢失 | 同上 | loss 以各自 `run_id` 独立归因；另一 run 不被覆盖、终止或错误恢复 |
| 7 | function | 覆盖预期结果 6：operator 读面 | 在验收 1–6 每个 checkpoint 保存 `coder-loop status <target> --json` 与 `logs --json` | 同上 | `queue.holds[]`、`current.externalTerminal`、warning/restoration/loss payload 与实际 SQLite/run/process 状态一致 |
| 8 | environment | 覆盖预期结果 7：HAPI 协议边界 | 对最终 diff 与引擎目录执行 HTTP/URL/auth/remote-response/session-server 概念审计，并列出 hapi 触碰位置 | local | coder-loop 内零 HAPI 协议实现；全部触点可归类为词表、execution domain、probe、invocation、worktree/status、observability |
| 9 | function | 覆盖预期结果 8：本地 runner 不回归 | `bun install --frozen-lockfile && bun run typecheck && bun test && bun scripts/engine-integration.ts` | local isolated loop-data | 全部 exit 0；claude/codex/opencode 不执行 external-terminal probe，不改变既有 missing-binary/spawn failure 与 attempt/resume 行为；无 orphan runtime |
| 10 | function | 完整测试与完整性卫生 | `git fetch origin main`; 在 candidate 与其 live merge-base 分别执行 `bun install --frozen-lockfile && bun test`，并审计 `$BASE..HEAD` test diff | clean detached worktrees | 两侧 exit 0；candidate 包含当前 `origin/main`；无删除/重命名/skip/todo/only/弱化既有测试；无 runtime/evidence/credential 文件进入 commit |

## 实现与证据要求

- 继续现有 PR #676；不要用第二个 PR 分别关闭 #602/#603。
- PR body 第一行只关闭 #602；所有实现、验证与 runtime evidence 绑定同一 immutable candidate SHA。
- PR evidence 必须包含真实 HAPI E2E 的 setup、readiness、逐 checkpoint 行为、status/log/SQLite/process/session 观察、cleanup 与可复现命令。
- Web/browser 行不适用；本 issue 是 CLI/daemon/SQLite/remote-runner 路径。
- 验证结束后停止隔离 daemon/children，清除其 socket、worktree、credential 与 recreatable runtime；不得触碰生产 `~/.coder-loop`。

## 依赖关系

- Depends on：`mouriya-s-lab/hapi-remote-session#2`（可执行 CLI）、#418 与 `mouriya-s-lab/hapi-remote-session#1`（交互与 headless 契约）。
- Coordination：#559（scheduler/task-tree 同语义面，后合者基于 current main reconcile 并重跑完整验收）。
- Blocks：#548 关闭验证行 7；#684 冻结 SHA 跨子系统验证；#685 bundled preset / GitHub compatibility。
- #603 的全部需求已并入本 issue，不再是 #602 的 dependency，也不能作为独立半闭环完成。


---

## Comments (0)

---

## Timeline (27)

- 2026-07-10T05:56:40Z `assigned` @RiriAgent
- 2026-07-10T05:58:14Z `cross-referenced` @RiriAgentsrc=603
- 2026-07-10T05:58:46Z `parent_issue_added` @RiriAgent
- 2026-07-10T05:59:28Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-10T06:00:30Z `cross-referenced` @RiriAgentsrc=418
- 2026-07-10T06:02:41Z `referenced` @RiriAgentcommit=1d09c41d35c5fb064c7ce07332bbe9879b3b3284
- 2026-07-12T01:22:22Z `cross-referenced` @RiriAgentsrc=660
- 2026-07-12T14:00:42Z `cross-referenced` @RiriAgentsrc=666
- 2026-07-12T14:34:45Z `cross-referenced` @RiriAgentsrc=667
- 2026-07-13T00:03:34Z `cross-referenced` @RiriAgentsrc=661
- 2026-07-13T05:31:14Z `cross-referenced` @RiriAgentsrc=676
- 2026-07-13T10:24:48Z `referenced` @RiriAgentcommit=76d2e2f0ab713e566efcfeb56406112a98323a7f
- 2026-07-13T10:24:48Z `referenced` @RiriAgentcommit=3f856eda5fd857e7d9f0f9e05853562a2051b86c
- 2026-07-13T12:33:47Z `referenced` @RiriAgentcommit=7b71372230f248dc0e0acf6d5190e59d38299dfe
- 2026-07-13T12:33:47Z `referenced` @RiriAgentcommit=21ba3690b5ce27b8b41c294e77f8c709a3c56093
- 2026-07-13T12:33:47Z `referenced` @RiriAgentcommit=b959904e383b427efbe4d21b0f527affca207d7a
- 2026-07-15T10:58:34Z `referenced` @RiriAgentcommit=1c0d08531296d292e2d7903f2dc4c58e3ec1570f
- 2026-07-15T10:58:35Z `referenced` @RiriAgentcommit=044ed35897007c54ff6fb9f75e5e4ea47e2e3db0
- 2026-07-15T10:58:35Z `referenced` @RiriAgentcommit=3022704f976f0234bde988652180a5b2871f2e7d
- 2026-07-15T13:39:56Z `referenced` @RiriAgentcommit=614e3a80cb58a61556df0821d55401a16fb0f107
- 2026-07-15T13:39:57Z `referenced` @RiriAgentcommit=868c4a2dbc3371e27b94adf669f1aea4617e98de
- 2026-07-15T22:29:23Z `referenced` @RiriAgentcommit=fea7c8d58c69aa2e34dcbe432450bd8f6e1f4815
- 2026-07-16T02:04:26Z `referenced` @RiriAgentcommit=36ff50118160b50a6f0f863b80000409d73f211c
- 2026-07-16T02:04:27Z `referenced` @RiriAgentcommit=04a9e8ec57bc4365b5099eedfd2437f7551df85f
- 2026-07-16T05:27:59Z `referenced` @RiriAgentcommit=34397f05470673a4761a8460c0d1cb8187088106
- 2026-07-17T20:37:36Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:37:46Z `cross-referenced` @RiriAgentsrc=748