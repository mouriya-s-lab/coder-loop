# #603 hapi runner 接入：外部执行终端样板与真实远端 session 验收

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-10T05:58:13Z  | updated: 2026-07-17T20:42:13Z
- closed: 2026-07-17T20:42:13Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/603
- comments: 1  | timeline events: 13

---

## Body

## 必须先读的关联 issue

- #548（RFC-6 umbrella，parent）。继承契约逐字快照：
  - hapi 通道边界（#413 三条约束续命）：「HAPI 远端 HTTP 交互不在 coder-loop 内实现；通用交互 CLI 归 `mouriya-s-lab/hapi-remote-session`；coder-loop 对 hapi 通道的全部感知收敛为『又一个 runner binary』（退出码 + `status.json` headless 契约）」。
  - 实施定位裁决（操作员 2026-07-10）：「hapi的实现是一个样板，现在就要做，这是典型的外部执行终端，他的核心目的是实现后是接口的验证，而不会出现抽象做了压根不知道抽象对不对，以及更核心的领域模型边界在哪」。
  - 代码红线（操作员裁决 2026-06-12，全仓统一）：「必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。」
- #602（外部执行终端缺席语义，本 issue 的引擎侧前提：`hapi` kind 词表准入 + 缺席警告/hold 语义在彼处落地）。
- #418（spike）与 mouriya-s-lab/hapi-remote-session#1（设计书）：三者交互结论与 CLI 消费契约是本 issue 的输入。

## 目标

把 hapi 外部执行终端的执行路径接入引擎调度（spawn `hapi-remote-session` CLI 作为 runner binary），并以一次真实远端 session run 验证 runner 抽象与领域模型边界——本 issue 是「外部执行终端」类别的接入样板。

## 使用场景

操作员在 preset phase 或 item 上声明 `runner = "hapi"`；daemon 调度该 item 时 spawn `hapi-remote-session` CLI，工作在远端 HAPI session 完成，引擎按既有 headless 契约（退出码 + `status.json`）推进队列。操作员用与其他三 runner 完全相同的读面（`status --json` 的 `current.runner` / `phaseRunners`）观察它。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）。概念锚点（实施前自行 grep 核对行号）：
  - runner 词表与 CHECK：`src/loop.ts:681`、`src/sqlite-state.ts:395`——`hapi` kind 的词表准入由 #602 落地，本 issue 消费。
  - spawn 管线与 headless 契约：`src/scheduler.ts` spawn 一次性 runner 进程，完成信号 = 退出码 + `<logDir>/<runId>/<phase>/status.json`；runner 每次 run 注入所属任务闭包既有 worktree；同一 `(item, phase)` attempt 链的 retry/resume 复用，闭包 consumed 后才回收（#548「hapi 执行通道」节）。
  - runner/model 声明与读面：CLAUDE.md「Runner selection」节（per-phase `runner`/`model`、item `--runner` 覆盖、`chain set-runner-model`）。
  - 消费的 binary：`hapi-remote-session` CLI（mouriya-s-lab/hapi-remote-session#2），消费契约 = 其设计书（hapi-remote-session#1）的「headless 调用契约」节。

## 问题

runner 抽象（退出码 + `status.json` + per-task-closure worktree）迄今只被三个本地进程 runner 检验过，从未承载过远端长驻 session 形态的执行终端。抽象对不对、引擎与外部执行终端的领域边界在哪，没有实现就无法证伪：

> 「他的核心目的是实现后是接口的验证，而不会出现抽象做了压根不知道抽象对不对，以及更核心的领域模型边界在哪」 — 操作员（2026-07-10，#548 设计修正 comment）

## 预期结果

性质表述：

1. 引擎对 hapi kind 的全部知识 = binary 名 + 启动参数约定 + 退出码 + `status.json` + per-task-closure worktree 注入 + #602 的外部终端声明；grep 引擎源码无 HTTP client、session 生命周期等 HAPI 协议概念。
2. 四个 runner kind 在类型层穷尽（union + 穷尽 switch + SQLite CHECK）；hapi 不引入任何 scheduler 特判分支——差异终止于统一的 attempt/result 边界。
3. 样板义务：实现 PR 触碰的全部位置构成「接入一个外部执行终端引擎需要知道什么」的实证清单，落本 issue comment 作领域边界记录——这是后续任何外部执行终端接入的模板。
4. runner=hapi 的 item 与其他 runner 的 item 在队列推进、resume、终止语义上同构，无 hapi 专属推进路径。

## 不应残留

- 范围内不许留下：HAPI HTTP/session 概念进入引擎源码；hapi 专属的调度/推进特判；绕过 `status.json` 契约的完成信号旁路。
- 范围外不应改动：`hapi-remote-session` CLI 本体（归 hapi-remote-session#2）；缺席警告与 hold 语义（归 #602，本 issue 只消费）；其他三 runner 的执行路径。

## 约束

继承快照见「必须先读」。补充：Depends on #602 的词表准入落地形态——若 #602 的最终设计与本 issue 假设冲突（如声明位形态变化），以 #602 落定的 comment 为准，冲突回 #548 登记。

## 本 issue 的验证边界

- **验证层级**：跨系统专用 E2E。
- **本 issue 必须证明**：真实 HAPI remote session 的启动、运行、退出、状态写回和缺席恢复；这是本 issue 自己的产品路径。
- **不在本 issue 内执行**：不得用 `scripts/real-e2e.ts` 代替上述外部路径。coder-loop 内部跨子系统接缝归 #684；claude/codex/opencode 与现有 bundled preset 的 compatibility 归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。 本 issue 仍必须运行正文定义的 HAPI remote session 专用 E2E；它不是 `bun scripts/real-e2e.ts`。
## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | integration | 真实 item 以 runner=hapi 完成一次 run（#548 关闭验证行 7 腿①） | 隔离 daemon（`--loop-data-root`）建 chain + item 指定 runner=hapi，观察全程 | local + 真实 HAPI machine | run 完成并推进队列；退出码 / `status.json` / per-task-closure worktree 生命周期与其他 runner 同构；同一闭包 retry/resume 复用既有 cwd，consumed 后才回收；`status --json` 读面正确报告 runner/model |
| 2 | integration | 缺席语义在真实 hapi kind 上生效（行 7 腿②联动） | 使 CLI 不可用后触发调度，再恢复 | 同上 | #602 定义的显式警告 + hold 生效；恢复后无人工干预完成执行 |
| 3 | environment | 引擎无 HAPI 协议知识 | grep 引擎源码（HTTP client / session 概念） | local | 零命中；hapi 感知收敛为 binary 契约 |
| 4 | function | 领域边界实证清单落地 | 实现 PR evidence 列出全部触碰位置，归纳落本 issue comment | local | 清单覆盖词表、spawn、配置、读面各触点，可作下一个外部执行终端的接入模板 |

## 依赖关系

- Depends on: #602（`hapi` 词表准入 + 缺席语义）、mouriya-s-lab/hapi-remote-session#2（可 spawn 的 CLI）、#418 + hapi-remote-session#1（交互结论与消费契约）。
- Blocks: #548 关闭验证行 7。


---

## Comments (1)

### comment #5007305927 by `RiriAgent` — 2026-07-17T20:42:12Z

修订后的 #602 已吸收完整 HAPI runner 闭环，#603 不再独立实现；综合验收归 #748。旧 issue 无关联 PR，关闭。


---

## Timeline (13)

- 2026-07-10T05:58:14Z `assigned` @RiriAgent
- 2026-07-10T05:58:33Z `cross-referenced` @RiriAgentsrc=602
- 2026-07-10T05:58:34Z `cross-referenced` @RiriAgentsrc=2
- 2026-07-10T05:58:47Z `parent_issue_added` @RiriAgent
- 2026-07-10T05:59:28Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-10T06:00:30Z `cross-referenced` @RiriAgentsrc=418
- 2026-07-12T01:22:22Z `cross-referenced` @RiriAgentsrc=660
- 2026-07-13T05:31:14Z `cross-referenced` @RiriAgentsrc=676
- 2026-07-17T20:37:36Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:37:43Z `cross-referenced` @RiriAgentsrc=3
- 2026-07-17T20:37:46Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-17T20:42:12Z `commented` @RiriAgent
- 2026-07-17T20:42:13Z `closed` @RiriAgentcommit=None