# #582 feat(gui): 元信息预览——消费 preset compile 编译产物渲染状态机图与任务树

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:23Z  | updated: 2026-07-17T20:41:35Z
- closed: 2026-07-17T20:41:35Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/582
- comments: 2  | timeline events: 14

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）与 #549（#547 编译管线 child）。继承条款逐字快照：

> "**RFC-2（#547，已答）**：元信息预览消费 `coder-loop preset compile --json` 编译产物（schemaVersion 稳定契约，六块：preset 元信息 / statuses+stateGraph / phases+任务树 / tools / fragments / findings）。本 RFC 只消费不定义 shape。" — #544 接口假设

> "元信息预览｜在 GUI 选任一 preset 查看结构｜状态机图/phase 任务树/变量类型流渲染自 #547 `preset compile --json` 编译产物（stateGraph 与 phases+任务树块），与 CLI 导出一致" — #544 关闭验证行 9

> "因为全链路类型化，所以状态机的判定来源是可计算类型……我认为这部分需要 GUI 可预览。" — #544 操作员目标（verbatim，`v3/v3-goals.md` 目标 3）

## 目标

GUI 可选任一 preset 查看其可计算元信息：状态机图、phase 任务树、变量类型流——渲染自 #549 编译产物，与 CLI 导出一致。

## 使用场景

preset 作者/operator 在写或排查 preset 时，不起 daemon、不读 toml 源文件，在 GUI 直接看到状态词表、哪个 phase 的哪个 exit 写哪个状态、phase 树结构、每个变量的类型与来源——操作员目标 3 的「GUI 可预览」闭环。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（实施前自行 grep 行号）。

- 产物契约（#549 逐字）："JSON 产物六块：`preset` 元信息（name/dir/源 hash）；`statuses` + `stateGraph`（节点=状态分类，边=「哪个 phase 的哪个 exit 写它」+ 引擎自有转移 entry/exhausted/unblock）；`phases`（exits/trigger/runner/model/typed variables/toolRequirements/rights）+ 任务树结构（#546 的 phase 层 seq/par 树）；`tools`；`fragments`；`findings`（warn 全列，error 已 throw）" — #549 必须先读节。
- 产物基线内容（#549 预期结果 3）：任务树为退化线性 seq、variables 全 `"string"` 基线、tools 空表——后续 #547 children additive 真实化；本 child 的渲染须对基线与真实化后的产物都成立。
- 消费方式：同仓 import 编译产物 boundary 派生类型（"TS 消费端类型从该 schema 派生，不手写平行 shape" — #549 预期结果 2）；网关 server route 调用同一计算路径获得产物（#549 性质 1：导出与运行用同一路径），CLI 一致性由此天然成立。
- 定位边界："快照 boundary 收紧与编译产物互补不重叠（快照=运行态，编译产物=定义态）"（#544 接口假设）——本 child 是定义态展示，不混入运行态数据。

## 问题

#544 现状问题 5 的定义态侧：装载期已可计算的元信息（状态图、phase 结构、变量流）只存在于进程内存与 toml 源文件，operator 无任何可视化面；#549 落地后产物存在但无 GUI 消费者，关闭验证行 9 无法闭合。

## 预期结果

性质表述：

1. **三视图在场**：状态机图（stateGraph 块：状态节点 + exit 边 + 引擎自有转移）、phase 任务树（phases 块树结构）、变量类型流（每 phase variables 的 KEY/type/source/required 视图）渲染自同一份编译产物。
2. **与 CLI 一致**：GUI 所渲染产物与 `coder-loop preset compile <name> --json` 输出来自同一计算路径与同一 schemaVersion——不存在 GUI 专属的第二份解析。
3. **schemaVersion 严格**：产物 schemaVersion 不被 GUI 支持时显式报错并显示版本号，不静默降级渲染。
4. **findings 可见**：warn findings 随预览展示——preset 作者的定义期反馈回路延伸到 GUI。

## 不应残留

- 本 child 范围内：GUI 侧解析 preset.toml 的任何路径；产物 shape 的平行手写类型；对产物内容的语义再计算（图布局是渲染，改写语义不是）。
- 范围之外不动：编译产物 shape 与计算路径（归 #549 及后续 #547 children）；运行态快照展示（归 #580）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 响应式（移动可用）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 三视图与 CLI 一致（#544 关闭验证行 9 具体化） | GUI 选 `gh-issue-pr-iteration` 与 `single-phase-example` 各看三视图；对照 `coder-loop preset compile <name> --json` 输出逐块核对 | operator Mac + 浏览器 | 图上节点/边/类型与 CLI 产物一致；两个 preset 都正确 |
| function | schemaVersion 严格 | 构造不支持的 schemaVersion 产物（测试注入） | 本机 | 显式报错含版本号，无静默降级 |
| function | findings 展示 | 选一个带 warn findings 的 preset（fixture） | 本机 | warn 列表在预览可见 |
| function | 类型单源 | code review：产物消费类型来源 | 本机 | 从 #549 boundary 派生，无平行 shape |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #549（编译产物——总控简报边 2）、#576（网关宿主）。
- Blocks: 无（#585 收尾在其后 gate）。


---

## Comments (2)

### comment #4866585128 by `RiriAgent` — 2026-07-02T14:02:29Z

## 架构切片

1. **系统定位**：定义态展示面——#549 编译产物的 GUI 消费者；与运行态展示（#580）分面不混（快照=运行态，编译产物=定义态）。
2. **全局坐标**：编译产物契约域（schemaVersion 边界）→ 前端渲染域；GUI 不触 preset.toml 源域。
3. **类型↔值不漂移**：防类型泄露——产物 shape 平行定义；防值漂移——GUI 第二份解析路径 vs CLI，同一计算路径封死。
4. **消除的错误类别**：「GUI 预览与实际装载语义不一致」不可表达（同源）；「schemaVersion 不匹配静默渲染」被显式报错封死。

## log/观测义务

无新增义务。


### comment #5007301943 by `RiriAgent` — 2026-07-17T20:41:34Z

重新拆分后由 #726 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (14)

- 2026-07-02T12:02:24Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:02:01Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:29Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:52:00Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:51Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:41:34Z `commented` @RiriAgent
- 2026-07-17T20:41:35Z `closed` @RiriAgentcommit=None