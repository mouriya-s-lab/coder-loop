# #556 dead-fragment 编译检查与 plan 面退役

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:44Z  | updated: 2026-07-17T20:42:02Z
- closed: 2026-07-17T20:42:02Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/556
- comments: 2  | timeline events: 15

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其裁决 I，逐字快照：

> "从 preset 退役；planning 定性为 operator 侧活动（skill 空间 + 队列 CLI + RFC-6 调用面），不属于任务定义 DSL；新增 dead-fragment 编译检查（warn）；不加 fragment 跳转边声明位" / 理由："调查证据见下节；跳转链唯一样本随 plan 退役消失" — #547 裁决记录 I

调查证据逐字快照：

> "12 个 `plan/*.md` fragments 注册于 `[[fragments]]`（role="plan"）但**无任何 phase 的 `roles` 含 "plan"**……——引擎从不渲染，仅过 `assertReadable`。`plan/index.md` 自证："Planning is **not** a `preset.phases` member… The L1 engine does not see planning."……`contract.md` 中被 iter/review 执行侧消费的部分留任。`/dev-plan` 命令去留归 operator 工具空间，本 RFC 只登记。" — #547 plan 面退役（裁决 I 的调查证据）

> "dead-fragment 编译检查（warn：声明了却无任何 phase role 可见的 fragment）与 #408 dead-vocabulary 同构——该检查若早存在，12 个死 fragment 第一天即暴露。" — #547 同节

## 目标

编译管线新增 dead-fragment 检查（warn：注册了却无任何 phase role 可见的 fragment）；bundled preset 的 plan 面（12 个死 fragment）退役。

## 使用场景

- preset 作者注册 fragment 却忘了给任何 phase 的 `roles` 授权可见 → compile findings 立即给 warn 点名 fragment id——「注册即被消费」从约定变成被检查的事实。
- bundled preset 装载不再携带 12 个引擎从不渲染的文件；`preset compile` 的 fragments 块与真实消费一致。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对；下列计数 2026-07-02 核实）。

- `presets/gh-issue-pr-iteration/plan/` 下 12 个 md；`grep -c 'role = "plan"' presets/gh-issue-pr-iteration/preset.toml` = 12；四个 phase 的 `roles` 分别为 `["common","quality","iter"]` / `["common","quality","review"]` / `["common"]` / `["common"]`（`preset.toml:85/133/237/286`）——无 "plan"。
- 死 fragment 的唯一装载副作用是 `assertReadable`（`src/loop.ts:4080`）。
- 同构检查先例：`checkPresetDag` R3 dead-vocabulary warn（`src/preset-dag-check.ts:25-30`）——dead-fragment 照此形态进 findings。
- `contract.md` 是 `role = "common"` 的活 fragment（`preset.toml:346-349`），全部 phase 可见——留任；其内容若含 plan 专属段落，按「被 iter/review 执行侧消费的部分留任」裁剪。
- `/dev-plan` 入口已烂的证据（`.claude/commands/dev-plan.md` 引用 #433/#436/#434 已退役机制）——去留归 operator 工具空间，本 child 只登记不裁。

## 问题

fragment 注册表允许「注册但永不可见」的死条目而定义期不暴露——bundled preset 的 12 个 plan fragment 游离于状态机之外多个版本无人察觉，正是缺此检查的实证（#547："该检查若早存在，12 个死 fragment 第一天即暴露"）。

## 预期结果

性质表述：

1. **注册可见性被检查**：任何注册于 `[[fragments]]` 但不被任何 phase `roles` 覆盖的 fragment，compile 产出 warn finding 点名 fragment id——与 #408 R3 同层同形态。
2. **plan 面退役**：`presets/gh-issue-pr-iteration/plan/` 目录与 12 条 `role = "plan"` 注册移除；`contract.md` 被 iter/review 消费的部分留任；退役后 bundled preset compile findings 无 dead-fragment warn（自我验证：检查 + 退役互证）。
3. **不加跳转边声明位**：fragment 间跳转不进 DSL（裁决 I："不加 fragment 跳转边声明位"）——本 child 不为 plan 链的查表跳转发明任何替代机制。

### 显式决策项（落地时裁，裁决留本 thread）

- repo 内 dogfood 实例 `.claude/commands/dev-plan.md` 的处置（随 plan 目录一并移除 vs 保留并登记失效）——operator 工具空间的 `~/.claude/commands/` 版本不动，仅登记。

## 不应残留

- 本 child 范围内：`role = "plan"` 注册、`plan/` 目录、指向已删 fragment 的引用。
- 范围之外不动：`/dev-plan` 的 operator 侧安装副本；planning 的替代形态（skill 空间 + 队列 CLI，已是现状，无需新建）；iter/review/quality/common fragments。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- warn 不升 error：dead fragment 不破坏调度正确性（同 #408 R3 的分级理由），保持 warn。

## 本 issue 的验证边界

- **验证层级**：preset compile/render contract、受影响 fragment/CLI 的目标测试，以及使用确定性 runner 的最小调度 integration。
- **本 issue 必须证明**：修改后的声明或 prompt 能被当前引擎装载并进入预期分支，旧制度性指示/旧词表按正文清单消失；不得只靠 grep，也不得要求真实 agent 替代确定性断言。
- **不在本 issue 内执行**：本 issue 不自行运行完整 GitHub issue→PR→merge→close。改动合流后的 `real-e2e-minimal`/`gh-issue-pr-iteration` compatibility 由 #685 在冻结发布候选 SHA 上统一证明；涉及 v3 新运行态的接缝由 #684 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | dead fragment 定义期暴露（RFC 关闭验证行 6） | fixture preset 含无 phase role 消费的 fragment → compile | local | warn finding，点名 fragment id |
| function | plan 面退役（RFC 关闭验证行 7） | `ls presets/gh-issue-pr-iteration/plan/ 2>&1; grep -c 'role = "plan"' presets/gh-issue-pr-iteration/preset.toml` | local | 目录不存在；计数 0 |
| function | 退役自洽 | `coder-loop preset compile gh-issue-pr-iteration --json \| jq '.findings'` | local | 无 dead-fragment warn |
| integration | 活 fragment 不误报 | 对 single-phase-example 与 bundled preset compile | local | 无误报 warn；全部既有加载用例绿 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #549（编译管线 child）（findings 面承载 warn）。


---

## Comments (2)

### comment #4865082669 by `RiriAgent` — 2026-07-02T11:14:43Z

## 架构切片

1. **系统定位**：编译管线的 fragment 可见性检查级（与 #408 R3 dead-vocabulary 同层同形态）+ bundled preset（L2）的 plan 资产退役。
2. **全局坐标**：fragment 注册域（`[[fragments]]`）↔ phase 可见域（`roles`）——检查在两域的连接完整性上；planning 活动整体迁出任务定义 DSL 域，归 operator 工具域。
3. **类型↔值不漂移**：防值漂移——注册表与真实消费失同步（12 个死 fragment 多版本无人察觉即此漂移的实证）。
4. **消除的错误类别**：「注册但永不可见的 fragment 静默存活」从定义期起不可表达（warn 点名）。

## log/观测义务

- dead-fragment warn 经 compile findings 通道；无运行期新事件。



### comment #5007304783 by `RiriAgent` — 2026-07-17T20:42:01Z

重新拆分后由 #741 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (15)

- 2026-07-02T11:12:45Z `assigned` @RiriAgent
- 2026-07-02T11:13:12Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:43Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T11:52:47Z `cross-referenced` @RiriAgentsrc=551
- 2026-07-05T07:52:00Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-12T00:31:28Z `cross-referenced` @RiriAgentsrc=658
- 2026-07-13T04:39:54Z `cross-referenced` @RiriAgentsrc=674
- 2026-07-16T23:17:59Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533
- 2026-07-17T20:37:15Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-17T20:37:28Z `cross-referenced` @RiriAgentsrc=741
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:42:01Z `commented` @RiriAgent
- 2026-07-17T20:42:03Z `closed` @RiriAgentcommit=None