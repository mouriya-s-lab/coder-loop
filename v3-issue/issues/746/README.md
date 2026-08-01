# #746 feat(router): GitHub 事件到 coder-loop CLI 的独立消费 daemon

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:37Z  | updated: 2026-07-27T01:00:57Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/746
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#548](https://github.com/mouriya-s-lab/coder-loop/issues/548) 的共享契约与关闭验证。

## 目标

交付独立 router product 与真实事件 E2E。

新建独立 repo 落地 GitHub 消费 daemon：接收 `github-hapi-agent-router` 的 HMAC push（规范化 issue 事件），按映射配置转译为 coder-loop CLI 的 `into-chain | new-workspace` 结构化调用，返回 `consumed | not-consumed` verdict。

## 问题

> "外部触发入口现状只有 CLI→Unix socket（行 JSON、每请求一连接，`src/daemon.ts:3833-3864`）；无 HTTP、无 webhook receiver" — #548 定位事实

GitHub 事件今天无法自动变成 coder-loop 队列工作；iac 链路（router → `github-hapi-iac-daemon`）已端到端验证消费 daemon 形态，但 coder-loop 侧的对应消费端不存在。裁决 F 已裁定承载体：新建独立 repo，不进 coder-loop、不进 router。

## 预期结果

性质表述：

1. **入队通路唯一性**：本 daemon 对 coder-loop 的一切写入都经 PATH 上的 `coder-loop` CLI——零 import 引擎源码、零直连 socket、零直写 SQLite。CLI 即契约（coder-loop CLAUDE.md 钉定的 stable API）。
2. **两分支覆盖、零 prompt**：映射配置能表达 `into-chain`（既有链追加）与 `new-workspace`（声明新链 + 播种）两分支；任何调用通路上不存在自由 prompt 字段——传递的只有 chain 选择、preset 引用、preset 声明的元信息字段。
3. **重放收敛**：对任意前缀失败的调用序列，同一事件重放收敛到与单次成功相同的终态——`chain.create` 幂等、`item.add` already-exists 按 `consumed` 处置（入队 = 接管的既成事实）、其余失败 → `not-consumed` 交 router 重推。
4. **verdict 忠实**：`consumed` 当且仅当 item 实际入队（或已在队）；coder-loop daemon 不可达 / 拒绝 → `not-consumed` + 结构化 blocker。
5. **映射知识独占**：label→preset、issue→itemId 约定、chain 命名约定、repo→本地 checkout 路径，全部归本 daemon 配置；coder-loop repo 零新增 GitHub 外挂知识。
6. 事件→动作映射结果与 verdict 用穷尽 ADT 建模（union 加 variant 时编译器给出 worklist）。

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- **repo 命名**：落地时定。repo owner 创建前按操作员 GitHub 账号路由规则确认（候选 owner 四选一；姊妹 repo router / iac-daemon / hapi-remote-session 均在 `mouriya-s-lab`）。
- **fire-and-forget 下的 GitHub 侧回执**（「已入队」comment 之类）：是否要、归哪端。若裁归 router 侧，需求登记到 router repo issue，不在本 repo 实现。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | function | into-chain 分支（RFC 行 1 前半） | 对映射到既有 chain 的 fixture 事件构造带合法 HMAC 的 POST；随后 `coder-loop status <target> --json` | local | 响应 `consumed`；item 出现在该 chain 队列（`queue.total` 增一且新 itemId 可见）；决策日志记录构造的 CLI 调用参数，其中无 prompt 内容字段 |
| 2 | function | new-workspace 分支（RFC 行 1 后半） | 对映射到新链声明的 fixture 事件 POST；`coder-loop chain list` + `status --json` | local | 新 chain 建立、item 入队且 `queue.selected` 可指向它 |
| 3 | function | 重放收敛（RFC 行 3） | 同一事件 POST 两次（模拟 router 重推同 delivery）；比较两次响应与 `status --json` 队列 | local | 两次均 `consumed`；队列 item 总数不变（执行恰好一次归行 5 端到端观察） |
| 4 | function | verdict 忠实：引擎停机 | `coder-loop daemon stop` 后 POST；重启引擎后重放同一事件 | local | 停机时响应 `not-consumed` + 结构化 blocker；恢复后重放 `consumed` |
| 5 | integration | 端到端 + 重试闭环（RFC 行 4、5；先决：router 完成模型 per-target 化已落地） | fixture repo 真实 labeled issue → router → 本 daemon → 引擎 → preset 工作流；期间制造一次引擎停机再恢复 | 真实 GitHub + router + 本机引擎 | issue 最终被 PR close；一次触发恰好一次执行；停机期事件经 router 队列重推恢复消费，不丢失 |
| 6 | assumption | 外挂纯度（RFC 行 6） | 本 repo：检查依赖清单与 import 面对 coder-loop 的引用；本 child 的 closing PR 不落在 coder-loop repo | local | 依赖清单与 import 均无 coder-loop 源码引用（仅 spawn PATH 上 CLI）；coder-loop repo 无本 child 产生的改动 |
| 7 | environment | 类型与测试 | 本 repo typecheck + test | local | 全绿 |

## 架构切片

1. **系统定位**：#548 核心设计外挂链路的第三部件（GitHub → router → **消费 daemon** → coder-loop daemon）。协议面词汇：它是两个既有稳定契约面之间的翻译进程——对 router 是 push target（consumed/not-consumed 合同），对 coder-loop 是又一个 CLI 调用方（operator 主体）；不拥有任何一侧的语义，只拥有映射表。
2. **全局坐标**：外网事件域（GitHub webhook，router 已验签）→ mesh HMAC 信任域（router push，本 daemon 验签）→ 本机 operator 信任域（CLI→socket）。parse 点两处：进程入口的 HMAC 验签 + 事件 schema 边界 parse；出口是 CLI 参数构造（引擎侧 socket 边界再 parse 一次）。
3. **类型↔值不漂移**：防类型泄露——GitHub 事件词表（label / issue number / repo fullName）终结在本 daemon 的映射配置，不得泄进 coder-loop 引擎类型；防值漂移——映射配置是唯一翻译表，事件字段不绕过映射直接透传成引擎参数。
4. **消除的错误类别**：「外部系统向引擎注入自由 prompt / 任意指令」不可表达（调用面只有结构化字段）；「GitHub 知识渗入引擎 repo」不可表达（翻译发生在引擎 repo 之外，RFC 行 6 grep 可证）。

## log/观测义务

- 本 daemon 每个决策写一行结构化 JSON 日志（对齐 router / iac-daemon 既有形态）：deliveryId、repository、issue、映射结果（分支 + chain + preset + 构造的 CLI 参数）、verdict、blocker。受众是 agent 与操作员排障，结构化优先。
- coder-loop 引擎侧零新增事件义务：chain.create / item.add 的既有审计事件（每条 mutation 1-3 条）已覆盖入队审计；裁决 H 的 origin 字段是登记在 #548 的可选演进，不进本 child。

## 依赖关系

- Depends on: router 项目的既有 #12 前置。
- Blocks: #747、#748。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:38Z `assigned` @RiriAgent
- 2026-07-17T20:39:14Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:39:17Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-17T20:40:23Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:09Z `cross-referenced` @RiriAgentsrc=569
- 2026-07-26T16:14:49Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-26T16:15:09Z `cross-referenced` @RiriAgentsrc=548