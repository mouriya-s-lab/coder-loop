# #574 feat(engine): status 快照 boundary 收紧——七个匿名 object 槽换精确 schema

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:03Z  | updated: 2026-07-17T20:41:17Z
- closed: 2026-07-17T20:41:17Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/574
- comments: 2  | timeline events: 19

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）与 #558（#546 首个实现 child）。继承条款逐字快照：

> "**status 快照 boundary 收紧**：七个匿名 `"object"` 槽换成精确 schema——GUI 的快照契约。此项与 RFC-2 的编译产物 schema 互补不重叠（快照=运行态，编译产物=定义态）。" — #544 引擎侧新增工作 3

> "树运行态持久化形态与 status 快照的树结构 shape 由 #546 首个实现 child 在设计期钉住——该 shape 是本 RFC 快照 boundary 收紧（引擎侧新增工作 3）的输入，实施顺序在其后。" — #544 接口假设 RFC-1

> "**shape 设计期先行发布**：实现编码前，本 issue comment 发布 shape 设计记录（持久化形态 + 快照树结构 shape 两节），#544/#545 children 以该 comment 为契约输入。" — #558 预期结果

> "不收紧快照中与树无关的其余匿名槽（归 #544 的快照 boundary 收紧 child）" — #558 不应残留

## 目标

`StatusSnapshotBoundary` 顶层七个匿名 `"object"` 槽全部换成精确 arktype schema，使 `status --json` 成为 GUI 可依赖的运行态契约。

## 使用场景

- #580（全链路层级展示）以收紧后的 boundary 派生类型消费快照——#544 现状问题 4（"status 快照对 GUI 无契约力……GUI 消费前必须收紧"）的解除点。
- supervisor/脚本等既有 `status --json` 消费者获得同一契约收益。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- `StatusSnapshotBoundary`（`src/loop.ts:490`）：顶层恰好七个匿名 `"object"` 槽——`target`/`state`/`queue`/`runs`/`current`/`events`/`processes`（`:491-497`）。
- 构建器 `buildCoderLoopStatusSnapshot`（`src/loop.ts:2724`）：只读读取（`readDbItemsForChain` `:2755`、`readDbCurrentRun` `:2756`），是观测面而非 mutation 面。
- 快照 shape 变更先例：#456——"per-phase 字段是唯一的 runner face……breaking change，PR body 须显式列出 shape diff"（CLAUDE.md Runner Selection 节）。
- 树结构节的 schema 本体归 #558（其 shape 设计 comment 是本 child 的契约输入）；本 child 收紧其余槽并集成树结构节，不改写其 shape。

## 问题

> "**status 快照对 GUI 无契约力**。`StatusSnapshotBoundary` 顶层是七个匿名 `"object"` 槽（`src/loop.ts:490-498`），内部形态靠实现自觉，GUI 消费前必须收紧。" — #544 现状问题 4

## 预期结果

性质表述：

1. **无匿名槽**：`StatusSnapshotBoundary` 顶层与各槽内部不存在匿名 `"object"`/宽松 record 兜底——每个字段有精确 schema，非法形状被 parse 拒绝。
2. **类型单源**：TS 消费端类型从 boundary schema 派生，不手写平行 shape；快照字段演进时编译器暴露全部消费点。
3. **树结构节如约集成**：树结构节采 #558 shape 设计 comment 的 schema，本 child 不改写；其余槽的收紧不侵入 #558 范围。
4. **shape diff 可审**：PR body 显式列出收紧前后 shape diff（#456 先例）；既有消费者（CLAUDE.md 登记的 status JSON 稳定 API 面）字段语义不变或 diff 中显式声明。

## 不应残留

- 本 child 范围内：匿名 `"object"` 槽；`as` 断言修补的类型链；boundary 之外的第二套快照 shape 描述。
- 范围之外不动：树结构节 shape 本体（归 #558）；hooks 节（归 #575，其数据源在 #543 实现 children）；`buildCoderLoopStatusSnapshot` 的数据来源与只读语义；daemon RPC 协议。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- `coder-loop status <target> --json` 是 CLAUDE.md 登记的 stable read-only JSON API——收紧是加约束不是改语义，breaking 字段变更须在 PR body shape diff 中逐项列出。
- 排序默认（总控简报 2026-07-02）：#534 audit 树 children 先合，本 child 在其后 rebase；偏离需在 PR 说明。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 匿名槽清零 | `grep -n '"object"' src/loop.ts`（限 `StatusSnapshotBoundary` 定义区）+ 阅读 boundary 全文 | 本机 | 零匿名槽；每槽字段显式 |
| function | 负例拒绝 | `bun test`（新增用例：对每个槽注入非法形状，断言 parse 拒绝） | 本机 | 七槽各至少一条负例，全部拒绝 |
| integration | 真实快照过 boundary | `coder-loop status <target> --json` 对活 chain 跑一次 | 本机（真实 loop-data root） | 输出通过收紧后 boundary parse；`state.kind == "ok"` |
| assumption | 树结构节与 #558 一致 | 对照 #558 shape 设计 comment 逐字段核对 | GitHub + 本机 | 树结构节 schema 与 #558 记录一致，无本地改写 |
| environment | 既有消费不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #558（快照树结构 shape 的设计期契约；实施顺序在其后——总控简报边 1）。
- Blocks: #575（hooks 节）、#580（全链路层级展示）。


---

## Comments (2)

### comment #4866583575 by `RiriAgent` — 2026-07-02T14:02:19Z

## 架构切片

1. **系统定位**：L1 观测面 status 快照的边界收紧——`StatusSnapshotBoundary` 从「形状靠实现自觉」升格为精确契约；构建器数据来源与只读语义不动。
2. **全局坐标**：引擎运行态域（SQLite/内存）→ 快照消费域（CLI JSON / 网关 route）；arktype boundary 是 parse 点；树结构节 shape 权威在 #558，本 child 集成不定义。
3. **类型↔值不漂移**：防类型泄露——消费端手写平行 shape 即把快照形状编码进前端，从 schema 派生封死；防值漂移——匿名槽内部形态自觉即漂移源。
4. **消除的错误类别**：「快照字段变更静默破坏消费者」从可能变为编译期可见（派生类型 + 七槽负例测试）。

## log/观测义务

无新增事件义务；shape diff 义务在 PR body（#456 先例）。


### comment #5007300023 by `RiriAgent` — 2026-07-17T20:41:16Z

重新拆分后由 #718 承接，并新增严格只读前置 #716。旧 issue 无关联 PR，关闭。


---

## Timeline (19)

- 2026-07-02T12:02:04Z `assigned` @RiriAgent
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T14:01:51Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:19Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:46:45Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-05T07:48:53Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-05T07:49:11Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-15T19:03:57Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:36Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:41:16Z `commented` @RiriAgent
- 2026-07-17T20:41:17Z `closed` @RiriAgentcommit=None