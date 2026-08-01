# #580 feat(gui): 全链路层级展示——daemon→chains→items→runs→phases/attempts 钻取与任务树渲染

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:17Z  | updated: 2026-07-17T20:41:30Z
- closed: 2026-07-17T20:41:30Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/580
- comments: 2  | timeline events: 21

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**层级**：daemon → chains → items → runs → phases/attempts，与既有关联键（chain/item/runId/phase）一致；事件→run→item 可关联跳转。" — #544 信息架构

> "**RFC-1（#546，已裁）**：slot 语义退役，不再是展示对象；chains→items 层的展示对象是任务树（节点 = leaf/seq/par + join 声明与状态 + reopen 计数），「活 run 并行分支」= par 内多 leaf 各自的 run。" — #544 接口假设

> "全链路层级展示｜从 daemon 首屏钻取到 chain → item → run → phase/attempt｜各层可达；从任一事件可跳到其 run/item" — #544 关闭验证行 5

## 目标

GUI 全链路层级钻取成立：从首屏到任一 attempt 各层可达，chains→items 层渲染任务树（含 v2 退化树），事件与 run/item 可互相跳转。

## 使用场景

- operator 从首屏点进异常 chain → 看树结构与各节点状态 → 点进卡住的 leaf → 看 run/attempt 明细——全程不开终端。
- 事件流里看到 `attempt.timeout` → 一键跳到对应 run 与 item。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（实施前自行 grep 行号）。

- 快照契约：#574 收紧后的 `StatusSnapshotBoundary` 派生类型——本 child 的数据契约输入；树结构节 shape 源头是 #558（"v2 既有线性链呈现为退化树（seq(leaf…)），语义不变" — #558 使用场景）。
- 事件面：#577 的查询/推送 API；信封关联键 `chain?`/`item?`/`runId?`/`phase?`（`src/observability.ts:234-241`）是跳转的连接键。
- per-run 明细 fallback 层：`<logDir>/<runId>/<phase>/status.json`（CLAUDE.md："非第一契约面"）——本 child 以快照与事件为第一数据源，run 目录文件只作深层明细的补充展示，不当契约刮取。

## 问题

#544 现状问题 5："数据源良好但无消费面"——44 种事件、快照、SQLite 四表齐备，但 operator 没有任何层级化视图；v3 任务树落地（#546 树）后，「chain 里发生什么」将进一步超出 flat 队列直觉，无树渲染则 par/join/reopen 状态完全不可见。

## 预期结果

性质表述：

1. **各层可达**：daemon → chains → items → runs → phases/attempts 每层有视图且相邻层互链；任一层可直达（可分享的 URL 定位）。
2. **树如实渲染**：任务树节点（leaf/seq/par + join 声明与状态 + reopen 计数）按快照树结构节渲染；节点类型是 discriminated union 穷尽渲染——新增节点 kind 时编译器暴露渲染缺口；v2 退化树正常显示。
3. **事件↔对象跳转**：从任一携带关联键的事件跳到其 run/item；从 run/item 视图反查其事件序列。
4. **契约消费**：数据 shape 全部从 #574/#577 的边界类型派生，无平行 shape、无匿名透传。

## 不应残留

- 本 child 范围内：slot 概念作为展示对象（#546 已裁退役）；树节点渲染的 stringly `switch` 无穷尽检查；把 run 目录文件当第一契约刮取。
- 范围之外不动：快照 schema（归 #574）；events 读取面（归 #577）；prompt 明细页（归 #581）；context entries 视图（归 #583）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- "A 域资产收编（trace / evidence / handoff 的格式化展示）"在范围外（#544 范围外节）——GUI 对 A 域只做路径引用与原文透传。
- 响应式（移动可用），深层浏览与 PC 同构（#544 信息架构）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 钻取全链（#544 关闭验证行 5 具体化） | 对真实 root 从首屏逐层点到一个 attempt | operator Mac + 浏览器 | 各层可达、无死链；URL 直达任一层 |
| integration | 事件跳转 | 在事件流选取带 runId 的事件点跳转；从该 run 反查事件 | 同上 | 双向跳转正确落位 |
| function | 树渲染（含退化树） | v2 线性 chain 与含 par 的树 fixture（#546 children 落地前用 #558 migration 后的退化树）各看一次 | 本机 | 节点类型/join/reopen 计数如实；退化树正常 |
| function | 穷尽渲染 | code review：树节点渲染处的 union 穷尽检查 | 本机 | 存在 `assertNever` 型穷尽保障 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #574（快照契约）、#576（网关宿主）、#577（事件面）。
- Blocks: #581（attempt 明细入口）、#583（entries 视图挂载位）、#584（深层浏览同构）。


---

## Comments (2)

### comment #4866584797 by `RiriAgent` — 2026-07-02T14:02:26Z

## 架构切片

1. **系统定位**：GUI 信息架构主干——层级钻取视图树 + 事件↔对象关联；消费 #574/#577 两契约。
2. **全局坐标**：快照契约域 + 事件契约域 → 前端渲染域；关联键（chain/item/runId/phase）是跨域连接值。
3. **类型↔值不漂移**：防类型泄露（平行 shape）与值漂移——slot 概念复活（#546 已裁退役的展示对象）不得再编码进前端。
4. **消除的错误类别**：「par/join/reopen 状态不可见」从必然变为不可表达（树节点穷尽渲染，新增 kind 编译期暴露）。

## log/观测义务

无新增义务；纯消费。


### comment #5007301468 by `RiriAgent` — 2026-07-17T20:41:29Z

重新拆分后由 #724 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (21)

- 2026-07-02T12:02:18Z `assigned` @RiriAgent
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-02T12:02:58Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-02T12:02:59Z `cross-referenced` @RiriAgentsrc=582
- 2026-07-02T12:03:01Z `cross-referenced` @RiriAgentsrc=583
- 2026-07-02T12:03:02Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-02T14:01:58Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:26Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:36Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:41:29Z `commented` @RiriAgent
- 2026-07-17T20:41:30Z `closed` @RiriAgentcommit=None