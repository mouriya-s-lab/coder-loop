# RFC #543 · R9 修补后预期地基

> 本文只汇合 `20-external-contract-resolution.md`、`21-runtime-consistency-resolution.md`、`22-observer-process-resolution.md` 与 `aggregation.md` / `01-clauses.md` 的稳定条款。main 实然问题只引用 R4/R7 已有报告结论，不重查源码。本文不选择 schema、API、表、锁、队列或 artifact 的物理形态，不拆 issue，也不声称实现或运行证明已经完成。

## A. 主 agent 摘要

修补后的最弱地基分成三层。第一，observer 是 durable at-least-once 投递：每个 event × matching observer 独立形成 delivery；每次真实启动形成 execution attempt；同一 delivery 的重派使用固定、版本化、pinned payload。clean stop 有界回收，crash/restart 对非终态 attempt 先回收旧进程组再重派。execution 终态是 diagnostic 权威事实，`hook.*` 只是可恢复、可重复的派生。

第二，gate runtime 以 typed current-state mutation、durable evaluation/journal 和 lifecycle admission 为地基。成功 mutation 不得用 stale whole snapshot 静默覆盖并发状态；`shutdown-held` 保持 query 可用、拒绝新 mutation 与新调度/observer dispatch；未终结的引擎内 delivery/effect intent 在重启后可恢复。terminal/consumed 只证明引擎拥有的状态已有 durable outcome。

第三，#543 不替 RFC-1/RFC-2 建权威。RFC-2 必须供给 pinned definition resolver 与公共 compile projection；RFC-1 必须供给 canonical closure 六边 transition，以及 typed structured-reopen authority。缺供给时相应主张保持外部 blocker，不能以当前路径重编译、旧 `closure.*` 推断、本地 journal 或多次 CLI 调用补齐。

不同脚本、同一脚本跨事件/chain/连续触发均允许并发。引擎不兜底文件、Git、数据库、第三方服务或跨脚本 effect；脚本作者负责可重入、资源协调与外部幂等。剩余 schema、时长、batch、存储介质、primitive 签名等均为实现参数或证明计划，剩余操作员产品裁决为 **0**。

## B. 逐域合同矩阵

| 域 | 稳定条款 | main 实然问题（既有报告） | 操作员 / 归属裁决 | 修补后最弱保证 | 可保留资产 | 外部 blocker | 仍未证明的运行项 | 明确非保证 |
|---|---|---|---|---|---|---|---|---|
| Observer process / clean stop | A1–A3、G1–G3、R8；RFC 关闭行 1/6 | R4 `04`：执行层尚未接线；R7 DI-01 `09`：现有 agent 进程管理与 daemon clean-stop/recovery 不能直接证明 observer 生命周期 | OP-01：停止接纳后 bounded drain，超时 process-group TERM→KILL，await close 后再关存储 | owned observer attempt 在正常停止中有界收敛为权威终态，不遗留已知 owned group | 现有 async spawn、agent timeout/recycle 与 daemon 生命周期分层经验可复用，但不能冒充 observer 已实现 | 无 | 进程树、忽略 TERM、stdio 继承、关闭顺序与总时限真跑 | 不保证脚本成功；不把 clean-stop termination 变成自动 retry |
| Observer crash/restart / identity | J1–J7、G2–G3 | R7 DI-01 `09`：spawn、ownership durable fact 与 crash recovery 间存在待证明窗口 | OP-02：持久 execution/delivery；重启先回收旧 group，再以同一 delivery 重派；每 attempt 独立 execution identity | durable delivery 至少发起一次可审计 attempt；只有 crash 后仍非终态/结果不确定的 attempt 恢复；success、nonzero、spawn/stdio failure、timeout 与 clean-stop termination 均终结 delivery，restart 不自动重派 | SQLite 事务能力、既有进程组回收与审计关联思路 | 无 | spawn/ownership 全 kill-point matrix；重复 crash 因果链；无主窗口关闭 | 不保证最多一次、attempt 次数上限或完成顺序；不为已知终态增加通用失败重试 |
| Payload / pinned input | F1–F8、R13；共享合同 6 | R4 `04`：当前无 hook stdin payload；可复用 projection 边界存在但 pinned definition 解引用未供给；R7 DI-02 `10`：当前路径不能证明旧实例跨重启仍读旧定义 | payload 来自公共 compile projection + runtime snapshot；同一 delivery 固定；RFC-2 owner 决定 artifact/resolver 物理形态 | 同一 delivery 的所有 attempts 收到语义与字节表示等价的版本化 payload；payload/stdin 携带稳定 delivery identity 与本 attempt execution identity；runtime/source 漂移不改写 replay 输入 | 已有 typed runtime facts、compile DTO/projection 与声明 provenance | **RFC-2-PIN / RFC-2-RESOLVER** | H1→同路径 H2→restart；旧实例仍 H1、新实例 H2；missing/corrupt/version failure 穷尽；crash 前后 stdin 对比 | 不保证当前路径可作 fallback；不规定 inline/blob/hash/压缩/GC；不注入 GitHub 业务事实 |
| Diagnostic authority / derivation | E1、E3–E5、G3、R9 | R4 `04`：`hook.*` 尚未进入统一事件 boundary，observer execution 也不存在；R7 DI-01 `09`：现有 close/error 事实不足以构成 durable observer diagnostic | OP-04：execution terminal record 是权威 diagnostic；统一 `hook.*` 从其派生 | terminal durable 后 diagnostic 可在 restart 补做；重复派生携带稳定 execution 因果 identity；派生失败不改变 scheduler 或重跑已终态 delivery；派生的 `hook.*` 不可再次匹配 observer | 统一事件流与 observer 类型层 `hook.*` 结构排除 | 无 | terminal-before-append、append-before-mark、sink failure/restart replay；零自反派发 | 不保证 event append exactly-once、全局顺序或 sink durable ack；事件不是第二权威 |
| Dispatch / subprocess primitive | G1–G3、R8 | R4 `04`：无 observer dispatcher；R7 DI-01 `09`：legacy/agent executor 混有领域状态，且 sync 形态违反异步红线 | OP-03：抽取领域无关 async subprocess primitive；OP-05：producer 栈内完成 admission、spawn/error handshake 与完整 stdin，随后不等 child | primitive 只处理 spawn/stdio/process-group/timeout/TERM→KILL/close；agent/observer 各自 adapter；observer completion 不阻塞 producer，observer 的任一 outcome 不改变 scheduler decision | 既有 spawn、stdio、timeout、recycle 过程资产 | 无 | slow child、EPIPE、大 payload/backpressure、多 observer；agent adapter runtime 回归 | 不保证 producer 零延迟；primitive 不承载 delivery/item/phase/session/backoff 领域语义 |
| Gate evaluation / journal | B1–B6、H1–H5、I1–I9、J1–J7 | R4 `05`/`06`：gate 仅有声明，无执行、decision ingress、epoch/journal/consumer；R7 DI-06 `14`：现存事务不能证明 decision、pending intent、effect consumption 的 crash 原子后果 | authoritative evaluation identity、decision 与引擎内 pending intent 是 durable typed facts；重启无需原触发点重现即可推进 | decision 与 pending delivery/effect intent 建立有原子边界；未终结引擎内工作可恢复；每 epoch decision/consumption 按稳定 ADT 穷尽处理 | 已落地 hook declaration ADT、四层合成、operator-only 写面、现有 SQLite transaction primitives | RFC-1 structured reopen authority（reopen 分支） | transaction 前/中/commit 后 SIGKILL；decided 未消费恢复；mutation replay absorption；全点真实 gate 路径 | 不保证判定主体只执行一次；不回滚非确定脚本已产生的外部或孤儿 effect；不指定 outbox/table/consumer 拓扑 |
| Metadata mutation consistency | J1–J7、R6 | R4 `05`/`06`：whole metadata carrier 仍可能被陈旧 snapshot 替换；R7 DI-04 `12` 已用并发实验观察到双成功后 lost update | 结果合同固定：typed mutation 基于 durable current state 原子应用，或显式 conflict；机制由实现选择 | 成功 mutation 不静默删除另一已提交的不相交子状态；同字段冲突有确定结果或 typed conflict | 已有 typed carrier boundary、事务与 hooks 省略/清除语义 | 无 | 双连接 barrier 覆盖两种提交序、不相交/同字段；生产 writer 闭集审计 | 不保证外部绕过支持入口的 writer；不指定 patch/CAS/revision/分表 |
| `shutdown-held` admission | I7–I8、R6 | R4 `05`：daemon shutdown 无 gate；R7 DI-05 `13`：现有查询/命令面不等于 lifecycle 准入闭集，且曾使用隔离 harness 的观察只证明局部 | 稳定语义决定：query 可用；尚未执行的 mutation typed reject；无新 scheduler/observer dispatch；已入执行工作按 drain 收敛 | rejection 无 DB/event/spawn 副作用；status/query 反映真实 held 状态；advance 后继续生命周期 | daemon socket/status、command ADT 与现有 shutdown skeleton | 无 | command ADT 闭集 response + DB/event/spawn diff；held→advance 真跑 | 不保证自动重试被拒 mutation；不规定统一 dispatch 或逐 handler 承载 |
| RFC-2 pinned definition | F2–F6、K1–K5；共享合同 6 | R7 DI-02 `10`：durable canonical pinned artifact/resolver/failure ADT 未在 main 供给 | RFC-2 owner 供给，#543 只消费；缺失/损坏/不支持版本显式失败，不回退当前路径 | 给定 pinned `definitionRef`，重启后可得到对应不可变资料并投影为公共 DTO，或得到穷尽 typed failure | compile schema/projection 与实例 definition identity | **RFC-2-PIN / RFC-2-RESOLVER** | 冻结供给 SHA 上 pin、重启、source 漂移、failure matrix | 不规定 artifact 介质、resolver API/返回 canonical model；#543 不建替代 resolver |
| RFC-1 closure transition | A4、A7、F7、M5、R11 | R4 `04`/`06` 与 R7 DI-03 `11`：main 五类 `closure.*` 主题事件不等同 canonical 六边 `create/run-spawn/run-exit/suspend/reopen/consume`，producer/identity/snapshot 未齐 | RFC-1 owner 供给 canonical transition fact；#543 observer 自动消费；六边 observer-only，不扩 gate 闭集 | 每次权威转移具有稳定 kind、发生时点 snapshot 与 transition identity；每个 observer match 另建 delivery identity | 统一事件词表、closure typed facts、observer 词表结构派生 | **RFC-1-CLOSURE-TRANSITION / EDGE-IDENTITY** | 六边合法 producer、commit/restart、重复读取与 snapshot/identity 真跑 | 不从旧事件推断补齐；delivery identity 不冒充 transition identity；不规定 outbox/emitter |
| RFC-1 closure/reopen authority | B2–B4、D3、L1–L3、R5、R14；共享合同 1/4/7 | R4 `06` 与 R7 DI-07 `15`：main 无 target wire authority、correction claim、budget resolver 与原子 reopen effect；本地 reachability 不是权威消费 | RFC-1 owner 供给 typed admission/effect；#543 提交稳定 evaluation/decision identity、opaque target 与精确既存 correction IDs | authority 穷尽校验 point×decision、membership/已运行/同 seq、claim、budget、冲突/重复；成功时 target reopen、cursor/budget、claim 与 consumed effects 全有或全无，terminal item 不改写 | decision ADT 槽位、evaluation-scoped CLI 与 typed ingress seam | **RFC-1-REOPEN-TARGET / CORRECTION-CLAIM / REOPEN-BUDGET / REOPEN-EFFECT** | 合法、非法、重复、冲突、预算耗尽、crash recovery；closure reopen/consume 全路径 | #543 不解释 target/budget 字符串，不用本地 journal冒充权威，不规定 relation/table/API |
| 并发 / 外部 effect 责任 | R3、R7、J5；observer 独立投递合同 | R7 补充 `19`：SQLite 局部原子性不能覆盖跨脚本文件、Git、外部服务；operator authority 不等于互斥；crash 重派可重复 effect | PO-01：同/不同脚本跨 event/chain 可并发；外部事情引擎不兜底，脚本作者负责 | 每个 match 独立 delivery，不合并、不跳过；引擎提供 stable identity、固定 payload、自有 durable state、局部 CLI 事务与审计关联 | operator CLI admission、stable delivery/execution identity | 目标资源自身的幂等/CAS/锁能力由脚本依赖，不是 #543 blocker | 并发启动与独立 delivery 真跑；测试不得把声明顺序写成 effect/completion 顺序 | 不提供 per-script/global lane、跨脚本锁、外部事务/回滚、effect sandbox、distributed exactly-once 或副作用顺序 |

## C. 外部 blocker

| Blocker 组 | 提供方 | 阻塞的 #543 主张 | 解除证据 |
|---|---|---|---|
| RFC-2 pinned definition artifact/resolver | RFC-2 (#547) | payload 的 pinned、一致、no-fallback 与跨重启重放 | 冻结供给 SHA 上 H1→路径 H2→restart；旧/新实例分读 H1/H2；missing/corrupt/version typed failure |
| RFC-1 closure canonical transitions | RFC-1 (#546) | closure 六边真实 observer 触发、权威时点 snapshot、稳定 transition identity | 冻结供给 SHA 上逐边从合法 producer 触发，覆盖 commit/restart/重复读取 |
| RFC-1 structured reopen authority | RFC-1 (#546) | script reopen admission、claim、budget、cursor 与原子 effect | 冻结供给 SHA 上合法/非法/重复/冲突/耗尽/崩溃恢复，证明 typed result 与全有或全无 |

这些 blocker 只阻塞依赖它们的 completion claim，不授权 #543 实现替代 authority。文件、Git、第三方服务的并发与幂等责任不是外部 blocker，而是明确的非保证边界。

## D. 证明计划

1. **Observer/process：** spawn/ownership kill-point、固定 payload、重复 crash、known-terminal no-retry、进程树回收、diagnostic replay、producer backpressure、clean-stop 顺序、并发独立 delivery、agent adapter 回归。
2. **Gate/runtime：** metadata 双连接 barrier；`shutdown-held` command ADT 闭集；decision/pending/effect transaction kill/restart；sink replay；生产 mutation ingress 闭集；legacy carrier 与新 authority 隔离。
3. **RFC-2 接缝：** pinned definition source 漂移 + restart + failure ADT，在冻结上游供给 SHA 上验收。
4. **RFC-1 接缝：** closure 六边 producer/identity/snapshot；structured reopen 的 target、claim、budget、cursor、terminal preservation 与 crash atomicity，在冻结上游供给 SHA 上验收。
5. **RFC 关闭：** 上述地基取得资格后，仍须逐项满足 `aggregation.md` §三和 `01-clauses.md` §三的全量关闭验证；局部 proof 不可外推为整个 RFC 已完成。

这些是运行资格要求，不是本文已经执行的测试，也不改变单个后续 implementation issue 的验证边界。

## E. 非保证

- 不保证 hook 脚本成功、只运行一次、按声明顺序完成，或普通失败自动 retry。
- 不保证 event sink、文件、Git、数据库或第三方服务 exactly-once、可回滚、跨系统原子或全局有序。
- 不提供 per-script/global serialization、通用资源锁、distributed transaction、effect sandbox 或外部幂等代理。
- 不在 replay 时回退当前 preset 路径，不从旧 `closure.*` 主题事件推断 canonical 六边，不用 #543 journal 代替 RFC-1 reopen authority。
- 不保证 `shutdown-held` 中被拒 mutation 自动重试，也不把 query availability 扩张为 mutation availability。
- 不规定 schema、API、表、列、索引、锁、队列、outbox、consumer、artifact、hash、GC、grace 数值、batch 或模块签名。
- 不迁移或删除旧 keep-active carrier；只保证它不成为新 evaluation/journal authority。

## F. 证据映射与尾部核对

| 结论 | 稳定来源 | main / 细节证据 | R8 归属核算 |
|---|---|---|---|
| observer durable at-least-once、固定 payload、identity、diagnostic | A/G/E/J、R8/R9 | R4 `04`；R7 `09`；补充 `19` | `22` |
| typed mutation、shutdown admission、journal recovery | I/J、R6 | R4 `05`/`06`；R7 `12`/`13`/`14` | `21` |
| RFC-2 pin/resolver 消费 | F/K、共享合同 6 | R4 `04`/`06`；R7 `10` | `20` D1–D2 |
| RFC-1 closure/reopen 消费 | A/B/D/L、R5/R11/R14 | R4 `04`/`06`；R7 `11`/`15` | `20` D3–D8 |
| 并发与外部 effect 边界 | J5、R3/R7 | `19` | `22` B7–B8 |

- 覆盖域：observer process、payload、diagnostic、gate evaluation、journal、metadata、shutdown、RFC-2 pinned definition、RFC-1 closure/reopen、并发/外部 effect。
- 外部 blocker：**3 组**；剩余操作员产品裁决：**0**。
- 未选择任何 schema/API/表/锁/队列物理形态；未实现代码；未拆 issue；未创建 worktree。
- 本文件是“修补后预期地基”，不是当前 main 已达到该状态的事实声明。
