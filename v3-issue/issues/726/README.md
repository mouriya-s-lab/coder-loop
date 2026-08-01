# #726 feat(gui): 编译元信息与任务树预览

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:52Z  | updated: 2026-07-27T04:27:06Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/726
- comments: 0  | timeline events: 8

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

消费 preset compile 产物，不在 GUI 重建编译器。

GUI 可选任一 preset 查看其可计算元信息：状态机图、phase 任务树、变量类型流——渲染自 #549 编译产物，与 CLI 导出一致。

## 问题

#544 现状问题 5 的定义态侧：装载期已可计算的元信息（状态图、phase 结构、变量流）只存在于进程内存与 toml 源文件，operator 无任何可视化面；#549 落地后产物存在但无 GUI 消费者，关闭验证行 9 无法闭合。

## 预期结果

性质表述：

1. **三视图在场**：状态机图（stateGraph 块：状态节点 + exit 边 + 引擎自有转移）、phase 任务树（phases 块树结构）、变量类型流（每 phase variables 的 KEY/type/source/required 视图）渲染自同一份编译产物。
2. **与 CLI 一致**：GUI 所渲染产物与 `coder-loop preset compile <name> --json` 输出来自同一计算路径与同一 schemaVersion——不存在 GUI 专属的第二份解析。
3. **schemaVersion 严格**：产物 schemaVersion 不被 GUI 支持时显式报错并显示版本号，不静默降级渲染。
4. **findings 可见**：warn findings 随预览展示——preset 作者的定义期反馈回路延伸到 GUI。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 三视图与 CLI 一致（#544 关闭验证行 9 具体化） | GUI 选 `gh-issue-pr-iteration` 与 `single-phase-example` 各看三视图；对照 `coder-loop preset compile <name> --json` 输出逐块核对 | operator Mac + 浏览器 | 图上节点/边/类型与 CLI 产物一致；两个 preset 都正确 |
| function | schemaVersion 严格 | 构造不支持的 schemaVersion 产物（测试注入） | 本机 | 显式报错含版本号，无静默降级 |
| function | findings 展示 | 选一个带 warn findings 的 preset（fixture） | 本机 | warn 列表在预览可见 |
| function | 类型单源 | code review：产物消费类型来源 | 本机 | 从 #549 boundary 派生，无平行 shape |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：定义态展示面——#549 编译产物的 GUI 消费者；与运行态展示（#724）分面不混（快照=运行态，编译产物=定义态）。
2. **全局坐标**：编译产物契约域（schemaVersion 边界）→ 前端渲染域；GUI 不触 preset.toml 源域。
3. **类型↔值不漂移**：防类型泄露——产物 shape 平行定义；防值漂移——GUI 第二份解析路径 vs CLI，同一计算路径封死。
4. **消除的错误类别**：「GUI 预览与实际装载语义不一致」不可表达（同源）；「schemaVersion 不匹配静默渲染」被显式报错封死。

## log/观测义务

无新增义务。

## 依赖关系

- Depends on: #549、#720、#739、#743。
- Blocks: #729、#744。



---

## Comments (0)

---

## Timeline (8)

- 2026-07-17T20:36:53Z `assigned` @RiriAgent
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:10Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:39:58Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:35Z `cross-referenced` @RiriAgentsrc=582
- 2026-07-27T04:27:11Z `cross-referenced` @RiriAgentsrc=739