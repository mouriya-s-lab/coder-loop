# #744 test(v3): 编译契约冻结 SHA 综合验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:33Z  | updated: 2026-07-27T01:00:55Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/744
- comments: 0  | timeline events: 20

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

唯一跨 consumer integration owner；显式依赖 #545 runtime tool enforcement、#546 runtime tree、hook/GUI consumers。

## 伞 #547 的关闭终态条件（本 issue 复核对象）

以下是伞 #547 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | Command | Env | Expect |
|---|---|---|---|---|
| 1 | 编译产物可导出且六块齐全 | `coder-loop preset compile gh-issue-pr-iteration --json \| jq '.schemaVersion, (.stateGraph.edges \| length), (.phases[0].variables[0].type)'` | local | schemaVersion 输出；边数 > 0；变量带 type 字段 |
| 2 | 零原语清零 + 变量名特判死亡 | `grep -rnE 'DEFAULT_PRESET_NAME\|REPOSITORY_REF_PATTERN\|normalizeQueueIssueId\|inferRepositoryFromGit\|=== "ISSUE"' src/` | local | 无输出 |
| 3 | required 校验前移创建期 | fixture chain 缺 required chain binding 跑 `chain create`；缺 required item 字段跑 `item add` | local | 均创建被拒，错误点名缺失字段；无静默 `""` render 通路 |
| 4 | json 类型可渲染 | fixture preset 声明 json 字段绑定，真实 spawn 路径渲染 | local | 规范化 JSON 出现在渲染产物，无 throw |
| 5 | 工具约束定义期判定 | fixture 分别声明 outcome 缺失+required（任意 provider）、outcome=entry-existence+required → compile | local | 前者编译错误，错误点名 required 需要确定性输出条件（不提及 provider）；后者编译通过；可执法性判定只消费 outcome 轴，provider 不出现在判定路径 |
| 6 | dead fragment 定义期暴露 | fixture preset 含无 phase role 消费的 fragment → compile | local | warn finding，点名 fragment id |
| 7 | plan 面退役 | `ls presets/gh-issue-pr-iteration/plan/ 2>&1; grep -c 'role = "plan"' presets/gh-issue-pr-iteration/preset.toml` | local | 目录不存在；计数 0 |
| 9 | 验证阶段不漂移 | fixture 分别制造定义错误、实例缺值、run 内 required-tool 的 outcome 不成立 | local | 三类错误分别在 compile、create、run-finalize 最早可决定点被拒；无重复判定或提前臆断 |
| 10 | 运行实例定义不漂移 | 用 H1 创建实例，改同路径 preset 为 H2，kill -9/restart daemon | local | 旧实例继续绑定 H1、新实例使用 H2；只保护事前可计算定义，无运行态 MVCC/事务快照 |
| 11 | identity 连续 | 编译 `seq(leaf, par(leaf, leaf))`，构造运行态并读取 SQLite/status/events | local | 同一节点 identity 可跨 compile/持久化/观测关联，结构路径不充当主键 |
| 12 | 公共投影契约 | 对 compile success/rejected 两分支做 boundary round-trip，并让一个独立消费者只靠 schema 读取 | local | 无 exception 文本解析、私有补丁、字段猜测或 arktype expression 执行 |

## 依赖关系

- Depends on: #735、#736、#737、#738、#739、#740、#741、#742、#743、#732、#733、#698、#706、#710、#726。
- Blocks: #547 closure。


---

## Comments (0)

---

## Timeline (20)

- 2026-07-17T20:37:34Z `assigned` @RiriAgent
- 2026-07-17T20:38:55Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:38:56Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:38:59Z `cross-referenced` @RiriAgentsrc=735
- 2026-07-17T20:39:01Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-17T20:39:02Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-17T20:39:03Z `cross-referenced` @RiriAgentsrc=738
- 2026-07-17T20:39:05Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:39:06Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:39:07Z `cross-referenced` @RiriAgentsrc=741
- 2026-07-17T20:39:09Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-17T20:39:10Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:40:20Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:57Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-17T20:42:07Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-18T07:40:29Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-27T04:26:58Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-27T04:27:00Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-27T04:27:06Z `cross-referenced` @RiriAgentsrc=726