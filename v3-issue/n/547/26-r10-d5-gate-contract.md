# RFC 547 R10/D5 — Gate contract 需求侧推导

> 只读输入：`AGGREGATE-547.md` D5、`24-r9-expected-foundation.md` D5 与 Gate-2/4/5/6，以及 gate 供给摘要。本文不读源码、不复用旧 issue 边界、不指定或虚构 executor transport，不估规模、不新增需求。

## A. 主 agent 摘要（≤1页）

D5 的唯一闭环是：

`compiled gate declaration → typed point/host → runtime capability handshake → chain-over-global named binding → stable evaluation identity/epoch → GateEvaluation journal → transition reference/consume → restart recovery`

稳定 point 只有四类：`run.pre-spawn`、`run.post-exit`、`container.join`、`chain-complete`。它们不是裸字符串，而是携带各自 host ref 的封闭 ADT。current 八字符串 hook vocabulary 仅是可迁移 carrier，不是 compiled gate contract；不得用近似名字猜 host。

任何 gate declaration 都要求 gate evaluator/journal runtime capability。capability 缺席或版本/point/decision/journal/payload 不满足时：新 instance 在业务持久化前 typed reject；既有 pinned instance 在调度/恢复时 typed hold。required/optional 只决定 named binding missing：required missing reject/hold，optional missing 才可 skip；binding 已存在后 executor failure 服从显式 failure policy，optional 不能吞失败，更不能在 executor/capability 缺失时 inert 运行。

pre-spawn 在 scheduler 原子 `ready→claimed` 并分配 stable RunIntentId/RunId 后 evaluate。hold 必须在同一事务 `claimed→held`，保留 RunIntent/RunId/evaluation epoch、释放 scheduler capacity，且不创建 worktree/closure/process、不增加 attempt；恢复按 journal/fingerprint 重评。advance 后才允许资源副作用。

现有地基可复用 hook declaration carrier、四层持久化/effective view、严格 parse/写入授权、runtime/run/tree identity 与通用事务。修补后复用 Gate-2 完整 instance、Gate-4 domain-ref consume/effect/outbox、Gate-5 readiness claim/held recovery。D5 自建 typed declaration/point/host、named binding resolver、capability requirement/handshake、evaluation identity 与 journal seam。具名 dependency 是 **gate evaluator/journal**；**scripted join consumer** 只对 container/chain point 的真实消费形成相邻依赖。两者未完成前必须诚实 reject/hold。

原子需求共 **20** 项；验证从 compile、create handshake、schedule/pre-spawn、journal/transition 到 restart 分层，不以 carrier、projection、unit fixture 或 issue 存在代替 runtime capability。

## B. 原子需求

### B1. Declaration、四类 point 与 host identity

| ID | 原子需求 | Authority / identity | 匹配与验证 |
|---|---|---|---|
| D5-R01 | `GateDeclaration` 必须是 `{id,name,mode,point}` 的 typed product；mode 仅 `required | optional`；同一 pinned definition 内 name 唯一。 | `GateDeclarationId = (PresetDefinitionRef, GateName)`；compile product 唯一 authority。 | duplicate name、unknown mode/field、invalid point 在 compile typed reject。 |
| D5-R02 | point 封闭 ADT 仅含 `RunPreSpawn{phaseNodeId}`、`RunPostExit{phaseNodeId}`、`ContainerJoin{containerNodeId}`、`ChainComplete{topLevelJoinNodeId}`。 | point variant 自带 definition host ref；禁止裸 string、数组 index、path/name concat。 | 四 variant projection/round-trip；legacy 八字符串与近似名不得直接准入。 |
| D5-R03 | `RunPreSpawn` runtime host 必须是 stable `RunIntentHost{chainId,itemId,phaseNodeId,runIntentId,runId}`，在任何 gate/runner process 与 worktree 副作用前持久。 | host identity 绑定 pinned definition node 与 stable run identity。 | hold/advance/restart 保持同 RunIntentId/RunId；不得二次 mint。 |
| D5-R04 | `RunPostExit` host 必须是 `CompletedRunHost{chainId,itemId,phaseNodeId,runId,exitFactRef}`；runner exit fact 不等于 gate decision。 | read immutable execution fact；GateEvaluation 单独写。 | foreign/stale run、missing exit fact、point/host mismatch reject/hold。 |
| D5-R05 | `ContainerJoin` host 必须使用 runtime container stable identity、closure identity 与 epoch；不得使用 definition id alone、数组 path 或当前 item 推断。 | runtime tree/closure store 提供 host ref。 | non-degenerate join host round-trip；wrong container/closure/epoch reject。 |
| D5-R06 | `ChainComplete` host 必须使用 chain identity、top-level join identity、closure-set ref 与 epoch；不得以 first item、chain status string 或 hook index替代。 | top-level runtime join/closure set 唯一 host authority。 | closure-set mutation、stale epoch、wrong top join typed reject。 |
| D5-R07 | `GateDecisionPointId = (GateDeclarationId, GatePoint, GateHostStableId)`；`GateEvaluationId = (GateDecisionPointId, Epoch)`。fingerprint 只含该 identity、相关 canonical state 与 effective declaration hash。 | journal key 唯一；fingerprint 与 epoch 正交。 | duplicate replay、state unchanged recovery、relevant state changed re-evaluation；偶然 DB 字段不改变 fingerprint。 |

### B2. Named binding、required/optional 与 resolution

| ID | 原子需求 | Read/write rule | 匹配与验证 |
|---|---|---|---|
| D5-R08 | named binding producer 仅 global 与 chain；chain 覆盖 global；item direct hook 不参与 named resolution。 | resolver 读 pinned declaration + global/chain bindings；写 resolution ADT。 | `Selected(chain,shadowedGlobal)`、`Selected(global)`、missing 三态；item 输入不改变选择。 |
| D5-R09 | same-layer duplicate binding 在边界 typed reject；禁止按数组顺序、最后写入或 concat order 选中。 | binding admission 保持 layer/name/point identity 唯一。 | global/chain duplicate、跨 point 同名、合法 chain override。 |
| D5-R10 | resolution ADT 必须区分 `Selected{binding,source,shadowedGlobal?} | MissingOptional | MissingRequired`，并可投影 selected/shadowed/missing。 | resolution record 不等于 evaluation verdict。 | doctor/status/projection 读取同一 resolution；无 boolean/nullable soup。 |
| D5-R11 | required missing：新 instance create typed reject，既有 pinned instance schedule/recovery hold；optional missing：只写可观察 skip，不创建假 evaluation verdict。 | create/scheduler 在资源副作用前决定。 | required/optional × new/pinned 矩阵；optional missing 不调用 executor。 |
| D5-R12 | binding 已 Selected 后，required/optional 不改变 executor failure 语义；failure 只按 declaration 的显式 failure policy处理，optional 不得吞 failure。 | GateEvaluation journal 记录 typed decision/failure。 | selected optional 的 timeout/error/malformed decision 不得 advance/inert。 |

### B3. Runtime capability handshake

| ID | 原子需求 | Handshake boundary | 匹配与验证 |
|---|---|---|---|
| D5-R13 | runtime capability 必须具名、版本化，并声明 protocol、supported point variants、decision variants、journal version、payload schema version；requirement 从 compiled declarations 机械推导。 | gate evaluator/journal 完成真实注册后才可 advertise；配置、carrier、symbol、issue 不构成 capability。 | absent、old version、missing point/decision、journal/payload mismatch 各自 typed error。 |
| D5-R14 | compile/preview 可产生含 gate 的 model，但 create 在写业务 instance 前 handshake；resume/restart 对 pinned requirement 与当前 capability 再 handshake。 | Gate-2 pure admission plan；失败零业务 row。 | new instance absent capability typed reject；pinned instance capability lost typed hold。 |
| D5-R15 | 任何 gate declaration 在 capability absent 时都执行 R14；optional 不能跳过 capability/executor，只有 `MissingOptional` binding 可 skip。 | capability failure 优先于 named binding optionality。 | optional+no capability、optional+unsupported point、optional+missing executor 全部 reject/hold。 |

### B4. Pre-spawn claim、evaluation 与 journal

| ID | 原子需求 | Transaction / side-effect boundary | 匹配与验证 |
|---|---|---|---|
| D5-R16 | pre-spawn 前完成 definition integrity、typed runtime values、capability handshake 与 named binding resolution；然后 scheduler 原子 `ready→claimed` 并分配 stable RunIntentId/RunId。 | readiness store 是 claim authority；不先建 worktree/closure/process。 | stale readiness、double claim、capability/binding failure 均无资源副作用。 |
| D5-R17 | gate evaluator/journal 以同一 GateEvaluationId 创建或恢复 `evaluating | decided | consumed` epoch；transport 与执行机制由 dependency owner决定，D5 不假设 HTTP/event/process。 | GateEvaluation journal 是 gate decision 唯一 authority。 | malformed/duplicate/out-of-epoch result typed reject；carrier/event/context 不冒充 decision。 |
| D5-R18 | decision=`hold` 时同一事务执行 `claimed→held`，保留 RunIntent/RunId/evaluation epoch，释放 scheduler capacity；不建资源、不增 attempt。decision=`advance` 后才可准备 worktree/branch/closure/process。 | readiness transition 与 journal ref 关联；资源边界在 advance 后。 | hold 无孤儿资源/容量泄漏/重复 run；advance 使用同 RunId。 |

### B5. Transition consume、recovery 与 unsupported

| ID | 原子需求 | Recovery authority | 匹配与验证 |
|---|---|---|---|
| D5-R19 | 业务 transition 只能引用并 consume `decided` GateEvaluationRef；transition effects 与 journal consumption 同一 DB 事务。GateEvaluation 不复制到 transition 第二 journal，outbox 只派生观察事件。 | Gate-4 transition + gate journal 各一 authority。 | crash before/after commit、duplicate consume、foreign/stale evaluation；一次业务推进。 |
| D5-R20 | restart 扫描 `evaluating/decided/consumed` 与 `held` readiness：decided-unconsumed 重消费而不重执行；evaluating/held 按同 identity、journal、fingerprint重评；capability/dependency 缺失继续 hold。container/chain point 在 scripted join consumer 未闭合时 typed unsupported/hold。 | pinned definition、GateEvaluation journal、readiness store；不读 current 猜测。 | daemon restart、capability loss/restore、fingerprint unchanged/changed、join consumer absent；无 silent advance。 |

## C. 地基匹配与责任边界

| 分类 | 可用/目标 | 不得升级为 |
|---|---|---|
| 24 地基已供 | hook declaration carrier、四层持久化/effective view、严格 parse/写入授权、runtime/run/tree identity、通用 SQLite 事务 | carrier/八字符串、拼接 list、placeholder、测试 fixture 不等于 gate contract 或 runtime capability |
| 修补后复用 | Gate-2 pure instance plan/零半实例；Gate-4 domain-ref consume/outbox；Gate-5 readiness claim/held recovery；D3 runtime host identity | 相邻 Gate 未实现前不得称 create/transition/restart 已闭环 |
| D5 自建 | R01–R20 的 declaration、四 point/host、binding resolver、capability requirement/handshake、evaluation identity/journal seam、unsupported contract | 不实现或指定 executor transport；不复制 scheduler/transition/join authority |
| 具名 dependency | gate evaluator/journal 提供真实 capability、evaluation execution 与 journal；scripted join consumer 提供 container/chain point 的真实 lifecycle consumption | dependency 名称不是合同 identity；其缺席只能 reject/hold，不能 inert/fallback |
| 地基未闭合 | gate evaluator/journal executor/recovery、Gate-4 transition consume、Gate-5 held capacity/re-evaluation、non-degenerate join consumption | 文档、carrier、projection、事件或 issue 存在不得替代 runtime proof |

## D. 验证分层

| 最早可决定点 | 必须验证 |
|---|---|
| compile/projection | declaration uniqueness、四 point ADT、point→definition host、derived capability requirement、unknown variant/version |
| binding boundary | chain-over-global、same-layer duplicate、selected/shadowed/missing、item exclusion、required/optional matrix |
| create handshake | absent/mismatched capability 对任何 gate declaration typed reject，零业务 row；optional 不豁免 |
| schedule/pre-spawn | ready→claimed、stable RunIntent/RunId、hold→held、capacity release、advance 前零资源副作用 |
| lifecycle host | post-exit、container join、chain complete 的 stable host/epoch 与 wrong-host rejection |
| journal/transition | evaluating→decided→consumed、same-transaction consume、duplicate/crash recovery、outbox 非 authority |
| restart/dependency | pinned requirement re-handshake、capability loss/restore、fingerprint 重评、scripted join consumer absent hold |

## 尾结论

**D5 的 20 项原子需求把四类 typed point、stable host、chain-over-global binding、required/optional、runtime capability handshake、pre-spawn `claimed→held`、GateEvaluation journal、transition consume 与 restart recovery 收敛为一条合同。任何 gate 在 gate evaluator/journal capability 缺席或不匹配时都必须新建 reject、既有 pinned hold；optional 只允许 missing binding skip，绝不允许 executor inert。现有 carrier 与事务只是地基，gate evaluator/journal、scripted join consumer 及真实 lifecycle/recovery 仍未闭合，本文不虚构 executor transport。**
