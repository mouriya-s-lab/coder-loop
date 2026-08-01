# #722 feat(gui): daemon 活性首屏与生命周期控制

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:43Z  | updated: 2026-07-27T01:00:28Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/722
- comments: 0  | timeline events: 9

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

交付 daemon 三证活性和 daemon-down 终态展示。

首屏一眼回答「跑没跑」，判据可靠（三证不折叠）；daemon 死时可观测（何时死、死因线索、最后事件）且可从浏览器一键恢复。

## 问题

> "**「跑没跑」恰是现状最不可靠的判据**。……daemon 是一个会频繁死、且死时最需要被看见的进程，而现在死了就整个观测面一起消失。" — #544 现状问题 3

## 预期结果

性质表述：

1. **三证独立呈现**：pid 文件存在性+进程存活、socket connect 结果、`daemon.status` 应答——三个证据各自展示，任意分裂组合（如 #359 型「进程活/socket 死」）如实可见，不折叠成单布尔。
2. **死态可观测**：daemon 死时首屏明示死了、死于何时（最后 `daemon.stop`/`daemon.fatal` 事件或最后事件时间）、死因线索事件、队列终态照常可读。
3. **断网可区分**：网关仍应答即非断网——daemon 死与网络不可达在 UI 上是不同状态。
4. **一键恢复闭环**：start/stop/restart 按上钉机制工作；restart 后三证翻绿。spawn 的 daemon 进程与网关解耦（网关退出不带走 daemon）。
5. **首屏判据齐全**：三证 + 每 chain 活 run/最近转移 + `rateLimit` 冷却 + 最近异常事件，一屏可见。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 活态首屏（#544 关闭验证行 1 具体化） | daemon 活 + 至少一活 run 时打开 GUI | operator Mac + 浏览器 | 三证全绿、活 run 与最近事件在场、rateLimit 状态在场 |
| integration | 死态首屏（行 1+2 具体化） | `daemon.down`（或 kill -9）后打开/刷新 GUI | 同上 | 明确显示死了、死于何时、死因线索事件、三证细节；events 历史与队列终态照常可读 |
| integration | 一键恢复（行 2 具体化） | 死态下从浏览器点 start；再从手机（mesh）重复 | operator Mac + mesh 手机 | daemon 拉起、三证翻绿；手机路径同样成功 |
| function | 分裂状态如实 | 构造 pid 活/socket 不可达（如陈尸 sock 文件场景）后看首屏 | 本机 | 三证各自如实、无「假活」判定 |
| function | 断网区分 | mesh 断开 vs daemon 死两场景对照 | mesh 设备 | 前者网关不可达（浏览器层报错），后者网关应答且明示 daemon 死 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：GUI 首屏级 + daemon 生命周期控制面——三证探针是网关对 daemon 活性的独立观测件（不信任任何单一来源）。
2. **全局坐标**：网关 ↔ daemon 进程边界的三条独立证据线（pid 文件 / socket connect / RPC 应答）；控制线 = `daemon.down` RPC + spawn `daemon up`（进程域操作）。
3. **类型↔值不漂移**：防值漂移——三证折叠成布尔即把多源事实坍缩为可漂移单值（#359 教训）；`rateLimit` 宽 `JsonObject` 经边界 parse 收精确。
4. **消除的错误类别**：「daemon 死了但看起来活着 / 活着但看起来死了」从常态变为不可表达（三证独立呈现）；「app 更新后忘重启且无远程手段」闭环消除。

## log/观测义务

无引擎事件义务；死因线索纯消费既有 `daemon.fatal`/`daemon.stop` 事件（经 #721 面）。

## 依赖关系

- Depends on: #716、#720、#721。
- Blocks: #728、#729。


---

## Comments (0)

---

## Timeline (9)

- 2026-07-17T20:36:44Z `assigned` @RiriAgent
- 2026-07-17T20:38:35Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:41Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:38:50Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:53Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:26Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-26T16:14:24Z `cross-referenced` @RiriAgentsrc=723