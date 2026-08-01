# #723 feat(gui): 控制面解卡动作与写入口收口

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:45Z  | updated: 2026-07-27T01:00:30Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/723
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

所有 mutation 经 daemon RPC，不从 gateway 直写 SQLite。

GUI 的队列/链解卡动作齐备（`queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder`），并提供 capability-gated per-epoch operator decision；全 GUI 写入口恰为 F 档清单——不多不少。

## 问题

F 裁决把「看见异常当场处置」定为控制面价值，但 #722 只覆盖 daemon 生命周期——队列/链层面的解卡动作（unblock、stop/resume、reorder）以及 join evaluation 的 operator decision 在 GUI 尚无入口；同时 F 档是范围收口承诺（"不多不少"），需要一个可验证的收口面防止入口蔓延。

## 预期结果

性质表述：

1. **解卡动作可用**：unblock / chain stop / chain resume / item reorder 在对应对象的视图上可达并生效；decision dossier 在 daemon 返回当前 operator 对指定 epoch 的 capability 时显示 `advance | hold | reopen`，无 capability 时只显示 authority 缺口；失败有明确错误呈现，不静默。
2. **mutation 面是编译期闭集**：网关内一切 socket mutation 经单一 typed mutation client 模块，其方法集合恰为 daemon 生命周期、`queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder` 与 #700 暴露的 operator decision typed operation（+ #722 的 spawn `daemon up`，非 RPC）；前端无裸 socket 访问路径——新增写动作必须扩该闭集，编译器与 review 双重可见。
3. **无创建类入口**：GUI 不存在 `chain.create`/`item.add`/batch 的任何调用路径。
4. **转发不加语义**：动作参数与结果 shape 来自引擎类型派生；网关不做第二套合法性判断（daemon 准入门是唯一裁判），只呈现 daemon 的接受/拒绝。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 四动作生效 | 对真实 chain 各执行一次：blocked item unblock、chain stop、chain resume、item reorder；另对持有 evaluation capability 的 epoch 执行一次 operator decision，随后用 status/events 核对 | operator Mac + 浏览器 | 每个动作后 status/events 反映预期变化；operator decision 的 evaluation identity、主体、decision 与审计事件一致 |
| function | F 档收口（#544 关闭验证行 7 具体化） | 遍历 GUI 全部可点写入口清单（人工遍历 + mutation client 方法集合 code review） | 浏览器 + 本机 | 写入口恰为：daemon start/stop/restart（#722）+ unblock/stop/resume/reorder + capability-gated per-epoch operator decision；无任何创建类入口 |
| function | mutation 闭集 | 阅读 mutation client 模块 + `grep` 网关代码中 socket 写命令字符串 | 本机 | 一切写经 mutation client；方法集合与 F 档清单一致 |
| function | 失败呈现 | daemon 死态下执行任一动作 | 浏览器 | 明确错误呈现，无静默吞掉 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：控制面 mutation 级——网关内唯一 socket 写通道（typed mutation client 闭集）。
2. **全局坐标**：前端动作 → 网关 mutation client → daemon 准入门；合法性裁判唯一在 daemon，网关不加第二套判断。
3. **类型↔值不漂移**：防类型泄露——mutation 动词字符串拷贝即把 RPC 词表编码进前端，闭集派生封死。
4. **消除的错误类别**：「GUI 写入口蔓延出 F 档」从 review 负担变为编译期可见（闭集扩张必过类型与 review 双关）。

## log/观测义务

mutation 审计事件由 daemon 既有机制发射（每 mutation 1-3 条）；网关零新增义务。

## 依赖关系

- Depends on: #720。
- Blocks: #728、#729。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:46Z `assigned` @RiriAgent
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:50Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:54Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:28Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-26T23:49:22Z `cross-referenced` @RiriAgentsrc=722