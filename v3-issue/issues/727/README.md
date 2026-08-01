# #727 feat(gui): context entries 只读展示

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:54Z  | updated: 2026-07-27T01:00:34Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/727
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

只消费 #545 context read boundary。

context entries 在 GUI 可见：按 scope（item / chain / group）浏览某 chain 的 entries，shape 纯消费 #545 read boundary。

## 问题

#545 落地后 entries 是影响 agent 判断质量的一等中间态，但只有 CLI 查询面；#544/#545 接缝三处互指「展示面归 RFC-5」，若无本 child 该承诺无 owner。

## 预期结果

性质表述：

1. **三 scope 视图**：item 谱系 / chain 公告 / group 分支组三种 scope 的 entries 在对应对象视图可浏览，envelope 字段（id/ts/scope/author）与 body 原文如实展示。
2. **shape 零定义**：网关与前端的 entries 类型全部从 #545 read boundary 派生——GUI 代码无 entry shape 的平行定义；分页/过滤跟随 #545 实现 child 落地的形态，GUI 不自造维度。
3. **body 不透明贯穿**：GUI 对 body 只做原文透传（等宽/原样渲染），不 markdown 解析、不提取结构。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 三 scope 浏览 | 用 CLI 分别写 item/chain/group scope entries 若干，GUI 对应视图查看 | operator Mac + 浏览器 | 各 scope entries 落位正确、envelope 与 body 与写入一致 |
| function | shape 零定义 | code review + `grep` 网关代码 entry 字段的类型定义来源 | 本机 | 类型全部 import 自 #545 boundary，无平行定义 |
| function | body 不透明 | 写入含状态字面量/markdown/控制记号的 body 后查看 | 浏览器 | 原文透传显示，无解析副作用 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：A 域内容通道（context entries）的 GUI 只读展示面——纯消费 #545 read boundary。
2. **全局坐标**：daemon context 服务域 →（operator 主体 socket read 命令）→ 网关 → 前端；不触 entries 存储表。
3. **类型↔值不漂移**：防类型泄露——entry shape 平行定义；body 不透明贯穿——不解析即不把 body 语义编码进前端。
4. **消除的错误类别**：「查 entries 必须开终端跑 CLI」退役；「GUI 解析 body 引入第二套语义」不可表达（原文透传）。

## log/观测义务

无新增义务（读命令审计归 #545 机制）。

## 依赖关系

- Depends on: #720、#730。
- Blocks: #729。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:55Z `assigned` @RiriAgent
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:38:52Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:39:59Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:37Z `cross-referenced` @RiriAgentsrc=583
- 2026-07-26T23:49:24Z `cross-referenced` @RiriAgentsrc=724