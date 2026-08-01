# RFC #544 R8 七档案收口核算

> 核算对象为 `decision-S1-status-544.md`–`decision-S7-cap4-544.md`、R7正式报告与 AGG/SYNTH 稳定条款。本报告只核算R8权限、需求来源、工程形态和跨档接缝；不推荐实现、不估规模、不拆 issue。

## A. 主 agent 摘要（≤一页）

- **逐档重新核算后gate为7/7。** 核算逐一检查每档的稳定条款来源、当前偏离、工程形态与风险清单；只有不再把当前实现分叉、物理存储沉默、外部接口细节或调查风险升级成要求的档案才通过。S1–S7现均满足。
- **操作员裁决：0。** C1最终wire、C2稳定可见性结果、C3 current name-based compile都已由稳定设计固定，不存在三包待裁。
- **R9前置owner裁决：0。** CAP-2生命周期内pinned definition可达是已定保证；retention/GC是该保证下的工程设计。CAP-3精确typed shape与CAP-6实际Arktype boundary由外部能力提供，但均是消费接口细节，不阻塞R9建立scalar/additive seam和typed consumer seam。
- **原C5六维包删除。** pagination/filter随upstream实际实现；auth/audit、bad-row/partial、跨页snapshot、retention/GC、cursor失效、deleted-chain可见性是风险或工程未知，不能由调查生成RFC需求。
- **七档案工程形态可以进入R9。** R9应从稳定语义选择修补后预期地基：最终wire通过单一engine-owned boundary、稳定事件可见性结果、current name-based compile、CAP-2 pinned可达、CAP-3 additive seam、CAP-6 typed consumer seam、F档typed mutation façade与CAP-4 domain链路。不得猜外部shape、TTL或加入未要求的持久operation/全局known-outcome。
- **跨档实质冲突：0。** 真实接缝保留；此前“等待C1–C5才能进入R9”的阻塞结论删除。

## B. 完整核算矩阵

### B1. 七档案gate

| 档案 | 可进入R9的稳定语义 | 工程形态/接缝 | 操作员裁决 | R9前置owner裁决 | Gate |
|---|---|---|---:|---:|---|
| S1 status | 最终CLI/HTTP wire通过单一engine-owned boundary parse；domain/wire同源 | opener、事务、投影与序列化顺序 | 0 | 0 | ✓ |
| S2 daemon/transport | 三证与已定错误/活性语义、typed client deadline/cancel且销毁socket | ownership、framing与identity；response/server caps均为可选资源强化 | 0 | 0 | ✓ |
| S3 events | 主events真实历史、active offset增量、rotation无丢重、SSE存活与断开资源清理、最后/死因/具名异常可见 | segment identity/offset是内部工程；replay、Last-Event-ID、restart cursor persistence为可选强化 | 0 | 0 | ✓ |
| S4 attempt/compile | D2/D10同源artifact；CAP-2生命周期内pinned可解引用；D11 current name-based；CAP-3 additive | repository/resolver/artifact packet/ADT与typed extension seam | 0 | 0 | ✓ |
| S5 context | 一个operator socket外部read合同；upstream Arktype boundary；三scope、固定envelope、opaque body；pagination/filter随upstream | read handler内聚或共享read service两种内部放置；写恢复不在本RFC范围 | 0 | 0 | ✓ |
| S6 mutation | F档exact、typed client、既定operator调用、daemon裁判、四动作可用且结果/错误可观察 | F投影与逐verb最小错误传播；认证重构、封store、durable operation/outbox/saga/log均降为风险/强化 | 0 | 0 | ✓ |
| S7 CAP-4 | evaluation identity、decision ADT、capability、typed F operation、consumer、status/event/audit对齐 | decision storage、capability与epoch/currentness；不继承S6 durable operation前提 | 0 | 0 | ✓ |

**Gate核算结果：7/7。** S1最终wire、S2 transport、S3事件、S4 attempt、S5 context、S6 mutation、S7 CAP-4均已逐档检查；每档只保留可追溯到稳定条款的交付要求，将更强机制降为工程候选、风险或外部接口细节。

### B2. C1–C5纠偏核对

| 原ID | 正确分类 | 稳定依据决定的结果 | R9处理 |
|---|---|---|---|
| C1 | 已定要求 | consumer收到的最终wire必须通过单一engine-owned精确boundary；禁止平行schema/parser/builder | 选择使最终wire受同一boundary证明的工程形态 |
| C2 | 已定可见性结果+工程分叉 | 主events历史与最后事件可读；崩溃记录作死因线索；具名异常可见 | 不建立六格membership合同；工程上实现所需读取、投影和去重 |
| C3 | 已定要求 | D11是current name-based compile preview，与同次CLI compile对照 | 不增加historical-pinned或双视图 |
| C4 | 已定保证+外部接口细节 | CAP-2生命周期内pinned可解引用；CAP-3 scalar基线上additive typed | 设计可达性与GC；保留typed extension seam，不猜shape |
| C5 | 外部接口依赖+工程未知 | 消费upstream Arktype boundary、三scope、固定envelope、opaque body；pagination/filter随upstream | 不建立六维裁决包；保留typed consumer seam |

对账结果：**操作员裁决0，R9前置owner裁决0，新增需求0。**

### B3. 跨档接缝

| 接缝 | 收口规则 | 冲突 |
|---|---|---:|
| S1 ↔ S4/S7 | attempt/CAP-4字段进入同一status boundary，不各建parallel wire | 0 |
| S2 ↔ S6 | S2提供typed transport错误；S6提供逐verb accepted/rejected/failed及status/events核验，不要求持久operation查询/重放或共同commit | 0 |
| S3 ↔ S6/S7 | domain档定义动作/decision payload与核验语义；events档提供既定事件可见性，不强制共用outbox/log | 0 |
| S4 ↔ CAP-2/3 | artifact生命周期不替definition可达；scalar基线不替typed extension | 0 |
| S5 ↔ CAP-6 | handler/gateway只派生upstream Arktype boundary，不从内部full list倒推shape | 0 |
| S6 ↔ S7 | CAP-4进入F typed façade并复用既定operator/daemon裁判/最小结果语义；不以durable operation或第二日志为前提 | 0 |

### B4. R9输入边界

R9可以直接使用以下修补后预期保证：

1. status最终wire由单一engine-owned boundary约束；
2. 稳定文本要求的真实事件历史、active offset增量、rotation无丢重、SSE存活/断开清理，以及最后事件、死因线索和具名异常可见；断线replay与restart cursor不进入保证；
3. attempt prompt/bindings与实发同源，pinned definition在spawn/retry/restart中可解引用；
4. D11固定current name-based compile；
5. CAP-3维持scalar基线并预留additive typed seam；
6. context固定operator socket read拓扑并消费upstream CAP-6 Arktype boundary；
7. pagination/filter跟随upstream实际接口，不复制shape；
8. GUI mutation面恰为F，typed client按既定operator调用daemon，逐verb accepted/rejected/failed和错误可由status/events核验；
9. CAP-4以evaluation identity、decision ADT、capability与typed F operation形成domain链路，并与status/event/audit对齐。

R9不得自行增加historical D11、fallback六格集合、event断线replay/`Last-Event-ID`/restart cursor、TTL/永久保留、CAP-3字段、CAP-6 cursor/error shape、context写恢复、operator认证重构、全面封store、durable operation/query/replay、outbox/saga/command log、共同commit或跨介质known-outcome。外部接口尚未落定的部分保留typed seam和明确未知即可。

### B5. 最终收口

| 项 | 数量 | 结论 |
|---|---:|---|
| 七档案gate | **7/7** | 可进入R9修补后预期地基选择 |
| 操作员裁决 | **0** | 无需向操作员呈现C1/C2/C3 |
| R9前置owner裁决 | **0** | CAP-3/CAP-6 shape为外部接口依赖，不阻塞 |
| 跨档实质冲突 | **0** | 真实接缝均已分层 |
| 新增需求 | **0** | 风险与实现沉默未升级为合同 |
