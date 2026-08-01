# #557 chain 级 preset 兜底退役：DEFAULT_PRESET_NAME 清除与显式 null

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:46Z  | updated: 2026-07-17T20:42:04Z
- closed: 2026-07-17T20:42:04Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/557
- comments: 2  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接裁决 H 的第 1 处残留，零原语退役清单对应行逐字快照：

> "`DEFAULT_PRESET_NAME`（红线唯一违例）｜`src/daemon.ts:374` / `src/loop.ts:70`｜退役；chain 级 preset 显式传或 null，legacy default-seed（`src/daemon.ts` `handleChainCreate` 注释自证）随 chain 层语义归 #546 后消解" — #547 零原语退役清单

跨 RFC 接缝（chain 级判定落点），#547 接口假设逐字快照：

> "反向登记项已闭合：`DEFAULT_PRESET_NAME` 退役后「无 item 在手的 chain 级判定」落点 = **chain metadata**（#546 已裁：chain 层任务树含顶层 join/chain-complete 判定声明在 chain 自身元数据，不来自任何 preset）；该声明的边界 parse 与校验归本 RFC 编译/校验面（chain metadata 声明与 preset 编译产物同层校验，引擎不以 preset 名兜底）；item 恢复词表（`entryItemStatusForRecovery`）仍取自 per-item preset" — #547 接口假设·答复 #546

#546 侧同一契约的原文（互证，不复制语义）：

> "「无 item 在手的 chain 级判定」的落点 = **chain metadata**——chain 层任务树（含顶层 join/chain-complete 判定）声明在 chain 自身元数据，不来自任何 preset（#412 已使 chain 退出 preset 事实源，preset 无处兜底）；声明的边界 parse 与校验归 #547 编译/校验面。" — #546 接口假设·答复 #547

锚点更正（2026-07-02 核实）：两 RFC 引用的 `entryItemStatusForRecovery` 是概念名，仓内无此符号——真实机制是 `preset.statuses.entry` 经 `scheduler.recovery-entry-restore` / `scheduler.dependency-unblock-restore` 审计源写回（`src/scheduler.ts:1735`、`src/runtime-data.ts:38`）。语义不变：item 恢复词表仍取 per-item preset。

## 目标

退役引擎红线唯一现存违例 `DEFAULT_PRESET_NAME`：chain create 未声明 preset 时持久化显式 `null`，不再由引擎 seed bundled preset 名。chain task tree / 顶层 join 的 schema、边界 parse 与校验全部归 #566；本 child 只消费其 typed boundary，不重复定义或实现。

## 使用场景

- `chain create` 不传 preset → chain 级 preset 显式为 null，引擎不 seed 任何字面量；item 级 preset（#412）照常独立声明。
- chain create 同时携带 #566 已定义的 chain task declaration 时，继续走 #566 的 typed boundary；本 child 删除默认 preset seed 不得绕过、复制或改变该 boundary。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- `DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"` 双处：`src/daemon.ts:374`（消费点 `src/daemon.ts:1565`，`handleChainCreate` legacy default-seed，注释自证）、`src/loop.ts:70`（消费点 `src/loop.ts:4910`）。
- `chains.preset` 列 v9 起 nullable（`v3/survey-engine-daemon.md` §4："legacy default-seed"）——物理层已容纳 null，字面量 seed 是纯代码行为。
- chain metadata 既有边界：`ChainMetadata`（`src/runtime-data.ts:105-135`，bindings / per-runner 覆盖 / `maxItemAttempts` / trigger 指纹）——chain 层声明的 parse 扩展点。
- CLAUDE.md Conventions："引擎层禁止任何 `gh-issue-pr-iteration` 字面量"——本 child 消除其唯一现存违例。

## 问题

引擎以 preset 名兜底是「引擎不知道 preset 名」分层契约（CLAUDE.md L1 职责表）的直接违反，#547 定位其为 "红线唯一违例"。chain task declaration 的 shape 与 parse 由 #566 交付；若本 child 为删除 default seed 而再次定义该 shape，会制造两套 admission 契约。因此这里仅要求 chain create 在 preset 缺省时写入显式 null，并把其余 metadata 原样交给 #566 的唯一 typed boundary。

## 预期结果

性质表述：

1. **零 preset 名兜底**：`grep -rnE 'DEFAULT_PRESET_NAME' src/` 无命中（注意：`gh-issue-pr-iteration` 字符串在 src/ 注释与测试 fixture 数据中另有合法出现，2026-07-02 核实，不在本 child 清理范围——红线针对引擎行为路径的兜底，不针对文档性提及）；`chain create` 未传 preset 的语义是显式 null（status 面可见），任何需要 preset 而 chain 级为 null 且 item 级也缺失的路径给出点名错误，不静默替换。
2. **单一 chain metadata boundary**：chain task tree / 顶层 join 声明只经 #566 导出的 typed boundary 解析；本 child 不新增 parser、schema 或校验分支。删除 default seed 后，合法/非法 chain declaration 的结果与 #566 单独运行时完全一致。
3. **item 恢复不受影响**：恢复词表继续取 per-item preset 的 `statuses.entry`。

## 不应残留

- 本 child 范围内：`DEFAULT_PRESET_NAME` 常量与双消费点；`handleChainCreate` 的 default-seed 分支。
- 范围之外不动：chain task declaration 的 schema、parser、静态校验与调度语义（全部归 #566 及其运行时上游）；`chains.repository`（归 GitHub 记法退役 child）；bundled preset 内容。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 既有依赖 default-seed 的调用路径（生产 `~/.coder-loop` 的既有 chains 均已带 preset 值）不得因退役而损坏——迁移语义只影响新建路径。
- 排序默认（总控简报）：#534 audit 树 children 先合，本 child 在其后 rebase。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 字面量清零（RFC 关闭验证行 2 本 child 份额） | `grep -rnE 'DEFAULT_PRESET_NAME' src/` | local | 无输出 |
| function | 不 seed、显式 null | 隔离 loop-data root 下 `chain create` 不传 preset → 读 `daemon status`/`status --json` | local | chain 级 preset 为 null，无字面量；需要 preset 的路径报点名错误 |
| integration | 不复制 #566 boundary | 分别在删除 default seed 前后，经 socket 写入 #566 fixture 的合法/非法 chain declaration | local | 结果与 #566 boundary fixture 完全一致；本 child diff 中无第二套 chain declaration schema/parser |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #566（chain metadata 的唯一 typed boundary 已在场；本 child 只删除 preset default seed，不复制声明 parser）、#605（chain create 的 `ChainDefinitionRef` / 默认 `PresetDefinitionRef` 分型已在场，显式 null 不得把两类引用重新混为一个裸 hash）。
- 排序边: #534 audit 树（#535/#536/#538）先合。
- 与 #551（GitHub 记法退役 child）各自触 `chains` 表不同语义，后合者 rebase。


---

## Comments (2)

### comment #4865082826 by `RiriAgent` — 2026-07-02T11:14:44Z

## 架构切片

1. **系统定位**：daemon chain-create 准入级 + chain metadata 边界 parse（与 preset 编译校验同层的定义期校验面）。
2. **全局坐标**：operator 请求域（socket，不可信 JSON）→ chain 声明 typed 域（`ChainMetadata` 扩展）。chain 层任务树的语义域归 #546 children；本 child 是其声明的 parse/校验入口。
3. **类型↔值不漂移**：防值漂移——`DEFAULT_PRESET_NAME` 兜底是引擎私运 L2 业务默认值（引擎替 operator 做业务选择）；退役后「未选 preset」在类型上是显式 null，不是被静默填充的字面量。
4. **消除的错误类别**：「引擎替 operator 选 preset」不可表达；「非法 chain 层判定声明活到运行期」不可表达（写入期拒绝）。

## log/观测义务

- chain 层声明写入沿既有 mutation 审计事件（chain.create / metadata 更新的 1-3 条审计契约）；拒绝沿 `invalid_request` 形态。
- 无新事件类型预期；若需新增须过 `ObservabilityEventTypeBoundary` 枚举。



### comment #5007305062 by `RiriAgent` — 2026-07-17T20:42:04Z

重新拆分后由 #742 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (16)

- 2026-07-02T11:12:47Z `assigned` @RiriAgent
- 2026-07-02T11:13:13Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:44Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T11:52:47Z `cross-referenced` @RiriAgentsrc=551
- 2026-07-02T11:58:01Z `cross-referenced` @RiriAgentsrc=569
- 2026-07-02T11:58:39Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-05T07:48:06Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-11T10:10:27Z `renamed` @RiriAgent
- 2026-07-12T00:58:25Z `cross-referenced` @RiriAgentsrc=659
- 2026-07-17T20:13:32Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:37:15Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-17T20:37:30Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:42:04Z `commented` @RiriAgent
- 2026-07-17T20:42:05Z `closed` @RiriAgentcommit=None