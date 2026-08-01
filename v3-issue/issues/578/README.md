# #578 feat(gui): 首屏「跑没跑」——daemon 三证活性与一键生命周期控制

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:13Z  | updated: 2026-07-17T20:41:25Z
- closed: 2026-07-17T20:41:25Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/578
- comments: 2  | timeline events: 19

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**daemon-down 行为（本 RFC 立身场景）**：daemon 死后网关照常服务——events 历史与死前最后事件（JSONL）、队列终态（SQLite 只读）、死因线索（`daemon.fatal`/`daemon.stop` 事件与 #388 落盘的崩溃记录）可读；活性判定用三证探针（pid 文件 + socket connect + `daemon.status` 应答），三证呈现给前端而非折叠成一个布尔——#359 型「进程活但 socket 死」的分裂状态如实展示。GUI 提供一键 `daemon up` / restart。" — #544 架构

> "**首屏「跑没跑」判据**：daemon 三证状态 + 每 chain 的活 run/最近转移 + rate-limit 冷却（`daemon.status.rateLimit`）+ 最近异常事件（`daemon.fatal`/`scheduler.tick_failed`/`attempt.timeout` 等）。daemon 死与断网可区分：网关仍应答即非断网。" — #544 信息架构

> "GUI 全部写动作即以下清单，不多不少：daemon start / stop / restart（start 由网关 spawn `coder-loop daemon up`，stop/restart 经 socket RPC）……" — #544 控制面范围（daemon 生命周期部分归本 child；其余动作归 #579）

## 目标

首屏一眼回答「跑没跑」，判据可靠（三证不折叠）；daemon 死时可观测（何时死、死因线索、最后事件）且可从浏览器一键恢复。

## 使用场景

- operator 瞥一眼首屏即知 daemon 活性、各 chain 活 run、限流冷却、最近异常——#544 关闭验证行 1。
- app 更新后 daemon 必须重启（repo 规则 `daemon-restart-after-app-update`）——从手机/浏览器一键完成，"补上 `daemon-restart-after-app-update` 的运维闭环"（#544 裁决 A 理由）——关闭验证行 2。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- 三证锚点：pid 文件与 socket 路径 `resolveLoopDataPaths`（`src/runtime-paths.ts:113`，`daemon.pid`/`daemon.sock` 常量 `:13-14`）；`daemon.status` RPC（authClass `read-no-auth`，`src/daemon.ts:1291`），应答含 `rateLimit`（`src/daemon.ts:290`，填充 `:912`）。
- **RFC「stop/restart 经 socket RPC」的机制事实精化（2026-07-02 核实）**：不存在 `daemon.stop`/`daemon.restart` RPC。daemon 进程级唯一 RPC 是 `daemon.down`（`hard-deny-for-agent`，`src/daemon.ts:1292`）；CLI `daemon stop <target>` 实为 `chain.stop`（`src/loop.ts:3535`）；CLI `daemon restart <target>` 不重启进程、只查 status（`src/loop.ts:3567-3575`）。GUI 语义因此钉为：**start = 网关 spawn `coder-loop daemon up`；stop = `daemon.down` RPC；restart = `daemon.down` 后 spawn `daemon up`**。F 档动作清单不变，这是机制精化不是范围变更。
- 死因线索来源：`daemon.fatal`（`src/observability.ts:40`，emit `src/daemon.ts:1690`）、`daemon.stop`（`:37`，emit `daemon.ts:1070`）、`daemon.stop.terminated_runs`——**#388 的崩溃记录就是这些事件本身**（写入同一 events 流，无独立 crash 文件；2026-07-02 核实）。经 #577 事件面可读。
- 活性判据不可信史：repo 规则 `daemon-restart-after-app-update`——"`status --json` 的 daemon 字段不可信、sock/pid 可能是陈尸文件"；#359 进程活但 socket pathname 丢失。三证不折叠布尔的动机即此。
- `daemon.status` 应答的 `rateLimit` 字段引擎侧类型是宽 `JsonObject`（`src/daemon.ts:290`）——网关按红线以边界 parse 进精确类型消费（外部输入 parse 入口的合法形态）；若消费中发现引擎应导出精确类型，回 #544 thread 登记，不顺手改引擎。

## 问题

> "**「跑没跑」恰是现状最不可靠的判据**。……daemon 是一个会频繁死、且死时最需要被看见的进程，而现在死了就整个观测面一起消失。" — #544 现状问题 3

## 预期结果

性质表述：

1. **三证独立呈现**：pid 文件存在性+进程存活、socket connect 结果、`daemon.status` 应答——三个证据各自展示，任意分裂组合（如 #359 型「进程活/socket 死」）如实可见，不折叠成单布尔。
2. **死态可观测**：daemon 死时首屏明示死了、死于何时（最后 `daemon.stop`/`daemon.fatal` 事件或最后事件时间）、死因线索事件、队列终态照常可读。
3. **断网可区分**：网关仍应答即非断网——daemon 死与网络不可达在 UI 上是不同状态。
4. **一键恢复闭环**：start/stop/restart 按上钉机制工作；restart 后三证翻绿。spawn 的 daemon 进程与网关解耦（网关退出不带走 daemon）。
5. **首屏判据齐全**：三证 + 每 chain 活 run/最近转移 + `rateLimit` 冷却 + 最近异常事件，一屏可见。

## 不应残留

- 本 child 范围内：折叠布尔活性判定；把 `status --json` 的 daemon 字段当唯一活性来源；网关内第二套死因推断逻辑（只呈现事件事实）。
- 范围之外不动：queue/chain/item 控制动作（归 #579）；daemon 侧生命周期语义（引擎零改动——`daemon.down`/`daemon up` 既有语义够用，发现不够时回 #544 thread 登记）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 响应式（移动可用），PWA 与移动首屏裁剪归 #584。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 活态首屏（#544 关闭验证行 1 具体化） | daemon 活 + 至少一活 run 时打开 GUI | operator Mac + 浏览器 | 三证全绿、活 run 与最近事件在场、rateLimit 状态在场 |
| integration | 死态首屏（行 1+2 具体化） | `daemon.down`（或 kill -9）后打开/刷新 GUI | 同上 | 明确显示死了、死于何时、死因线索事件、三证细节；events 历史与队列终态照常可读 |
| integration | 一键恢复（行 2 具体化） | 死态下从浏览器点 start；再从手机（mesh）重复 | operator Mac + mesh 手机 | daemon 拉起、三证翻绿；手机路径同样成功 |
| function | 分裂状态如实 | 构造 pid 活/socket 不可达（如陈尸 sock 文件场景）后看首屏 | 本机 | 三证各自如实、无「假活」判定 |
| function | 断网区分 | mesh 断开 vs daemon 死两场景对照 | mesh 设备 | 前者网关不可达（浏览器层报错），后者网关应答且明示 daemon 死 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #576（网关宿主 + RPC 客户端）、#577（最近事件/死因线索/最后事件的数据源）。
- Blocks: #575（hooks 节呈现位）、#579（F 档全入口遍历在其后）、#584（移动首屏）。


---

## Comments (2)

### comment #4866584377 by `RiriAgent` — 2026-07-02T14:02:24Z

## 架构切片

1. **系统定位**：GUI 首屏级 + daemon 生命周期控制面——三证探针是网关对 daemon 活性的独立观测件（不信任任何单一来源）。
2. **全局坐标**：网关 ↔ daemon 进程边界的三条独立证据线（pid 文件 / socket connect / RPC 应答）；控制线 = `daemon.down` RPC + spawn `daemon up`（进程域操作）。
3. **类型↔值不漂移**：防值漂移——三证折叠成布尔即把多源事实坍缩为可漂移单值（#359 教训）；`rateLimit` 宽 `JsonObject` 经边界 parse 收精确。
4. **消除的错误类别**：「daemon 死了但看起来活着 / 活着但看起来死了」从常态变为不可表达（三证独立呈现）；「app 更新后忘重启且无远程手段」闭环消除。

## log/观测义务

无引擎事件义务；死因线索纯消费既有 `daemon.fatal`/`daemon.stop` 事件（经 #577 面）。


### comment #5007300981 by `RiriAgent` — 2026-07-17T20:41:25Z

重新拆分后由 #722 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (19)

- 2026-07-02T12:02:13Z `assigned` @RiriAgent
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-02T12:03:02Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:01:56Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:24Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:41:25Z `commented` @RiriAgent
- 2026-07-17T20:41:26Z `closed` @RiriAgentcommit=None