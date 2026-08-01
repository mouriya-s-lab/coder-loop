# #742 feat(engine): chain preset fallback 退役

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:29Z  | updated: 2026-07-27T01:00:52Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/742
- comments: 0  | timeline events: 8

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

清除 DEFAULT_PRESET_NAME 并使用显式 null。

退役引擎红线唯一现存违例 `DEFAULT_PRESET_NAME`：chain create 未声明 preset 时持久化显式 `null`，不再由引擎 seed bundled preset 名。chain task tree / 顶层 join 的 schema、边界 parse 与校验全部归 #705；本 child 只消费其 typed boundary，不重复定义或实现。

## 问题

引擎以 preset 名兜底是「引擎不知道 preset 名」分层契约（CLAUDE.md L1 职责表）的直接违反，#547 定位其为 "红线唯一违例"。chain task declaration 的 shape 与 parse 由 #705 交付；若本 child 为删除 default seed 而再次定义该 shape，会制造两套 admission 契约。因此这里仅要求 chain create 在 preset 缺省时写入显式 null，并把其余 metadata 原样交给 #705 的唯一 typed boundary。

## 预期结果

性质表述：

1. **零 preset 名兜底**：`grep -rnE 'DEFAULT_PRESET_NAME' src/` 无命中（注意：`gh-issue-pr-iteration` 字符串在 src/ 注释与测试 fixture 数据中另有合法出现，2026-07-02 核实，不在本 child 清理范围——红线针对引擎行为路径的兜底，不针对文档性提及）；`chain create` 未传 preset 的语义是显式 null（status 面可见），任何需要 preset 而 chain 级为 null 且 item 级也缺失的路径给出点名错误，不静默替换。
2. **单一 chain metadata boundary**：chain task tree / 顶层 join 声明只经 #705 导出的 typed boundary 解析；本 child 不新增 parser、schema 或校验分支。删除 default seed 后，合法/非法 chain declaration 的结果与 #705 单独运行时完全一致。
3. **item 恢复不受影响**：恢复词表继续取 per-item preset 的 `statuses.entry`。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 字面量清零（RFC 关闭验证行 2 本 child 份额） | `grep -rnE 'DEFAULT_PRESET_NAME' src/` | local | 无输出 |
| function | 不 seed、显式 null | 隔离 loop-data root 下 `chain create` 不传 preset → 读 `daemon status`/`status --json` | local | chain 级 preset 为 null，无字面量；需要 preset 的路径报点名错误 |
| integration | 不复制 #705 boundary | 分别在删除 default seed 前后，经 socket 写入 #705 fixture 的合法/非法 chain declaration | local | 结果与 #705 boundary fixture 完全一致；本 child diff 中无第二套 chain declaration schema/parser |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：daemon chain-create 准入级 + chain metadata 边界 parse（与 preset 编译校验同层的定义期校验面）。
2. **全局坐标**：operator 请求域（socket，不可信 JSON）→ chain 声明 typed 域（`ChainMetadata` 扩展）。chain 层任务树的语义域归 #546 children；本 child 是其声明的 parse/校验入口。
3. **类型↔值不漂移**：防值漂移——`DEFAULT_PRESET_NAME` 兜底是引擎私运 L2 业务默认值（引擎替 operator 做业务选择）；退役后「未选 preset」在类型上是显式 null，不是被静默填充的字面量。
4. **消除的错误类别**：「引擎替 operator 选 preset」不可表达；「非法 chain 层判定声明活到运行期」不可表达（写入期拒绝）。

## log/观测义务

- chain 层声明写入沿既有 mutation 审计事件（chain.create / metadata 更新的 1-3 条审计契约）；拒绝沿 `invalid_request` 形态。
- 无新事件类型预期；若需新增须过 `ObservabilityEventTypeBoundary` 枚举。

## 依赖关系

- Depends on: #549。
- Blocks: #705、#744。


---

## Comments (0)

---

## Timeline (8)

- 2026-07-17T20:37:30Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:18Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:05Z `cross-referenced` @RiriAgentsrc=557
- 2026-07-26T16:14:02Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:39Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-26T23:49:50Z `cross-referenced` @RiriAgentsrc=746