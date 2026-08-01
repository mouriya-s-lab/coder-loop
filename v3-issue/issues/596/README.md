# #596 feat(engine): context 共享 group scope 真实化——par 容器稳定 id 键解析

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T14:04:21Z  | updated: 2026-07-17T20:41:46Z
- closed: 2026-07-17T20:41:45Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/596
- comments: 1  | timeline events: 13

---

## Body

## 必须先读的关联 issue

#545（RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递）。继承条款逐字快照：

> "`group`（并行分支组内通信；scope 键 = par 节点物化时的稳定容器 id，#546 已裁）" — #545 设计裁决 2

> "**RFC-1（#546，已裁）**：`group` scope 键 = par 节点物化时的稳定容器 id，存储位随 #546 的树运行态 shape 承诺（其首个实现 child 设计期钉住）一并落定；context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道；`shared.md` 保留现有创建与 prompt 注入行为，作为零行为定义的 chain 级自由 prompt 注入面；git 工作产物与 GitHub 面是产物通道，不属 context。引擎递出的跨任务面必须显式分类；对象库、refs、repo config/hooks 与 linked-worktree metadata 仍是 repo 级共享 Git 协调面，此处不承诺 hostile-agent capability isolation。并行汇合（join）后下游对上游分支 entries 的可读性已由「chain 内自由读」天然覆盖，无需额外契约。" — #545「跨 RFC 接口假设」

#558（#546 首个实现 child，任务树运行态 shape）侧对应承诺：

> "par 容器稳定 id（即 #545 的 `group` scope 键，存储位在 shape 记录中显式写明）" — #558「预期结果」

> "**shape 设计期先行发布**：实现编码前，本 issue comment 发布 shape 设计记录（持久化形态 + 快照树结构 shape 两节），#544/#545 children 以该 comment 为契约输入。" — #558「预期结果」

## 目标

group scope 从「一律拒绝」真实化为可用：par 容器内的 run 写 group entry 时，daemon 从 #558 的树运行态推导容器稳定 id 作为 scope 键；读取按 group 键过滤命中同组 entries。

## 使用场景

并行分支（par 容器的两个 leaf）各自独立 run，分支 A 写 group entry（发现、约定、半成品结论），分支 B 在自己的 run 内拉取到它——这是 #546 已裁的「并行分支间唯一的结构化、受控、可审计上下文通道」的落地面。join 后下游 leaf 经 chain 内自由读拿到上游分支的全部 entries，无需 group 成员资格。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行 grep 核对）。

- **契约输入是 #558 的 shape 设计 comment**：group 容器 id 的存储位在其中显式写明（#558 验收行 1 保证该 comment 先于其实现存在）。本 child 不自造 id、不另设存储。
- 地基 child 已钉 v2 拒绝语义：item 不属于任何 par 容器时 group 写入在 admission 拒绝、错误点名原因——本 child 只添加正路径（真容器下的键推导），拒绝分支语义不变、不出现双路径。
- 树运行态 fixture 先例：#558 验收「用迁移 fixture/store 构造含 `seq(leaf, par(leaf, leaf))` 的树运行态（不经调度）」——本 child 验收同法构造 par 容器，不依赖 par 调度（#559/#561）落地。
- 凭证→item 定位：`resolveItemMutationCaller`（`src/daemon.ts:3182-3223`）给出 run 所属 item；item 在树中的容器谱系从 #558 shape 读取。

## 问题

地基 child 落地后 group variant 只有拒绝路径：daemon 无从推导写入者所属的 par 容器（v2 无树运行态）。#546 已裁 context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道——par 调度（#559/#561）落地后，并行分支之间将不存在任何合法的引擎提供上下文通道，「平行函数」的通信面缺失。

## 预期结果

性质表述：

1. **正路径**：凭证所属 item 位于 par 容器内时，group 写入被接受，默认键（凭证推导）= #558 shape 存储位中该容器的稳定 id；同容器其他分支的 run 按 group 过滤可命中。
2. **键解析真实容器**：无论凭证推导还是显式指定（指定方式按地基 child 决策项裁决，不得引入授权粒度），落库的 group 键都解析到树运行态中真实存在的 par 容器——不存在指向虚空的 group entry（地基 child「scope 键解析有效」性质在 group 维度的真实化）。
3. **拒绝分支不变**：不存在可寻址 par 容器时的 admission 拒绝语义与地基 child 完全一致——不出现「树存在与否」的双路径兜底。
4. **join 后可读性零新增契约**：容器 terminal 后，下游 agent 经 chain 内自由读可见上游分支全部 entries（含 group entries）——由裁决 3 的 chain 可见性天然覆盖，本 child 不添加任何 join 专属读取逻辑。
5. 树节点消费经穷尽 switch：容器谱系遍历对 #558 的节点 ADT 穷尽，新增节点 variant 由编译器暴露处置点。

### 显式决策项（落地时裁，裁决留本 thread）

- 嵌套 par 下的 group 键取值：最近祖先容器单键，还是祖先链多容器可分别过滤——过滤结果可观察（目标级分叉），取决于 #558 shape 对容器谱系的表示形态，以其 shape 设计 comment 为输入裁决。

## 不应残留

- 本 child 范围内：未经容器存在性解析即落库的 group 键（任何来源）；树存在性检查的兜底双路径；对 #558 节点 ADT 的 stringly 分支无穷尽检查。
- 本 issue 范围之外不应改动：#558 的 shape 本身（只消费不修订——shape 不满足键推导需要时，那是对 #558 的修正信号，走其 thread，不在本 child 内即兴绕过）；par 调度与 join 评估（归 #559/#561）；envelope 与读取 boundary（归本树前序 children）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。依据：#78 / #109、#453 契约 T3/T5。
- 授权无粒度（#545 裁决 3）：group scope 是过滤维度，不是可见性边界——不引入 group 成员资格授权；链内任何 agent 都可按 group 键过滤读取。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：触 `src/daemon.ts` admission 面，默认 #535/#536/#538 先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | #558 shape 契约输入在手 | 查 #558 comments | GitHub | shape 设计 comment 存在且写明 par 容器稳定 id 的存储位；本 child 实现引用该 comment |
| function | 同组互见 | fixture 构造 `par(leaf, leaf)` 树运行态（不经调度），两分支 run 凭证各写 group entry 后互相按 group 读 | local | 双向命中；scope 键 = 该容器稳定 id |
| function | 组外不命中 | 同 chain 容器外 item 的 run 按 group 过滤读 | local | 不命中该组 entries（chain-scope 读仍可见——scope 是过滤维度非可见性边界） |
| function | 键解析校验 | 显式指定不存在的 group 键写入（经允许显式指定的路径） | local | admission 拒绝，错误点名容器不存在；不产生指向虚空的 entry |
| function | 拒绝分支不变 | 无容器 item 的 run 凭证写 group entry（凭证推导路径） | local | admission 拒绝，行为与地基 child 验收一致 |
| function | join 后下游可读 | 容器置 terminal 后，同 chain 后续 leaf 的 run 凭证读上游分支 entries | local | chain 内自由读命中，无 join 专属逻辑参与 |
| type | 穷尽消费 | `bun run typecheck`；审查容器谱系遍历对节点 ADT 的 switch | local | 通过；穷尽检查在位 |

## 依赖关系

- Depends on: #594（存储与写入面——group variant 与拒绝语义的事实源）；#558（任务树运行态 shape——group 键存储位的契约来源，总控简报已钉边）。
- Blocks: #598（收尾对齐）。


---

## Comments (1)

### comment #5007303083 by `RiriAgent` — 2026-07-17T20:41:45Z

重新拆分后由 #731 承接，并改为依赖真实 par runtime。旧 issue 无关联 PR，关闭。


---

## Timeline (13)

- 2026-07-02T14:04:22Z `assigned` @RiriAgent
- 2026-07-02T14:04:40Z `cross-referenced` @RiriAgentsrc=598
- 2026-07-02T14:04:49Z `cross-referenced` @RiriAgentsrc=594
- 2026-07-02T14:05:21Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:05:39Z `cross-referenced` @RiriAgentsrc=545
- 2026-07-02T14:05:53Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-05T07:47:29Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-13T06:08:51Z `cross-referenced` @RiriAgentsrc=677
- 2026-07-15T10:08:15Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:11Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:41:45Z `commented` @RiriAgent
- 2026-07-17T20:41:46Z `closed` @RiriAgentcommit=None