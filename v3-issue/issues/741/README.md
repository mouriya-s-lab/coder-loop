# #741 feat(engine): dead-fragment 检查与 plan 面退役

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:27Z  | updated: 2026-07-27T01:00:51Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/741
- comments: 0  | timeline events: 6

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

交付静态检查与旧 plan 退役。

编译管线新增 dead-fragment 检查（warn：注册了却无任何 phase role 可见的 fragment）；bundled preset 的 plan 面（12 个死 fragment）退役。

## 问题

fragment 注册表允许「注册但永不可见」的死条目而定义期不暴露——bundled preset 的 12 个 plan fragment 游离于状态机之外多个版本无人察觉，正是缺此检查的实证（#547："该检查若早存在，12 个死 fragment 第一天即暴露"）。

## 预期结果

性质表述：

1. **注册可见性被检查**：任何注册于 `[[fragments]]` 但不被任何 phase `roles` 覆盖的 fragment，compile 产出 warn finding 点名 fragment id——与 #408 R3 同层同形态。
2. **plan 面退役**：`presets/gh-issue-pr-iteration/plan/` 目录与 12 条 `role = "plan"` 注册移除；`contract.md` 被 iter/review 消费的部分留任；退役后 bundled preset compile findings 无 dead-fragment warn（自我验证：检查 + 退役互证）。
3. **不加跳转边声明位**：fragment 间跳转不进 DSL（裁决 I："不加 fragment 跳转边声明位"）——本 child 不为 plan 链的查表跳转发明任何替代机制。

### 显式决策项（落地时裁，裁决留本 thread）

- repo 内 dogfood 实例 `.claude/commands/dev-plan.md` 的处置（随 plan 目录一并移除 vs 保留并登记失效）——operator 工具空间的 `~/.claude/commands/` 版本不动，仅登记。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | dead fragment 定义期暴露（RFC 关闭验证行 6） | fixture preset 含无 phase role 消费的 fragment → compile | local | warn finding，点名 fragment id |
| function | plan 面退役（RFC 关闭验证行 7） | `ls presets/gh-issue-pr-iteration/plan/ 2>&1; grep -c 'role = "plan"' presets/gh-issue-pr-iteration/preset.toml` | local | 目录不存在；计数 0 |
| function | 退役自洽 | `coder-loop preset compile gh-issue-pr-iteration --json \| jq '.findings'` | local | 无 dead-fragment warn |
| integration | 活 fragment 不误报 | 对 single-phase-example 与 bundled preset compile | local | 无误报 warn；全部既有加载用例绿 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：编译管线的 fragment 可见性检查级（与 #408 R3 dead-vocabulary 同层同形态）+ bundled preset（L2）的 plan 资产退役。
2. **全局坐标**：fragment 注册域（`[[fragments]]`）↔ phase 可见域（`roles`）——检查在两域的连接完整性上；planning 活动整体迁出任务定义 DSL 域，归 operator 工具域。
3. **类型↔值不漂移**：防值漂移——注册表与真实消费失同步（12 个死 fragment 多版本无人察觉即此漂移的实证）。
4. **消除的错误类别**：「注册但永不可见的 fragment 静默存活」从定义期起不可表达（warn 点名）。

## log/观测义务

- dead-fragment warn 经 compile findings 通道；无运行期新事件。

## 依赖关系

- Depends on: #549。
- Blocks: #744。


---

## Comments (0)

---

## Timeline (6)

- 2026-07-17T20:37:28Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:16Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:02Z `cross-referenced` @RiriAgentsrc=556
- 2026-07-26T16:14:39Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547