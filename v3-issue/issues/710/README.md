# #710 feat(engine): hook 全量元数据 payload 与运行态快照契约

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:16Z  | updated: 2026-07-27T04:27:00Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/710
- comments: 0  | timeline events: 11

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

合并声明消费与 payload 投影边界；已落地 #586 作为输入，不重复其实现。

hook stdin 的「全量元数据」typed payload 契约与单一组装函数：触发上下文 + #547 编译产物投影 + 运行态快照，三块类型全部从既有 schema 派生，零平行 shape。

## 问题

#543 执行模型要求「全量元数据 JSON 经 stdin」，接缝已裁「不另造第二套 shape」；当前不存在任何面向 hook 的元数据组装函数——若各执行 child 各自拼 JSON，必然手写平行 shape，违反接缝裁决，且 hook 作者面对的输入形态随执行路径漂移。

## 预期结果

性质表述：

1. **单一组装路径**：存在唯一 payload 组装函数与 typed 契约，三块组成——触发上下文（挂点 + 触发事件或决策点标识 + 关联键）、编译产物投影、运行态快照；observer/gate 两类执行路径共用，不存在第二套拼装。
2. **零平行 shape**：编译产物半边的类型从 #549 产物 schema 派生；运行态半边从 `StatusSnapshotBoundary` 派生；触发事件半边从 `ObservabilityEventBoundary` 派生——上游 shape 演进（#558 树结构节、#718 boundary 收紧）自动传导到 payload，本侧零同步代码。 运行中实例的编译产物半边必须解引用 #743 pinned definition；不得重新编译同路径当前 preset。
   运行态半边的红线适配：`StatusSnapshotBoundary` 现存匿名 `"object"` 槽（#718 收紧 child）——**匿名槽不透传进 payload**（透传即违反「禁匿名形状」红线）；payload 只投影已具精确 boundary 的节，#718 收紧后投影面经派生关系自动扩张，本侧零改动。
3. **版本化**：payload 自带版本标识；shape 演进 bump，PR body 列 shape diff（#456 先例）。
4. **schema 可导出**：hook 作者可获知 payload 精确形态（schema 导出面；作者文档载体归#715（收尾））。
5. **闭包元数据投影**（#546 body「资源模型公理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §2）：闭包转移边事件（`closure.create` / `run-spawn` / `run-exit` / `suspend` / `reopen` / `consume`）作为 observer 触发事件时，payload 运行态半边须投影闭包元数据（生命周期态 活跃/挂起/已消费、worktree 路径、闭包分支、par pin commit、sessionIds）。事实源 = #558 闭包状态表（四视图共同事实源）——投影关系派生自其 shape，本侧零平行定义；#558 落地后自动扩张。
6. **引擎不注入 GitHub 面字段**（L1 红线 + 权威记录 `v3/closure-lifecycle-decision.md` §5 打回记录）：payload 任何半边不得包含 mergedness、mergeCommit、PR 状态等 GitHub 面事实——「引擎理解 GitHub 字段」违反 L1 红线（`gh-issue-pr-iteration` preset 判定器自查 GitHub 面才是正确通道，供给条款 3）；边界 1 会话打回主张「引擎注入 mergedness 进判定 payload」的形态，本 child 从第一天起不留后门。相关 script 判定器自查形态见 #714。

### 显式决策项（落地时裁，裁决留本 thread）

- 编译产物投影的切片范围：全量六块 vs 按挂点相关切片（如 run 级挂点只投影所属 preset 的 phases 块）——「全量元数据」语义与 payload 体积的平衡。
- 无 chain/item 上下文的挂点（daemon startup/shutdown、tick）的运行态快照范围——与#712（决策点闭集） 协调（其 body 同步登记）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | payload 三块齐全且过 schema | 单元测试：fixture chain/run 组装 payload 后经边界 schema 校验 | local | 触发上下文/编译产物投影/运行态快照三块在场；校验通过；版本标识在场 |
| function | 操作员场景数据面 | 单元测试：多 runs fixture 下从 payload 运行态半边数出目标 item 的 run 次数 | local | 「计算迭代进行了几轮」可从 payload 得出 |
| type | 零平行 shape | 类型级断言 payload 类型由三个上游 schema 派生；`grep` 无重复字段手写定义 | local | 派生关系成立；无平行 shape |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |
| integration | stdin 端到端交付 | 登记：由 #711（observer 执行） 的「脚本收到含 run 元数据 JSON」验收行接管（本 child 落地时点为单元级） | local | — |

## 架构切片

1. **系统定位**：L1 引擎 hook 面的输入投影级——把引擎已有的两个 typed 事实源（定义态：编译产物；运行态：status 快照）加触发上下文合成为 hook 子进程的 stdin 契约。不新增事实源，只做投影合成。
2. **全局坐标**：引擎 typed 域（CompiledTaskModel / snapshot / event 信封）→ hook 子进程域（外部不可信消费者，经 stdin 收 JSON）。方向是 typed 域向外投影——无入站 parse 需求（hook 的回程通道是 gate stdout decision，归 gate child 的边界 parse）。
3. **类型↔值不漂移**：防值漂移——「全量元数据」若由各执行路径各自拼装即出现同值多副本失同步；单一组装函数封死。防类型泄露——payload 不得手写复制上游 schema 字段（从 schema 派生），上游演进零同步。
4. **消除的错误类别**：「hook 看到的元数据与 status/compile 输出不一致」不可表达（同源投影）；「执行路径间 payload 形态漂移」不可表达（单一组装）。

## log/观测义务

- 无新增运行期事件义务（payload 组装是纯函数面；组装失败随执行 children 的 hook.* 失败事件呈现）。

## 依赖关系

- Depends on: #586、#549、#743。
- Blocks: #711、#712、#713、#714、#715、#719、#744。



---

## Comments (0)

---

## Timeline (11)

- 2026-07-17T20:36:17Z `assigned` @RiriAgent
- 2026-07-17T20:38:28Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:38:30Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:38:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:39:10Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:39:33Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:40:59Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-27T04:27:03Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-27T04:27:04Z `cross-referenced` @RiriAgentsrc=714