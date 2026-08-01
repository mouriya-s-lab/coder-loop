# #575 feat(engine+gui): status 快照 hooks 节与 gate hold 可见性

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:06Z  | updated: 2026-07-17T20:41:19Z
- closed: 2026-07-17T20:41:19Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/575
- comments: 2  | timeline events: 17

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）与 #543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "gate hold 状态与 hook 声明清单（四层合成后的生效视图）进 status 快照新增的 hooks 节，并入本 RFC 快照 boundary 收紧工作。" — #544 接口假设 RFC-4

> "**RFC-5（#544，已裁）**：`hook.*` 事件类型与字段归本 RFC 实现 children，经 #411 统一事件流被 #544 网关消费，零新增通道；gate hold 状态与 hook 声明清单（四层合成后的生效视图）进 status 快照新增的 hooks 节，并入 #544 已裁的快照 boundary 收紧工作。" — #543 接口假设 RFC-5

拆分说明：RFC 把 hooks 节「并入快照 boundary 收紧工作」；本树把它从 #574 单列为本 child——#586 只拥有内部 typed 生效视图，本 child 是 `StatusSnapshotBoundary`、`status --json` hooks 投影与 GUI 呈现的唯一 owner。若并入 #574，则整条 GUI 快照契约链（#574 → #580）被 #543 树阻塞。单列不改变归属（工作仍归 #544 树），只解耦排序。

## 目标

status 快照新增 hooks 节（精确 schema）：hook 声明四层合成后的生效视图 + gate hold 状态；GUI 呈现之。

## 使用场景

operator 在 GUI 上看到：当前 chain 有哪些生效 hook（全局/chain/preset/item 四层合成结果）、哪个调度决策点正被 gate hold 住——hold 不再只是「chain 不动了」的无线索停滞。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（实施前自行 grep 行号）。

- `StatusSnapshotBoundary`（`src/loop.ts:490`）收紧后形态由 #574 落地——本 child 在其上 additive 新增 hooks 节。
- hook 声明模型、四层合成语义（"同一挂点多层命中时全部执行，顺序 全局 → chain → preset → item；gate decision 合成为「任一非 advance 即不放行」" — #543 核心设计）与 gate hold 运行态由 #543 实现 children 落地；本 child 消费其内存/持久化状态做快照投影，不定义 hook 语义。
- `hook.*` 事件经既有 events 流到达 GUI（#577 通道），无需本 child 新增通道——本 child 只补「当前状态」快照面（事件是增量，快照是现状）。

## 问题

#543 落地后，hook 声明与 gate hold 是影响调度的一等运行态，但 status 快照没有它们的位置：operator 无法从 `status --json` 或 GUI 回答「这个 chain 为什么不动」（gate hold 中）与「现在生效的 hook 是哪些」（四层合成结果）——只能翻事件流反推。

## 预期结果

性质表述：

1. **hooks 节精确 schema**：快照新增 hooks 节，含生效 hook 清单（四层合成后视图，标注来源层）与 gate hold 状态（哪个决策点、hold 起始、重问节奏线索）；schema 精确无匿名槽，与 #574 同一红线。
2. **GUI 可见**：gate hold 状态在 GUI 的 chain 视图/首屏异常区呈现；生效 hook 清单在 chain 详情可达。
3. **快照与事件互补**：hooks 节反映「现在」，`hook.*` 事件反映「过程」；两者字段可关联（同一 hook 标识）。

## 不应残留

- 本 child 范围内：hooks 节以裸 JSON 透传或匿名槽出现；GUI 侧对 hook 语义的第二套解读（只呈现快照事实）。
- 范围之外不动：hook 声明/执行/合成机制本体与内部 effective view（归 #543 children，#586 不再写 status 快照）；`hook.*` 事件类型定义（归 #543 children）；快照其余槽（归 #574）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 快照 shape 变更 PR body 显式列 shape diff（#456 先例）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 四层合成生效视图 | 全局+chain+preset+item 各声明 hook 后 `coder-loop status <target> --json` | 本机（#543 机制已落地） | hooks 节列出全部生效 hook 且标注来源层，与 #543 合成语义一致 |
| function | gate hold 可见 | 用必 hold 的 gate 脚本触发 hold 后查快照与 GUI | 本机 + 浏览器 | 快照 hooks 节与 GUI chain 视图都显示 hold 中的决策点 |
| function | 负例拒绝 | `bun test`（hooks 节非法形状 parse 拒绝用例） | 本机 | 断言通过 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #574（收紧后的快照 boundary 是本节的宿主）、#578（GUI 首屏/chain 视图是呈现位）、#586（hook 声明模型——四层声明位装载合并与生效视图，hooks 节 shape 的输入）、#590（gate 决策点闭集接线——含 hold 指纹泛化）。
- Blocks: 无（#585 收尾在其后 gate）。


---

## Comments (2)

### comment #4866583820 by `RiriAgent` — 2026-07-02T14:02:20Z

## 架构切片

1. **系统定位**：status 快照的 hooks 节（运行态投影级）+ GUI 呈现位——#543 hook 状态的快照面；hook 语义与执行不在此。
2. **全局坐标**：#543 hook 运行态域 → 快照消费域（只读投影）→ GUI 呈现；GUI 只呈现快照事实。
3. **类型↔值不漂移**：防值漂移——「生效 hook 视图」若 GUI 侧自行合成即与 daemon 四层合成语义漂移；快照单源封死。
4. **消除的错误类别**：「gate hold 导致的停滞无线索」从必然变为不可表达（hold 状态必在快照与 GUI）。

## log/观测义务

无新增事件义务（`hook.*` 事件归 #543 children）；本 child 只加快照节与呈现。


### comment #5007300265 by `RiriAgent` — 2026-07-17T20:41:18Z

重新拆分后由 #719 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (17)

- 2026-07-02T12:02:06Z `assigned` @RiriAgent
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-02T12:02:54Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:01:52Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:20Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-11T08:48:27Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-13T09:07:42Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:36Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:41:18Z `commented` @RiriAgent
- 2026-07-17T20:41:19Z `closed` @RiriAgentcommit=None