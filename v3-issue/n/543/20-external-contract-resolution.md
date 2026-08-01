# RFC #543 · R8 external contracts 归属核算

> 核算输入仅为 `17-decision-dossier-external-contracts.md`、`10/11/15` 的主 agent 摘要、`aggregation.md` 的稳定条款与 `WORKFLOW.md` 已登记裁决。本文不读取源码、不复做实验、不选择 RFC-1/RFC-2 的物理 schema/API/producer 形态，也不生成实现方案、工作量或 issue。

## A. 摘要

`17-decision-dossier-external-contracts.md` 的 D1–D8 都不是 #543 尚待操作员裁决的产品语义。它们分成两类：

- **RFC-2 owner 必须供给、#543 只消费：2 项（D1–D2）**。RFC-2 已拥有编译产物 schema、pinned definition 解引用和缺失/损坏不回退当前路径的语义；artifact、resolver 与 failure ADT 的物理形态由 RFC-2 落地。
- **RFC-1 owner 必须供给、#543 只消费：6 项（D3–D8）**。RFC-1 已拥有 closure 六边、point×decision 合法组合、结构化 reopen authority、correction subtree runtime、target/cursor/budget/claim/effect 语义；canonical record、wire identity、claim/budget/journal 的物理形态由 RFC-1 落地。

#543 真正拥有的是消费侧接缝：复用 RFC-2 的公共 projection；把 RFC-1 供给的 canonical closure transition 变成 observer delivery；生成 script evaluation/execution/delivery identity；通过 typed decision ingress 提交 `advance | hold | reopen(target, correctionItemIds)`；保存自身 journal、局部 DB/CLI 事务与审计。它不反向规定上游存储布局，也不为文件、Git、外部服务、跨脚本 effect 提供事务、锁、回滚或 exactly-once。

因此本域**剩余操作员裁决为 0**。尚未落地的上游能力是明确 blocker，不得改写成 #543 的新机制；#543 的主张应弱化为“依赖权威、稳定、可重启读取的上游合同”，而不是加强外部实现假设。

## B. D1–D8 逐项归属判定

| 项 | 归属 | 既定语义 | #543 可写入 expected foundation 的最弱依赖合同 | 未落地时的 blocker 标记 |
|---|---|---|---|---|
| D1 pinned definition durable canonical artifact | **RFC-2 owner 供给；#543 消费** | 运行实例绑定不可变 `definitionRef`；旧 H1 在同路径变 H2及重启后仍读 H1；缺失/损坏禁止回退当前路径。公共 compile projection 已版本化且有唯一 canonical 投影。 | 给定运行实例的 pinned `definitionRef`，RFC-2 能在重启后返回与该 ref 对应的不可变定义资料，足以生成公共 projection；读取结果与当前源路径内容无关。#543 不要求 blob、bundle、表列或 artifact 介质。 | **BLOCKED-EXTERNAL/RFC-2-PIN**：若 durable ref resolution 未落地，#543 不得声称 payload 的定义部分可跨重启保持 pinned，也不得以当前路径重编译代替。 |
| D2 definition resolver 返回边界与 failure ADT | **RFC-2 owner 供给；#543 消费** | 同源消费者沿 ref 读取；missing/corrupt/version-unsupported 必须显式失败并进入上游定义的 hold/error 路径，不能 silent fallback。 | RFC-2 提供 typed resolver boundary：成功结果可稳定投影为公共 compile DTO；失败可被穷尽区分并携带稳定 definition identity。#543 只把成功投影放入 payload，并传播/记录失败，不规定 resolver 返回 canonical model、projection或命名 product。 | **BLOCKED-EXTERNAL/RFC-2-RESOLVER**：没有稳定 resolver/failure contract 时，#543 的 pinned payload consumer 不可验收；将其标作上游缺供给，而非在 hook 层另建 resolver。 |
| D3 closure 六边 canonical durable record | **RFC-1 owner 供给；#543 消费** | 六边词表已冻结为 `create/run-spawn/run-exit/suspend/reopen/consume`；run 两边允许 active→active；全部 observer-only，gate 闭集不扩。现有五类 `closure.*` 不能冒充六边。 | RFC-1 对每次权威语义转移供给一个可消费的 canonical transition fact，覆盖所有合法 producer，并能在 producer commit/restart 边界保持其既定完整性语义。#543 不规定 outbox、同事务 record或统一 emitter。 | **BLOCKED-EXTERNAL/RFC-1-CLOSURE-TRANSITION**：六边 producer/record 未落地时，#543 只能声明 observer 订阅能力，不能声称六边均会真实触发；禁止由五类旧事件推断补齐。 |
| D4 六边 payload 时点与重复身份 | **RFC-1 owner 供给；#543 消费；#543 另拥有 delivery identity** | 边的语义时点必须由产生该边的权威状态机确定；transition identity 与 #543 的 observer execution/delivery identity 是不同域。#543 的重派为 at-least-once。 | 每个 canonical transition fact 携带稳定 edge kind、权威发生时点所需 snapshot/identity，以及足以让同一 transition 在重启重读时保持同一逻辑身份的键。#543 对每个匹配另建稳定 delivery/execution identity，并可重复投递；不重新定义 run-spawn、run-exit或consume的发生时点。 | **BLOCKED-EXTERNAL/RFC-1-EDGE-IDENTITY**：若上游不能给出稳定 edge identity/snapshot，#543 不得把 delivery identity冒充 transition identity，也不得承诺跨重启 payload 固定性。 |
| D5 reopen wire target identity | **RFC-1 owner 供给；#543 typed ingress 消费** | decision ADT 固定为 `reopen(target, correctionItemIds)`；target 重开、seq cursor 回退、terminal item不改写；target、closure、runtime node、item是不同 identity域。 | RFC-1 定义一个 opaque、typed、可持久验证的 reopen target wire value，并由其 validator 判定 membership、已运行、同 seq 与可 reopen。#543 只原样解析/携带该 target，不选择 runtimeNodeId、closureId或新 scope identity。 | **BLOCKED-EXTERNAL/RFC-1-REOPEN-TARGET**：target type/validator 未供给时，#543 可保留 ADT 槽位，但不能宣称 script reopen 可被权威接纳或执行。 |
| D6 correction item 与 evaluation/target claim | **RFC-1 owner 拥有 claim authority；#543 供给 evaluation identity与精确 IDs、消费 admission** | corrections 必须先经 evaluation scope CLI 创建，decision 精确引用既存 IDs；claim、target reopen、cursor/budget、decision consumed 的效果全有或全无。 | #543 为一次 evaluation 提供稳定 identity，并提交该 scope 下已创建的精确 `correctionItemIds`；RFC-1 admission 能验证这些 IDs 对 target/evaluation 的归属、未被冲突认领及重复提交语义，并返回 typed result。#543 不规定关联字段或关系表。 | **BLOCKED-EXTERNAL/RFC-1-CORRECTION-CLAIM**：没有 authoritative claim/admission 时，#543 只能证明 IDs 被创建，不能证明其归属、唯一认领或 reopen 原子效果。 |
| D7 `budgetRef` 解析、版本与耗尽事实 | **RFC-1 owner 供给；#543 消费结果** | par-local `{count,budgetRef}` 只是稳定持久 shape，不等于预算 authority；预算是否允许 reopen 属 RFC-1 reopen 合法性与执行语义。 | RFC-1 的 validator/effect authority 能在 pinned runtime context 中对 `budgetRef` 作确定解析，给出允许/耗尽的 typed 结论，并在成功 reopen 中权威更新 count。#543 无需知道额度来源、版本布局或 remaining 的物理表示。 | **BLOCKED-EXTERNAL/RFC-1-REOPEN-BUDGET**：budget resolver/writer 未落地时，#543 不得自行解释字符串、计算额度或宣称 budget 原子消费。 |
| D8 原子 reopen effect 的 journal/transaction 边界 | **RFC-1 owner 供给 effect authority；#543 拥有自身 decision journal/typed ingress** | B4 要求 claim、target reopen、cursor/budget 与 decision consumed 效果原子；不要求公开 API 恰为一个函数。terminal item保持不变。 | #543 把一个带稳定 evaluation/decision identity 的 typed reopen decision交给 RFC-1 authority；该 authority 对重复/冲突返回稳定 typed 结果，并保证其自有 reopen effects 全有或全无、重启后可判定。#543 只记录自身提交与结果，不规定上游 transaction、journal或内部 writer布局。 | **BLOCKED-EXTERNAL/RFC-1-REOPEN-EFFECT**：authority 未落地时，#543 不得把本地 decision journal、`decided-reopen` reachability seed或多次 CLI 调用称为原子 reopen。 |

## C. #543 可直接采用的 expected contracts

### C1. RFC-2 definition consumption

1. Hook payload 的 preset 定义部分只来自 RFC-2 公共 compile projection，不另造 hook 专属 preset shape。
2. 运行实例只按 pinned `definitionRef` 读取；同路径的新内容不改变旧实例结果。
3. resolver failure 是 typed、可审计的失败；#543 不回退当前路径。
4. #543 只依赖“可从 pinned ref 得到公共 projection或穷尽失败”，不依赖 artifact/schema/API 的物理形态。

### C2. RFC-1 closure transition consumption

1. #543 的 observer matcher面自动覆盖 RFC-1 供给的六个 canonical transition kind；六边不进入 gate point闭集。
2. transition fact 的发生时点、snapshot与逻辑 identity由 RFC-1 producer定义；#543 不从旧 `closure.*` 主题事件合成缺失边。
3. 每个 hook匹配产生独立 delivery；delivery/execution identity由 #543 持久化。上游 transition identity与下游 delivery identity分域。
4. at-least-once重派只承诺引擎内 execution/delivery 可追踪；外部文件、Git、服务与跨脚本 effect 的协调、幂等和去重归脚本作者。

### C3. RFC-1 reopen consumption

1. #543 输出并持久处理固定 decision ADT；point×decision合法组合、target合法性及 reopen效果由 RFC-1 authority判定。
2. #543 供给稳定 evaluation/decision identity，允许 corrections先经 CLI 创建，并提交精确 `correctionItemIds`。
3. RFC-1 admission/consumer负责 target、claim、budget、冲突、重复与原子 effect；#543 消费 typed结果并记录自身 journal/diagnostic。
4. #543 不要求上游使用特定 target ID、关系表、budget store或单函数 transaction，只要求稳定合同可被运行时验证。

## D. 外部 blocker

| Blocker | 提供方 | 阻塞的 #543 主张 | 解除证据 |
|---|---|---|---|
| RFC-2 pinned definition artifact/resolver 未落地 | RFC-2 | pinned payload、重启后定义一致性、missing/corrupt no-fallback | 在冻结供给 SHA 上证明 H1→路径H2→restart 后旧实例仍解析H1，新实例解析H2；missing/corrupt/version失败可穷尽观察。 |
| RFC-1 closure 六边 canonical producer/identity 未落地 | RFC-1 | 六边 observer真实触发、稳定 transition snapshot、重启恢复 | 在冻结供给 SHA 上逐边从各合法 producer触发并观察 canonical identity/snapshot；覆盖commit/restart与重复读取。 |
| RFC-1 structured reopen authority 未落地 | RFC-1 | script `reopen` admission、claim、budget、cursor及原子效果 | 在冻结供给 SHA 上以既存 corrections提交合法、重复、冲突、预算耗尽与崩溃恢复场景，证明 typed结果与全有或全无。 |

这些 blocker 只阻塞依赖它们的 #543 completion claim；不授权 #543 设计或实现替代上游 authority，也不把外部 effect 纳入引擎保证。

## E. 真正剩余操作员裁决

**0 项。**

D1–D8 的未定部分都是 RFC-1/RFC-2 owner 的物理 schema/API/producer 落地选择，或已由跨 RFC 稳定语义确定的消费合同；它们不应继续向操作员逐项提问。#543 在此域只需登记 expected contracts 与外部 blocker。

## F. 尾部核对

- D1–D8：逐项覆盖 **8/8**。
- 分类：RFC-2 owner供给/#543消费 **2**；RFC-1 owner供给/#543消费 **6**；#543独占且仍需操作员裁决 **0**。
- 稳定边界：已保留 projection复用、pinned no-fallback、closure六边observer-only、decision三词闭集、corrections先创建、reopen效果语义。
- 操作员原则：已明确外部文件/Git/服务/跨系统effect不由引擎兜底；无通用事务、锁、回滚或 exactly-once主张。
- 禁止项复核：未选 artifact、resolver、transition record、target、claim、budget或transaction的物理形态；未生成实现方案、工作量、issue或worktree。
- 外部 blocker：**3 组**（RFC-2 pin/resolver；RFC-1 closure transition；RFC-1 structured reopen authority）。
- 本域剩余操作员裁决：**0**。
