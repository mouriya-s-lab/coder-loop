# #748 test(v3): 外部 router 与 HAPI runner 冻结 SHA 综合验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:45Z  | updated: 2026-07-27T01:20:11Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/748
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#548](https://github.com/mouriya-s-lab/coder-loop/issues/548) 的共享契约与关闭验证。

## 目标

以 corrected atomic #602/PR #676 为 HAPI runner owner；hapi runner 接入不再单列为独立 issue，与外部终端缺席语义合并交付。task-closure worktree/resume/consume 验收硬依赖 #699 replacement。

把「外部执行终端随时可能不存在」与「真实 hapi runner 执行」作为一个不可拆分的闭环交付：`hapi` 进入 runner 词表；daemon 在创建、调度和运行中检测终端可用性；缺席时显式 warning + hold；恢复后自动执行；执行时通过 `hapi-remote-session` 完成真实远端 session；运行中通道消失时，以独立 loss 语义终止、恢复并重新调度。

本 issue 同时完成外部终端缺席语义与 hapi runner 接入的全部范围。二者不能分阶段完成：没有真实 hapi invocation，就不存在可验证的 active external-terminal run，运行中 loss/latch/recovery 只是不可达代码；没有 availability/hold/loss 语义，真实 hapi invocation 又不具备“终端随时可能不存在”的正确运行模型。

把 hapi 外部执行终端的执行路径接入引擎调度（spawn `hapi-remote-session` CLI 作为 runner binary），并以一次真实远端 session run 验证 runner 抽象与领域模型边界——本 issue 是「外部执行终端」类别的接入样板。

## 问题

现有引擎只把 runner 不可用视为 spawn failure，并进入盲指数 backoff。对外部执行终端而言，缺席是正常、可恢复的运行状态，不是瞬时 spawn 故障；该状态必须在调度前被发现并在 operator 读面显式呈现。

同时，外部终端抽象不能脱离真实 hapi invocation 单独完成。probe、hold、loss latch、credential revoke、TERM/KILL、status race、session invalidation 和 recovery 都依赖同一个真实 active run 身份。若 availability/loss 与 invocation/session/status 被拆到两个 issue：

- 前半部分只能制造一个永远停在 `invocation-pending` 的 runner，无法验证运行中消失；
- 后半部分又依赖前半部分定义 active-run gate、loss 和恢复语义；
- 两边互相依赖，任何一边都不能通过端到端 runtime 验收；
- 大量不可达的 speculative machinery 会先进入 main，直到后续 issue 才首次经真实输入运行。

因此完成单位必须是从 runner 选择、probe、真实 invocation、远端 session、status 写回，到缺席、恢复与运行中 loss 的一个生产闭环。

runner 抽象（退出码 + `status.json` + per-task-closure worktree）迄今只被三个本地进程 runner 检验过，从未承载过远端长驻 session 形态的执行终端。抽象对不对、引擎与外部执行终端的领域边界在哪，没有实现就无法证伪：

> 「他的核心目的是实现后是接口的验证，而不会出现抽象做了压根不知道抽象对不对，以及更核心的领域模型边界在哪」 — 操作员（2026-07-10，#548 设计修正 comment）

## 预期结果

1. `runner=hapi` 从 item 创建到真实远端 session 完成形成一个可运行闭环，队列按 `status.json` 正确推进。
2. 创建期、调度期和运行中三档可用性语义均通过同一个真实 hapi runner 路径验证；不存在只在 fake/test seam 可达的 loss 逻辑。
3. 终端缺席时 item durable hold、无 spawn/attempt/backoff；恢复后自动真实执行。
4. active HAPI run 期间终端消失时，per-run loss、credential revoke、受控终止、状态恢复、session invalidation 与重新调度全部可观察。
5. terminal-first、loss-first、并发 repo-slot run 与 daemon restart 的竞态结果确定且 durable。
6. operator 从 `status --json` / `logs --json` 获取完整 typed availability/hold/restoration/loss 信息，不需要从 spawn-failure 日志推断。
7. coder-loop 不包含 HAPI HTTP/session 协议实现；触碰位置形成可核对的外部执行终端接入边界清单。
8. 本地 runner 的 invocation、missing-binary、spawn failure、attempt、resume 与 status 行为不变。

性质表述：

1. 引擎对 hapi kind 的全部知识 = binary 名 + 启动参数约定 + 退出码 + `status.json` + per-task-closure worktree 注入 + #602 的外部终端声明；grep 引擎源码无 HTTP client、session 生命周期等 HAPI 协议概念。
2. 四个 runner kind 在类型层穷尽（union + 穷尽 switch + SQLite CHECK）；hapi 不引入任何 scheduler 特判分支——差异终止于统一的 attempt/result 边界。
3. 样板义务：实现 PR 触碰的全部位置构成「接入一个外部执行终端引擎需要知道什么」的实证清单，落本 issue comment 作领域边界记录——这是后续任何外部执行终端接入的模板。
4. runner=hapi 的 item 与其他 runner 的 item 在队列推进、resume、终止语义上同构，无 hapi 专属推进路径。

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

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | integration | 真实 item 以 runner=hapi 完成一次 run（#548 关闭验证行 7 腿①） | 隔离 daemon（`--loop-data-root`）建 chain + item 指定 runner=hapi，观察全程 | local + 真实 HAPI machine | run 完成并推进队列；退出码 / `status.json` / per-task-closure worktree 生命周期与其他 runner 同构；同一闭包 retry/resume 复用既有 cwd，consumed 后才回收；`status --json` 读面正确报告 runner/model |
| 2 | integration | 缺席语义在真实 hapi kind 上生效（行 7 腿②联动） | 使 CLI 不可用后触发调度，再恢复 | 同上 | #602 定义的显式警告 + hold 生效；恢复后无人工干预完成执行 |
| 3 | environment | 引擎无 HAPI 协议知识 | grep 引擎源码（HTTP client / session 概念） | local | 零命中；hapi 感知收敛为 binary 契约 |
| 4 | function | 领域边界实证清单落地 | 实现 PR evidence 列出全部触碰位置，归纳落本 issue comment | local | 清单覆盖词表、spawn、配置、读面各触点，可作下一个外部执行终端的接入模板 |

## 伞 #548 的关闭终态条件（本 issue 复核对象）

以下是伞 #548 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | 结构化调用两分支可达 | 外挂形态调用方对引擎执行 into-chain 与 new-workspace 各一次 | 既有链追加 item 成功；新链建立 + item 入队并被调度执行；全程无 prompt 传递 |
| 2 | 请求校验面生效 | 元信息漏 required 字段 / preset 引用不存在的调用 | 外挂预校验或引擎创建期拒绝，错误点名缺失字段；无 spawn 后才失败的通路 |
| 3 | 幂等 | 同一 delivery id / 同一 itemId 重放 | 不产生第二个 item / 第二次执行 |
| 4 | GitHub 事件端到端 | labeled issue → router → 消费 daemon → 引擎 → preset 工作流 | issue 最终被 PR close；一次触发恰好一次执行 |
| 5 | 重试闭环 | coder-loop daemon 停机时触发事件，随后恢复 | not-consumed → router 保留重推 → 恢复后消费成功，事件不丢失 |
| 6 | 外挂纯度 | grep coder-loop repo 与消费 daemon repo | 引擎无 GitHub 外挂知识新增；消费 daemon 不 import coder-loop 源码，仅经 CLI |
| 7 | hapi 通道能力与边界 | ① 一个真实 item 以 runner=hapi 在真实 HAPI 远端 session 完成 run；② 通道缺席时 daemon 显式警告 + item hold，恢复后无人工干预执行；hapi-remote-session#1 设计书落地 | 退出码 / `status.json` / per-task-closure worktree 生命周期与其他 runner 同构；同一闭包的 retry/resume 复用既有 cwd，consumed 后才回收；警告在 events/status 可观察且区分于瞬时故障；coder-loop 内无 HAPI HTTP 客户端 |

## 依赖关系

- Depends on: #746、#747、hapi-remote-session#3、#602、#699。
- Blocks: #548 closure。



---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:46Z `assigned` @RiriAgent
- 2026-07-17T20:39:13Z `cross-referenced` @RiriAgentsrc=746
- 2026-07-17T20:39:14Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:40:26Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:13Z `cross-referenced` @RiriAgentsrc=603
- 2026-07-26T16:15:09Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-27T04:26:50Z `cross-referenced` @RiriAgentsrc=699