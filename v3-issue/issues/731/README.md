# #731 feat(engine): real-par context group scope

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:03Z  | updated: 2026-07-27T01:00:39Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/731
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

必须依赖真实 par 生产调度，以两个真实并行 branch credential 写读同一稳定 group id；禁止直接 store fixture 冒充。

group scope 从「一律拒绝」真实化为可用：par 容器内的 run 写 group entry 时，daemon 从 #558 的树运行态推导容器稳定 id 作为 scope 键；读取按 group 键过滤命中同组 entries。

## 问题

地基 child 落地后 group variant 只有拒绝路径：daemon 无从推导写入者所属的 par 容器（v2 无树运行态）。#546 已裁 context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道——par 调度（#698/#700）落地后，并行分支之间将不存在任何合法的引擎提供上下文通道，「平行函数」的通信面缺失。

## 预期结果

性质表述：

1. **正路径**：凭证所属 item 位于 par 容器内时，group 写入被接受，默认键（凭证推导）= #558 shape 存储位中该容器的稳定 id；同容器其他分支的 run 按 group 过滤可命中。
2. **键解析真实容器**：无论凭证推导还是显式指定（指定方式按地基 child 决策项裁决，不得引入授权粒度），落库的 group 键都解析到树运行态中真实存在的 par 容器——不存在指向虚空的 group entry（地基 child「scope 键解析有效」性质在 group 维度的真实化）。
3. **拒绝分支不变**：不存在可寻址 par 容器时的 admission 拒绝语义与地基 child 完全一致——不出现「树存在与否」的双路径兜底。
4. **join 后可读性零新增契约**：容器 terminal 后，下游 agent 经 chain 内自由读可见上游分支全部 entries（含 group entries）——由裁决 3 的 chain 可见性天然覆盖，本 child 不添加任何 join 专属读取逻辑。
5. 树节点消费经穷尽 switch：容器谱系遍历对 #558 的节点 ADT 穷尽，新增节点 variant 由编译器暴露处置点。

### 显式决策项（落地时裁，裁决留本 thread）

- 嵌套 par 下的 group 键取值：最近祖先容器单键，还是祖先链多容器可分别过滤——过滤结果可观察（目标级分叉），取决于 #558 shape 对容器谱系的表示形态，以其 shape 设计 comment 为输入裁决。

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

- Depends on: #594、#730、#698、#699。
- Blocks: #734。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:04Z `assigned` @RiriAgent
- 2026-07-17T20:38:52Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:38:58Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:40:05Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:46Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-27T04:26:49Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-27T04:26:50Z `cross-referenced` @RiriAgentsrc=699