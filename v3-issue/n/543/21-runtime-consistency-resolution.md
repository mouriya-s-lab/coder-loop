# R8 runtime consistency 归属核算

> 证据边界：只读 `18-decision-dossier-runtime-consistency.md`、`12-detail-chain-metadata-concurrency.md`、`13-detail-shutdown-admission.md`、`14-detail-journal-killpoints.md` 的主 agent 摘要、`aggregation.md` 稳定条款及 `WORKFLOW.md` 当前裁决。本文不选择 schema、表、API、锁或 consumer 的物理形态，不修改稳定需求。

## A. 摘要

`18` 把七项工程后果写成了实现形态选择，但按稳定 J/B/I 条款、类型红线以及已经落定的外部副作用边界重新核算后，它们都不再构成操作员产品分叉：

- metadata 只需保证 typed mutation 不会用 stale whole snapshot 静默覆盖已提交的不相交状态；transaction patch、CAS 或状态分离都是实现可选项。
- `shutdown-held` 已由“查询仍可用、停止新调度、mutation 不准入”确定；准入矩阵放在统一 dispatch 还是 typed handler 是实现内部选择。
- journal/outbox 只保证引擎自身 durable decision、pending delivery、restart recovery、stable identity 与 at-least-once；文件、Git、事件 sink 或其他外部 effect 不进入引擎事务、锁、回滚或 exactly-once 主张。
- 旧 keep-active carrier 不得成为新 epoch/journal 的输入。新状态使用独立 typed authority 即可隔离；是否另行迁移或删除旧历史不影响 #543 新语义，因此不是本 RFC 的待裁产品口径。

分类结果：7 项由稳定条款/既有裁决直接确定，4 项是纯证明计划；旧历史处置 1 项由“新旧语义隔离”收敛为历史处置口径，不产生 #543 机制。真正剩余操作员裁决为 **0**。

## B. 逐项归属

| 项目 | 归属 | 核算结论 |
|---|---|---|
| RC-E01 metadata 冲突语义 | 稳定条款确定 | DI-04 已证明 stale whole replacement 会丢失已提交状态。稳定要求只需要可观察结果：typed mutation 要么基于事务内最新值原子应用，要么显式返回冲突；不得“成功”并静默覆盖不相交状态。采用 patch、revision/CAS、状态分离或其最小组合属于工程实现，不需操作员选物理机制。 |
| RC-E02 shutdown command admission | 稳定 I 条款确定 | `shutdown-held` 是已登记的决策点宿主；其最低合同是 query 可用、不得接受新 mutation、不得开始新调度。daemon control 只需保持既有停止/状态查询的生命周期语义。统一 dispatch 与逐 typed handler 都只是承载位置。 |
| RC-E03 mutation rejection outcome | 稳定类型边界确定 | 被 lifecycle 拒绝的 mutation 必须返回显式、可识别的 typed lifecycle rejection，且不得产生 DB、event、spawn 副作用；不得用成功空响应或字符串猜测。具体错误名、字段和 wire shape 留给实现阶段。是否自动重试不是本条保证。 |
| RC-E04 journal durable boundary | 稳定 J1–J7 确定 | authoritative evaluation identity、epoch、decision、delivery/effect intent 与 consumption progress 必须是 durable typed facts；产生决定与写入其引擎内 pending intent 必须具有原子提交边界。closure 的 `pending/emitted` 名称不是新 schema 依据。 |
| RC-E05 restart 后推进者 | 稳定 J 的重启恢复要求确定 | 已持久化但未终结的引擎内 delivery 必须在 daemon restart 后可恢复推进，不能依赖原 scheduler point 偶然再次到达或原 socket command 重发。统一 drainer、恢复队列或等价内部机制均可，只验收恢复后果。 |
| RC-E06 event/delivery 交付契约 | 稳定条款 + 外部边界裁决确定 | 引擎内契约为 at-least-once，并携带 stable execution/delivery identity 供审计与消费端去重。不得主张 event sink 或脚本外部 effect exactly-once。重复 delivery 是合同内行为，不要求引擎为文件、Git 或外部服务兜底。 |
| RC-E07 cleanup/event/consumption 完成关系 | 稳定条款 + 外部边界裁决确定 | journal 只能在所有**引擎拥有的** durable state transition 与 delivery outcome 已记录后进入 terminal/consumed；未记录的引擎内步骤保持 pending 并可恢复。外部 effect 的真实成功、回滚或去重不作为引擎 consumed 的保证；引擎只记录尝试及其 outcome。resource identity 至少保留到对应引擎内 execution/delivery 终态可审计。具体子状态数与事务拆分不预裁。 |
| RC-PO02 旧专用历史行 | 历史处置纯口径，已可隔离收敛 | 唯一稳定约束是旧 keep-active 二词不得静默解释为新 epoch/journal。#543 的新 typed authority 不读取旧 carrier，即可使旧行不影响新状态。旧值可原样保留为 legacy/opaque 数据；迁移或清理若未来有独立产品需求再处理，不进入 #543 expected foundation，也无需本轮操作员在 H-A/H-B/H-C 中选择。 |
| RC-P01 transaction 中真实 SIGKILL | 纯证明缺口 | 用 deterministic child-process barrier 覆盖 transaction 前、事务中、commit 后 kill，验证未提交不外露、已提交 durable intent 可恢复。普通 throw rollback 不替代该证明；不由缺口反推新产品机制。 |
| RC-P02 shutdown command 闭集矩阵 | 纯证明缺口 | 对 command ADT 闭集逐项验证 `shutdown-held` 下 response、DB diff、event diff、spawn diff；证明 query 可用、mutation 被 typed 拒绝、无新调度。无需操作员逐命令裁决。 |
| RC-P03 event append durability | 纯证明缺口 | 不把 append 返回当成 authoritative durability。验证 durable journal/delivery 在 append 丢失或重复后能重放派生；若 sink 自身无 fsync/ack，只把它记为 at-least-once 外部 sink，而不增强引擎主张。 |
| RC-P04 外部 writer 与历史次数 | 纯证明/历史审计，不是需求分叉 | 对当前受支持写入口做闭集审计，证明新 typed mutation 边界覆盖生产调用者。历史 lost-update 次数不可由缺失日志可靠重建，也不影响新合同验收；外部绕过受支持入口的 writer 不扩张 #543 保证。 |

## C. 可直接写入 expected foundation 的最弱合同

1. **Typed current-state mutation**：所有 #543 拥有的 runtime state mutation 必须在一个明确的 typed boundary 上，以 durable current state 为基准原子应用，或显式返回 conflict。成功结果不得由 stale whole snapshot 静默删除另一已提交子状态。
2. **`shutdown-held` admission**：该状态保持 query 可用，拒绝尚未进入执行的 mutation，并禁止新的 scheduler/observer dispatch；已经进入执行的工作按既定 shutdown drain 收敛。拒绝具有 typed lifecycle outcome 且无 DB/event/spawn 副作用。
3. **Durable evaluation/delivery authority**：evaluation identity、epoch、decision、pending delivery 与 terminal outcome 是引擎内 durable typed facts。决定和其 pending delivery 的建立具有原子边界；未终结 delivery 在 restart 后无需原触发点重现即可恢复推进。
4. **At-least-once 与 stable identity**：引擎对 execution/delivery 采用 at-least-once，重放保持稳定 identity 并进入 payload、journal、audit 与 diagnostic projection。重复外部 effect 是允许风险，由脚本/外部消费者用该 identity 自行协调。
5. **Terminal/consumed 含义**：terminal/consumed 只证明引擎拥有的 execution/delivery 状态已经有 durable outcome；不证明文件、Git、event sink 或第三方服务的 effect exactly-once、可回滚或跨系统原子。
6. **Legacy isolation**：旧 keep-active metadata 不是 evaluation identity、epoch、decision 或 delivery authority，不参与新 journal 的恢复、指纹或首次评估。#543 新状态必须由独立 typed authority 提供；旧数据迁移/删除不属于本 RFC 成立条件。

以上合同刻意不指定 JSON patch、revision 列、CAS 重试、独立表、统一 dispatch、handler annotation、outbox 表名、consumer 拓扑或 journal state 数量。只要实现能证明上述结果，便满足当前稳定要求。

## D. 纯证明计划

| 证明 | 最小实验/审计 | 必须观察的结果 |
|---|---|---|
| metadata 并发 | 两个独立连接，以 barrier 固定两种提交顺序；覆盖不相交子状态与同一字段冲突 | 不相交状态都保留；同字段按所选 typed contract 得到确定 commit-order 结果或显式 conflict；不得双成功后静默丢状态 |
| shutdown admission | 进入可控 `shutdown-held` barrier 后穷尽 command ADT | query 成功且投影真实；mutation 返回 typed lifecycle rejection；DB/event/spawn 无差异；无新调度 |
| journal kill/restart | 在 decision/pending 建立、delivery 执行、outcome 记录各边界做 deterministic child-process kill | 未提交事实不外露；已提交 pending 可在 restart 后自行恢复；重复使用同一 stable identity；最终得到唯一权威 terminal outcome |
| sink 重放 | 模拟 append 前失败、append 后 mark 前 kill、重复派生 | durable journal 不丢；允许 0→重放或重复 append；每次派生带同一 delivery identity；不得据此声称外部 exactly-once |
| writer 闭集 | 审计所有受支持 metadata/runtime mutation ingress，并以类型/派生守护覆盖新增入口 | 没有生产入口继续提交 stale whole replacement；绕过公共入口不在保证面 |
| legacy upgrade | 用含旧 keep-active carrier 的 fixture 打开新 runtime | 新 journal 不读取、转换或信任旧值；首次 evaluation 与无旧 carrier 情况遵循同一新合同；旧值保留或独立清理由额外工作决定 |

这些证明属于实现/验收阶段，不要求在 R8 先选 schema，也不得为了证明方便扩大成外部 effect 协调机制。

## E. 真正剩余操作员裁决

**0。**

所有不同工程形态只要满足 C 节结果合同，其差异都属于内部实现与验证成本，不改变操作员可见语义。旧历史行的迁移/删除也不影响 #543 新 authority；没有稳定需求要求本轮选择其产品处置。

## F. 尾部

- [x] RC-E01–E07 逐项回归稳定条款与既有外部边界裁决。
- [x] 未把风险存在自动升级成事务、锁、回滚或 exactly-once 机制。
- [x] metadata 只固定“无 stale silent overwrite”的结果，不选择 patch/CAS/分表。
- [x] `shutdown-held` 固定 query、mutation admission 与 no-spawn，不选择 dispatch 物理位置。
- [x] journal/outbox 只固定引擎内 durable at-least-once + stable identity。
- [x] 旧 carrier 与新 authority 隔离；没有把 legacy migration/cleanup 变成 #543 blocker。
- [x] RC-P01–P04 保持证明/审计任务，不产生产品机制。
- [x] 未读源码、未实验、未创建 worktree、未修改其他文件、未拆 issue。
