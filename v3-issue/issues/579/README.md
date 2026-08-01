# #579 feat(gui): 控制面解卡动作与 F 档写入口收口

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:15Z  | updated: 2026-07-17T20:41:28Z
- closed: 2026-07-17T20:41:28Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/579
- comments: 2  | timeline events: 15

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "GUI 全部写动作即以下清单，不多不少：daemon start / stop / restart、`queue.unblock`、`chain.stop` / `chain.resume`、`item.reorder`，以及当前 operator 对指定 evaluation epoch 有 capability 时的 `advance | hold | reopen` decision。全部经 operator RPC 转发；GUI 不推导 decision；创建类不进 v3。" — #544 控制面范围（daemon 生命周期三动作由 #578 落地；本 child 落其余队列/链/decision 动作并做全清单收口验证）

> "控制面范围｜**观测 + daemon 生命周期 + 解卡动作**（否决完整 CLI parity）｜手机场景 = 看见异常当场处置；创建类重交互（chain create / item add）留给 CLI/agent，不进 v3" — #544 裁决记录 F

## 目标

GUI 的队列/链解卡动作齐备（`queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder`），并提供 capability-gated per-epoch operator decision；全 GUI 写入口恰为 F 档清单——不多不少。

## 使用场景

手机上看见 item 卡在 blocked / chain 需要停或恢复 / item 顺序要调——当场处置，不用回电脑开 CLI（#544 关闭验证行 7 所验证的能力面）。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- RPC 锚点（dispatch 表 `src/daemon.ts:1279-1305`）：`queue.unblock`（`hard-deny-for-agent`，`:1305`）、`chain.stop`（`:1280`）、`chain.resume`（`:1281`）、`item.reorder`（`per-phase-authorized`，`:1288`）。
- 网关主体："网关无 agent 凭证，daemon 视之为 operator 主体，`logs.query` hard-deny-for-agent 不影响它，零新增鉴权面"（#544 架构）——hard-deny-for-agent 类对 operator 主体开放，无需新增鉴权。
- unblock 语义上游：`unblockable` 状态集与 `entry` 恢复由 preset 声明（CLAUDE.md / preset schema）——GUI 只转发，不复制语义判断（daemon 侧网关是唯一裁判）。

## 问题

F 裁决把「看见异常当场处置」定为控制面价值，但 #578 只覆盖 daemon 生命周期——队列/链层面的解卡动作（unblock、stop/resume、reorder）以及 join evaluation 的 operator decision 在 GUI 尚无入口；同时 F 档是范围收口承诺（"不多不少"），需要一个可验证的收口面防止入口蔓延。

## 预期结果

性质表述：

1. **解卡动作可用**：unblock / chain stop / chain resume / item reorder 在对应对象的视图上可达并生效；decision dossier 在 daemon 返回当前 operator 对指定 epoch 的 capability 时显示 `advance | hold | reopen`，无 capability 时只显示 authority 缺口；失败有明确错误呈现，不静默。
2. **mutation 面是编译期闭集**：网关内一切 socket mutation 经单一 typed mutation client 模块，其方法集合恰为 daemon 生命周期、`queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder` 与 #561 暴露的 operator decision typed operation（+ #578 的 spawn `daemon up`，非 RPC）；前端无裸 socket 访问路径——新增写动作必须扩该闭集，编译器与 review 双重可见。
3. **无创建类入口**：GUI 不存在 `chain.create`/`item.add`/batch 的任何调用路径。
4. **转发不加语义**：动作参数与结果 shape 来自引擎类型派生；网关不做第二套合法性判断（daemon 准入门是唯一裁判），只呈现 daemon 的接受/拒绝。

## 不应残留

- 本 child 范围内：mutation client 之外的 socket 写调用；创建类 RPC 的调用代码（含「预留」的死代码）；未处理的静默失败。
- 范围之外不动：daemon 侧 RPC 语义与鉴权分类（零引擎改动）；daemon 生命周期动作（归 #578）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 响应式（移动可用），移动首屏的控制面裁剪归 #584。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 四动作生效 | 对真实 chain 各执行一次：blocked item unblock、chain stop、chain resume、item reorder；另对持有 evaluation capability 的 epoch 执行一次 operator decision，随后用 status/events 核对 | operator Mac + 浏览器 | 每个动作后 status/events 反映预期变化；operator decision 的 evaluation identity、主体、decision 与审计事件一致 |
| function | F 档收口（#544 关闭验证行 7 具体化） | 遍历 GUI 全部可点写入口清单（人工遍历 + mutation client 方法集合 code review） | 浏览器 + 本机 | 写入口恰为：daemon start/stop/restart（#578）+ unblock/stop/resume/reorder + capability-gated per-epoch operator decision；无任何创建类入口 |
| function | mutation 闭集 | 阅读 mutation client 模块 + `grep` 网关代码中 socket 写命令字符串 | 本机 | 一切写经 mutation client；方法集合与 F 档清单一致 |
| function | 失败呈现 | daemon 死态下执行任一动作 | 浏览器 | 明确错误呈现，无静默吞掉 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #576（网关宿主 + RPC 客户端）、#578（daemon 生命周期入口先在场，收口遍历才完整）、#561（evaluation identity、operator decision ADT 与 capability 契约）。
- Blocks: #584（移动首屏控制面动作）。


---

## Comments (2)

### comment #4866584602 by `RiriAgent` — 2026-07-02T14:02:25Z

## 架构切片

1. **系统定位**：控制面 mutation 级——网关内唯一 socket 写通道（typed mutation client 闭集）。
2. **全局坐标**：前端动作 → 网关 mutation client → daemon 准入门；合法性裁判唯一在 daemon，网关不加第二套判断。
3. **类型↔值不漂移**：防类型泄露——mutation 动词字符串拷贝即把 RPC 词表编码进前端，闭集派生封死。
4. **消除的错误类别**：「GUI 写入口蔓延出 F 档」从 review 负担变为编译期可见（闭集扩张必过类型与 review 双关）。

## log/观测义务

mutation 审计事件由 daemon 既有机制发射（每 mutation 1-3 条）；网关零新增义务。


### comment #5007301230 by `RiriAgent` — 2026-07-17T20:41:27Z

重新拆分后由 #723 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (15)

- 2026-07-02T12:02:16Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:54Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-02T12:03:02Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-02T14:01:57Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:25Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:41:27Z `commented` @RiriAgent
- 2026-07-17T20:41:28Z `closed` @RiriAgentcommit=None